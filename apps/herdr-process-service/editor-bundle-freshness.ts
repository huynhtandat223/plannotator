/**
 * Is the editor bundle we are about to serve actually built from this checkout?
 *
 * This service serves a prebuilt, gitignored single-file bundle
 * (`apps/ex-pi-extension/ex-plannotator.html`). Nothing in the request path
 * consults the source tree, so pulling new UI work and restarting the service
 * looks exactly like a deploy and changes nothing at all: the process re-reads
 * the same old HTML off disk and the browser keeps rendering the previous UI.
 *
 * That is not hypothetical — it is how a shipped left-rail control came to be
 * missing from a running instance whose source was three merges ahead of the
 * bundle it was serving. A restart is not a build; only `bun run build:ex-pi`
 * is. So compare the two and say so before anyone goes looking for the bug in
 * the source.
 *
 * Warn, never refuse: a source checkout is edited constantly and a hard failure
 * would take a captain's running instance down over an ordinary save.
 */

export type EditorSourceStamp = { path: string; mtimeMs: number };

export type EditorBundleFreshness =
  | { state: "fresh" }
  /** No bundle, or no source tree to compare against — nothing to claim. */
  | { state: "unknown" }
  | { state: "stale"; bundleMtimeMs: number; source: EditorSourceStamp };

/**
 * A bundle is stale when any source it is built from is newer than it.
 *
 * mtime is the right signal precisely because of how the failure happens: a
 * `git pull` (or a checkout, or an edit) rewrites the changed source files with
 * a current mtime and never touches the gitignored artifact. Equal timestamps
 * count as fresh — a build writes the artifact last.
 */
export function describeEditorBundleFreshness(input: {
  bundleMtimeMs: number | null;
  newestSource: EditorSourceStamp | null;
}): EditorBundleFreshness {
  const { bundleMtimeMs, newestSource } = input;
  if (bundleMtimeMs === null || newestSource === null) return { state: "unknown" };
  if (newestSource.mtimeMs <= bundleMtimeMs) return { state: "fresh" };
  return { state: "stale", bundleMtimeMs, source: newestSource };
}

/**
 * The operator-facing sentence. Names the newer file and the command, because
 * the whole point is to stop the next person debugging source that the browser
 * has never seen.
 */
export function formatStaleEditorBundleWarning(
  freshness: EditorBundleFreshness,
  format: (mtimeMs: number) => string,
): string | null {
  if (freshness.state !== "stale") return null;
  return [
    `⚠  Serving a STALE editor bundle: apps/ex-pi-extension/ex-plannotator.html was built ${format(freshness.bundleMtimeMs)},`,
    `   but ${freshness.source.path} changed ${format(freshness.source.mtimeMs)}.`,
    `   Restarting this service does not rebuild it — the browser will keep showing the older UI.`,
    `   Rebuild with: bun run build:ex-pi`,
  ].join("\n");
}
