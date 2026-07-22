# Ex-Plannotator for Pi

Ex-Plannotator provides independent Pi commands that can coexist with Official Plannotator:

- `/ex-plannotator-last` opens a persistent review surface for recent assistant responses.
- `/ex-plannotator-thinking` opens the same persistent review surface over the assistant's thinking/reasoning blocks instead of its final responses.
- `/ex-plannotator-plan [folder]` opens one mixed review round for recent assistant responses and a Plan Folder.

## Plan Folder review

`/ex-plannotator-plan` resolves an optional `[folder]` relative to the current Pi session cwd. It defaults to `./plan`. Paths inserted through Pi's `@` file picker are also accepted, for example `/ex-plannotator-plan @.pi/agent/`.

At the start of each Review Round, Ex-Plannotator recursively lists every regular file below that folder, including hidden files. It applies no ignore list and does not follow directory symlinks. Markdown and MDX files can be opened for read-only annotation; other discovered files remain visible in the Files tab and are marked unsupported. The Files tab has an accessible, case-insensitive path filter that only narrows this server-provided discovery list.

A file's content is read lazily only when opened, then retained as that round's snapshot. The Messages tab shows the latest four assistant responses from the active branch in chronological order. Draft sources that leave that compact picker are retained server-side until delivery, so one **Send feedback** action atomically includes every saved draft across Messages and Files. After Pi accepts the batch, its delivered drafts are cleared and are not sent again by later live updates. The browser applies live response updates in place; it does not reload the review page. While annotation input waits for the next completed assistant response, the current round remains readable. On that first finalized response, Ex-Plannotator re-scans the Plan Folder once, opens the next round with the newest response selected, and lazily reads files again. Added and removed paths appear then; there are no filesystem watchers, file diffs, badges, rename detection, or stale-draft remapping.

The browser never edits Plan Files. Feedback asks the agent to make file changes.

## Thinking review

`/ex-plannotator-thinking` opens a persistent Live Message Review Session whose Reviewed Source is the assistant's thinking/reasoning blocks rather than its final text blocks. It reuses the same live review server, session-identity guard, Feedback Batch delivery, and stop/reconcile lifecycle as `/ex-plannotator-last`; only the reviewed content differs. Each Source Snapshot keeps the Pi message ID as its Source Identity, so reasoning blocks reconcile across Review Rounds exactly like final responses. `/ex-plannotator-last` is unchanged and still excludes thinking blocks from its snapshot. Both commands share the `ex-plannotator.html` browser asset, so no additional bundle build is required.

## Build and package

Build the two sibling browser assets independently from this package directory:

```sh
bun run build        # Last asset only: ex-plannotator.html
bun run build:plan   # Plan asset only: ex-plannotator-plan.html
bun run build:package # Both, sequentially
```

`prepublishOnly` runs both independent build entries before packaging. The package explicitly discovers `index.ts` for Last and `plan-extension.ts` for Plan; the Plan build writes `ex-plannotator-plan.html` and does not route through Official Plannotator assets.

Then load or install `apps/ex-pi-extension` as a Pi package. Official `@plannotator/pi-extension` can remain installed.

On WSL, Ex-Plannotator binds to `0.0.0.0` and opens the browser through the current WSL IPv4 address so Windows can reach the server. Set `EX_PLANNOTATOR_BIND_HOST` to override the listening interface or `EX_PLANNOTATOR_HOST` to override the hostname/IP placed in the browser URL.
