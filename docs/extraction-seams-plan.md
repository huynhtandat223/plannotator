# Extraction-seams plan: capping the fork's merge cost

Companion to [ADR 0002](./adr/0002-feature-flagged-official-editor.md). That ADR accepts the
feature-flagged official-editor architecture; this document is the concrete plan for the
extractions that make the acceptance affordable. Evidence (hunk counts, line anchors) comes from
the 2026-07 custom-surface review, findings #7/#8 and §2; line anchors were re-verified against
`main` at `a0ddcd9`.

**Status: planned, not performed.** Each extraction is a separate PR. They are large, they will
conflict with in-flight live-pane work, and each deserves its own review. Do not batch them with
feature work.

**Ordering:** 1 → 2 → 3. Extraction 1 unblocks easier testing of live-review logic and removes
the biggest conflict surface first; 2 and 3 are independent of each other and can run in
parallel once 1 has landed (they touch disjoint files).

**Acceptance bar shared by all three:** after the extraction, the upstream file's remaining
custom hunks are mount-point-sized — a flag, one hook call, one component mount, or one optional
prop — such that an upstream sync conflict is a mechanical re-apply. Behavior is unchanged
(feature flags off ⇒ byte-identical rendering; flags on ⇒ same UX), verified by the existing
test suites plus new hook/component tests that move with the code.

## Extraction 1 — `packages/editor/live/`: the live-review orchestration out of `App.tsx`

**Evidence:** ~2,180 insertions across **269 hunks** in upstream's 6,062-line
`packages/editor/App.tsx` (measured by summing per-commit numstat, sync commits excluded). The
largest single merge-cost item in the fork. 65 occurrences of `liveMessageReview` alone.

**What moves** (current anchors on `a0ddcd9`):

- Live-review state block — `App.tsx:679-747` (`liveMessageReview`, reload-on-selection,
  read-only mode, round status, lock derivation).
- SSE wiring — `App.tsx:3036-3061`.
- `applyLiveReviewSnapshot` — `App.tsx:1484-1571` (snapshot application incl. the
  reload-on-selection trigger).
- Reconcile logic and selection handling threaded through `handleSelectMessage`.
- Ex AI block — `App.tsx:4230-4314` (`exAIIdentity`, eligibility, chat panel wiring).
- Live JSX interleaved through the main return — `App.tsx:5072-5140` (pane chips row, handoff
  warning, transcript wiring, Ex AI panel).

**Target shape:**

- `packages/editor/live/useLiveMessageReview.ts` — one hook owning state + SSE subscription +
  snapshot application + reconcile. Returns a single object App.tsx consumes.
- `packages/editor/live/LiveReviewSurface.tsx` (name flexible) — composition component(s) for
  the live JSX, so the main return gains one conditional mount instead of interleaved blocks.
- The existing pure helpers (`liveMessageScope.ts`, `liveCaptainEcho.ts`, `livePaneChips.ts`,
  `liveActivityTrail.ts`, `liveActivityChip.ts`) stay where they are; the hook composes them.
- `App.tsx` keeps: the feature-flag detection, one `useLiveMessageReview()` call, one
  `<LiveReviewSurface …/>` mount, and the handful of props it must thread into upstream
  components (which extraction 2/3 then shrink further).

**Bonus fixes to fold into the same PR** (they are properties of the moved code):

- Whole-App re-render per accepted 2 s frame: nothing below App is memoized except `AppHeader`,
  whose memo is defeated by inline lambdas at `App.tsx:4933,4965,4968-4970`. Memoize the
  extracted surface and stabilize those callbacks.
- Latent identity bug: `liveSourceIdentity` (`App.tsx:4133-4144`) memoizes on an object re-found
  fresh from `recentMessages` every frame — one `useEffect([createSession])` away from
  re-creating the 88 req/s loop the `exAIIdentity` comment at `:4247-4250` memorializes. Derive
  primitives first, like the correct pattern at `:4251-4256`.

**Effort:** L. Touches shared upstream files, but strictly to shrink their footprint.

## Extraction 2 — captain-owned `LiveTranscriptBrowser`; restore upstream `MessagesBrowser`

**Evidence:** `packages/ui/components/sidebar/MessagesBrowser.tsx` is a de-facto fork:
**+681/−156 cumulative churn across 57 hunks** on a 634-line file. The
chronological/chatLayout/echo/auto-scroll machinery now dwarfs upstream's picker. #2 on the
merge-cost table.

