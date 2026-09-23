import {
  articleToken,
  BATCHEXECUTE_URL,
  decodeRequestBody,
  paramsUrls,
  parseDecoded,
  parseParams,
} from "./protocol.ts";

export type FailureReason =
  | "not_google_news"
  | "rate_limited"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "parse";

export type DecodeResult =
  | { ok: true; url: string }
  | { ok: false; reason: FailureReason; status?: number; message: string };

/** `decodeAll` adds one outcome: never attempted, because the batch stopped first. */
export type BatchResult = DecodeResult | { ok: false; reason: "skipped"; message: string };

export interface DecoderOptions {
  /** The transport. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Budget for one whole decode: every page, redirect, retry and the RPC. Default 15 000. */
  timeoutMs?: number;
  userAgent?: string;
  /**
   * Opt-in cache of successful decodes, keyed by article token. Yours to own, scope and clear;
   * failures are never stored, so a transient failure can't go stale in it.
   */
  cache?: Map<string, string>;
}

export interface DecodeOptions {
  signal?: AbortSignal;
  /** Overrides the decoder's `timeoutMs` for this call. */
  timeoutMs?: number;
}

export interface DecodeAllOptions extends DecodeOptions {
  /** Pause between decodes that reach the network. Cache hits and non-Google URLs don't wait. */
  delayMs?: number;
}

export interface Decoder {
  decode(url: string, options?: DecodeOptions): Promise<DecodeResult>;
  /**
   * Decode serially, keyed by input URL (duplicates collapse to one entry). Stops at the first
   * `rate_limited` or `aborted`: the rest come back `skipped`, because Google's limit is a per-IP
   * budget that backing off doesn't recover.
   */
  decodeAll(urls: Iterable<string>, options?: DecodeAllOptions): Promise<Map<string, BatchResult>>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
// Counted decoded; article pages run ~1 MB uncompressed.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Failures that happen before a request can have reached the server, so a retry can't spend a
// second unit of the address's budget. ECONNRESET and read timeouts are deliberately absent: the
// request may have landed (fork measured a stalled request being delivered twice).
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

type Failure = Extract<DecodeResult, { ok: false }>;

class DecodeFailure extends Error {
  constructor(readonly result: Failure) {
    super(result.message);
  }
}

function fail(reason: FailureReason, message: string, status?: number): never {
  throw new DecodeFailure(
    status === undefined ? { ok: false, reason, message } : { ok: false, reason, message, status },
  );
}

interface Context {
  fetch: typeof globalThis.fetch;
  userAgent: string;
  signal: AbortSignal;
  callerSignal: AbortSignal | undefined;
  timeoutMs: number;
}

function abortFailure(ctx: Context): never {
  if (ctx.callerSignal?.aborted) fail("aborted", "aborted by caller");
  fail("timeout", `decode exceeded ${ctx.timeoutMs} ms`);
}

// Settles as soon as the signal aborts, even if the transport ignores the signal. This is what
// makes the timeout cover the whole decode whatever fetch is injected.
function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isConnectError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function isGoogleHost(hostname: string): boolean {
  return hostname === "google.com" || hostname.endsWith(".google.com");
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

async function send(ctx: Context, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await race(ctx.fetch(url, { ...init, redirect: "manual", signal: ctx.signal }), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) abortFailure(ctx);
      if (attempt === 0 && isConnectError(error)) continue;
      fail("network", `request to ${new URL(url).host} failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? error.message;
}

async function readBounded(ctx: Context, response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read(), ctx.signal);
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        reader.cancel().catch(() => {});
        fail("parse", `response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof DecodeFailure) throw error;
    reader.cancel().catch(() => {});
    if (ctx.signal.aborted) abortFailure(ctx);
    fail("network", `reading response failed: ${describe(error)}`);
  }
}

/**
 * GET or POST, following redirects by hand. Node's fetch sends no cookies, which matters: Google's
 * consent endpoint walls a client that replays the SOCS cookie it sets on the article's 302 (fork).
 * A hop to google.com/sorry is Google's unusual-traffic page, so it is reported as a rate limit
 * (upstream saw non-browser clients sent there).
 */
async function request(ctx: Context, url: string, init: RequestInit): Promise<string> {
  let current = url;
  let currentInit = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await send(ctx, current, currentInit);
    const { status } = response;
    if (REDIRECT_STATUSES.has(status)) {
      discard(response);
      const location = response.headers.get("location");
      if (!location) fail("http", `HTTP ${status} without a Location`, status);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        fail("http", `HTTP ${status} to an unusable Location`, status);
      }
      if (!isGoogleHost(next.hostname)) fail("http", `redirected off Google, to ${next.hostname}`, status);
      if (next.pathname.startsWith("/sorry")) fail("rate_limited", "redirected to google.com/sorry", status);
      if (status === 303 || ((status === 301 || status === 302) && currentInit.method === "POST")) {
        currentInit = { method: "GET", headers: { "User-Agent": ctx.userAgent } };
      }
      current = next.href;
      continue;
    }
    if (status === 429) {
      discard(response);
      fail("rate_limited", "HTTP 429", status);
    }
    if (status < 200 || status >= 300) {
      discard(response);
      fail("http", `HTTP ${status} from ${new URL(current).host}`, status);
    }
    return readBounded(ctx, response);
  }
  fail("http", `more than ${MAX_REDIRECTS} redirects`);
}

