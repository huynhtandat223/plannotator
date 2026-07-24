import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SingleFlight } from "../../packages/shared/single-flight";
import {
  LiveSnapshotPublisher,
  acceptsPanelSessionUpdate,
  commandArgv,
  commandDelivery,
  feedbackBatch,
  formatInstructionFileReferences,
  instructionDelivery,
  panelsFromSnapshot,
  releasePanelSession,
  reviewSnapshotFromPanels,
  searchLiveWorkspaceFiles,
  readPanelSessionJson,
  serveWorkspaceFilesStream,
  panelSessions,
  notifyPanelSessionWaiters,
  waitForPanelSessionRegistration,
  waitForNextPanelSessionRegistration,
  type HerdrPanel,
  type PanelSessionEnrichment,
  workspaceStatus,
  sessionFallbackMetadataFromEntries,
  reuseOrLaunchGitChangesReview,
  cancelPendingGitChangesReviewLaunch,
  type PendingGitChangesReviewLaunch,
  askAiWorkspaceFromSnapshot,
  resolveOrCreateAskAiWorkspace,
  resolveHerdrAIWorkspace,
  createProcessPanel,
  isKnownProcessPanelWorkspace,
  selectHerdrAIWorkspace,
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

describe("Pi session metadata fallback", () => {
  test("uses Pi totalTokens for context but totals all billable usage", () => {
    const metadata = sessionFallbackMetadataFromEntries([
      { type: "model_change", provider: "9route", modelId: "cx/gpt-5.6-terra" },
      { type: "message", message: { role: "assistant", model: "cx/gpt-5.6-terra", provider: "9route", usage: { input: 4_000, output: 500, cacheRead: 200_000, cacheWrite: 0, totalTokens: 204_500 } } },
    ]);

    expect(metadata.contextUsage).toEqual({ tokens: 204_500, contextWindow: 1_050_000, percent: (204_500 / 1_050_000) * 100 });
    expect(metadata.totalUsedTokens).toBe(204_500);
    expect(metadata.model).toMatchObject({ id: "cx/gpt-5.6-terra", provider: "9route", name: "GPT-5.6 Terra" });
  });

  test("keeps context unknown until an assistant response after compaction", () => {
    const metadata = sessionFallbackMetadataFromEntries([
      { type: "model_change", provider: "9route", modelId: "cx/gpt-5.6-terra" },
      { type: "message", message: { role: "assistant", usage: { input: 3_000, output: 200, cacheRead: 100_000, cacheWrite: 0, totalTokens: 103_200 } } },
      { type: "compaction", tokensBefore: 103_200 },
    ]);

    expect(metadata.contextUsage).toEqual({ tokens: null, contextWindow: 1_050_000, percent: null });
    expect(metadata.latestCompactionTokens).toBe(103_200);
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

  test("does not reuse a review launched with a different compare mode", async () => {
    type Review = { paneId: string; sessionId: string; cwd: string; compareMode?: "since-base" | "head" | "unstaged" | "staged" };
    const active = new Map<string, Review>();
    const launches = new Map<string, PendingGitChangesReviewLaunch<Review>>();
    let created = 0;

    const first = await reuseOrLaunchGitChangesReview(
      active, launches, "w:p1", "session-1", "/repo",
      async () => ({ paneId: "w:p1", sessionId: "session-1", cwd: "/repo", compareMode: "since-base" }),
      undefined,
      "since-base",
    );
    const second = await reuseOrLaunchGitChangesReview(
      active, launches, "w:p1", "session-1", "/repo",
      async () => {
        created += 1;
        return { paneId: "w:p1", sessionId: "session-1", cwd: "/repo", compareMode: "head" };
      },
      undefined,
      "head",
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(created).toBe(1);
    expect(active.get("w:p1")?.compareMode).toBe("head");
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

  test("switches Git Changes comparison to HEAD, unstaged, or staged", async () => {
    const repo = createTemporaryRepository();
    writeFileSync(join(repo, "tracked.ts"), "export const version = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    writeFileSync(join(repo, "tracked.ts"), "export const version = 2;\n");
    git(repo, "add", "tracked.ts");
    writeFileSync(join(repo, "tracked.ts"), "export const version = 3;\n");
    writeFileSync(join(repo, "untracked.ts"), "export const fresh = true;\n");

    const head = await workspaceStatus(repo, "head");
    expect(Object.keys(head.files).sort()).toEqual([join(repo, "tracked.ts"), join(repo, "untracked.ts")]);
    expect(head.files[join(repo, "tracked.ts")]).toMatchObject({ additions: 1, deletions: 1, staged: false, unstaged: false });
    expect(head.files[join(repo, "untracked.ts")]).toMatchObject({ status: "untracked", additions: 1 });

    const unstaged = await workspaceStatus(repo, "unstaged");
    expect(Object.keys(unstaged.files).sort()).toEqual([join(repo, "tracked.ts"), join(repo, "untracked.ts")]);
    expect(unstaged.files[join(repo, "tracked.ts")]).toMatchObject({ additions: 1, deletions: 1, staged: false, unstaged: true });

    const staged = await workspaceStatus(repo, "staged");
    expect(Object.keys(staged.files)).toEqual([join(repo, "tracked.ts")]);
    expect(staged.files[join(repo, "tracked.ts")]).toMatchObject({ additions: 1, deletions: 1, staged: true, unstaged: false });
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

  test("rejects malformed commands and commands absent from this pane session", () => {
    expect(commandDelivery({ paneId: "w:p1", command: "/handoff-to-continue" }, [panel], registrations)).toBeNull();
    expect(commandDelivery({ paneId: "w:p2", command: "handoff-to-continue" }, [panel], registrations)).toBeNull();
  });

  test("drops the capability when the pane session is replaced", () => {
    const replaced = new Map(registrations);
    replaced.set("w:p1", { paneId: "w:p1", sessionId: "session-2", messages: [], commands: [] });
    expect(commandDelivery({ paneId: "w:p1", command: "handoff-to-continue" }, [panel], replaced)).toBeNull();
  });
});

describe("live workspace file mention search", () => {
  test("returns relative source paths from only the requested live pane workspace", async () => {
    const repo = createTemporaryRepository();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "App.tsx"), "export const App = 1;\n");
    writeFileSync(join(repo, "src", "App.test.tsx"), "export {};\n");
    mkdirSync(join(repo, "node_modules", "hidden"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "hidden", "secret.ts"), "export {};\n");
    const panels: HerdrPanel[] = [{ id: "w:p1", cwd: repo, status: "idle", name: "Pi" }];

    expect(await searchLiveWorkspaceFiles("w:p1", "app.tsx", panels)).toEqual(["src/App.tsx"]);
    expect(await searchLiveWorkspaceFiles("closed:p1", "app", panels)).toBeNull();
  });
});

describe("instruction file references", () => {
  test("adds canonical in-root file ranges before the literal user message", async () => {
    const repo = createTemporaryRepository();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "App.tsx"), "export const App = 1;\n");

    expect(await formatInstructionFileReferences("Please inspect @App.tsx:10-20", repo)).toEqual({
      content: [
        "Referenced workspace files (inspect these before answering):",
        "- `src/App.tsx`, lines 10-20",
        "",
        "Please inspect @App.tsx:10-20",
      ].join("\n"),
    });
  });

  test("rejects an explicit file mention outside the pane root", async () => {
    const repo = createTemporaryRepository();
    const sibling = mkdtempSync(join(tmpdir(), "plannotator-herdr-sibling-"));
    temporaryRepos.push(sibling);
    writeFileSync(join(sibling, "secret.ts"), "export const secret = true;\n");

    expect(await formatInstructionFileReferences(`Inspect @${join(sibling, "secret.ts")}`, repo)).toEqual({
      error: `Could not resolve referenced file: ${join(sibling, "secret.ts")}`,
    });
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

  test("passes Pi context, compaction, and Git branch metadata to every response in a pane", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true, gitBranch: "feature/herdr-metadata" },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([["w:p1", {
      paneId: "w:p1",
      sessionId: "session-1",
      commands: [],
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      model: { id: "cx/gpt-5.6-terra", provider: "9route" },
      activity: { kind: "subagent", count: 2 },
      totalUsedTokens: 5_300_000,
      latestCompactionTokens: 156_000,
      messages: [{ messageId: "assistant-1", text: "Response" }],
    }]]);

    expect(reviewSnapshotFromPanels(panels, null, enrichments).messages[0]).toMatchObject({
      gitBranch: "feature/herdr-metadata",
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      model: { id: "cx/gpt-5.6-terra", provider: "9route" },
      activity: { kind: "subagent", count: 2 },
      totalUsedTokens: 5_300_000,
      latestCompactionTokens: 156_000,
    });
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

});

describe("waitForPanelSessionRegistration", () => {
  const registration = (paneId: string, sessionId: string): PanelSessionEnrichment => ({
    paneId,
    sessionId,
    commands: [],
    messages: [],
  });

  afterEach(() => {
    panelSessions.clear();
  });

  test("resolves immediately when the pane is already registered", async () => {
    panelSessions.set("w:ready", registration("w:ready", "s-ready"));
    const start = Date.now();
    const result = await waitForPanelSessionRegistration("w:ready", 5_000);
    expect(result?.sessionId).toBe("s-ready");
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("resolves the moment a registration lands, without polling", async () => {
    const pending = waitForPanelSessionRegistration("w:late", 5_000);
    // Register on the next tick, as /api/session would.
    setTimeout(() => {
      panelSessions.set("w:late", registration("w:late", "s-late"));
      notifyPanelSessionWaiters("w:late");
    }, 20);
    const result = await pending;
    expect(result?.sessionId).toBe("s-late");
  });

  test("resolves undefined when no registration arrives before the timeout", async () => {
    const result = await waitForPanelSessionRegistration("w:never", 30);
    expect(result).toBeUndefined();
  });

  test("waits for a next registration even when a prior snapshot already exists", async () => {
    panelSessions.set("w:next", registration("w:next", "old"));
    const pending = waitForNextPanelSessionRegistration("w:next", 100);
    setTimeout(() => {
      panelSessions.set("w:next", registration("w:next", "new"));
      notifyPanelSessionWaiters("w:next");
    }, 20);
    await expect(pending).resolves.toMatchObject({ sessionId: "new" });
  });

  test("a late notify after timeout does not throw or double-resolve", async () => {
    const result = await waitForPanelSessionRegistration("w:stale", 20);
    expect(result).toBeUndefined();
    // The waiter already timed out and unregistered; this must be a no-op.
    panelSessions.set("w:stale", registration("w:stale", "s-stale"));
    expect(() => notifyPanelSessionWaiters("w:stale")).not.toThrow();
  });
});

describe("askAiWorkspaceFromSnapshot", () => {
  test("resolves a shell-only workspace by label+cwd via the panes array", () => {
    const workspaceId = askAiWorkspaceFromSnapshot({
      workspaces: [
        { workspace_id: "w1", label: "bridge-kernel-app" },
        { workspace_id: "w2", label: "other" },
      ],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", cwd: "/host/app", foreground_cwd: "/host/app" },
        { pane_id: "w2:p1", workspace_id: "w2", cwd: "/host/other" },
      ],
      agents: [],
    }, "bridge-kernel-app", "/host/app");
    expect(workspaceId).toBe("w1");
  });

  test("matches on foreground_cwd, falling back to cwd", () => {
    expect(askAiWorkspaceFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "bridge-kernel-app" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/other", foreground_cwd: "/host/app" }],
    }, "bridge-kernel-app", "/host/app")).toBe("w1");
    expect(askAiWorkspaceFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "bridge-kernel-app" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/host/app" }],
    }, "bridge-kernel-app", "/host/app")).toBe("w1");
  });

  test("does NOT reuse a mislabeled-at-different-path workspace (label matches, cwd differs)", () => {
    expect(askAiWorkspaceFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "bridge-kernel-app" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/somewhere/else" }],
    }, "bridge-kernel-app", "/host/app")).toBeNull();
  });

  test("does not match when the label differs even if a pane sits at cwd", () => {
    expect(askAiWorkspaceFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "not-it" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/host/app" }],
    }, "bridge-kernel-app", "/host/app")).toBeNull();
  });

  test("returns null on an empty snapshot", () => {
    expect(askAiWorkspaceFromSnapshot({}, "bridge-kernel-app", "/host/app")).toBeNull();
  });
});

