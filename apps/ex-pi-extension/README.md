# Ex-Plannotator for Pi

Ex-Plannotator provides two independent Pi commands that can coexist with Official Plannotator:

- `/ex-plannotator-last` opens a persistent review surface for recent assistant responses.
- `/ex-plannotator-plan [folder]` opens one mixed review round for recent assistant responses and a Plan Folder.

## Plan Folder review

`/ex-plannotator-plan` resolves an optional `[folder]` relative to the current Pi session cwd. It defaults to `./plan`.

At the start of each Review Round, Ex-Plannotator recursively lists every regular file below that folder, including hidden files. It applies no ignore list and does not follow directory symlinks. Markdown and MDX files can be opened for read-only annotation; other discovered files remain visible in the Files tab and are marked unsupported.

A file's content is read lazily only when opened, then retained as that round's snapshot. One **Send feedback** action atomically includes drafts across both Messages and Files. After Pi accepts the batch, the current round remains readable while annotation input waits for the next completed assistant response. On that first finalized response, Ex-Plannotator re-scans the Plan Folder once, opens the next round with the newest response selected, and lazily reads files again. Added and removed paths appear then; there are no filesystem watchers, file diffs, badges, rename detection, or stale-draft remapping.

The browser never edits Plan Files. Feedback asks the agent to make file changes.

## Build and package

Build the two sibling browser assets independently from this package directory:

```sh
bun run build        # Last asset only: ex-plannotator.html
bun run build:plan   # Plan asset only: ex-plannotator-plan.html
bun run build:package # Both, sequentially
```

`prepublishOnly` runs both independent build entries before packaging. The package explicitly discovers `index.ts` for Last and `plan-extension.ts` for Plan; the Plan build only writes `ex-plannotator-plan.html` and does not route through Official Plannotator assets.

Then load or install `apps/ex-pi-extension` as a Pi package. Official `@plannotator/pi-extension` can remain installed.

On WSL, Ex-Plannotator binds to `0.0.0.0` and opens the browser through the current WSL IPv4 address so Windows can reach the server. Set `EX_PLANNOTATOR_BIND_HOST` to override the listening interface or `EX_PLANNOTATOR_HOST` to override the hostname/IP placed in the browser URL.
