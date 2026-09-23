// Offline by default: a test that forgets to inject a fetch fails here instead of reaching Google
// and spending the address's budget. The live smoke test opts out with GNEWS_LIVE=1.
if (process.env.GNEWS_LIVE !== "1") {
  globalThis.fetch = () => Promise.reject(new Error("network disabled in tests; inject a fetch"));
}
