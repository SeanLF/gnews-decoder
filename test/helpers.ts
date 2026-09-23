import { readFileSync } from "node:fs";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

// Recorded 2026-09-23 from one live decode. Script and style bodies stripped from the page (they
// carry session tokens), nothing else changed.
export const ARTICLE_PAGE = fixture("article-page.html");
export const BATCHEXECUTE = fixture("batchexecute.txt");
export const SOURCE_URL = fixture("source-url.txt").trim();
export const PUBLISHER_URL =
  "https://www.reuters.com/world/middle-east/hope-progress-after-us-iran-hold-first-shuttle-talks-months-2026-09-23/";

export interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

type Reply =
  | Response
  | Error
  | ((call: Call, signal: AbortSignal | undefined) => Promise<Response> | Response);

/**
 * A fetch that answers from a script of replies, in order, and records every call. Running out of
 * replies throws, so a test that makes an unexpected request fails rather than passing on a default.
 */
export function scriptedFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const reply = replies.shift();
    if (reply === undefined)
      throw new Error(`unexpected request #${calls.length}: ${call.method} ${call.url}`);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(call, init?.signal ?? undefined);
    return reply;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const page = (html = ARTICLE_PAGE) => new Response(html, { status: 200 });
export const rpc = (body = BATCHEXECUTE) => new Response(body, { status: 200 });
export const status = (code: number, headers?: Record<string, string>) =>
  new Response(null, { status: code, ...(headers ? { headers } : {}) });

/** What undici throws when the TCP connect is refused. */
export function connectError(code = "ECONNREFUSED"): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

/** A reply that never settles on its own; it rejects only if the signal aborts. */
export function hang(honourSignal = true) {
  return (_call: Call, signal: AbortSignal | undefined) =>
    new Promise<Response>((_, reject) => {
      if (honourSignal) signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

export function delayed(ms: number, response: () => Response) {
  return () => new Promise<Response>((resolve) => setTimeout(() => resolve(response()), ms));
}
