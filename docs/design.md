# Design

2026-09-23. Stale by default: check the code before trusting a claim here.

## Scope

A client library, not a service. One job: Google News article URL in, publisher URL or a typed failure out.

Out of scope, on purpose:

- **Batched RPC** (many decodes in one POST). The fork has it; see "Not done yet".
- **Proxies, custom TLS, retries beyond connect.** Inject a `fetch` for any of these.
- **Logging and metrics.** A library that logs picks your log format for you. Every result carries `reason` and a `message` that is safe to log, and the caller counts them.
- **Scheduling and pacing policy** beyond `delayMs`. The caller knows its budget; the library doesn't.

## Requirements

Functional: decode `/rss/articles/`, `/articles/`, `/read/`; tell every failure apart (`not_google_news`, `rate_limited`, `http`, `network`, `timeout`, `aborted`, `parse`); a batch helper keyed by input URL.

Non-functional, in the order they decided things:

1. **Spend as little of the per-IP budget as possible.** Google's limit acts like a daily budget per address. It is not a rate that recovers with backoff; that comes from the fork's probes, which this port didn't re-measure. Every other choice gives way to this one.
2. **Bounded time.** One deadline for the whole decode, enforced even against a transport that ignores its signal.
3. **Bounded memory.** 32 MB cap on each decoded response, read as a stream.
4. **Fail loud, never wrong.** A parse failure beats a plausible wrong URL.
5. **No shared state.** Two decoders, or two calls, can't affect each other unless you pass them the same cache.

## Estimates

The consumer does 10 to 30 decodes a day from one IP.

| | per decode | per day at 30 |
|---|---|---|
| requests | 2 (article page + RPC); 3 to 4 when the first page fails | 60 to 120 |
| bytes on the wire | ~120 KB page gzipped (measured 122,428 on the recorded page) + ~0.3 KB RPC | ~3.7 MB |
| decoded in memory | ~594 KB page, transient | one at a time |
| wall time | ~1 s (the live smoke test, including one feed fetch) | ~30 s plus `delayMs` pauses |

There is no storage and no server. The optional cache is a `Map` of token to URL, a few hundred bytes an entry: 30 a day for a year is ~11k entries, a few MB. Hardware sizing doesn't come into it; the per-IP budget runs out long before CPU, memory or bandwidth do.

## Protocol

HTTPS through `fetch` (undici in Node, which keeps connections alive by default). There is no alternative: the endpoint is Google's, and so is the protocol, an undocumented form-encoded `batchexecute` RPC. The fork measured connection pooling as a possible but unproven help to the budget (p = 0.22), so this port doesn't manage connections itself.

Redirects are followed by hand (`redirect: "manual"`) so that each hop is checked. A hop may only go to `google.com` or a subdomain, and `/sorry` means refused. Node's fetch keeps no cookies, and that matters: replaying the consent cookie is what gets a client walled.

## Architecture

```
decode(url)
  articleToken ─ pure; not_google_news, no request
  cache? ─────── hit: done
  fetchParams ── GET /rss/articles → GET /articles  (next page only on http/network/parse)
  request ────── manual redirects, 429/sorry → rate_limited, bounded read
  send ───────── fetch raced against the deadline; one retry on connect failure
  POST batchexecute → parseDecoded → isPlausibleUrl
```

`protocol.ts` is pure (strings in, strings out). `decoder.ts` holds all the I/O and every policy decision.

**Single point of failure: Google's undocumented contract.** Any change to the page attributes, the RPC envelope or the response framing breaks every decode, and no amount of replication helps. Everything else follows from that:

- **Detection belongs to the caller.** Alert when `attempted > n` and `ok == 0`, or when the share of `parse` failures jumps. The Python version shipped a malformed envelope and resolved zero links for 25 days with nobody noticing. Distinct reasons exist so that breakage and throttling can't be mistaken for each other.
- **Walled exits are covered.** The fork's harness runs this package's `decode()` on VPN exits (`probes/walled_ts.py`, Node 24 and 26). On 2026-09-23 it decoded on 7 of 8 walled rows, with no `parse` failures. One decode through a slow exit took 28 s, above the 15 s default. The live smoke test decodes in about 1 s from the development machine's own connection, one measurement and not a survey, so the default stands; a caller behind a slow proxy or exit should raise `timeoutMs`.
- **The live smoke test** (`npm run test:live`) is the check for when that alert fires. It is not in CI: a shared runner IP spends someone else's budget and would flake.
- **Recovery is a fixture update:** record a new decode and adjust `protocol.ts`. The pure layer is where changes land.

## Security

- **SSRF:** requests go only to `news.google.com` and redirects only to `*.google.com`. The token is limited to `[A-Za-z0-9_-]`, ≤ 8192 characters, before it is placed in a URL.
- **Output:** the decoded URL must parse as http(s) with a host and contain no control characters, since callers put it in HTML, headers and logs.
- **Input to the RPC:** built with `JSON.stringify`, so a hostile signature can't escape its string.
- **Resource exhaustion:** the response cap, the redirect cap (10) and the deadline.
- **Logs:** `message` never includes the article URL or token.
- **Supply chain:** zero runtime dependencies. Publishing uses npm trusted publishing (OIDC, no stored token) with provenance. Dependabot proposes bumps for dev dependencies and Actions.

## Idempotency and retries

Both requests are reads as far as Google's state goes. They aren't free, though: each one spends budget. So the rule isn't "retry what's idempotent" but "retry only what can't have arrived". A failed connect can't have arrived. A reset or a read timeout may have, and the fork measured a stalled request being delivered twice. A 429 isn't retried either: backoff doesn't recover the budget.

## Testing and CI

- Offline by default. A stub global `fetch` fails any test that forgets to inject one, and a guard test checks that the stub is in place.
- Contract tests for every `reason`, the whole-decode deadline, abort vs timeout, retry-once, the cache and batch keying.
- Mutation-checked once by hand (2026-09-23). 15 of 16 mutations were caught; the survivor, a tag pre-filter in `parseParams`, doesn't change behaviour.
- CI on Node `lts/*` and `current`, monthly as well to catch toolchain drift. Release on a `v*` tag, checking that the tag matches `package.json`.

## API lifecycle

Semver. The public contract is the exported types, the `reason` union, `status` and the option names. It does **not** cover `message` text.

- **Breaking (major):** removing or renaming a reason, option or export; a new `reason`, because it breaks exhaustive `switch`es in TypeScript; changing a default in a way that spends more budget.
- **Minor:** new options with no-op defaults, new exports.
- While in 0.x, breaking changes land on a minor bump, as semver allows. Each one gets a CHANGELOG entry.
- No SDK generation or API docs site. The `.d.ts` files and the README are the docs, and there is one language.

## Not done yet

- **Batched RPC.** One POST for N decodes, results keyed by the tag sent with each, never by position; the fork measured Google reordering them. Measured 2026-09-23 with the fork's VPN harness (`probes/post_budget.py`): 1,200 POSTs across four exits drew no 429, addresses refusing GETs kept serving POSTs, and 300 POSTs left GET budgets in the usual range. So a POST costs well under a GET; whether it costs anything the variance between addresses hides. Batching therefore saves N−1 round trips of latency and little or no budget, since the article GETs are one per URL either way. Not worth its batch-level deadline and partial-failure rules at 30 decodes a day.
