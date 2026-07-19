# Ex-Plannotator / Herdr live Pi review

This document describes the persistent **Ex-Plannotator** review surface for live Pi panes managed by Herdr. It supplements [the separate-package ADR](adr/0001-separate-ex-plannotator-package.md) and the focused service reference at [`apps/herdr-process-service/README.md`](../apps/herdr-process-service/README.md).

## Scope

Ex-Plannotator is independent of Official Plannotator. It reuses stable UI and shared libraries, but owns its Pi extension, Herdr host service, browser assets, and persistent live-review behavior. Do not alter Official Plannotator flows while changing this integration.

The service is a live navigator and review bridge, not a chat archive or a generic host-file browser. It discovers panes from Herdr, while the Pi extension enriches those panes with finalized assistant responses and supported commands.

## Architecture

```text
Herdr snapshot                         Pi extension in the live pane
    │                                           │
    ▼                                           ▼
apps/herdr-process-service/server.ts ◀── panel-session registration
    │                 │                         │
    │                 ├── /api/plan, SSE ───────┘
    ▼                 ▼
Existing Ex-Plannotator editor UI
    │
    ├── feedback batch ──► /api/feedback ──► claimed by Pi extension
    ├── raw waiting-pane message ─► /api/instruction ─► claimed by Pi extension
    └── explicit slash command ─► /api/command ─► herdr pane run
```

- [`apps/herdr-process-service/server.ts`](../apps/herdr-process-service/server.ts) normalizes `herdr api snapshot`, serves the pre-built Ex-Plannotator UI, and owns the transient browser-to-Pi delivery queues.
- [`apps/ex-pi-extension/herdr-registration.ts`](../apps/ex-pi-extension/herdr-registration.ts) registers the current pane, Pi session, latest structured assistant responses, and supported commands.
- [`apps/ex-pi-extension/index.ts`](../apps/ex-pi-extension/index.ts) republishes that enrichment during Pi lifecycle activity and polls for queued feedback or raw instructions.
- [`packages/editor/App.tsx`](../packages/editor/App.tsx) reconciles live snapshots and scopes browser-only review drafts.
- [`packages/ui/components/Viewer.tsx`](../packages/ui/components/Viewer.tsx) and [`packages/ui/components/CommentPopover.tsx`](../packages/ui/components/CommentPopover.tsx) provide the existing Global Comment flow and its live-Pi additions.

## Identity, liveness, and security invariants

### Herdr owns liveness

A pane is live only when it is present in a fresh Herdr snapshot. The service prunes enrichment for panes that disappear. Do not infer liveness from browser state, persisted drafts, or terminal output.

### Session boundaries are strict

A pane registration is scoped by both its Herdr `paneId` and its Pi `sessionId`.

- The browser uses a composite message key (`paneId:assistantMessageId`) only as a UI identity.
- A live feedback batch is validated against the currently selected structured assistant response and is delivered only to the matching `{ paneId, sessionId }`.
- When a pane changes Pi session, browser-only drafts for that pane are discarded rather than crossing into the new conversation.
- Repeated identical SSE snapshots must not repeatedly discard drafts or show duplicate discard notices. `App.tsx` keeps the last accepted snapshot in a synchronous ref for this reason.

### Privileged routes are narrow

Pi registration and browser-to-Pi claim endpoints are loopback-only. Browser mutations are accepted from loopback, private Tailscale peers, or a browser holding the optional write-token cookie. See `canWriteFeedback`, `isLoopback`, and `isTailscalePeer` in the service.

The delivery queues are intentionally in memory and use destructive, at-most-once claims. That is safer than sending a duplicate Pi prompt after a crash, but it means a service restart clears registrations and undelivered items.

## Reviewer behavior

### Responses and waiting panes

The existing message picker is the main way to choose a live pane and assistant response. A pane with no published assistant response is rendered as a synthetic waiting document.

A waiting pane:

- disables normal annotation creation;
- exposes **Message Pi** through the existing Global Comment surface;
- switches automatically to a real response when the same pane later publishes one;
- accepts only a raw text instruction, not image attachments.

The sticky waiting action is icon-only with the accessible name **Message Pi**; the explanatory waiting-state action remains text-labelled.

On mobile, retain the separate **Messages**, **Folder**, and **Git Changes** controls. Do not consolidate them into a Herdr-specific hamburger menu. The Global Comment flow is also the primary way to message a live Pi pane; do not add a separate composer for this feature.

### Feedback counts and reset

After successful live feedback delivery, the selected response's cached annotations, code annotations, global attachments, selections, and count are cleared. Drafts attached to another response remain local until that response is selected and sent.

## Messages, commands, and attachments

These user actions have distinct transports. Do not merge them or infer one from another.

| Reviewer action | Browser route | Delivery route | Image support |
| --- | --- | --- | --- |
| Feedback about an existing assistant response | `POST /api/feedback` | Matching Pi extension claims the batch and sends formatted follow-up feedback | Yes |
| Raw message while a pane is waiting | `POST /api/instruction` | Matching Pi extension claims it and calls `pi.sendUserMessage` | No, text only |
| Explicit supported slash command | `POST /api/command` | `herdr pane run <paneId> /<command> [args]` | Not applicable |

