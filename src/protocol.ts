// The decode protocol as pure functions over strings. No I/O here.
//
//   articleToken(url)            the opaque token from the URL
//   -> paramsUrls(token, url)    GET an article page (two candidates)
//   -> parseParams(html)         scrape signature + timestamp
//   -> decodeRequestBody(...)    POST them to batchexecute
//   -> parseDecoded(body)        pull out the publisher URL

export const BATCHEXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

const ARTICLE_SEGMENTS = new Set(["articles", "read"]);
// Real tokens run a few hundred characters; this bounds a crafted one.
export const MAX_TOKEN_LENGTH = 8192;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// Sent up front so Google doesn't spend a 302 adding it (fork: 3 requests -> 2 per decode).
const DEFAULT_LOCALE = { hl: "en-US", gl: "US", ceid: "US:en" } as const;

// Opaque scaffold for the garturlreq RPC. Only the token, timestamp and signature vary.
const RPC_CONTEXT = [
  ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
  "X",
  "X",
  1,
  [1, 1, 1],
  1,
  1,
  null,
  0,
  0,
  null,
  0,
];

/** The article token from a Google News URL, or null if the URL is not one. */
export function articleToken(sourceUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "news.google.com") return null;
  const segments = url.pathname.split("/");
  if (segments.length < 2) return null;
  const parent = segments.at(-2) as string;
  const token = segments.at(-1) as string;
  if (!ARTICLE_SEGMENTS.has(parent)) return null;
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(token)) return null;
  return token;
}

/**
 * Article pages to try, in order. `/rss/articles` first: it is the smaller page (fork measured
 * ~118 KiB against ~167) and carries the same attributes. Locale comes from the source URL when it
 * has one (upstream's idea), else the default.
 */
export function paramsUrls(token: string, sourceUrl: string): [string, string] {
  let source: URLSearchParams;
  try {
    source = new URL(sourceUrl).searchParams;
  } catch {
    source = new URLSearchParams();
  }
  const query = new URLSearchParams({
    hl: source.get("hl") || DEFAULT_LOCALE.hl,
    gl: source.get("gl") || DEFAULT_LOCALE.gl,
    ceid: source.get("ceid") || DEFAULT_LOCALE.ceid,
  });
  return [
    `https://news.google.com/rss/articles/${token}?${query}`,
    `https://news.google.com/articles/${token}?${query}`,
  ];
}

// A start tag, tolerating `>` inside quoted attribute values.
const TAG_RE = /<[a-zA-Z][^\s/>]*((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?|\s*\/)*)\s*>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" };

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, name: string) => ENTITIES[name] ?? "");
}

/**
 * (signature, timestamp) from an article page, or null.
 *
 * Both attributes must come off the SAME element: a signature from one element paired with a
 * timestamp from another builds a well-formed request Google rejects. Comments and script bodies
 * are dropped first so a `data-n-a-sg` inside either can't be picked up. Attribute order varies:
 * the recorded fixture has ts before sg.
 */
export function parseParams(html: string): { signature: string; timestamp: string } | null {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const tag of markup.matchAll(TAG_RE)) {
    const attrs = tag[1];
    if (!attrs?.includes("data-n-a-sg") || !attrs.includes("data-n-a-ts")) continue;
    let signature: string | undefined;
    let timestamp: string | undefined;
    for (const [, name, dq, sq, bare] of attrs.matchAll(ATTR_RE)) {
      const value = unescapeHtml(dq ?? sq ?? bare ?? "");
      if (name === "data-n-a-sg") signature = value;
      else if (name === "data-n-a-ts") timestamp = value;
    }
    if (signature && timestamp && /^\d+$/.test(timestamp)) return { signature, timestamp };
  }
  return null;
}

/**
 * The batchexecute form body. The RPC is nested THREE arrays deep ([[[rpc]]]); two levels is
 * rejected with HTTP 400 (fork). The inner payload goes through JSON.stringify rather than string
 * interpolation (upstream), so nothing in a signature can break out of it.
 */
export function decodeRequestBody(token: string, signature: string, timestamp: string): string {
  const inner = JSON.stringify(["garturlreq", RPC_CONTEXT, token, Number(timestamp), signature]);
  return `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]))}`;
}

/** An http(s) URL with a host and no control characters, which could split a header or a log line. */
export function isPlausibleUrl(candidate: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f]/.test(candidate)) return false;
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The publisher URL from a batchexecute response, or null.
 *
 * The body opens with the `)]}'` XSSI guard (upstream strips it explicitly; the fork's
 * split-on-blank-line only works by accident of layout). Every `garturlres` frame is read, and two
 * different answers are a failure: a visible failure beats a plausible wrong URL.
 */
export function parseDecoded(body: string): string | null {
  const urls = new Set<string>();
  const text = body.replace(/^\)\]\}'/, "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[")) continue;
    let frames: unknown;
    try {
      frames = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!Array.isArray(frame) || frame[0] !== "wrb.fr" || frame[1] !== "Fbv4je") continue;
      if (typeof frame[2] !== "string") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(frame[2]);
      } catch {
        continue;
      }
      if (Array.isArray(payload) && payload[0] === "garturlres" && typeof payload[1] === "string") {
        urls.add(payload[1]);
      }
    }
  }
  const [url, ...others] = urls;
  return url !== undefined && others.length === 0 && isPlausibleUrl(url) ? url : null;
}
