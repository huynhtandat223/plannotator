# Plannotator Herdr host service

A native, loopback-only navigator for **live Pi panels managed by Herdr**. It runs as the same user as Herdr, reads `herdr api snapshot`, and never scans host processes or retains stale session history.

The service serves the existing Ex-Plannotator UI exactly as built. Every live Herdr Pi panel appears in Ex-Plannotator's existing picker, labelled with workspace, tab, pane, cwd, and status. The Ex-Plannotator Pi extension automatically publishes that pane's latest structured assistant response, so selecting a pane opens the same response `/ex-plannotator-last` would open without requiring the command. There is no separate dashboard, card layout, or service-specific visual style.

## Run

From the Plannotator repository:

```sh
bun apps/herdr-process-service/server.ts
```

Open <http://127.0.0.1:19432>.

Configuration:

- `PLANNOTATOR_HERDR_HOST` — bind host (default `0.0.0.0`)
- `PLANNOTATOR_HERDR_PORT` — port (default `19432`)
- `PLANNOTATOR_HERDR_WRITE_TOKEN` — required to submit feedback from a non-loopback browser. Start the service with a long random value, then open `http://<host>:19432/?token=<value>` once to receive the same-site write cookie. Loopback browsers do not need it.

## Discovery contract

`GET /api/panels` runs `herdr api snapshot` and returns only entries whose `agent` is `pi`. Every response is live; a closed Pi pane disappears on the next refresh. `GET /api/plan` maps those panes and their in-memory Pi enrichment into Ex-Plannotator's existing response-picker model.

The extension reports the latest **five** structured assistant responses per pane, newest first, only to the service's loopback-only control endpoint. Herdr remains authoritative for liveness: enrichment for panes absent from a fresh snapshot is discarded. Nothing is persisted and terminal output is never parsed as an assistant response. Each browser keeps its own selected response; viewers do not overwrite one another's selection.

Feedback is delivered through a narrow loopback bridge: the browser queues a batch for one live `{ paneId, sessionId }`, then only the matching local Pi extension claims it and reuses Ex-Plannotator's existing `formatLiveFeedbackBatch` + `pi.sendUserMessage(..., { deliverAs: "followUp" })` delivery. A changed or closed session invalidates queued feedback. The queue uses at-most-once claim semantics to avoid duplicate prompts after crashes.
