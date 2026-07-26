# Plannotator Herdr host service

A native, loopback-only navigator for **live agent panels managed by Herdr**. It runs as the same user as Herdr, reads `herdr api snapshot`, and never scans host processes or retains stale session history.

The service serves the existing Ex-Plannotator UI exactly as built. Every live Herdr agent panel appears in Ex-Plannotator's existing picker, labelled with workspace, tab, pane, cwd, and status. For a Pi pane, the Ex-Plannotator Pi extension automatically publishes that pane's latest structured assistant response, so selecting it opens the same response `/ex-plannotator-last` would open without requiring the command. Other agent kinds appear with whatever they can genuinely source and an explicit notice naming what they cannot — see **Per-agent capabilities**. There is no separate dashboard, card layout, or service-specific visual style.

## Run

From the Plannotator repository:

```sh
bun apps/herdr-process-service/server.ts
```

Open <http://127.0.0.1:19432>.

Configuration:

- `PLANNOTATOR_HERDR_HOST` — bind host (default `0.0.0.0`)
- `PLANNOTATOR_HERDR_PORT` — port (default `19432`)
- `PLANNOTATOR_HERDR_WRITE_TOKEN` — optional override for browser feedback from non-Tailscale networks. Start the service with a long random value, then open `http://<host>:19432/?token=<value>` once to receive the same-site write cookie. Loopback and Tailscale (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) browsers do not need it.

## Discovery contract

`GET /api/panels` runs `herdr api snapshot` and returns **every** agent entry it describes — Pi, Claude Code, Codex, OpenCode, and any kind a future Herdr learns to report. `panelsFromSnapshot` admits an entry when the snapshot gives it a pane id, a working directory and an agent kind, and for no other reason: **do not reintroduce a name check there**, not even a list of the kinds we know about today. Every response is live; a closed pane disappears on the next refresh. `GET /api/plan` maps those panes and their enrichment into Ex-Plannotator's existing response-picker model.

What a pane can actually *do* is decided separately, by the capability registry in `packages/core/live-pane-agents.ts` — the single place that knows the difference between agent kinds. See **Per-agent capabilities** below.

The extension reports the latest **five** structured assistant responses per pane, newest first, only to the service's loopback-only control endpoint. Herdr remains authoritative for liveness: enrichment for panes absent from a fresh snapshot is discarded. Nothing is persisted and terminal output is never parsed as an assistant response. Each browser keeps its own selected response; viewers do not overwrite one another's selection.

## Per-agent capabilities

Four surfaces come straight from Herdr's snapshot and work for **every** agent kind, now and in future: pane/workspace/tab identity, status, working directory, and focus. Everything richer than that originally came from the Ex-Plannotator **Pi extension** registering into `/api/panel-session`, so it has to be declared per kind:

| Surface | Pi | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- | --- |
| Identity / status / cwd / focus | ✅ Herdr snapshot | ✅ Herdr snapshot | ✅ Herdr snapshot | ✅ Herdr snapshot |
| Chat transcript | ✅ Pi extension | ✅ **cwd-keyed session log** (`apps/hook/server/session-log.ts`) | ⚠️ could exist — rollouts are keyed by `CODEX_THREAD_ID`, absent from the snapshot; needs a cwd → rollout resolver | ❌ sessions are reachable only from a plugin inside the agent process |
| Activity trail / recent commands | ✅ Pi extension | ❌ no extension registration | ❌ no extension registration | ❌ no extension registration |
| Context usage % | ✅ Pi extension (+ session-file fallback) | ⚠️ could exist — usage is logged, the model's context window is not, so a percentage would be a guess | ⚠️ could exist — lives in the unresolvable rollout | ❌ in-process only |
| Slash commands | ✅ Pi extension | ❌ not advertised | ❌ not advertised | ❌ not advertised |
| Handoff command | ✅ registered Pi command | ❌ none advertised | ❌ none advertised | ❌ none advertised |
| Send feedback / message | ✅ claimed by the Pi extension | ❌ nothing to claim it | ❌ nothing to claim it | ❌ nothing to claim it |
| Ex AI Chat companion | ✅ | ❌ pairs a Pi session to a Pi pane | ❌ same | ❌ same |