describe("resolveOrCreateAskAiWorkspace", () => {
  test("reuses an existing workspace without creating a new one", async () => {
    let created = 0;
    const result = await resolveOrCreateAskAiWorkspace(
      "bridge-kernel-app",
      "/host/app",
      async () => ({
        workspaces: [{ workspace_id: "w1", label: "bridge-kernel-app" }],
        panes: [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/host/app" }],
      }),
      async () => { created++; return "should-not-happen"; },
    );
    expect(result).toEqual({ workspaceId: "w1", cwd: "/host/app" });
    expect(created).toBe(0);
  });

  test("creates the workspace when the snapshot has no match", async () => {
    let created = 0;
    const result = await resolveOrCreateAskAiWorkspace(
      "bridge-kernel-app",
      "/host/app",
      async () => ({ workspaces: [], panes: [] }),
      async (label, cwd) => { created++; expect(label).toBe("bridge-kernel-app"); expect(cwd).toBe("/host/app"); return "w-new"; },
    );
    expect(result).toEqual({ workspaceId: "w-new", cwd: "/host/app" });
    expect(created).toBe(1);
  });

  // ensureAskAiWorkspace wraps resolveOrCreateAskAiWorkspace in a SingleFlight
  // keyed on the label. Two near-simultaneous Ask AI creates must coalesce so
  // only ONE workspace is ever created for the same label.
  test("single-flight coalesces concurrent creates into one workspace", async () => {
    const flight = new SingleFlight<{ workspaceId: string; cwd: string }>();
    let created = 0;
    let releaseSnapshot: () => void = () => {};
    const snapshotGate = new Promise<void>((r) => { releaseSnapshot = r; });
    const run = () => flight.run("bridge-kernel-app", () => resolveOrCreateAskAiWorkspace(
      "bridge-kernel-app",
      "/host/app",
      async () => { await snapshotGate; return { workspaces: [], panes: [] }; },
      async () => { created++; return "w-new"; },
    ));
    const first = run();
    const second = run();
    releaseSnapshot();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ workspaceId: "w-new", cwd: "/host/app" });
    expect(b).toEqual({ workspaceId: "w-new", cwd: "/host/app" });
    expect(created).toBe(1);
  });
});

