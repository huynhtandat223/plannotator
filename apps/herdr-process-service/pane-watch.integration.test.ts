/**
 * Real-Herdr integration coverage for the read-only Watch live transport.
 *
 * This test uses a REAL Herdr pane, the REAL `herdr pane read`, and the REAL
 * Plannotator host endpoint served by a spawned `server.ts`. Nothing about the
 * transport is faked, because the properties under test — that no capture
 * happens before a viewer connects, that a disconnect actually releases the
 * work, that Watch never writes to a pane — are exactly the properties a stub
 * would assert into existence.
 *
 * ## Isolation
 *
 * It creates its OWN Herdr workspace and operates only inside it. It never
 * touches an existing workspace, tab, or pane, and it removes only the
 * workspace it created. A fleet tripwire records every pre-existing workspace,
 * tab and pane id (plus the focused pane) before the run and asserts they are
 * identical afterwards, so a regression that reaches outside the sandbox fails
 * the test rather than the captain's session.
 *
 * ## How "no work without a viewer" is observed
 *
 * The spawned server gets a `herdr` shim first on its PATH that appends every
 * invocation to a log and delegates to the real binary. The log therefore
 * contains exactly the server's Herdr calls and none of the test's own (the
 * test invokes the real binary by absolute path), which makes "no read before a
 * viewer", "reads stop after disconnect", and "no write command was ever
 * issued" externally observable facts rather than claims about internals.
 *
 * Gated behind `PLANNOTATOR_HERDR_WATCH_E2E=1`: a default `bun test` must never
 * create Herdr workspaces.
 */

import { afterAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PANE_WATCH_READ_FORMAT, PANE_WATCH_READ_SOURCE } from "../../packages/core/pane-watch";

const execFileAsync = promisify(execFile);
const enabled = /^(1|true)$/i.test(process.env.PLANNOTATOR_HERDR_WATCH_E2E ?? "");

const LABEL = `plannotator-watch-e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
/** Agent kind Herdr has never heard of — proves Watch is kind-agnostic. */
const AGENT_KIND = "plannotator-watch-e2e-agent";
const REPORT_SOURCE = `plannotator-watch-e2e-${process.pid}`;

interface HerdrSnapshotShape {
  workspaces?: Array<{ workspace_id?: string }>;
  tabs?: Array<{ tab_id?: string }>;
  panes?: Array<{ pane_id?: string; focused?: boolean }>;
  agents?: Array<{ pane_id?: string; agent?: string }>;
}

let herdrBin = "";
let workDir = "";
let shimLog = "";
let createdWorkspaceId: string | null = null;
let createdPaneId: string | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

async function realHerdr(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(herdrBin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function snapshot(): Promise<HerdrSnapshotShape> {
  const stdout = await realHerdr(["api", "snapshot"]);
  return (JSON.parse(stdout) as { result?: { snapshot?: HerdrSnapshotShape } }).result?.snapshot ?? {};
}

/**
 * Every workspace/tab/pane id that existed before this test.
 *
 * Focus is deliberately NOT part of this fingerprint. Herdr moves focus by
 * itself when a workspace closes — measured on 0.7.3: closing a workspace that
 * was created with `--no-focus` and never focused still reassigns focus to
 * another workspace's pane. That is the sandbox's unavoidable teardown, not
 * anything Watch does, so asserting focus equality here would fail for a reason
 * this feature does not control. The real "Watch never changes focus or size"
 * property is proved where it belongs: no focus/resize verb ever appears in the
 * server's Herdr invocation log, and focus never lands on the sandbox pane.
 */
async function fleetTripwire(): Promise<string> {
  const snap = await snapshot();
  const ids = (values: Array<Record<string, unknown>> | undefined, key: string): string[] =>
    (values ?? []).map((entry) => String(entry[key] ?? "")).filter(Boolean).sort();
  return JSON.stringify({
    workspaces: ids(snap.workspaces as Array<Record<string, unknown>>, "workspace_id")
      .filter((id) => id !== createdWorkspaceId),
    tabs: ids(snap.tabs as Array<Record<string, unknown>>, "tab_id"),
    panes: ids(snap.panes as Array<Record<string, unknown>>, "pane_id"),
  });
}

async function focusedPaneId(): Promise<string> {
  return (await snapshot()).panes?.find((pane) => pane.focused)?.pane_id ?? "";
}

function shimInvocations(): string[] {
  if (!existsSync(shimLog)) return [];
  return readFileSync(shimLog, "utf8").split("\n").filter(Boolean);
}

function paneReadCount(paneId: string): number {
  return shimInvocations().filter((line) => line.includes(` pane read ${paneId} `)).length;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Collects `pane-watch` SSE events until `stop()` is called. */
function openWatch(paneId: string): {
  events: Array<Record<string, unknown>>;
  stop: () => void;
  done: Promise<void>;
} {
  const events: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/pane-watch?paneId=${encodeURIComponent(paneId)}`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Abort is the normal end of a watch here.
    }
  })();
  return { events, stop: () => controller.abort(), done };
}

