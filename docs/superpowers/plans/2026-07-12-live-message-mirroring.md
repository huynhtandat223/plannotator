# Live Message Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Implementation workers MUST use the local `tdd` skill unless a task records a user-approved exception. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror each finalized assistant response from the active Pi branch into one long-lived Ex-Plannotator browser session while preserving server-owned review state across live updates and reloads.

**Architecture:** Deepen the Live Message Review Session module into the authoritative in-memory state owner. Its small extension-facing interface exposes branch reconciliation and close; its HTTP/SSE interface exposes snapshots and browser mutations. Pi `message_end` triggers a deferred active-branch reconciliation because Pi assigns the stable session-entry identity immediately after that lifecycle handler returns.

**Tech Stack:** TypeScript, Bun tests, Node HTTP/SSE, React 19, Vite single-file build, Pi extension lifecycle events.

## Global Constraints

- Official `@plannotator/pi-extension` remains unchanged.
- Ex-Plannotator registers only `/ex-plannotator-last`.
- Initial state contains at most 25 completed assistant responses from the active Pi branch.
- Only finalized assistant messages enter the session; user, tool-result, and streaming updates do not.
- Stable Pi session-entry IDs are the response identities and deduplication keys.
- Server memory is authoritative for messages, selection, unread state, and draft annotations.
- Feedback submission and waiting/recovery state are outside issue #3.

---

### Task 1: Authoritative Live Message Review Session

**Files:**
- Modify: `apps/ex-pi-extension/session.ts`
- Modify: `apps/ex-pi-extension/server.ts`
- Modify: `apps/ex-pi-extension/server.test.ts`
- Modify: `apps/ex-pi-extension/session.test.ts`

**Interfaces:**
- Consumes: initial `LiveAssistantMessage[]`, HTTP selection and draft mutations, later active-branch `LiveAssistantMessage[]`.
- Produces: `LiveMessageReviewSnapshot` with `messages`, `selectedMessageId`, `unreadMessageIds`, and `draftsByMessageId`; `LiveMessageReviewServer.reconcile(messages)`; SSE snapshot events.

**Test seams:**
- Black-box Live Message Review Session seam: start the real local session, use HTTP like the browser, call only the extension-facing `reconcile`, and reconnect through a fresh HTTP/SSE request.
- None — TDD required.

- [ ] **Step 1: Write the failing black-box initial/live/dedup/focus/reconnect test**

```ts
const session = await startLiveMessageReviewServer({ htmlContent, messages: initial });
await saveDraft(session.url, "older", [draft]);
session.reconcile([...arrivals, ...initial]);
expect(await snapshot(session.url)).toEqual({
  messages: expectedNewestFirst,
  selectedMessageId: "older",
  unreadMessageIds: ["arrival"],
  draftsByMessageId: { older: [draft] },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test apps/ex-pi-extension/server.test.ts`
Expected: FAIL because `reconcile`, unread state, draft persistence, and mutation routes do not exist.

- [ ] **Step 3: Implement the minimal authoritative state and transport**

```ts
export type LiveMessageReviewServer = {
  port: number;
  url: string;
  reconcile(messages: LiveAssistantMessage[]): void;
  stop(): void;
};
```

The state module deduplicates by `messageId`, keeps newest-first order, auto-selects only when the prior newest response is selected and there are no drafts, clears unread on selection, stores draft arrays by response ID, and emits a complete snapshot to every SSE subscriber after each mutation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test apps/ex-pi-extension/session.test.ts apps/ex-pi-extension/server.test.ts`
Expected: PASS.

### Task 2: Pi Lifecycle and Active-Branch Reconciliation

**Files:**
- Modify: `apps/ex-pi-extension/assistant-message.ts`
- Modify: `apps/ex-pi-extension/index.ts`
- Modify: `apps/ex-pi-extension/extension.test.ts`
- Modify: `apps/ex-pi-extension/browser.ts`

**Interfaces:**
- Consumes: Pi `message_end` events and `ctx.sessionManager.getBranch()` after Pi persists the finalized message.
- Produces: deferred `activeSession.reconcile(getAssistantMessages(ctx))` only for assistant events; deterministic timer/session shutdown cleanup.

**Test seams:**
- Ex-Plannotator extension registration and lifecycle callbacks through a fake Pi `ExtensionAPI`, with the Live Message Review Session replaced only at its public interface.
- None — TDD required.

- [ ] **Step 1: Write a failing lifecycle behavior test**

```ts
await handlers.message_end({ message: { role: "user" } }, ctx);
await handlers.message_end({ message: finalizedAssistant }, ctx);
branch.push(persistedAssistantEntry);
await deferredWork();
expect(reconciliations).toEqual([[{ messageId: "stable-entry-id", text: "Final" }]]);
```

Also assert an assistant entry outside `getBranch()` is absent and duplicate callbacks remain harmless at the session seam.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test apps/ex-pi-extension/extension.test.ts`
Expected: FAIL because `message_end` is not registered and the active session has no reconciliation method.

