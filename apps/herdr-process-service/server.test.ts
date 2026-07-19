import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LiveSnapshotPublisher,
  acceptsPanelSessionUpdate,
  commandArgv,
  commandDelivery,
  feedbackBatch,
  instructionDelivery,
  scoutDelivery,
  panelsFromSnapshot,
  releasePanelSession,
  reviewSnapshotFromPanels,
  readPanelSessionJson,
  serveWorkspaceFilesStream,
  managedScouts,
  panelSessions,
  type HerdrPanel,
  type PanelSessionEnrichment,
  workspaceStatus,
  reuseOrLaunchGitChangesReview,
  cancelPendingGitChangesReviewLaunch,
  type PendingGitChangesReviewLaunch,
} from "./server";

const temporaryRepos: string[] = [];

function createTemporaryRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "plannotator-herdr-workspace-"));
  temporaryRepos.push(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@plannotator.dev");
  git(repo, "config", "user.name", "Plannotator Test");
  return repo;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("panel-session transport", () => {
  test("rejects a nested subagent registration that would replace the pane owner's command-capable session", () => {
    const owner: PanelSessionEnrichment = {
      paneId: "w:p1",
      sessionId: "owner-session",
      messages: [],
      commands: [{ name: "ex-plannotator-last", source: "extension" }],
    };
    const nestedSubagent: PanelSessionEnrichment = {
      paneId: "w:p1",
      sessionId: "subagent-session",
      messages: [],
      commands: [{ name: "run", source: "extension" }],
    };

    expect(acceptsPanelSessionUpdate(owner, nestedSubagent, true)).toBe(false);
    // Compatibility fallback for a child running an extension version before
    // it labelled itself as a subagent.
    expect(acceptsPanelSessionUpdate(owner, nestedSubagent, false)).toBe(false);
    expect(acceptsPanelSessionUpdate(undefined, nestedSubagent, false)).toBe(true);
  });

  test("accepts a new pane-owner session that advertises its live-review command", () => {
    const owner: PanelSessionEnrichment = {
      paneId: "w:p1",
      sessionId: "owner-session",
      messages: [],
      commands: [{ name: "ex-plannotator-last", source: "extension" }],
    };
    const replacementOwner: PanelSessionEnrichment = {
      paneId: "w:p1",
      sessionId: "replacement-session",
      messages: [],
      commands: [{ name: "ex-plannotator-last", source: "extension" }],
    };

    expect(acceptsPanelSessionUpdate(owner, replacementOwner, false)).toBe(true);
  });

  test("accepts a structured assistant response beyond the generic 16 KiB action-body limit", async () => {
    const body = JSON.stringify({
      paneId: "w:p1",
      sessionId: "session-1",
      messages: [{ messageId: "assistant-1", text: "x".repeat(20_000) }],
      commands: [],
    });
    const request = Readable.from([body]) as unknown as Parameters<typeof readPanelSessionJson>[0];

    await expect(readPanelSessionJson(request)).resolves.toEqual(JSON.parse(body));
  });
});

describe("Git Changes full-review launch", () => {
  test("coalesces simultaneous launches for the same pane session into one review", async () => {
    type Review = { paneId: string; sessionId: string; cwd: string; port: number };
    const active = new Map<string, Review>();
    const launches = new Map<string, PendingGitChangesReviewLaunch<Review>>();
    let created = 0;

    const launch = async () => {
      created += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { paneId: "w:p1", sessionId: "session-1", cwd: "/repo", port: 41000 + created };
    };

    const [first, second] = await Promise.all([
      reuseOrLaunchGitChangesReview(active, launches, "w:p1", "session-1", "/repo", launch),
      reuseOrLaunchGitChangesReview(active, launches, "w:p1", "session-1", "/repo", launch),
    ]);

    expect(created).toBe(1);
    expect(first).toEqual({ review: { paneId: "w:p1", sessionId: "session-1", cwd: "/repo", port: 41001 }, reused: false });
    expect(second).toEqual({ review: { paneId: "w:p1", sessionId: "session-1", cwd: "/repo", port: 41001 }, reused: true });
    expect(active.get("w:p1")).toEqual(first.review);
    expect(launches.has("w:p1")).toBe(false);
  });

  test("releases the reservation after a failed launch so the pane can retry", async () => {
    type Review = { paneId: string; sessionId: string; cwd: string };
    const active = new Map<string, Review>();
    const launches = new Map<string, PendingGitChangesReviewLaunch<Review>>();

    await expect(reuseOrLaunchGitChangesReview(
      active,
      launches,
      "w:p1",
      "session-1",
      "/repo",
      () => { throw new Error("review startup failed"); },
    )).rejects.toThrow("review startup failed");

    const retried = await reuseOrLaunchGitChangesReview(
      active,
      launches,
      "w:p1",
      "session-1",
      "/repo",
      async () => ({ paneId: "w:p1", sessionId: "session-1", cwd: "/repo" }),
    );

    expect(retried.reused).toBe(false);
    expect(launches.has("w:p1")).toBe(false);
  });

  test("does not make a replacement session await a stale failed launch", async () => {
    type Review = { paneId: string; sessionId: string; cwd: string };
    const active = new Map<string, Review>();
    const launches = new Map<string, PendingGitChangesReviewLaunch<Review>>();
    let rejectOldLaunch!: (error: Error) => void;
    const oldLaunch = reuseOrLaunchGitChangesReview(
      active,
      launches,
      "w:p1",
      "session-a",
      "/repo",
      () => new Promise<Review>((_, reject) => { rejectOldLaunch = reject; }),
    );
    await Promise.resolve();

    const replacement = await reuseOrLaunchGitChangesReview(
      active,
      launches,
      "w:p1",
      "session-b",
      "/repo",
      async () => ({ paneId: "w:p1", sessionId: "session-b", cwd: "/repo" }),
    );
    rejectOldLaunch(new Error("stale launch failed"));

    await expect(oldLaunch).rejects.toThrow("superseded");
    expect(replacement).toEqual({
      review: { paneId: "w:p1", sessionId: "session-b", cwd: "/repo" },
      reused: false,
    });
    expect(active.get("w:p1")).toEqual(replacement.review);
  });

  test("disposes a launch cancelled before its review server becomes active", async () => {
    type Review = { paneId: string; sessionId: string; cwd: string };
    const active = new Map<string, Review>();
    const launches = new Map<string, PendingGitChangesReviewLaunch<Review>>();
    let resolveLaunch!: (review: Review) => void;
    let disposed = 0;
    const pending = reuseOrLaunchGitChangesReview(
      active,
      launches,
      "w:p1",
      "session-a",
      "/repo",
      () => new Promise<Review>((resolve) => { resolveLaunch = resolve; }),
      () => { disposed += 1; },
    );
    await Promise.resolve();

    cancelPendingGitChangesReviewLaunch(launches, "w:p1", "session-a");
    resolveLaunch({ paneId: "w:p1", sessionId: "session-a", cwd: "/repo" });

    await expect(pending).rejects.toThrow("superseded");
    expect(disposed).toBe(1);
    expect(active.has("w:p1")).toBe(false);
  });
});

describe("workspaceStatus", () => {
  test("includes committed branch changes in the Git Changes payload", async () => {
    const repo = createTemporaryRepository();
    writeFileSync(join(repo, "base.ts"), "export const base = true;\n");
    writeFileSync(join(repo, "changed.ts"), "export const version = 1;\n");
    writeFileSync(join(repo, "renamed.ts"), "export const name = 'old';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    git(repo, "checkout", "-b", "feature/live-review");
    writeFileSync(join(repo, "committed.ts"), "export const committed = true;\n");
    writeFileSync(join(repo, "changed.ts"), "export const version = 2;\nexport const extra = true;\n");
    git(repo, "mv", "renamed.ts", "renamed-new.ts");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "committed branch changes");

    const cleanStatus = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(cleanStatus.stdout).toBe("");

    const status = await workspaceStatus(repo);

    expect(status.available).toBe(true);
    expect(status.files[join(repo, "committed.ts")]).toMatchObject({
      status: "added",
      additions: 1,
      deletions: 0,
      staged: false,
      unstaged: false,
    });
    expect(status.files[join(repo, "changed.ts")]).toMatchObject({
      status: "modified",
      additions: 2,
      deletions: 1,
      staged: false,
      unstaged: false,
    });
    expect(status.files[join(repo, "renamed-new.ts")]).toMatchObject({
      status: "renamed",
      oldPath: join(repo, "renamed.ts"),
      additions: 0,
      deletions: 0,
      staged: false,
      unstaged: false,
    });
    expect(status.sinceBase).toMatchObject({
      base: "main",
      files: {
        "committed.ts": { group: "committed", staged: false },
        "changed.ts": { group: "committed", staged: false },
        "renamed-new.ts": { group: "committed", staged: false },
      },
    });
  });

  test("combines committed, working-tree, and untracked changes without leaking a sibling directory", async () => {
    const repo = createTemporaryRepository();
    const pane = join(repo, "apps", "pane");
    const sibling = join(repo, "apps", "sibling");
    mkdirSync(pane, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(pane, "base.ts"), "export const base = true;\n");
    writeFileSync(join(sibling, "secret.ts"), "export const secret = false;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    git(repo, "checkout", "-b", "feature/live-review");
    writeFileSync(join(pane, "committed.ts"), "export const committed = true;\n");
    writeFileSync(join(sibling, "secret.ts"), "export const secret = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "branch work");

    writeFileSync(join(pane, "base.ts"), "export const base = false;\n");
    writeFileSync(join(pane, "untracked.ts"), "export const untracked = true;\n");

    const status = await workspaceStatus(pane);

    expect(status.available).toBe(true);
    expect(Object.keys(status.files).sort()).toEqual([
      join(pane, "base.ts"),
      join(pane, "committed.ts"),
      join(pane, "untracked.ts"),
    ]);
    expect(status.files[join(pane, "committed.ts")]?.staged).toBe(false);
    expect(status.files[join(pane, "base.ts")]).toMatchObject({ status: "modified", unstaged: true });
    expect(status.files[join(pane, "untracked.ts")]).toMatchObject({ status: "untracked", additions: 1 });
    expect(status.sinceBase?.files).toEqual({
      "apps/pane/base.ts": { group: "changes", staged: false },
      "apps/pane/committed.ts": { group: "committed", staged: false },
      "apps/pane/untracked.ts": { group: "untracked", staged: false },
    });
  });

  test("keeps composite since-base line counts for a committed-and-modified file", async () => {
    const repo = createTemporaryRepository();
    writeFileSync(join(repo, "tracked.ts"), "export const version = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    git(repo, "checkout", "-b", "feature/live-review");
    writeFileSync(join(repo, "tracked.ts"), "export const version = 2;\n");
    git(repo, "add", "tracked.ts");
    git(repo, "commit", "-m", "committed change");
    writeFileSync(join(repo, "tracked.ts"), "export const version = 3;\nexport const working = true;\n");

    const status = await workspaceStatus(repo);

    expect(status.files[join(repo, "tracked.ts")]).toMatchObject({
      status: "modified",
      additions: 2,
      deletions: 1,
      staged: false,
      unstaged: true,
    });
    expect(status.sinceBase?.files["tracked.ts"]).toEqual({ group: "changes", staged: false });
  });
});

describe("Git Changes live stream", () => {
  test("rejects a directory that is not a currently live pane root", async () => {
    const repo = createTemporaryRepository();
    const outside = mkdtempSync(join(tmpdir(), "plannotator-herdr-outside-"));
    temporaryRepos.push(outside);
    const response = await invokeWorkspaceFilesStream(outside, [{
      id: "w:p1",
      workspace: "one",
      tab: "",
      panel: "Pane p1",
      cwd: repo,
      status: "idle",
      focused: true,
    }]);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Directory is not a currently live Herdr Pi workspace" });
  });

  test("publishes a changed event after a file changes in an authorized live pane root", async () => {
    const repo = createTemporaryRepository();
    writeFileSync(join(repo, "base.ts"), "export const base = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    const panels: HerdrPanel[] = [{
      id: "w:p1",
      workspace: "one",
      tab: "",
      panel: "Pane p1",
      cwd: repo,
      status: "idle",
      focused: true,
    }];
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      void serveWorkspaceFilesStream(request, response, url, panels);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const streamUrl = new URL(`http://127.0.0.1:${address.port}/api/reference/files/stream`);
      streamUrl.searchParams.append("dirPath", repo);
      const response = await fetch(streamUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const eventsPromise = readSSEEvents(response, 2);
      // Chokidar emits the stream's ready frame before its recursive watcher
      // finishes attaching. Let this tiny fixture settle, then exercise a live
      // user edit rather than racing watcher initialization.
      await new Promise((resolve) => setTimeout(resolve, 250));
      writeFileSync(join(repo, "changed.ts"), "export const changed = true;\n");
      const events = await eventsPromise;

      expect(events.map(({ type, dirPath }) => ({ type, dirPath }))).toEqual([
        { type: "ready", dirPath: repo },
        { type: "changed", dirPath: repo },
      ]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

async function invokeWorkspaceFilesStream(dirPath: string, panels: HerdrPanel[]): Promise<Response> {
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void serveWorkspaceFilesStream(request, response, url, panels);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    return await fetch(`http://127.0.0.1:${address.port}/api/reference/files/stream?dirPath=${encodeURIComponent(dirPath)}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function readSSEEvents(
  response: Response,
  count: number,
): Promise<Array<{ type?: string; dirPath?: string }>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const decoder = new TextDecoder();
  const events: Array<{ type?: string; dirPath?: string }> = [];
  let pending = "";

  try {
    while (events.length < count) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 3_000)),
      ]);
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      const blocks = pending.split("\n\n");
      pending = blocks.pop() ?? "";
      for (const block of blocks) {
        const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
        if (line) events.push(JSON.parse(line.slice("data: ".length)));
      }
    }
    return events;
  } finally {
    await reader.cancel();
  }
}

describe("LiveSnapshotPublisher", () => {
  test("publishes a newer focused-pane snapshot immediately and does not republish unchanged state", async () => {
    let current = { focusedPaneId: "w:p7", selectedMessageId: "w:p7:waiting" };
    const publisher = new LiveSnapshotPublisher(async () => current);
    const received: Array<{ revision: number; value: typeof current }> = [];

    const first = await publisher.refresh();
    const unsubscribe = publisher.subscribe((snapshot) => received.push(snapshot));
    expect(first).toEqual({ revision: 1, value: { focusedPaneId: "w:p7", selectedMessageId: "w:p7:waiting" } });
    expect(received).toEqual([first]);

    const unchanged = await publisher.refresh();
    expect(unchanged).toBe(first);
    expect(received).toEqual([first]);

    current = { focusedPaneId: "w:p1", selectedMessageId: "w:p1:response-1" };
    const switched = await publisher.refresh();

    expect(switched).toEqual({ revision: 2, value: { focusedPaneId: "w:p1", selectedMessageId: "w:p1:response-1" } });
    expect(received).toEqual([first, switched]);
    unsubscribe();
  });
});

describe("feedbackBatch", () => {
  test("attributes global image attachments to the selected structured live response", () => {
    const messages = [{
      messageId: "w:p1:pi-message-1",
      paneId: "w:p1",
      assistantMessageId: "pi-message-1",
      text: "Structured response",
      label: "Response 1 · latest",
      description: "Structured Pi assistant response",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "working" as const,
      cwd: "/one",
    }];

    expect(feedbackBatch({
      annotations: [],
      codeAnnotations: [],
      selectedMessageId: "w:p1:pi-message-1",
      globalAttachments: [{ path: "/tmp/plannotator/reference.png", name: "reference" }],
    }, messages)).toEqual({
      paneId: "w:p1",
      batch: expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: "pi-message-1",
          annotations: [],
          globalAttachments: [{ path: "/tmp/plannotator/reference.png", name: "reference" }],
        })],
      }),
    });
  });

  test("attributes code-only feedback to the selected structured live response", () => {
    const messages = [{
      messageId: "w:p1:pi-message-1",
      paneId: "w:p1",
      assistantMessageId: "pi-message-1",
      text: "Structured response",
      label: "Response 1 · latest",
      description: "Structured Pi assistant response",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "working" as const,
      cwd: "/one",
    }];

    expect(feedbackBatch({
      annotations: [],
      codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
      selectedMessageId: "w:p1:pi-message-1",
    }, messages)).toEqual({
      paneId: "w:p1",
      batch: expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: "pi-message-1",
          annotations: [],
          codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
        })],
      }),
    });
  });
});

describe("commandArgv", () => {
  test("parses executable arguments without shell evaluation", () => {
    expect(commandArgv('pi --model "claude sonnet"')).toEqual(["pi", "--model", "claude sonnet"]);
    expect(commandArgv("pi 'two words'")).toEqual(["pi", "two words"]);
  });

  test("rejects empty and incomplete commands", () => {
    expect(commandArgv("   ")).toBeNull();
    expect(commandArgv("pi \\")).toBeNull();
    expect(commandArgv("pi 'unterminated")).toBeNull();
  });
});

describe("commandDelivery", () => {
  const panel: HerdrPanel = { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "idle", focused: true };
  const registrations = new Map<string, PanelSessionEnrichment>([
    ["w:p1", {
      paneId: "w:p1",
      sessionId: "session-1",
      messages: [],
      commands: [{ name: "handoff-to-continue", description: "Write a handoff", source: "extension" }],
    }],
  ]);

  test("accepts an explicitly supported command for the current live pane session", () => {
    expect(commandDelivery({ paneId: "w:p1", command: "handoff-to-continue", args: "preserve this task" }, [panel], registrations)).toEqual({
      paneId: "w:p1",
      command: "handoff-to-continue",
      args: "preserve this task",
    });
  });

  test("rejects a raw slash-prefixed message and commands absent from this pane session", () => {
    expect(commandDelivery({ paneId: "w:p1", command: "/handoff-to-continue" }, [panel], registrations)).toBeNull();
    expect(commandDelivery({ paneId: "w:p1", command: "continue-handoff" }, [panel], registrations)).toBeNull();
    expect(commandDelivery({ paneId: "w:p2", command: "handoff-to-continue" }, [panel], registrations)).toBeNull();
  });

  test("drops the capability when the pane session is replaced", () => {
    const replaced = new Map(registrations);
    replaced.set("w:p1", { paneId: "w:p1", sessionId: "session-2", messages: [], commands: [] });
    expect(commandDelivery({ paneId: "w:p1", command: "handoff-to-continue" }, [panel], replaced)).toBeNull();
  });
});

describe("scoutDelivery", () => {
  const panel: HerdrPanel = { id: "w:p1", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "idle", focused: true };
  const source = {
    messageId: "w:p1:assistant-1", paneId: "w:p1", piSessionId: "session-1", assistantMessageId: "assistant-1",
    text: "I will replace the auth flow.", label: "Response 1 · latest", description: "Structured Pi assistant response",
    paneLabel: "one", paneDescription: "Pane p1", agentStatus: "idle" as const, cwd: "/one", workspaceId: "workspace-1",
  };
  const snapshot = { messages: [source], selectedMessageId: source.messageId, unreadMessageIds: [], draftsByMessageId: {}, sentAnnotationsByMessageId: {}, reviewRoundStatus: "open" as const, deliveryError: null };
  const registrations = new Map<string, PanelSessionEnrichment>([["w:p1", { paneId: "w:p1", sessionId: "session-1", messages: [{ messageId: "assistant-1", text: source.text }], commands: [] }]]);

  test("uses only the live registered structured source response to build a bounded Scout briefing", () => {
    const delivery = scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: source.messageId, question: "Find the unsafe assumptions." }, snapshot, [panel], registrations);
    expect(delivery?.request.sourceSessionId).toBe("session-1");
    expect(delivery?.request.prompt).toContain("Ideal direction");
    expect(delivery?.request.prompt).toContain(source.text);
    expect(delivery?.request.prompt).toContain("Find the unsafe assumptions.");
  });

  test("rejects waiting documents, foreign messages, and replaced source sessions", () => {
    expect(scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: "w:p1:waiting", question: "Inspect" }, snapshot, [panel], registrations)).toBeNull();
    expect(scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: source.messageId, question: "Inspect" }, snapshot, [panel], new Map([["w:p1", { ...registrations.get("w:p1")!, sessionId: "session-2" }]]))).toBeNull();
  });
});

describe("instructionDelivery", () => {
  test("accepts a text instruction for a live pane before it has an assistant response", () => {
    expect(instructionDelivery({ paneId: "w:p1", text: "Please start by checking the logs." }, [{
      messageId: "w:p1:waiting",
      paneId: "w:p1",
      piSessionId: "session-1",
      text: "Waiting for the Pi session to publish its latest assistant response.",
      label: "Waiting for a response",
      description: "No structured assistant response published yet",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "idle" as const,
      cwd: "/one",
    }])).toEqual({ paneId: "w:p1", content: "Please start by checking the logs." });
  });

  test("rejects instructions without live pane text", () => {
    expect(instructionDelivery({ paneId: "w:p1", text: "   " }, [])).toBeNull();
    expect(instructionDelivery({ paneId: "closed:p1", text: "Hello" }, [])).toBeNull();
  });
});

describe("panelsFromSnapshot", () => {
  test("lists only live Pi agents with Herdr workspace and tab labels", () => {
    expect(panelsFromSnapshot({
      workspaces: [{ workspace_id: "workspace-1", label: "pi-harness" }],
      tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1", label: "plannotator" }],
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          foreground_cwd: "/home/me/codes/pi-harness",
          pane_id: "workspace-1:p9",
          tab_id: "tab-1",
          workspace_id: "workspace-1",
          focused: true,
        },
        {
          agent: "claude",
          agent_status: "working",
          cwd: "/home/me/codes/other",
          pane_id: "workspace-1:p10",
        },
      ],
    })).toEqual([{
      id: "workspace-1:p9",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      workspace: "pi-harness",
      tab: "plannotator",
      panel: "Pane p9",
      cwd: "/home/me/codes/pi-harness",
      status: "working",
      focused: true,
    }]);
  });

  test("uses stable fallbacks when Herdr has no resource labels", () => {
    expect(panelsFromSnapshot({
      agents: [{ agent: "pi", agent_status: "idle", cwd: "/work/repo", pane_id: "w:p1" }],
    })).toEqual([{
      id: "w:p1",
      workspaceId: "",
      tabId: "",
      workspace: "repo",
      tab: "",
      panel: "Pane p1",
      cwd: "/work/repo",
      status: "idle",
      focused: false,
    }]);
  });

  test("renders each pane's structured response history newest-first while retaining pane and Pi message identities", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session-1", commands: [], messages: [
        { messageId: "pi-message-1", text: "Newest response", timestamp: "2026-07-18T00:00:00.000Z" },
        { messageId: "pi-message-0", text: "Older response" },
      ] }],
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", commands: [], messages: [{ messageId: "pi-message-2", text: "Second pane response" }] }],
    ]);

    const snapshot = reviewSnapshotFromPanels(panels, "w:p2", enrichments);
    expect(snapshot.selectedMessageId).toBe("w:p2:pi-message-2");
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        messageId: "w:p1:pi-message-1",
        paneId: "w:p1",
        piSessionId: "session-1",
        assistantMessageId: "pi-message-1",
        text: "Newest response",
        timestamp: "2026-07-18T00:00:00.000Z",
        label: "Response 1 · latest",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p1:pi-message-0",
        paneId: "w:p1",
        assistantMessageId: "pi-message-0",
        text: "Older response",
        label: "Response 2",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p2:pi-message-2",
        paneId: "w:p2",
        piSessionId: "session-2",
        assistantMessageId: "pi-message-2",
        text: "Second pane response",
        paneLabel: "two",
      }),
    ]);
  });

  test("selects the newest response in the focused pane by default", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session", commands: [], messages: [
        { messageId: "newest", text: "Newest" },
        { messageId: "older", text: "Older" },
      ] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, null, enrichments).selectedMessageId).toBe("w:p1:newest");
  });

  test("shows a truthful waiting document until the Pi extension enriches a live pane", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    const snapshot = reviewSnapshotFromPanels(panels);
    expect(snapshot.selectedMessageId).toBe("w:p1:waiting");
    expect(snapshot.messages[0].text).toContain("Waiting for the Pi session");
    expect(snapshot.messages[0].text).not.toContain("**Status:**");
  });

  test("escapes the waiting document working directory while preserving its copyable value", () => {
    const cwd = '/work/\"><img src=x onerror=alert(1)>';
    const snapshot = reviewSnapshotFromPanels([
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd, status: "working", focused: true },
    ]);

    expect(snapshot.messages[0].text).toContain('title="Working directory — select to copy: /work/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(snapshot.messages[0].text).toContain('/work/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(snapshot.messages[0].text).not.toContain('<img src=x');
  });

  test("keeps a live user pane selection across assistant message changes", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", commands: [], messages: [{ messageId: "new-message", text: "New response" }] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, "w:p2", enrichments).selectedMessageId).toBe("w:p2:new-message");
  });

  test("falls back when the remembered panel is no longer live", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    expect(reviewSnapshotFromPanels(panels, "w:p2").selectedMessageId).toBe("w:p1:waiting");
  });

  test("does not let a shutting-down previous session remove a newer pane registration", () => {
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "new-session", commands: [], messages: [{ messageId: "message", text: "Newest response" }] }],
    ]);

    expect(releasePanelSession(enrichments, "w:p1", "old-session")).toBe(false);
    expect(enrichments.get("w:p1")?.sessionId).toBe("new-session");
    expect(releasePanelSession(enrichments, "w:p1", "new-session")).toBe(true);
    expect(enrichments.has("w:p1")).toBe(false);
  });

  test("includes scouts in reviewSnapshotFromPanels and handles pruning and status sync", () => {
    managedScouts.clear();
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: null,
      delivered: false,
    });

    // Test 1: includes scout when live panel matches key/cwd
    const panel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "working", focused: true };
    let snapshot = reviewSnapshotFromPanels([panel], null, new Map());
    expect(snapshot.scouts).toEqual([
      {
        workspaceKey: "workspace-1:/one",
        workspaceId: "workspace-1",
        cwd: "/one",
        paneId: "w:p2",
        status: "running",
      },
    ]);

    // Test 2: transitions running -> ready when delivered is true and panel is idle
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: true,
    });
    const idlePanel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "idle", focused: true };
    snapshot = reviewSnapshotFromPanels([idlePanel], null, new Map());
    expect(snapshot.scouts?.[0].status).toBe("ready");
    expect(managedScouts.get("workspace-1:/one")?.status).toBe("ready");
    expect(managedScouts.get("workspace-1:/one")?.pending).toBeNull();

    // Test 3: remains running if panel is working
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: true,
    });
    const workingPanel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "working", focused: true };
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    expect(snapshot.scouts?.[0].status).toBe("running");

    // Test 4: handles failed status and includes error
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "failed",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: false,
      error: "Could not deliver prompt",
    });
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    expect(snapshot.scouts?.[0]).toEqual({
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "failed",
      error: "Could not deliver prompt",
    });

    // Test 5: prunes duplicate/stale mappings
    managedScouts.set("workspace-1:/two", {
      workspaceKey: "workspace-1:/two",
      workspaceId: "workspace-1",
      cwd: "/two",
      paneId: "w:p2",
      status: "ready",
      pending: null,
      delivered: false,
    });
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    // Since workingPanel cwd is /one, the workspace-1:/two mapping is stale and is pruned
    expect(snapshot.scouts?.length).toBe(1);
    expect(managedScouts.has("workspace-1:/two")).toBe(false);

    managedScouts.clear();
  });
});