function frames(events: Array<Record<string, unknown>>): string[] {
  return events.filter((event) => event.type === "frame").map((event) => String(event.ansi ?? ""));
}

afterAll(async () => {
  server?.kill();
  if (createdWorkspaceId && herdrBin) {
    // Remove ONLY the workspace this test created.
    await realHerdr(["workspace", "close", createdWorkspaceId]).catch(() => {});
  }
});

test.skipIf(!enabled)("watches a real Herdr pane read-only, and stops when nobody is looking", async () => {
  herdrBin = (await execFileAsync("bash", ["-lc", "command -v herdr"])).stdout.trim();
  expect(herdrBin).toBeTruthy();

  const before = await fleetTripwire();

  // --- isolated sandbox: our own workspace, tab and pane ------------------
  workDir = mkdtempSync(join(tmpdir(), "plannotator-watch-e2e-"));
  const workspaceOut = await realHerdr(["workspace", "create", "--cwd", workDir, "--label", LABEL, "--no-focus"]);
  createdWorkspaceId = String(
    (JSON.parse(workspaceOut) as { result?: { workspace?: { workspace_id?: string } } })
      .result?.workspace?.workspace_id ?? "",
  );
  expect(createdWorkspaceId).toBeTruthy();

  const tabOut = await realHerdr([
    "tab", "create", "--workspace", createdWorkspaceId, "--cwd", workDir, "--label", LABEL, "--no-focus",
  ]);
  const tabResult = (JSON.parse(tabOut) as {
    result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } };
  }).result;
  createdPaneId = String(tabResult?.root_pane?.pane_id ?? "");
  expect(createdPaneId).toBeTruthy();

  // Give the pane an agent identity Herdr has never seen. Discovery is
  // kind-agnostic, so Watch must work for it exactly as for a Pi pane.
  await realHerdr([
    "pane", "report-agent", createdPaneId,
    "--source", REPORT_SOURCE, "--agent", AGENT_KIND, "--state", "idle",
  ]);
  await waitFor(
    async () => (await snapshot()).agents?.some((agent) => agent.pane_id === createdPaneId) === true,
    15_000,
    "the sandbox pane to appear as an agent in Herdr's snapshot",
  );

  // --- spawn the real host, behind a logging herdr shim -------------------
  const shimDir = mkdtempSync(join(tmpdir(), "plannotator-watch-shim-"));
  shimLog = join(shimDir, "herdr-invocations.log");
  const shimPath = join(shimDir, "herdr");
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' " $* " >> ${JSON.stringify(shimLog)}\nexec ${JSON.stringify(herdrBin)} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);

  port = 19000 + (process.pid % 900);
  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      PLANNOTATOR_HERDR_PORT: String(port),
      PLANNOTATOR_HERDR_HOST: "127.0.0.1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
    } catch {
      return false;
    }
  }, 30_000, "the Plannotator Herdr service to become healthy");
  await waitFor(async () => {
    const panels = await (await fetch(`http://127.0.0.1:${port}/api/panels`)).json() as Array<{ id: string }>;
    return panels.some((panel) => panel.id === createdPaneId);
  }, 20_000, "the host to discover the sandbox pane");

  // --- no viewer, no capture ---------------------------------------------
  // The service has been running and polling snapshots for seconds by now; if
  // Watch had any idle capture behaviour this would be non-zero.
  expect(paneReadCount(createdPaneId)).toBe(0);

  // --- first screen is the actual current visible screen ------------------
  const marker1 = `WATCH_MARKER_ONE_${Math.random().toString(36).slice(2, 8)}`;
  await realHerdr(["pane", "run", createdPaneId, `printf '%s\\n' ${marker1}`]);
  await Bun.sleep(1_000);

  const first = openWatch(createdPaneId);
  await waitFor(() => frames(first.events).some((frame) => frame.includes(marker1)), 20_000,
    "the first frame to carry the pane's current visible screen");

  // The read is the fixed one: source and format are the host's, never the
  // browser's, and no other pane argument appears.
  const reads = shimInvocations().filter((line) => line.includes(` pane read ${createdPaneId} `));
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) {
    expect(read).toContain(`--source ${PANE_WATCH_READ_SOURCE}`);
    expect(read).toContain(`--format ${PANE_WATCH_READ_FORMAT}`);
  }

  // --- live changes reach the viewer --------------------------------------
  const marker2 = `WATCH_MARKER_TWO_${Math.random().toString(36).slice(2, 8)}`;
  await realHerdr(["pane", "run", createdPaneId, `printf '%s\\n' ${marker2}`]);
  await waitFor(() => frames(first.events).some((frame) => frame.includes(marker2)), 20_000,
    "a live frame carrying new pane output");

  // Watching a pane must not pull focus to it — the captain keeps looking at
  // whatever they were looking at.
  expect(await focusedPaneId()).not.toBe(createdPaneId);

  // --- disconnect releases the observation work ---------------------------
  first.stop();
  await first.done;
  await Bun.sleep(1_500);
  const afterDisconnect = paneReadCount(createdPaneId);
  // The watch really did poll repeatedly while a viewer was attached — without
  // this, "reads stopped after disconnect" could hold simply because reads had
  // never started, and the whole release assertion would be vacuous.
  expect(afterDisconnect).toBeGreaterThan(1);
  await Bun.sleep(2_000);
  expect(paneReadCount(createdPaneId)).toBe(afterDisconnect);

  // --- reconnect reads a fresh screen, it does not replay -----------------
  const second = openWatch(createdPaneId);
  await waitFor(() => frames(second.events).length > 0, 20_000, "a frame after reconnect");
  const firstFrameAfterReconnect = frames(second.events)[0]!;
  // The newest screen, not a replay of the screen the first watch started on.
  expect(firstFrameAfterReconnect).toContain(marker2);

  // --- a pane that goes away ends the watch -------------------------------
  await realHerdr(["pane", "close", createdPaneId]);
  await waitFor(
    () => second.events.some((event) => event.type === "ended" && event.reason === "pane-gone"),
    30_000,
    "the watch to end when Herdr stops reporting the pane",
  );
  second.stop();
  await second.done;

  // --- Watch never wrote to the pane --------------------------------------
  // Everything the server asked Herdr for, across the whole run: only snapshot
  // reads and screen reads. Any input, focus, resize or lifecycle verb here
  // would mean the observe/control boundary had been crossed.
  const serverCalls = shimInvocations();
  expect(serverCalls.length).toBeGreaterThan(0);
  for (const verb of ["send-text", "send-keys", "send-input", "focus", "resize", "zoom", "split", "pane close", "pane run", "agent send"]) {
    expect(serverCalls.some((line) => line.includes(verb))).toBe(false);
  }

  // --- the captain's session is untouched ---------------------------------
  await realHerdr(["workspace", "close", createdWorkspaceId]);
  const closedWorkspaceId = createdWorkspaceId;
  createdWorkspaceId = null;
  await waitFor(
    async () => (await snapshot()).workspaces?.every((w) => w.workspace_id !== closedWorkspaceId) === true,
    20_000,
    "the sandbox workspace to be removed",
  );
  expect(await fleetTripwire()).toBe(before);
}, 180_000);
