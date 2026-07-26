# Ex-Plannotator is a feature-flagged mode of the official editor, with extraction seams to cap merge cost

Date: 2026-07-26

Status: Accepted. Supersedes [0001-separate-ex-plannotator-package.md](./0001-separate-ex-plannotator-package.md).

## Context

ADR 0001 promised Ex-Plannotator would "not modify or register through the Official Plannotator
app". Since commit `9647665` ("ship rich Plan review editor") that has not been true, and the gap
only widened:

- The live message review UI is feature-flag branches inside the official plan editor
  (`packages/editor/App.tsx` and shared `packages/ui` components), not a separate app.
- The committed Pi-extension browser bundle **is** the official hook build. Every official surface
  built from this fork ships the live-pane / Ex AI code — inert when the flags are off, but shipped.
- The thin-wrapper apps the ADR implied (`apps/ex-review`, `apps/ex-plan-review`) are dead code or
  deleted; nothing builds or serves them since `9647665`.

The measured cost of the drift (custom-surface review, 2026-07, finding #7): the custom footprint
inside upstream's 6,062-line `packages/editor/App.tsx` is **~2,180 insertions across 269 hunks**,
paid again as conflict cost at every upstream sync — the single largest merge-cost item in the
fork. `packages/ui/components/sidebar/MessagesBrowser.tsx` (+681/−156, 57 hunks) and
`packages/ui/components/CommentPopover.tsx` (+430/−46, 48 hunks) are #2 and #3.

Two coherent paths existed: (a) supersede the ADR and invest in extraction seams to cap merge
cost, or (b) re-honour separation by rebuilding a thin wrapper over `@plannotator/ui` public
seams. The captain decided (a) on 2026-07-26.

## Decision

Accept the architecture the code is already on: **Ex-Plannotator's live review is a
feature-flagged mode of the official Plannotator editor**, sharing the official build and bundle.
We state plainly what this means: official surfaces built from this fork ship the custom
live-pane / Ex AI code inert; there is no separate Ex-Plannotator browser app.

In exchange, we cap the merge cost by extracting the custom code behind captain-owned seams so
upstream files carry only mount-point-sized hunks. The concrete, dispatchable plan is
[docs/extraction-seams-plan.md](../extraction-seams-plan.md):

1. Extract the live-review orchestration out of `App.tsx` into a captain-owned
   `packages/editor/live/` module (`useLiveMessageReview()` + a composition component).
2. Split a captain-owned `LiveTranscriptBrowser` so upstream's `MessagesBrowser.tsx` returns to
   near-pristine.
3. Collapse `CommentPopover.tsx`'s five woven-in features behind one `composerExtensions` prop.

The already-extracted pure helpers (`packages/editor/liveMessageScope.ts`, `liveCaptainEcho.ts`,
`livePaneChips.ts`, each with tests) are the model: new live-pane features land in captain-owned
modules, never as another hunk in an upstream file.

## Consequences

- The rule ADR 0001 stated is replaced by a weaker but honest one: custom code MAY live in
  upstream files, but only as mount-point-sized seams (a flag, a hook call, a component mount, an
  optional prop). Stateful logic and JSX bodies belong in captain-owned modules under
  `packages/editor/live/` or equivalently scoped locations.
- Upstream syncs remain a fact of life for the seam hunks; the extraction plan bounds them to a
  size where a conflict is a mechanical re-apply, not a re-derivation.
- The dead thin-wrapper `apps/ex-review` no longer represents an intended future and can be
  removed in a cleanup pass (tracked in the review's findings; not part of this ADR).
- Shared-package fork points that silently change upstream behavior or published seams are debt
  under this ADR too — the plan lists the known ones with per-item recommendations.

## Open decision (deliberately not answered here)

Whether to offer the host-agnostic `review.ts` session refactor and pathspec threading **upstream
as a PR**. Doing so would convert that slice of fork debt to zero, but engaging upstream is the
captain's call. Registered as a captain hold; this ADR does not presume the answer.
