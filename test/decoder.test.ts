import { describe, expect, it } from "vitest";
import { createDecoder, decode } from "../src/index.ts";
import {
  connectError,
  delayed,
  hang,
  PUBLISHER_URL,
  page,
  rpc,
  SOURCE_URL,
  scriptedFetch,
  status,
} from "./helpers.ts";

const OTHER_URL = "https://news.google.com/articles/CBMiOTHER";

describe("decode: success", () => {
  it("decodes from the recorded responses in two requests", async () => {
    const { fetch, calls } = scriptedFetch(page(), rpc());
    expect(await decode(SOURCE_URL, { fetch })).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname.split("/").slice(0, 3).join("/")}`),
    ).toEqual(["GET /rss/articles", "POST /_/DotsSplashUi"]);
    expect(calls[0]?.url).toContain("hl=en-US&gl=US&ceid=US%3Aen");
    expect(calls[1]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(decodeURIComponent(calls[1]?.body ?? "")).toContain("Ae5Wzi-zTr7BmTsy16W2E8ubaTXt");
  });

  it("falls back to the second candidate when the first page has no signature", async () => {
    const { fetch, calls } = scriptedFetch(page("<html></html>"), page(), rpc());
    expect(await decode(SOURCE_URL, { fetch })).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(new URL(calls[1]?.url ?? "").pathname).toMatch(/^\/articles\//);
  });

  it("falls back to the second candidate on an HTTP error", async () => {
    const { fetch } = scriptedFetch(status(503), page(), rpc());
    expect(await decode(SOURCE_URL, { fetch })).toEqual({ ok: true, url: PUBLISHER_URL });
  });

  it("follows a consent hop and never sends a cookie", async () => {
    const { fetch, calls } = scriptedFetch(
      status(302, { location: "https://consent.google.com/ml?continue=x", "set-cookie": "SOCS=abc" }),
      status(302, { location: "https://news.google.com/rss/articles/TOK?hl=en-US" }),
      page(),
      rpc(),
    );
    expect(await decode(SOURCE_URL, { fetch })).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(calls.map((c) => c.headers.get("cookie"))).toEqual([null, null, null, null]);
    expect(calls.every((c) => c.headers.get("user-agent")?.startsWith("Mozilla/5.0"))).toBe(true);
  });
});

describe("decode: rate limits", () => {
  it("reports 429 on the article page, and does not spend the second candidate", async () => {
    const { fetch, calls } = scriptedFetch(status(429));
    expect(await decode(SOURCE_URL, { fetch })).toEqual({
      ok: false,
      reason: "rate_limited",
      status: 429,
      message: "HTTP 429",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports 429 on the RPC", async () => {
    const { fetch } = scriptedFetch(page(), status(429));
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({
      ok: false,
      reason: "rate_limited",
      status: 429,
    });
  });

  it("treats a redirect to google.com/sorry as a rate limit", async () => {
    const { fetch, calls } = scriptedFetch(
      status(302, { location: "https://www.google.com/sorry/index?q=x" }),
    );
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({
      ok: false,
      reason: "rate_limited",
      status: 302,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("decode: other failures", () => {
  it("reports the last HTTP error when both candidates fail", async () => {
    const { fetch } = scriptedFetch(status(500), status(404));
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "http", status: 404 });
  });

  it("reports a parse failure when no page has a signature", async () => {
    const { fetch } = scriptedFetch(page("<html></html>"), page("<html></html>"));
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "parse" });
  });

  it("reports a parse failure when the RPC answer is unreadable", async () => {
    const { fetch } = scriptedFetch(page(), rpc(')]}\'\n\n[["er",null,null,null,null,400]]'));
    const result = await decode(SOURCE_URL, { fetch });
    expect(result).toMatchObject({ ok: false, reason: "parse" });
    expect(result).not.toHaveProperty("status");
  });

  it("refuses a redirect off Google", async () => {
    const { fetch } = scriptedFetch(
      status(302, { location: "https://evil.example/" }),
      status(302, { location: "https://evil.example/" }),
    );
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "http", status: 302 });
  });

  it("refuses a response over the size cap without buffering it all", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent++;
            controller.enqueue(chunk);
          },
        }),
      );
    const { fetch } = scriptedFetch(huge, huge);
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "parse" });
    expect(sent).toBeLessThan(80);
  });

  it("returns not_google_news without a request", async () => {
    const { fetch, calls } = scriptedFetch();
    expect(await decode("https://www.reuters.com/world/", { fetch })).toMatchObject({
      ok: false,
      reason: "not_google_news",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("decode: connect retry", () => {
  it("retries a failed connect once, to the same URL", async () => {
    const { fetch, calls } = scriptedFetch(connectError(), page(), rpc());
    expect(await decode(SOURCE_URL, { fetch })).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(calls[0]?.url).toBe(calls[1]?.url);
  });

  it("retries only once", async () => {
    const { fetch, calls } = scriptedFetch(connectError(), connectError(), connectError(), connectError());
    expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "network" });
    expect(calls).toHaveLength(4); // two per candidate page
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET"])(
    "never retries %s, which may have reached the server",
    async (code) => {
      const { fetch, calls } = scriptedFetch(page(), connectError(code));
      expect(await decode(SOURCE_URL, { fetch })).toMatchObject({ ok: false, reason: "network" });
      expect(calls).toHaveLength(2);
    },
  );
});

describe("decode: timeout and abort", () => {
  it("times out a hung request", async () => {
    const { fetch } = scriptedFetch(hang());
    const started = performance.now();
    expect(await decode(SOURCE_URL, { fetch, timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("times out even when the transport ignores the signal", async () => {
    const { fetch } = scriptedFetch(hang(false));
    expect(await decode(SOURCE_URL, { fetch, timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("budgets the whole decode, not each request", async () => {
    // Each request fits in the budget on its own; together they don't.
    const { fetch } = scriptedFetch(delayed(80, page), delayed(80, rpc));
    expect(await decode(SOURCE_URL, { fetch, timeoutMs: 120 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("times out a body that stalls mid-stream", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>"));
          },
        }),
      );
    const { fetch } = scriptedFetch(stalled);
    expect(await decode(SOURCE_URL, { fetch, timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("reports a caller abort as aborted, not timeout", async () => {
    const controller = new AbortController();
    const { fetch } = scriptedFetch(hang());
    setTimeout(() => controller.abort(), 20);
    expect(await decode(SOURCE_URL, { fetch, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: "aborted",
    });
  });

  it("makes no request when already aborted", async () => {
    const { fetch, calls } = scriptedFetch();
    expect(await decode(SOURCE_URL, { fetch, signal: AbortSignal.abort() })).toMatchObject({
      reason: "aborted",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a nonsense timeout as a programming error", () => {
    expect(() => createDecoder({ timeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("cache", () => {
  it("is off by default: two decoders, or two calls, share nothing", async () => {
    const { fetch, calls } = scriptedFetch(page(), rpc(), page(), rpc());
    const decoder = createDecoder({ fetch });
    await decoder.decode(SOURCE_URL);
    await decoder.decode(SOURCE_URL);
    expect(calls).toHaveLength(4);
  });

  it("serves a success from a supplied cache", async () => {
    const cache = new Map<string, string>();
    const { fetch, calls } = scriptedFetch(page(), rpc());
    const decoder = createDecoder({ fetch, cache });
    await decoder.decode(SOURCE_URL);
    expect(await decoder.decode(SOURCE_URL)).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  it("rejects a nonsense per-call timeout even on a cache hit", async () => {
    const { fetch } = scriptedFetch(page(), rpc());
    const decoder = createDecoder({ fetch, cache: new Map() });
    await decoder.decode(SOURCE_URL);
    await expect(decoder.decode(SOURCE_URL, { timeoutMs: 0 })).rejects.toThrow(RangeError);
  });

  it("never caches a failure", async () => {
    const cache = new Map<string, string>();
    const { fetch } = scriptedFetch(status(429), page(), rpc());
    const decoder = createDecoder({ fetch, cache });
    expect(await decoder.decode(SOURCE_URL)).toMatchObject({ reason: "rate_limited" });
    expect(cache.size).toBe(0);
    expect(await decoder.decode(SOURCE_URL)).toEqual({ ok: true, url: PUBLISHER_URL });
  });
});

describe("decodeAll", () => {
  it("keys results by input URL, collapsing duplicates", async () => {
    const { fetch } = scriptedFetch(page(), rpc(), status(404), status(404));
    const results = await createDecoder({ fetch }).decodeAll([
      SOURCE_URL,
      "https://example.com/a",
      SOURCE_URL,
      OTHER_URL,
    ]);
    expect([...results.keys()]).toEqual([SOURCE_URL, "https://example.com/a", OTHER_URL]);
    expect(results.get(SOURCE_URL)).toEqual({ ok: true, url: PUBLISHER_URL });
    expect(results.get("https://example.com/a")).toMatchObject({ reason: "not_google_news" });
    expect(results.get(OTHER_URL)).toMatchObject({ reason: "http", status: 404 });
  });

  it("reports each result to onResult as it lands, skipped ones included", async () => {
    const seen: string[] = [];
    const { fetch } = scriptedFetch(status(429));
    const results = await createDecoder({ fetch }).decodeAll(
      ["https://example.com/a", SOURCE_URL, OTHER_URL],
      {
        onResult: (url, result) => {
          // Called before the batch finishes: the map already holds this URL, and nothing after it.
          seen.push(
            `${url === SOURCE_URL ? "source" : url === OTHER_URL ? "other" : "plain"}:${result.ok ? "ok" : result.reason}`,
          );
        },
      },
    );
    expect(seen).toEqual(["plain:not_google_news", "source:rate_limited", "other:skipped"]);
    expect(results.size).toBe(3);
  });

  it("a throwing onResult rejects the batch rather than being swallowed", async () => {
    const { fetch } = scriptedFetch();
    const decoder = createDecoder({ fetch });
    await expect(
      decoder.decodeAll(["https://example.com/a"], {
        onResult: () => {
          throw new Error("heartbeat failed");
        },
      }),
    ).rejects.toThrow("heartbeat failed");
  });

  it("stops at a rate limit and skips the rest", async () => {
    const third = "https://news.google.com/articles/CBMiTHIRD";
    const { fetch, calls } = scriptedFetch(status(429));
    const results = await createDecoder({ fetch }).decodeAll([SOURCE_URL, OTHER_URL, third]);
    expect(results.get(SOURCE_URL)).toMatchObject({ reason: "rate_limited" });
    expect(results.get(OTHER_URL)).toMatchObject({ reason: "skipped" });
    expect(results.get(third)).toMatchObject({ reason: "skipped" });
    expect(calls).toHaveLength(1);
  });

  it("paces between network decodes, not before the first", async () => {
    const { fetch } = scriptedFetch(status(404), status(404), status(404), status(404));
    const started = performance.now();
    await createDecoder({ fetch }).decodeAll([SOURCE_URL, OTHER_URL], { delayMs: 60 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(115);
  });

  it("an already-aborted batch reports aborted on the first network URL, then skips", async () => {
    const { fetch, calls } = scriptedFetch();
    const results = await createDecoder({ fetch }).decodeAll(
      ["https://example.com/a", SOURCE_URL, OTHER_URL],
      { signal: AbortSignal.abort() },
    );
    expect(results.get("https://example.com/a")).toMatchObject({ reason: "not_google_news" });
    expect(results.get(SOURCE_URL)).toMatchObject({ reason: "aborted" });
    expect(results.get(OTHER_URL)).toMatchObject({ reason: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("an abort during the pause is reported on the URL it delayed", async () => {
    const controller = new AbortController();
    const { fetch } = scriptedFetch(status(404), status(404));
    setTimeout(() => controller.abort(), 20);
    const results = await createDecoder({ fetch }).decodeAll([SOURCE_URL, OTHER_URL], {
      delayMs: 5000,
      signal: controller.signal,
    });
    expect(results.get(OTHER_URL)).toMatchObject({ reason: "aborted" });
  });
});

it("the standalone decode rejects a bad timeout rather than throwing synchronously", async () => {
  const pending = decode(SOURCE_URL, { timeoutMs: 0 });
  await expect(pending).rejects.toThrow(RangeError);
});
