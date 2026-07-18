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

## Discovery contract

`GET /api/panels` runs `herdr api snapshot` and returns only entries whose `agent` is `pi`. Every response is live; a closed Pi pane disappears on the next refresh. `GET /api/plan` maps those panes and their in-memory Pi enrichment into Ex-Plannotator's existing response-picker model.

The extension reports structured data only to the service's loopback-only control endpoint. Herdr remains authoritative for liveness: enrichment for panes absent from a fresh snapshot is discarded. Nothing is persisted and terminal output is never parsed as an assistant response.

A native response/Git review bridge needs a verified way to correlate a Herdr pane with Pi's structured assistant messages and a safe feedback-delivery experiment. Until that exists, this service is read-only: open Ex-Plannotator directly inside the selected Pi panel to annotate/send feedback. The host service never injects text into a user's live Pi pane.
