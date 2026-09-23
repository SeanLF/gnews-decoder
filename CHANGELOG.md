# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). What counts as breaking is set out under
"Stability" in the README.

## [Unreleased]

First release, not yet cut. A TypeScript port of the `googlenewsdecoder` Python package, by way of
[SeanLF/google-news-url-decoder](https://github.com/SeanLF/google-news-url-decoder).

### Added

- `createDecoder()`, with `decode()` for one URL and `decodeAll()` for a batch keyed by input
  URL, paced by `delayMs`, stopping at the first rate limit, and reporting each result to an
  `onResult` callback as it lands (for progress, or a job runner's heartbeat).
- `decode()` and `isGoogleNewsUrl()` for one-off use.
- Structured results: `{ ok: true, url }` or `{ ok: false, reason, status?, message }`, with
  reasons `not_google_news`, `rate_limited`, `http`, `network`, `timeout`, `aborted` and `parse`.
  `decodeAll` adds `skipped`.
- One deadline for the whole decode (`timeoutMs`, default 15 s), plus an `AbortSignal`; the
  deadline holds even when an injected `fetch` ignores its signal.
- A single retry of a failed connect, and of nothing that may have reached Google.
- An injectable `fetch`, and an opt-in cache that is a `Map` you own and that stores successes
  only.
- Support for `/rss/articles/`, `/articles/` and `/read/` URLs, with the source URL's locale
  carried to the article page.

### Security

- Requests go only to `news.google.com`, and redirects only to `google.com` and its subdomains. The article token
  is limited in characters and length, the decoded URL must be http(s) with a host and no control
  characters, and responses are capped at 32 MB decoded.
- Zero runtime dependencies. The first release is built, tested and published by hand, because
  npm trusted publishing needs the package to exist. Later releases are built by CI with no
  credential, staged through trusted publishing, and go live only on a maintainer's 2FA approval.