describe("selectHerdrAIWorkspace", () => {
  const sameCwdLivePanel: HerdrPanel = {
    id: "w-captain:p1",
    workspaceId: "w-captain",
    workspace: "captain",
    tab: "",
    panel: "Captain pane",
    cwd: "/host/app",
    status: "idle",
    focused: true,
  };

  test("locks a configured dedicated workspace identity ahead of a same-cwd live pane", () => {
    expect(selectHerdrAIWorkspace("/host/app", [sameCwdLivePanel], {
      workspaceId: "w-dedicated",
      cwd: "/host/app",
    })).toEqual({
      workspaceId: "w-dedicated",
      cwd: "/host/app",
      ensuredWorkspaceId: "w-dedicated",
    });
  });

  test("uses a same-cwd live pane only when no matching dedicated workspace exists", () => {
    expect(selectHerdrAIWorkspace("/host/app", [sameCwdLivePanel], null)).toEqual({
      workspaceId: "w-captain",
      cwd: "/host/app",
    });
    expect(selectHerdrAIWorkspace("/other", [sameCwdLivePanel], {
      workspaceId: "w-dedicated",
      cwd: "/host/app",
    })).toBeNull();
  });
});

describe("isKnownProcessPanelWorkspace (createProcessPanel guard)", () => {
  const livePanel: HerdrPanel = {
    id: "w-live:p1",
    workspaceId: "w-live",
    workspace: "live",
    tab: "",
    panel: "Pane p1",
    cwd: "/host/live",
    status: "idle",
    focused: false,
  };

  test("accepts a workspace that already hosts a live pi pane", () => {
    expect(isKnownProcessPanelWorkspace("w-live", [livePanel])).toBe(true);
  });

  test("accepts a vouched-for, pi-pane-less workspace absent from panels", () => {
    // The ensured Ask AI workspace may be shell-only, so it never appears in
    // `panels` (which is built from `agents`). The extra allow-set lets it
    // through without weakening the rejection of unknown ids.
    expect(isKnownProcessPanelWorkspace("w-ensured", [], new Set(["w-ensured"]))).toBe(true);
    expect(isKnownProcessPanelWorkspace("w-ensured", [livePanel], new Set(["w-ensured"]))).toBe(true);
  });

  test("still rejects an unknown workspaceId (neither live nor vouched-for)", () => {
    expect(isKnownProcessPanelWorkspace("w-unknown", [])).toBe(false);
    expect(isKnownProcessPanelWorkspace("w-unknown", [livePanel])).toBe(false);
    expect(isKnownProcessPanelWorkspace("w-unknown", [livePanel], new Set(["w-ensured"]))).toBe(false);
  });
});

