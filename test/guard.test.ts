import { expect, it } from "vitest";
import { decode } from "../src/index.ts";
import { SOURCE_URL } from "./helpers.ts";

// Negative control for the offline guard: with no injected fetch the default transport must be the
// guard, which surfaces as a network failure, not a success from a real request.
it.skipIf(process.env.GNEWS_LIVE === "1")("the default transport is blocked offline", async () => {
  expect(await decode(SOURCE_URL)).toMatchObject({ ok: false, reason: "network" });
});
