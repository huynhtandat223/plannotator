/**
 * The failure this guards is the one that actually reached a captain: source
 * three merges ahead of the bundle being served, a restart that looked like a
 * deploy, and a shipped control that was simply not in the HTML the browser
 * received. Unit tests all passed, because the code under test was never the
 * code on screen.
 */

import { expect, test } from "bun:test";
import {
  describeEditorBundleFreshness,
  formatStaleEditorBundleWarning,
} from "./editor-bundle-freshness";

const JUL_28 = Date.parse("2026-07-28T23:21:00Z");
const JUL_29 = Date.parse("2026-07-29T17:47:00Z");

test("a bundle older than its sources is stale, and names the newer file", () => {
  const freshness = describeEditorBundleFreshness({
    bundleMtimeMs: JUL_28,
    newestSource: { path: "packages/editor/App.tsx", mtimeMs: JUL_29 },
  });
  expect(freshness).toEqual({
    state: "stale",
    bundleMtimeMs: JUL_28,
    source: { path: "packages/editor/App.tsx", mtimeMs: JUL_29 },
  });
});

test("a bundle built after its sources is fresh", () => {
  expect(
    describeEditorBundleFreshness({
      bundleMtimeMs: JUL_29,
      newestSource: { path: "packages/editor/App.tsx", mtimeMs: JUL_28 },
    }),
  ).toEqual({ state: "fresh" });
});

test("a build writes the artifact last, so equal timestamps are fresh", () => {
  expect(
    describeEditorBundleFreshness({
      bundleMtimeMs: JUL_29,
      newestSource: { path: "packages/ui/theme.css", mtimeMs: JUL_29 },
    }),
  ).toEqual({ state: "fresh" });
});

test("nothing to compare means nothing is claimed", () => {
  // An installed package has no source tree beside it, and a checkout that has
  // never built has no artifact. Neither is a staleness report.
  expect(
    describeEditorBundleFreshness({ bundleMtimeMs: JUL_29, newestSource: null }),
  ).toEqual({ state: "unknown" });
  expect(
    describeEditorBundleFreshness({
      bundleMtimeMs: null,
      newestSource: { path: "packages/editor/App.tsx", mtimeMs: JUL_29 },
    }),
  ).toEqual({ state: "unknown" });
});

test("the warning tells the operator what to run, not just that something is off", () => {
  const warning = formatStaleEditorBundleWarning(
    describeEditorBundleFreshness({
      bundleMtimeMs: JUL_28,
      newestSource: { path: "packages/editor/App.tsx", mtimeMs: JUL_29 },
    }),
    mtimeMs => new Date(mtimeMs).toISOString(),
  );
  expect(warning).toContain("STALE");
  expect(warning).toContain("ex-plannotator.html");
  expect(warning).toContain("packages/editor/App.tsx");
  // The whole point: a restart is not a build.
  expect(warning).toContain("bun run build:ex-pi");
  expect(warning).toContain("2026-07-28");
  expect(warning).toContain("2026-07-29");
});

test("fresh and unknown say nothing at all", () => {
  const format = (mtimeMs: number) => new Date(mtimeMs).toISOString();
  expect(formatStaleEditorBundleWarning({ state: "fresh" }, format)).toBeNull();
  expect(formatStaleEditorBundleWarning({ state: "unknown" }, format)).toBeNull();
});