// These createProcessPanel cases return null at the input/guard stage, BEFORE
// any live `herdr` CLI call, so they are safe to run in unit tests.
describe("createProcessPanel input guard (no live herdr)", () => {
  const validBody = {
    workspaceId: "w-ensured",
    cwd: "/does/not/exist/on/disk",
    panelName: "Ask AI",
    command: "pi --tools read,grep,find,ls",
  };

  test("rejects an unknown workspaceId that is neither a live panel nor vouched-for", async () => {
    expect(await createProcessPanel(validBody, [])).toBeNull();
  });

  test("rejects a vouched-for workspaceId that differs from the request", async () => {
    expect(await createProcessPanel(validBody, [], new Set(["some-other-ws"]))).toBeNull();
  });
});

// resolveHerdrAIWorkspace only touches live herdr on the requested-cwd branch
// (via discoverPanels). The no-cwd branch is driven entirely by the injected
// ensureWorkspace seam, so these cases stay off live herdr.
// resolveHerdrAIWorkspace's non-absolute-cwd branch takes an injectable
// ensureWorkspace, so feature-on/off behavior is unit-testable without touching
// live herdr (a real client cwd would call discoverPanels()).
describe("resolveHerdrAIWorkspace feature gate (no client cwd)", () => {
  test("feature OFF: preserves the exact legacy error message", async () => {
    await expect(resolveHerdrAIWorkspace(undefined, async () => null)).rejects.toThrow(
      "Select a live Pi response before starting Ask AI.",
    );
    await expect(resolveHerdrAIWorkspace("not-absolute", async () => null)).rejects.toThrow(
      "Select a live Pi response before starting Ask AI.",
    );
  });

  test("feature ON: resolves to the ensured workspace cwd instead of throwing", async () => {
    const cwd = await resolveHerdrAIWorkspace(undefined, async () => ({
      workspaceId: "w-ensured",
      cwd: "/host/app",
    }));
    expect(cwd).toBe("/host/app");
  });
});