An agent kind with no registry entry gets `unknownLivePaneAgentProfile`, which claims nothing — so a fifth kind appears honestly on day one without a code change to discovery.

**The rule this enforces:** a pane either works or is *visibly and specifically* limited. Every unsupported capability carries a user-facing reason that names the missing mechanism; the browser renders them in a per-pane notice and disables the matching affordance, and every write endpoint answers `409` with the same reason instead of a Pi-shaped "session not registered". Nothing may render as working while empty.

Feedback is delivered through a narrow bridge: loopback and Tailscale browsers may queue a batch for one live `{ paneId, sessionId }`, then only the matching local Pi extension claims it through a loopback-only endpoint and reuses Ex-Plannotator's existing `formatLiveFeedbackBatch` + `pi.sendUserMessage(..., { deliverAs: "followUp" })` delivery. A changed or closed session invalidates queued feedback. The queue uses at-most-once claim semantics to avoid duplicate prompts after crashes.

## Ex AI Chat companions

Ex AI Chat is separate from Ask AI. For an eligible live main Pi `{ paneId, sessionId }`, the header opens inline setup and `POST /api/ex-ai-companion/start` creates one ordinary, unfocused Pi pane in the same Herdr workspace and cwd. Opening setup creates no process. The companion is durably paired with the exact main identity in `${PLANNOTATOR_DATA_DIR:-~/.plannotator}/ex-ai-companions.json`; the registry stores setup choices, UI-originated turn projection, and bounded handoff idempotency results, not a second transcript.

`GET /api/ex-ai-companion?paneId=&sessionId=` returns setup, recovery, pair, model/capability metadata, and projected history. `POST /api/ex-ai-companion/turn` sends the first hidden preamble once, then only later user text, and waits for a newly finalized structured response from that exact companion session. Direct native-pane activity is represented as a collapsed activity event rather than copied into chat.

Fresh Herdr panels are liveness authority. A service restart temporarily reports a pair as `recovering` until Pi registration republishes; it never closes a still-live companion merely because enrichment is briefly absent. A missing/replaced main closes its managed companion. A missing companion marks the pair `closed`; it is replaced only after explicit Start. Companion panes are badged in the picker and cannot start nested companions.

`POST /api/ex-ai-companion/handoff` requires the same browser-write authorization as feedback, revalidates the exact live main registration, and queues a follow-up for the loopback-only Pi claim endpoint. Clients retain one request ID for a draft so duplicate retries converge to one delivery. Do not use this route to send an unapproved synthetic message into a live main conversation.

## Create a Pi panel

The browser's **New panel** action creates one background Pi agent in a new tab of an existing, live Herdr workspace. Choose a live workspace, select a live panel's working directory or enter another existing absolute directory, give the panel a name, and start with `pi` or another command plus arguments. The action never changes the current Herdr focus or splits an existing pane. The header **Close** action closes the currently selected live Pi pane. Both actions use the same loopback/Tailscale/write-token browser authorization as feedback; Pi session registration and message claiming remain loopback-only.

## Folder View and Git Changes

The existing Ex-Plannotator **Files** sidebar is enabled for the selected live Pi pane. `GET /api/reference/files` exposes a point-in-time folder tree plus Git status only for an exact `cwd` that a fresh `herdr api snapshot` currently reports for a Pi pane. The tree reuses Ex-Plannotator's normal exclusions and Git decorations (`A`, `D`, `R`, `U`, conflicts, and line totals); changed files of every extension are included so their Git status remains visible. On mobile, the same FileBrowser opens in a full-height sheet. It does not accept arbitrary host directories, persist workspace data, or watch the filesystem.

Selecting a response from another live pane switches the Files sidebar to that pane's Herdr-reported `cwd`. Opening a file uses the existing `/api/doc` resolver, confined to the selected live pane workspace. File-system access is read-only; refresh the Files tab to retrieve a new point-in-time tree and Git status.