- [ ] **Step 3: Implement minimal lifecycle ingestion**

Register `message_end`; reject non-assistant roles immediately; defer reconciliation one task so Pi can assign and persist its stable entry ID; read the active branch rather than trusting the event payload; cancel stale deferred work when the session is replaced or shut down.

- [ ] **Step 4: Run extension tests and verify GREEN**

Run: `bun test apps/ex-pi-extension/extension.test.ts apps/ex-pi-extension/assistant-message.test.ts`
Expected: PASS.

### Task 3: Browser Rehydration, Mutations, and Unread UI

**Files:**
- Modify: `apps/ex-review/LiveMessageReviewApp.tsx`
- Create: `apps/ex-review/LiveMessagesBrowser.tsx`

**Interfaces:**
- Consumes: complete snapshots from `GET /api/session` and `EventSource('/api/session/events')`.
- Produces: serialized draft updates to `PUT /api/session/drafts`, selection updates to `PUT /api/session/selection`, and visible per-message unread badges.

**Test seams:**
- The black-box session transport from Task 1 is the agreed behavior seam; browser compilation checks the React consumer against the wire types.
- No separate DOM seam is introduced for issue #3.

- [ ] **Step 1: Add the browser consumer for complete snapshots and server mutations**

```ts
useEffect(() => {
  void hydrate();
  const events = new EventSource("/api/session/events");
  events.onmessage = ({ data }) => applySnapshot(JSON.parse(data));
  return () => events.close();
}, []);
```

Draft updates first update React state, then enqueue the authoritative server mutation. Selection updates clear the local unread mark immediately and send the same mutation to the server.

- [ ] **Step 2: Add a local message browser with unread badges**

Render a labeled unread dot/count on each unread response while preserving newest-first order, timestamp, annotation count, and selected styling.

- [ ] **Step 3: Run typechecking and build**

Run: `bun run typecheck && bun run build:ex-pi`
Expected: PASS and `apps/ex-pi-extension/ex-plannotator.html` is regenerated.

### Task 4: Review, Verification, and Commits

**Files:**
- Review all changes since fixed point `850a262`.
- Commit only issue #3 files in the Plannotator fork.
- Commit only `ext-packages/plannotator` in the superproject.

**Interfaces:**
- Consumes: issue #3 acceptance criteria, repository standards, test/build output.
- Produces: reviewed Plannotator commit, reviewed superproject gitlink commit, and closed issue #3 with verification evidence.

**Test seams:**
- Full focused Ex tests, repository typecheck, deterministic Ex browser build, and full Bun suite.
- None — verification required.

- [ ] **Step 1: Run focused verification**

```bash
bun test apps/ex-pi-extension/*.test.ts
bun run typecheck
bun run build:ex-pi
git diff --exit-code -- apps/ex-pi-extension/ex-plannotator.html
```

- [ ] **Step 2: Run two-axis code review from `850a262`**

Run Standards and Spec reviews in parallel using the repository `code-review` skill. Apply valid fixes as the sole writer and rerun focused verification.

- [ ] **Step 3: Run full regression tests**

Run: `bun test`
Expected: zero failures.

- [ ] **Step 4: Commit the fork and superproject gitlink**

```bash
git add apps/ex-pi-extension apps/ex-review docs/superpowers/plans/2026-07-12-live-message-mirroring.md
git commit -m "feat: mirror live assistant responses (#3)"
cd ../..
git add ext-packages/plannotator
git commit -m "chore: update Plannotator for live response mirroring (#3)"
```

- [ ] **Step 5: Close issue #3 only after verification**

Post the exact verification and commit IDs, then close `huynhtandat223/pi-harness#3`. Do not push.
