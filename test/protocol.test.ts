import { describe, expect, it } from "vitest";
import {
  articleToken,
  decodeRequestBody,
  isPlausibleUrl,
  paramsUrls,
  parseDecoded,
  parseParams,
} from "../src/protocol.ts";
import { ARTICLE_PAGE, BATCHEXECUTE, PUBLISHER_URL, SOURCE_URL } from "./helpers.ts";

describe("articleToken", () => {
  it.each([
    ["https://news.google.com/rss/articles/CBMiAbc?oc=5", "CBMiAbc"],
    ["https://news.google.com/articles/CBMi_Abc-1", "CBMi_Abc-1"],
    ["https://news.google.com/read/CBMiAbc?hl=fr", "CBMiAbc"],
  ])("accepts %s", (url, token) => {
    expect(articleToken(url)).toBe(token);
  });

  it.each([
    "https://example.com/rss/articles/CBMiAbc",
    "https://news.google.com.evil.example/rss/articles/CBMiAbc",
    "https://news.google.com/topics/CBMiAbc",
    "https://news.google.com/rss/articles/",
    "https://news.google.com/rss/articles/abc%22def",
    "ftp://news.google.com/rss/articles/CBMiAbc",
    "not a url",
    `https://news.google.com/rss/articles/${"A".repeat(8193)}`,
  ])("rejects %s", (url) => {
    expect(articleToken(url)).toBeNull();
  });
});

describe("paramsUrls", () => {
  it("tries the smaller RSS page first, with the default locale", () => {
    const [first, second] = paramsUrls("TOK", "https://news.google.com/rss/articles/TOK");
    expect(first).toBe("https://news.google.com/rss/articles/TOK?hl=en-US&gl=US&ceid=US%3Aen");
    expect(second).toBe("https://news.google.com/articles/TOK?hl=en-US&gl=US&ceid=US%3Aen");
  });

  it("carries the source URL's locale", () => {
    const [first] = paramsUrls("TOK", "https://news.google.com/rss/articles/TOK?hl=fr&gl=FR&ceid=FR:fr");
    expect(first).toBe("https://news.google.com/rss/articles/TOK?hl=fr&gl=FR&ceid=FR%3Afr");
  });
});

describe("parseParams", () => {
  it("reads the recorded page (timestamp before signature)", () => {
    expect(parseParams(ARTICLE_PAGE)).toEqual({
      signature: "Ae5Wzi-zTr7BmTsy16W2E8ubaTXt",
      timestamp: "1790181872",
    });
  });

  it("reads either attribute order", () => {
    expect(parseParams('<div data-n-a-sg="S" data-n-a-ts="1"></div>')).toEqual({
      signature: "S",
      timestamp: "1",
    });
  });

  it("never pairs attributes from different elements", () => {
    expect(parseParams('<div data-n-a-sg="S"></div><div data-n-a-ts="1"></div>')).toBeNull();
  });

  it("ignores decoys in comments and scripts", () => {
    const html =
      '<!-- <div data-n-a-sg="FAKE" data-n-a-ts="9"> --><script>x=\'<div data-n-a-sg="F2" data-n-a-ts="8">\'</script>' +
      '<div data-n-a-sg="REAL" data-n-a-ts="1"></div>';
    expect(parseParams(html)).toEqual({ signature: "REAL", timestamp: "1" });
  });

  it("refuses a non-numeric timestamp", () => {
    expect(parseParams('<div data-n-a-sg="S" data-n-a-ts="1,2"></div>')).toBeNull();
  });

  it("returns null for a page without the attributes (a consent interstitial)", () => {
    expect(
      parseParams("<html><body><form action='https://consent.google.com/save'></form></body></html>"),
    ).toBeNull();
  });
});

describe("decodeRequestBody", () => {
  it("nests the RPC three arrays deep and sends the timestamp as a number", () => {
    const body = decodeRequestBody("TOK", "SIG", "123");
    const fReq = JSON.parse(decodeURIComponent(body.replace(/^f\.req=/, "")));
    expect(fReq[0][0][0]).toBe("Fbv4je");
    const inner = JSON.parse(fReq[0][0][1]);
    expect(inner[0]).toBe("garturlreq");
    expect(inner.slice(2)).toEqual(["TOK", 123, "SIG"]);
  });

  it("keeps a hostile signature inside its string", () => {
    const body = decodeRequestBody("TOK", 'x","evil', "1");
    const inner = JSON.parse(JSON.parse(decodeURIComponent(body.slice(6)))[0][0][1]);
    expect(inner.at(-1)).toBe('x","evil');
  });
});

describe("parseDecoded", () => {
  it("reads the recorded response", () => {
    expect(parseDecoded(BATCHEXECUTE)).toBe(PUBLISHER_URL);
  });

  const frame = (url: string) => JSON.stringify(["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", url, 1])]);

  it("fails on two different answers rather than picking one", () => {
    expect(
      parseDecoded(`)]}'\n\n[${frame("https://a.example/")},${frame("https://b.example/")}]`),
    ).toBeNull();
  });

  it("rejects a URL a header or log could be split on", () => {
    expect(parseDecoded(`)]}'\n\n[${frame("https://a.example/\r\nSet-Cookie: x")}]`)).toBeNull();
    expect(parseDecoded(`)]}'\n\n[${frame("javascript:alert(1)")}]`)).toBeNull();
  });

  it("returns null for an error frame", () => {
    expect(parseDecoded(`)]}'\n\n[["wrb.fr","Fbv4je",null,null,null,[3],"generic"],["di",10]]`)).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseDecoded("<html>Error 400</html>")).toBeNull();
  });
});

describe("isPlausibleUrl", () => {
  it("accepts the fixture's publisher URL", () => expect(isPlausibleUrl(PUBLISHER_URL)).toBe(true));
  it("rejects bare http", () => expect(isPlausibleUrl("http")).toBe(false));
  it("rejects NUL", () => expect(isPlausibleUrl("https://a.example/\u0000")).toBe(false));
});

it("the recorded source URL is a Google News URL", () => {
  expect(articleToken(SOURCE_URL)).toMatch(/^CBMi/);
});
