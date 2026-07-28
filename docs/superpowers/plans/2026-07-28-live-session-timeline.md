# Live Session Timeline Implementation Plan

> **For agentic workers:** Implementation workers MUST use the local `tdd` skill unless a task records a user-approved exception. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Agent Response surface own session-scoped two-sided history without incoming frames navigating the captain.

**Architecture:** Add a live-only session reducer keyed by Pi session (or waiting pane), then compose a compact session switcher and a session-projected `MessagesBrowser` timeline in the Agent Response area. The existing selected assistant message remains annotation state; browser-local captain echoes join only its session timeline.

**Tech Stack:** React, TypeScript, Bun tests, Tailwind CSS, existing `MessagesBrowser` and sidebar sheet primitives.

## Global Constraints

- `activeSessionKey` and selected assistant response remain independent state.
- Incoming frames update cached timelines/unread only; explicit captain actions navigate except active-session removal.
- Preserve direct text Send and response-bound image feedback behavior from PRs #32/#34.
- Do not restore the separate live Messages sidebar history owner.
- Preserve timeline identity for telemetry-only frames.

---

### Task 1: Session timeline reducer

**Files:**
- Create: `packages/editor/live/liveSessionTimeline.ts`
- Test: `packages/editor/live/liveSessionTimeline.test.ts`

**Interfaces:**
- Produces `LiveSessionTimelineState`, `reconcileLiveSessionTimeline`, `activateLiveSession`, `selectLiveSessionMessage`, and `stableLiveTimelineMessages`.

**Test seams:** Pure reducer and stable projection. TDD required.

- [ ] Test Pi-session/pane fallback keys, background/active arrivals, waiting selection stability, removal fallback, unread clearing, and telemetry identity.
- [ ] Implement the minimum pure state transitions.
- [ ] Run `bun test packages/editor/live/liveSessionTimeline.test.ts`.

### Task 2: Session switcher and active timeline

**Files:**
- Create: `packages/editor/LiveSessionTimeline.tsx`
- Test: `packages/editor/LiveSessionTimeline.test.tsx`
- Modify: `packages/editor/App.tsx`
- Modify: `packages/editor/index.css` if a new Tailwind source is needed.

**Interfaces:**
- Consumes a stable active-session projection, the existing `MessagesBrowser`, captain echoes, and live pane derivation.
- Produces an accessible desktop switcher and mobile sheet plus a session-scoped chronological timeline.

**Test seams:** DOM roles/buttons, explicit session/message callbacks, and mobile dialog focus. TDD required.

- [ ] Test two same-workspace panes remain unambiguous, switching is explicit, and mobile opens a full-height session selector.
- [ ] Add the focused live-only component and wire it to `App` state/reconciliation.
- [ ] Disable the old live Messages panel while retaining non-live behavior and shared `MessagesBrowser`.
- [ ] Run focused DOM/editor tests.

### Task 3: Live integration regression coverage

**Files:**
- Modify: `packages/editor/liveMessageScope.test.ts`
- Modify: `packages/editor/App.tsx`
- Test: relevant existing direct Send/image feedback tests.

**Interfaces:**
- The snapshot callback calls the session reducer without sidebar navigation or message selection on frame ingestion.

**Test seams:** reducer/App-derived model and existing direct transport tests. TDD required.

- [ ] Verify selected real/waiting messages, pinned selections, per-session draft preservation, exact Send/image target state, and no auto-jump transitions.
- [ ] Verify unchanged telemetry frames preserve the main timeline projection identity.
- [ ] Run focused editor/service tests.

### Task 4: Build and validation

**Files:** none expected unless validation exposes a defect.

**Test seams:** package isolation, typecheck, production build, temporary-port browser smoke test.

- [ ] Run focused DOM/editor/service tests, full `PLANNOTATOR_REMOTE=0 bun test`, typecheck, extension package build/isolation, production builds, and git diff checks.
- [ ] Serve an isolated build on a port other than `19432`; use Chrome DevTools AXI fixture/smoke coverage if live multi-session events are unavailable.
- [ ] Commit, push only `fm/plannotator-main-agent-session-timeline`, and open a direct PR through `gh-axi`.
