import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeLiveSession, resetClaudeLiveSessionCache, sessionIdFromLogPath } from "./claude-live-session";

const temporaryDirs: string[] = [];

afterEach(() => {
  resetClaudeLiveSessionCache();
  while (temporaryDirs.length > 0) rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

/** Claude Code's own layout: ~/.claude/projects/<slug>/<session-uuid>.jsonl */
function projectsDirWithSession(cwd: string, sessionId: string, lines: unknown[]): string {
  const projectsDir = mkdtempSync(join(tmpdir(), "plannotator-claude-projects-"));
  temporaryDirs.push(projectsDir);
  const projectDir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return projectsDir;
}

function assistant(id: string, text: string, timestamp?: string): unknown {
  return { type: "assistant", timestamp, message: { id, role: "assistant", content: [{ type: "text", text }] } };
}

describe("readClaudeLiveSession", () => {
  test("reads a pane's newest assistant messages newest-first, with the session uuid", async () => {
    const projectsDir = projectsDirWithSession("/repos/app", "5f0b6b3e-0000-4000-8000-000000000001", [
      { type: "user", message: { role: "user", content: "start" } },
      assistant("msg_1", "First reply", "2026-07-26T00:00:00.000Z"),
      { type: "user", message: { role: "user", content: "more" } },
      assistant("msg_2", "Second reply", "2026-07-26T00:01:00.000Z"),
    ]);
    expect(await readClaudeLiveSession("/repos/app", 20, projectsDir)).toEqual({
      sessionId: "5f0b6b3e-0000-4000-8000-000000000001",
      messages: [
        { messageId: "msg_2", text: "Second reply", timestamp: "2026-07-26T00:01:00.000Z" },
        { messageId: "msg_1", text: "First reply", timestamp: "2026-07-26T00:00:00.000Z" },
      ],
    });
  });

  test("honours the retention limit", async () => {
    const projectsDir = projectsDirWithSession("/repos/app", "5f0b6b3e-0000-4000-8000-000000000002", [
      assistant("msg_1", "one"),
      assistant("msg_2", "two"),
      assistant("msg_3", "three"),
    ]);
    const session = await readClaudeLiveSession("/repos/app", 2, projectsDir);
    expect(session?.messages.map((message) => message.messageId)).toEqual(["msg_3", "msg_2"]);
  });

  test("returns null for a directory Claude Code has never run in", async () => {
    const projectsDir = projectsDirWithSession("/repos/app", "5f0b6b3e-0000-4000-8000-000000000003", [assistant("msg_1", "hi")]);
    expect(await readClaudeLiveSession("/repos/elsewhere", 20, projectsDir)).toBeNull();
  });

  test("returns null for a session log with no rendered assistant text", async () => {
    const projectsDir = projectsDirWithSession("/repos/app", "5f0b6b3e-0000-4000-8000-000000000004", [
      { type: "user", message: { role: "user", content: "start" } },
      { type: "system", subtype: "hook" },
    ]);
    expect(await readClaudeLiveSession("/repos/app", 20, projectsDir)).toBeNull();
  });

  test("survives a truncated tail line without losing the rest of the transcript", async () => {
    // The log is appended to live; the final line is routinely half-written.
    const projectsDir = mkdtempSync(join(tmpdir(), "plannotator-claude-projects-"));
    temporaryDirs.push(projectsDir);
    const projectDir = join(projectsDir, "-repos-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "5f0b6b3e-0000-4000-8000-000000000005.jsonl"),
      `${JSON.stringify(assistant("msg_1", "complete"))}\n{"type":"assistant","message":{"id":"msg_2"`,
    );
    const session = await readClaudeLiveSession("/repos/app", 20, projectsDir);
    expect(session?.messages).toEqual([{ messageId: "msg_1", text: "complete" }]);
  });

  test("picks up newly appended messages rather than serving a stale cache", async () => {
    const projectsDir = projectsDirWithSession("/repos/app", "5f0b6b3e-0000-4000-8000-000000000006", [assistant("msg_1", "one")]);
    expect((await readClaudeLiveSession("/repos/app", 20, projectsDir))?.messages).toHaveLength(1);
    writeFileSync(
      join(projectsDir, "-repos-app", "5f0b6b3e-0000-4000-8000-000000000006.jsonl"),
      [assistant("msg_1", "one"), assistant("msg_2", "two")].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const session = await readClaudeLiveSession("/repos/app", 20, projectsDir);
    expect(session?.messages.map((message) => message.messageId)).toEqual(["msg_2", "msg_1"]);
  });
});

describe("sessionIdFromLogPath", () => {
  test("uses the log's uuid basename", () => {
    expect(sessionIdFromLogPath("/home/me/.claude/projects/-repos-app/abc-123.jsonl")).toBe("abc-123");
  });
});
