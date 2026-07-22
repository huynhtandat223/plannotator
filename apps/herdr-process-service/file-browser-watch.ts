import chokidar, { type FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative } from "node:path";

import { isFileBrowserExcludedPath } from "../../packages/shared/reference-common";
import { getGitMetadataWatchPaths } from "../../packages/shared/workspace-status";

interface FileBrowserChangeEvent {
  type: "ready" | "changed";
  dirPath: string;
  reason: "files" | "git" | "initial";
  timestamp: number;
}

interface WatchEntry {
  dirPath: string;
  subscribers: Map<ServerResponse, string>;
  contentWatcher: FSWatcher | null;
  gitWatcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const HEARTBEAT_MS = 30_000;
const DEBOUNCE_MS = 180;
const watchers = new Map<string, WatchEntry>();

function serialize(event: FileBrowserChangeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isFileBrowserWatchIgnoredPath(path: string, root: string): boolean {
  const rel = relative(root, path).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return isFileBrowserExcludedPath(rel);
}

async function isValidDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function broadcast(entry: WatchEntry, reason: FileBrowserChangeEvent["reason"]): void {
  for (const [response, clientDirPath] of entry.subscribers) {
    try {
      response.write(serialize({
        type: "changed",
        dirPath: clientDirPath,
        reason,
        timestamp: Date.now(),
      }));
    } catch {
      entry.subscribers.delete(response);
    }
  }
}

function scheduleBroadcast(entry: WatchEntry, reason: "files" | "git"): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    broadcast(entry, reason);
  }, DEBOUNCE_MS);
}

function closeWatcher(entry: WatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  void entry.contentWatcher?.close();
  void entry.gitWatcher?.close();
  if (watchers.get(entry.dirPath) === entry) watchers.delete(entry.dirPath);
}

function releaseSubscriber(entry: WatchEntry, response: ServerResponse): void {
  entry.subscribers.delete(response);
  if (entry.subscribers.size === 0) closeWatcher(entry);
}

function ensureWatcher(dirPath: string): WatchEntry {
  const existing = watchers.get(dirPath);
  if (existing) return existing;

  const entry: WatchEntry = {
    dirPath,
    subscribers: new Map(),
    contentWatcher: null,
    gitWatcher: null,
    debounceTimer: null,
  };
  entry.contentWatcher = chokidar.watch(dirPath, {
    ignoreInitial: true,
    persistent: true,
    ignored: (path) => isFileBrowserWatchIgnoredPath(path, dirPath),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
  });
  entry.contentWatcher.on("all", () => scheduleBroadcast(entry, "files"));
  entry.contentWatcher.on("error", () => scheduleBroadcast(entry, "files"));

  const gitWatchPaths = getGitMetadataWatchPaths(dirPath);
  if (gitWatchPaths.length > 0) {
    entry.gitWatcher = chokidar.watch(gitWatchPaths, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    });
    entry.gitWatcher.on("all", () => scheduleBroadcast(entry, "git"));
    entry.gitWatcher.on("error", () => scheduleBroadcast(entry, "git"));
  }

  watchers.set(dirPath, entry);
  return entry;
}

export async function startFileBrowserWatchStream(
  request: IncomingMessage,
  response: ServerResponse,
  subscriptions: Array<{ dirPath: string; clientDirPath: string }>,
): Promise<void> {
  const validity = await Promise.all(subscriptions.map(({ dirPath }) => isValidDirectory(dirPath)));
  if (subscriptions.length === 0 || validity.some((valid) => !valid)) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Invalid directory path" }));
    return;
  }

  const entries = subscriptions.map(({ dirPath }) => ensureWatcher(dirPath));
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.setTimeout(0);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const clientDirPath = subscriptions[index]?.clientDirPath ?? entry.dirPath;
    entry.subscribers.set(response, clientDirPath);
    response.write(serialize({
      type: "ready",
      dirPath: clientDirPath,
      reason: "initial",
      timestamp: Date.now(),
    }));
  }

  const heartbeat = setInterval(() => {
    try {
      response.write(": heartbeat\n\n");
    } catch {
      for (const entry of entries) releaseSubscriber(entry, response);
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);

  response.once("close", () => {
    clearInterval(heartbeat);
    for (const entry of entries) releaseSubscriber(entry, response);
  });
}
