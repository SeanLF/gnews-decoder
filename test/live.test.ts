import { describe, expect, it } from "vitest";
import { createDecoder } from "../src/index.ts";

// Spends one Google feed fetch and one decode (two requests) of this address's budget. Never in CI.
describe.runIf(process.env.GNEWS_LIVE === "1")("live", () => {
  it("decodes a current Google News link", { timeout: 30_000 }, async () => {
    const feed = await (
      await fetch("https://news.google.com/rss/search?q=reuters+when:1d&hl=en-US&gl=US&ceid=US:en")
    ).text();
    const link = feed.match(/<link>(https:\/\/news\.google\.com\/rss\/articles\/[^<]+)<\/link>/)?.[1];
    expect(link).toBeDefined();
    const result = await createDecoder().decode(link as string);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(new URL(result.url).hostname).not.toMatch(/google\.com$/);
  });
});
