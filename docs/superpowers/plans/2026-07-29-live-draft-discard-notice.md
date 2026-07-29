# Live Draft Discard Notice Implementation Plan

> **For agentic workers:** Implementation workers MUST use the local `tdd` skill unless a task records a user-approved exception. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show one discard notice when a live Pi-session transition actually removes old review drafts, without ever allowing those drafts into the replacement session.

**Architecture:** Keep the existing session-change detection and cache deletion boundary. Add a pure predicate that checks whether the changed pane owns a draft before the cache is deleted; use it only to decide whether to toast. The cache remains deleted for every detected session change.

**Tech Stack:** TypeScript, React, Bun test.

## Global Constraints

- Old-session drafts must never be retained or delivered to a replacement Pi session.
- Repeated or out-of-order frames must not stack notices after their old draft is already gone.

---

### Task 1: Test and implement discard-notice eligibility

**Files:**
- Modify: `packages/editor/liveMessageScope.ts`
- Test: `packages/editor/liveMessageScope.test.ts`

**Interfaces:**
- Produces: `hasMessageStateDraftsForChangedPanes(states, previous, changedPaneIds, hasDraft): boolean`.

**Test seams:**
- The pure helper observes cached state identity plus its caller-provided draft predicate.
- None — TDD required.

- [ ] **Step 1: Add a test for repeated frames and a later, genuinely new discarded draft.**
- [ ] **Step 2: Run `bun test packages/editor/liveMessageScope.test.ts` and verify the new test fails.**
- [ ] **Step 3: Add the pure predicate without changing the cache deletion behavior.**
- [ ] **Step 4: Run the focused test and verify it passes.**

### Task 2: Gate only the notice, not draft deletion

**Files:**
- Modify: `packages/editor/App.tsx`
- Test: `packages/editor/liveMessageReview.test.ts`

**Interfaces:**
- Consumes: `hasMessageStateDraftsForChangedPanes`.
- Produces: one toast only when the old session actually had a review draft to discard.

**Test seams:**
- The static live-review wiring test confirms the callback uses the eligibility guard while preserving `discardMessageStatesForChangedPanes`.
- None — TDD required.

- [ ] **Step 1: Add the callback wiring assertion.**
- [ ] **Step 2: Run `bun test packages/editor/liveMessageReview.test.ts` and verify it fails.**
- [ ] **Step 3: Gate the toast with cached/current old-session draft eligibility; keep the unconditional cache deletion.**
- [ ] **Step 4: Run focused tests and typecheck.**