// Rate limits, timeouts and aborts end the decode; anything else tries the next candidate page.
const FINAL_REASONS = new Set<FailureReason>(["rate_limited", "timeout", "aborted"]);

async function fetchParams(ctx: Context, token: string, sourceUrl: string) {
  let last: DecodeFailure | undefined;
  for (const candidate of paramsUrls(token, sourceUrl)) {
    try {
      const html = await request(ctx, candidate, { method: "GET", headers: { "User-Agent": ctx.userAgent } });
      const params = parseParams(html);
      if (params) return params;
      last = new DecodeFailure({ ok: false, reason: "parse", message: "no signature on the article page" });
    } catch (error) {
      if (!(error instanceof DecodeFailure) || FINAL_REASONS.has(error.result.reason)) throw error;
      last = error;
    }
  }
  throw last;
}

function checkTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  return timeoutMs;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createDecoder(options: DecoderOptions = {}): Decoder {
  const defaultTimeout = checkTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const { cache } = options;

  async function decode(url: string, callOptions: DecodeOptions = {}): Promise<DecodeResult> {
    const token = articleToken(url);
    if (!token) return { ok: false, reason: "not_google_news", message: "not a Google News article URL" };
    const timeoutMs = checkTimeout(callOptions.timeoutMs ?? defaultTimeout);
    const cached = cache?.get(token);
    if (cached !== undefined) return { ok: true, url: cached };

    const callerSignal = callOptions.signal;
    const timeout = AbortSignal.timeout(timeoutMs);
    const ctx: Context = {
      // Resolved per call, not captured at creation, so a stubbed global fetch is honoured.
      fetch: options.fetch ?? globalThis.fetch,
      userAgent,
      signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
      callerSignal,
      timeoutMs,
    };
    try {
      if (ctx.signal.aborted) abortFailure(ctx);
      const { signature, timestamp } = await fetchParams(ctx, token, url);
      const body = await request(ctx, BATCHEXECUTE_URL, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: decodeRequestBody(token, signature, timestamp),
      });
      const decoded = parseDecoded(body);
      if (!decoded) fail("parse", "no publisher URL in the batchexecute response");
      cache?.set(token, decoded);
      return { ok: true, url: decoded };
    } catch (error) {
      if (error instanceof DecodeFailure) return error.result;
      throw error;
    }
  }

  async function decodeAll(urls: Iterable<string>, callOptions: DecodeAllOptions = {}) {
    const { delayMs = 0, signal } = callOptions;
    const results = new Map<string, BatchResult>();
    let stopped: string | undefined;
    let reachedNetwork = false;
    for (const url of urls) {
      if (results.has(url)) continue;
      if (!stopped && signal?.aborted) stopped = "aborted by caller";
      if (stopped) {
        results.set(url, { ok: false, reason: "skipped", message: stopped });
        continue;
      }
      const token = articleToken(url);
      const needsNetwork = token !== null && !cache?.has(token);
      if (needsNetwork && reachedNetwork && delayMs > 0 && !(await sleep(delayMs, signal))) {
        stopped = "aborted by caller";
        results.set(url, { ok: false, reason: "skipped", message: stopped });
        continue;
      }
      const result = await decode(url, callOptions);
      reachedNetwork ||= needsNetwork;
      results.set(url, result);
      if (!result.ok && result.reason === "rate_limited") stopped = "stopped after a rate limit";
      if (!result.ok && result.reason === "aborted") stopped = "aborted by caller";
    }
    return results;
  }

  return { decode, decodeAll };
}

/** One decode with a throwaway decoder. Holds no state between calls. */
export function decode(url: string, options: DecoderOptions & DecodeOptions = {}): Promise<DecodeResult> {
  return createDecoder(options).decode(url, options);
}

/** Whether `url` is a Google News article URL this library can decode. Pure, no I/O. */
export function isGoogleNewsUrl(url: string): boolean {
  return articleToken(url) !== null;
}