**Plan:** split a captain-owned `LiveTranscriptBrowser` in `packages/editor` (it is only used by
the live surface) that reuses the already-exported pure helpers, and restore upstream's
`MessagesBrowser.tsx` to near-pristine picker behavior. Retention (`LIVE_MESSAGE_RETENTION`),
`+N more` paging, and jump-to-latest move with the transcript component.

**Known behavior bugs to fix in the move** (properties of the forked code):

- Scroll anchoring compensates `scrollTop` on a prepend-at-top assumption, which is inverted for
  the append-at-bottom chat transcript — a mid-history reader is shifted by each new row;
  bottom-pinned following works by accident (`MessagesBrowser.tsx:222-230, 321-334`).
- Render-phase ref assignment (`MessagesBrowser.tsx:568`).

**Effort:** M. Depends on extraction 1 only for a clean mount point; logically independent.

## Extraction 3 — `CommentPopover` behind one `composerExtensions` prop

**Evidence:** `packages/ui/components/CommentPopover.tsx` carries **+430/−46 across 48 hunks**:
five features woven in — file mentions, Pi command autocomplete, the module-level draft store
(`CommentPopover.tsx:87`), option pick-list, direct send. Each is an optional-prop seam
individually, but the density makes every upstream composer change a conflict. #3 on the
merge-cost table, and still accreting (4 of the last 8 PRs touched it).

**Plan:** collapse the five features into a single optional `composerExtensions` prop — an
object/slot the live surface (extraction 1's module) constructs and passes in. Upstream's file
keeps one prop declaration and one render/dispatch site; future composer features add zero
upstream hunks. The draft-store keying (`live:<paneId>:<piSessionId>`) and any sessionStorage
mirroring (review finding #10) live on the captain side of the seam.

**Effort:** M. Independent of extraction 2.

## Shared-package fork points to shim now (cheap now, expensive later)

From review §2, "Shared-package fork points" — each with a recommendation:

1. **`packages/shared/gitbutler-core.ts` — default `STATUS_CACHE_MS` silently changed
   1000→5000.** The later env override (`PLANNOTATOR_GITBUTLER_STATUS_CACHE_MS`) is fine; the
   default change is an unmarked upstream-behavior fork. *Recommendation:* revert the default to
   upstream's 1000 and set 5000 via configuration/env where the fork needs it — or, if 5000 is
   genuinely wanted as the fork's default, isolate it as a clearly-marked one-line constant
   override so syncs see one intentional hunk, and document it in CLAUDE.md's env table (which
   currently states 5000 as if upstream's).
2. **`packages/shared/workspace-status.ts` — private `parseNumstat` renamed to exported
   `parseGitNumstat`.** Every upstream touch of that function now conflicts on the name.
   *Recommendation:* restore the upstream-private name in place and add a one-line export shim
   (`export const parseGitNumstat = parseNumstat`) so the upstream hunk disappears and the
   fork's callers keep their import.
3. **`packages/ai/endpoints.ts:63-76` (seam now at `:90`) — changed the published `getCwd` seam
   signature** (`getCwd?: (requestedCwd?: string) => string | Promise<string>`). This is a
   published-package API fork. *Recommendation:* keep upstream's signature and layer the fork's
   requested-cwd validation as a wrapper on the captain side of the seam; if the widened
   signature is genuinely better, that is exactly the kind of change to fold into the upstream-PR
   decision below rather than carry silently.
4. **Captain-new files inside published packages** (`ui/components/sidebar/GitChangesBrowser`,
   `ui/components/sidebar/CaptainEchoRow`, `core/live-message-window`, `core/file-mention`,
   `shared/context-handoff-threshold`) grow the
   public `@plannotator/ui` / `@plannotator/core` surface. Zero conflict cost. *Recommendation:*
   move the ones that survive extractions 1–3 under a captain-scoped subpath (or into
   `packages/editor`) so the published API surface stays upstream's; no urgency.

## Open decision (captain hold — not answered here)

**Offer the host-agnostic `review.ts` session refactor + pathspec threading upstream as a PR?**
Landing it upstream converts that slice of fork debt (in `packages/server/review.ts` /
`packages/shared/review-core.ts`) to zero and would also be the natural vehicle for fork point 3 above. Cost:
engaging upstream, review latency, and committing to upstream's API expectations. This is the
captain's call on whether to engage upstream at all; registered as a hold, and no extraction
above depends on its answer.
