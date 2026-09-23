# gnews-decoder

Turns a Google News link (`news.google.com/rss/articles/…`, `/articles/…`, `/read/…`) into the publisher's URL, so you can link to the article and not to Google. Every failure comes back as a value you can branch on. A rate limit is its own case, so a batch can stop before it burns the rest of your IP's daily budget. The existing npm package, `google-news-url-decoder` 1.2.2, has no timeout, reports a 429 only as message text, and pairs batch results with inputs by position, though Google answers in arbitrary order.

- **Whole-decode timeout.** One `timeoutMs` covers both article pages, every redirect, the retry and the RPC, including a transport that ignores its `AbortSignal`. Pass your own `signal` too; `timeout` and `aborted` are separate results.
- **Structured results.** `{ ok: true, url }` or `{ ok: false, reason, status?, message }`. Expected failures never throw.
- **Rate limits end the decode.** A 429, or a redirect to `google.com/sorry`, returns `rate_limited` at once, without trying the second article page.
- **One retry, connect only.** A failed connect (`ECONNREFUSED`, DNS, connect timeout) is retried once. A request that may have reached Google is never sent twice.
- **No hidden state.** No module-level cache or counters. A cache is a `Map` you pass in, and it only ever holds successes.
- **Keyed batches.** `decodeAll` returns a `Map` keyed by input URL, paces with `delayMs`, and skips the rest after a rate limit.
- **Small.** Zero runtime dependencies, ESM-only, Node 24+. Offline tests replay one real recorded decode.

## Example

```ts
import { createDecoder } from "gnews-decoder";

const decoder = createDecoder({ timeoutMs: 15_000 });

await decoder.decode("https://news.google.com/rss/articles/CBMiswFBVV95cUxP…");
// { ok: true, url: "https://www.reuters.com/world/middle-east/hope-progress-after-us-iran-hold-first-shuttle-talks-months-2026-09-23/" }

await decoder.decode("https://www.reuters.com/world/");
// { ok: false, reason: "not_google_news", message: "not a Google News article URL" }

// once your IP is throttled
// { ok: false, reason: "rate_limited", status: 429, message: "HTTP 429" }
```

A batch:

```ts
const results = await decoder.decodeAll(urls, { delayMs: 1_500, signal });
// Map { "https://news.google.com/rss/articles/…" => { ok: true, url: "…" }, … }
```

## Getting started

> Not on npm yet. Until the first release, install from GitHub.

```sh
npm install github:SeanLF/gnews-decoder   # after release: npm install gnews-decoder
```

Needs Node 24 or later; CI runs the active LTS and the current release. No other setup: no API key, no config.

## API

### `createDecoder(options?) => Decoder`

| option | default | |
|---|---|---|
| `fetch` | `globalThis.fetch` | the transport; inject one for tests or a proxy |
| `timeoutMs` | `15000` | budget for one whole decode |
| `userAgent` | a desktop Chrome UA | |
| `cache` | none | a `Map<string, string>` of token to URL. Successes only; a failure is never stored |

### `decoder.decode(url, { signal?, timeoutMs? }) => Promise<DecodeResult>`

```ts
type DecodeResult =
  | { ok: true; url: string }
  | { ok: false; reason: FailureReason; status?: number; message: string };
```

| `reason` | when | `status` |
|---|---|---|
| `not_google_news` | not a decodable Google News URL; no request made | |
| `rate_limited` | HTTP 429, or a redirect to `google.com/sorry` | 429 or the redirect's |
| `http` | any other non-2xx, a redirect off Google, too many redirects | yes |
| `network` | connect failed twice, the connection dropped, a read failed | |
| `timeout` | `timeoutMs` ran out | |
| `aborted` | your `signal` fired | |
| `parse` | no signature on either article page, or no URL in the RPC answer | |

`message` is for logs. It never includes the article URL.

A bad `timeoutMs` (zero, negative, `NaN`) throws a `RangeError`: that's a bug in the caller, not an expected case.

### `decoder.decodeAll(urls, { signal?, timeoutMs?, delayMs? }) => Promise<Map<string, BatchResult>>`

Decodes serially. Results are keyed by input URL, never by position; duplicates collapse. `delayMs` pauses only between decodes that reach the network. The batch stops at the first `rate_limited` or `aborted`; the rest come back `{ ok: false, reason: "skipped" }`. `timeoutMs` applies per decode.

### `decode(url, options?)` and `isGoogleNewsUrl(url)`

`decode` is `createDecoder(options).decode(url, options)` with a throwaway decoder. `isGoogleNewsUrl` is the pure URL check.

## Rate limits

Google limits by IP, and it behaves like a daily budget rather than a rate: backing off and retrying doesn't recover it. So:

- a 429 on the first article page ends the decode; the second candidate page isn't tried, since that would spend more of a budget that's already gone
- nothing is retried except a failed connect (`ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN`, `ENOTFOUND`, undici's connect timeout). A request that may have reached Google (a reset, a read timeout) is never sent twice
- `decodeAll` stops the batch on the first rate limit

Pacing is yours: `delayMs` on `decodeAll`, or your own loop around `decode`.

## Stability

Semver. `reason` values, `status`, option names and exports are the contract. `message` text is not. A new `reason` counts as breaking, because it breaks exhaustive `switch`es. Design notes, estimates and the threat model are in [`docs/design.md`](docs/design.md).

## Development

```sh
npm test            # offline; a stub fetch fails any test that forgets to inject one
npm run test:live   # GNEWS_LIVE=1: one feed fetch and one real decode. Never in CI
npm run lint && npm run typecheck && npm run build
```

Fixtures in `test/fixtures/` are one real decode recorded on 2026-09-23. Script and style bodies were stripped from the article page because they carry session tokens.

Releases: `npm version <patch|minor|major> && git push --follow-tags`. The release workflow publishes from the tag through npm trusted publishing, with provenance.

## Credits

A port of [SeanLF/google-news-url-decoder](https://github.com/SeanLF/google-news-url-decoder), branch `v0.2-protocol-transport-split`, itself a fork of [SSujitX/google-news-url-decoder](https://github.com/SSujitX/google-news-url-decoder) (`googlenewsdecoder` on PyPI) by Sujit Biswas. Both are MIT.

From the fork:

- the protocol as pure functions, with the I/O kept separate
- `/rss/articles` first (the smaller page), then `/articles`; locale sent up front to save a redirect
- signature and timestamp read off the *same* element, in either order, ignoring comments and scripts
- the three-level RPC nesting, and two different answers treated as a failure, not a guess
- connect-only retry; no cookies across redirects (Google's consent wall); a cap on decoded response size; a bound on token length
- validating the result as an http(s) URL without control characters

From upstream 0.2.1:

- taking `hl`/`gl`/`ceid` from the source URL when it has them
- building the RPC payload with a JSON serialiser instead of string interpolation
- stripping the `)]}'` guard explicitly when parsing the RPC answer
- the observation that non-browser clients get redirected to `google.com/sorry`, Google's unusual-traffic page. Reporting that as `rate_limited` is this port's inference, not something either upstream measured

Not taken: upstream's fallback that matches batch results by position when IDs are missing.

Not ported: the fork's batched RPC (many decodes in one POST), the async variant (every call here is async), proxy support (inject a `fetch` that uses one) and the probe harness.