### Global Comment autocomplete

For a live pane, typing `/` in Global Comment filters only commands published by the currently selected pane. Choosing a command makes the **Run `/command`** action explicit; the text after the command is passed as its arguments.

A raw slash-prefixed comment remains a comment unless the reviewer selects an advertised command and chooses Run. This distinction matters because Pi's public `sendUserMessage` route does not dispatch slash commands or expand prompts/skills. The service validates the command against the current pane registration before using Herdr's interactive `pane run` path, where Pi performs its normal command dispatch.

Typing `@` in a waiting pane's **Message Pi** composer searches source files only in that pane's live workspace. Choose a path, then type an optional line suffix directly: `@src/App.tsx:42` or `@src/App.tsx:42-60`. On submit, the host re-resolves every explicit mention inside the pane root and prefixes the delivered text with the canonical path and range. This is a file-reference aid, not a file-content attachment; Pi reads the file itself. The path index is in-memory, capped, and cached for 30 seconds — IndexedDB is not used.

### Image attachments

Images belong to feedback for an existing assistant response.

1. The UI uploads a supported image with `POST /api/upload`.
2. The service stores it under the host temporary directory, normally `/tmp/plannotator/<uuid>.<extension>`.
3. `GET /api/image?path=...` serves a preview.
4. `App.tsx` includes `globalAttachments` in the live feedback request.
5. The Herdr service validates the attachment records and associates them with the selected response's feedback batch.
6. Ex-Plannotator formats them as **Reference Images**, containing an attachment name and local path, before Pi receives the follow-up message.

The local path is intentional: Pi runs on the same host and can read the reference image. It is not an inline chat-media transport. Uploaded files are temporary operational state, not durable review history.

Do not show an attachment affordance in a waiting pane. Its raw instruction protocol is `{ paneId, text }`; allowing selection there would silently lose the attachment.

## Operations

The machine runs a user systemd service named `plannotator-herdr.service`. Its unit starts Bun from this checkout:

```text
/home/dathuynh/.local/bin/bun apps/herdr-process-service/server.ts
```

Use:

```sh
systemctl --user status plannotator-herdr.service
systemctl --user restart plannotator-herdr.service
journalctl --user -u plannotator-herdr.service -f
curl -fsS http://127.0.0.1:19432/health
```

The default service port is `19432`. After a restart, expect a brief startup window before the health endpoint answers. A restart does not stop Herdr or Pi panes, but it clears the service's in-memory registration and delivery queues. Active extensions republish during lifecycle events and their polling loop; use the diagnostic below rather than assuming every pane has already republished.

Inspect the live browser model with:

```sh
curl -fsS http://127.0.0.1:19432/api/plan |
  python3 -c 'import json,sys; x=json.load(sys.stdin); print([(m["paneId"], m.get("assistantMessageId"), len(m.get("commands", []))) for m in x["recentMessages"]])'
```

A synthetic waiting message has no `assistantMessageId`. A positive command count confirms that the current Pi session published command capabilities.

## Validation and maintenance

After changing this integration, run focused checks from the repository root:

```sh
bun test \
  apps/herdr-process-service/server.test.ts \
  apps/ex-pi-extension/herdr-registration.test.ts \
  apps/ex-pi-extension/extension.test.ts \
  packages/editor/liveMessageScope.test.ts

DOM_TESTS=1 bun test packages/ui/components/Viewer.consumer.test.tsx
bunx tsc --noEmit -p packages/ui/tsconfig.json
bunx tsc --noEmit -p apps/ex-pi-extension/tsconfig.json
git diff --check
bun run build:ex-pi
systemctl --user restart plannotator-herdr.service
curl -fsS http://127.0.0.1:19432/health
```

`bun run build:ex-pi` regenerates:

- `apps/ex-pi-extension/ex-plannotator.html`
- `apps/ex-pi-extension/ex-plannotator-plan.html`

Never edit those generated HTML files manually.

For browser coverage, use the repository's Chrome AXI workflow to verify at least:

1. a pane with a response exposes Global Comment and attachments;
2. a waiting pane exposes Message Pi and no attachment control;
3. a selected attachment uploads and its preview returns successfully;
4. a supported `/` command appears in Global Comment and only runs after explicit selection;
5. restarting the service and receiving repeated snapshots shows at most one session-change discard notice.

## Known limits

- Registrations and delivery queues are deliberately in memory; a service restart needs Pi extensions to republish and drops pending deliveries.
- Waiting-pane raw instructions are text-only.
- Image attachment references are temporary local paths and are usable only while the file remains available to the local Pi process.
- The service exposes only live pane workspaces and only while a fresh Herdr snapshot authorizes the exact working directory.

## Historical decisions worth preserving

The implementation intentionally rejected or replaced several earlier directions:

- A separate message composer was replaced by the existing Global Comment flow.
- A Herdr-specific mobile hamburger was rejected; the individual mobile navigation controls remain.
- A standalone terminal command picker was replaced by opt-in autocomplete inside Global Comment.
- Raw slash-prefixed text never became implicit command execution.
- Image attachments were initially unavailable in the Herdr service path; the current service now owns upload, preview, feedback-batch attachment propagation, and local-path formatting. Waiting-pane instructions remain text-only by design.
