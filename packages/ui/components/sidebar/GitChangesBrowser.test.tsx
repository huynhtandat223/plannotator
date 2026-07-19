import { afterEach, expect, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DirState } from "../../hooks/useFileBrowser";
import { GitChangesBrowser } from "./GitChangesBrowser";

const hasDom = typeof document !== "undefined";
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function renderBrowser(dirs: DirState[], rootPath = "/repo", onOpenFullReview?: () => void): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<GitChangesBrowser dirs={dirs} rootPath={rootPath} onRefresh={() => {}} onOpenFullReview={onOpenFullReview} />);
  });
}

test.skipIf(!hasDom)("renders the standard since-base committed, changes, and untracked groups", async () => {
  const dirs: DirState[] = [{
    path: "/repo",
    name: "repo",
    tree: [],
    isLoading: false,
    error: null,
    workspaceStatus: {
      available: true,
      rootPath: "/repo",
      repoRoot: "/repo",
      sinceBase: {
        base: "origin/main",
        mergeBase: "abc123",
        files: {
          "committed.ts": { group: "committed", staged: false },
          "working.ts": { group: "changes", staged: true },
          "untracked.ts": { group: "untracked", staged: false },
        },
      },
      files: {
        "/repo/committed.ts": {
          path: "/repo/committed.ts", repoRelativePath: "committed.ts", status: "added",
          additions: 1, deletions: 0, staged: false, unstaged: false,
        },
        "/repo/working.ts": {
          path: "/repo/working.ts", repoRelativePath: "working.ts", status: "modified",
          additions: 1, deletions: 1, staged: true, unstaged: false,
        },
        "/repo/untracked.ts": {
          path: "/repo/untracked.ts", repoRelativePath: "untracked.ts", status: "untracked",
          additions: 1, deletions: 0, staged: false, unstaged: false,
        },
      },
      totals: { files: 3, additions: 3, deletions: 1 },
    },
  }];

  renderBrowser(dirs);

  expect(host!.textContent).toContain("All changes since origin/main");
  expect(host!.textContent).toContain("Committed · 1");
  expect(host!.textContent).toContain("Changes · 1");
  expect(host!.textContent).toContain("Untracked · 1");
  expect(host!.textContent).not.toContain("Staged ·");
});

test.skipIf(!hasDom)("renders and invokes the full review action only when selected-pane changes exist", () => {
  const dirs: DirState[] = [{
    path: "/repo",
    name: "repo",
    tree: [],
    isLoading: false,
    error: null,
    workspaceStatus: {
      available: true,
      rootPath: "/repo",
      files: {
        "/repo/changed.ts": {
          path: "/repo/changed.ts", repoRelativePath: "changed.ts", status: "modified",
          additions: 1, deletions: 0, staged: false, unstaged: true,
        },
      },
      totals: { files: 1, additions: 1, deletions: 0 },
    },
  }];
  let opened = 0;

  renderBrowser(dirs, "/repo", () => { opened += 1; });

  expect(host!.textContent).toContain("Open full review");
  act(() => (host!.querySelector("button[data-open-full-review]") as HTMLButtonElement).click());
  expect(opened).toBe(1);

  act(() => root!.unmount());
  host!.replaceChildren();
  root = createRoot(host!);
  act(() => root!.render(<GitChangesBrowser dirs={[]} rootPath="/repo" onRefresh={() => {}} onOpenFullReview={() => {}} />));
  expect(host!.textContent).not.toContain("Open full review");
});

test.skipIf(!hasDom)("shows loading before the selected pane repository snapshot arrives", () => {
  renderBrowser([], "/repo");

  expect(host!.textContent).toContain("Loading Git changes");
  expect(host!.textContent).not.toContain("No Git changes");
});

test.skipIf(!hasDom)("shows the selected pane repository error instead of an empty state", () => {
  renderBrowser([{
    path: "/repo",
    name: "repo",
    tree: [],
    isLoading: false,
    error: "Failed to connect to server",
  }]);

  expect(host!.textContent).toContain("Failed to connect to server");
  expect(host!.textContent).not.toContain("No Git changes");
});

test.skipIf(!hasDom)("does not aggregate Git changes from another pane directory", () => {
  const change = (rootPath: string, file: string): DirState => ({
    path: rootPath,
    name: rootPath.slice(1),
    tree: [],
    isLoading: false,
    error: null,
    workspaceStatus: {
      available: true,
      rootPath,
      files: {
        [`${rootPath}/${file}`]: {
          path: `${rootPath}/${file}`,
          repoRelativePath: file,
          status: "modified",
          additions: 1,
          deletions: 0,
          staged: false,
          unstaged: true,
        },
      },
      totals: { files: 1, additions: 1, deletions: 0 },
    },
  });

  renderBrowser([change("/repo", "selected.ts"), change("/other", "foreign.ts")], "/repo");

  expect(host!.textContent).toContain("selected.ts");
  expect(host!.textContent).not.toContain("foreign.ts");
});
