# Ex-Plannotator for Pi

Ex-Plannotator provides two independent Pi commands that can coexist with Official Plannotator:

- `/ex-plannotator-last` opens a persistent review surface for recent assistant responses.
- `/ex-plannotator-plan [folder]` opens one mixed review round for recent assistant responses and a Plan Folder.

## Plan Folder review

`/ex-plannotator-plan` resolves an optional `[folder]` relative to the current Pi session cwd. It defaults to `./plan`. Paths inserted through Pi's `@` file picker are also accepted, for example `/ex-plannotator-plan @.pi/agent/`.

At the start of each Review Round, Ex-Plannotator recursively lists every regular file below that folder, including hidden files. It applies no ignore list and does not follow directory symlinks. Markdown and MDX files can be opened for read-only annotation; other discovered files remain visible in the Files tab and are marked unsupported. The Files tab has an accessible, case-insensitive path filter that only narrows this server-provided discovery list.

A file's content is read lazily only when opened, then retained as that round's snapshot. The Messages tab shows the latest four assistant responses from the active branch in chronological order. Draft sources that leave that compact picker are retained server-side until delivery, so one **Send feedback** action atomically includes every saved draft across Messages and Files. After Pi accepts the batch, its delivered drafts are cleared and are not sent again by later live updates. The browser applies live response updates in place; it does not reload the review page. While annotation input waits for the next completed assistant response, the current round remains readable. On that first finalized response, Ex-Plannotator re-scans the Plan Folder once, opens the next round with the newest response selected, and lazily reads files again. Added and removed paths appear then; there are no filesystem watchers, file diffs, badges, rename detection, or stale-draft remapping.

The browser never edits Plan Files. Feedback asks the agent to make file changes.

## Build and package

The browser asset `ex-plannotator.html` (~23 MB) is **generated and never committed** — it is gitignored, so a fresh clone does not have it. The package explicitly discovers `index.ts` for Last and `plan-extension.ts` for Plan; both commands serve that single bundle. The build pins `NODE_ENV=production` so a rebuild from any environment (including test runs) yields a production bundle, and CI runs the build and rejects a dev-flavored result.

**Installing from a published tarball:** nothing extra to do. `prepublishOnly` runs the build, and the `files` list ships `ex-plannotator.html` inside the package.

**Installing from a source checkout:** build the asset first, then install this directory as a Pi package (same flow as Official `@plannotator/pi-extension`):

```sh
cd plannotator
bun install
bun run build:ex-pi   # writes apps/ex-pi-extension/ex-plannotator.html
pi install ./apps/ex-pi-extension
```

If the bundle is missing at runtime, both commands fail with an error naming that exact build step instead of opening a broken page. Official `@plannotator/pi-extension` can remain installed alongside.

On WSL, Ex-Plannotator binds to `0.0.0.0` and opens the browser through the current WSL IPv4 address so Windows can reach the server. Set `EX_PLANNOTATOR_BIND_HOST` to override the listening interface or `EX_PLANNOTATOR_HOST` to override the hostname/IP placed in the browser URL.
