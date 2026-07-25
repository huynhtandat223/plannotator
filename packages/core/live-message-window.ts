/**
 * Single source of truth for the Ex-Plannotator live message window.
 *
 * The live Herdr pane picker is a per-pane quota: each pane keeps a floor of
 * visible assistant-response history regardless of how noisy its neighbours
 * are. Historically four different numbers governed this — the extension
 * snapshot cap (4), the extension registration cap (5), a 25-slice in the
 * extension host, and a UI selector that offered 10/All the host could never
 * satisfy. Those disagreeing caps made the 10/All options silently inert.
 *
 * Everything now reads from {@link LIVE_MESSAGE_RETENTION}: the extension
 * retention slices, the server's 400-rejection bound, and the UI option
 * ceiling. Keeping them anchored to one constant is what prevents the caps
 * from drifting apart again.
 */

/**
 * Finalized assistant responses retained per live pane, end to end.
 *
 * Published `text` is deliberately kept FULL at every retention slice. It is
 * not a display-only field: the editor builds the annotatable document body
 * from it (packages/editor/App.tsx:336,363) and the server derives delivered
 * feedback quotes from it (apps/herdr-process-service/server.ts:918), while
 * the live host disables refetch-on-selection (server.ts:2798). With no
 * rehydration path, truncating a non-selected message's text would silently
 * hand the reviewer a stub to annotate and send truncated quotes back to Pi.
 */
export const LIVE_MESSAGE_RETENTION = 20;
