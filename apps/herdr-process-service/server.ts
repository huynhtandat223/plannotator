// Native host companion for Herdr-managed Pi panels. It runs as the same user
// as Herdr, discovers live panels from `herdr api snapshot`, and serves the
// existing Ex-Plannotator UI unchanged. It does not scan host processes,
// persist snapshots, or depend on Docker.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = parsePort(process.env.PLANNOTATOR_HERDR_PORT ?? "19432");
const host = process.env.PLANNOTATOR_HERDR_HOST ?? "0.0.0.0";
// Herdr is used over a private Tailnet. Browser feedback is accepted from
// loopback and Tailscale peers; Pi enrichment and feedback claiming remain
// loopback-only because they carry the local Pi session identity.
const browserWriteToken = process.env.PLANNOTATOR_HERDR_WRITE_TOKEN?.trim() || null;
export const HERDR_LIVE_MESSAGE_LIMIT = 5;
// The packaged Ex-Plannotator editor owns every visual decision, including its
// responsive/mobile behavior. This service supplies data only.
const editorHtml = readFileSync(join(import.meta.dir, "..", "ex-pi-extension", "ex-plannotator.html"), "utf8");

type HerdrReviewSnapshot = {
  messages: Array<{
    messageId: string;
    paneId: string;
    assistantMessageId?: string;
    text: string;
    timestamp?: string;
    label: string;
    description: string;
    paneLabel: string;
    paneDescription: string;
    /** Herdr's authoritative live state for the pane containing this response. */
    agentStatus: HerdrPanel["status"];
    /** Herdr's authoritative workspace root for the pane containing this response. */
    cwd: string;
  }>;
  selectedMessageId: string | null;
  unreadMessageIds: string[];
  draftsByMessageId: Record<string, unknown[]>;
  sentAnnotationsByMessageId: Record<string, unknown[]>;
  reviewRoundStatus: "open";
  deliveryError: null;
};

export type HerdrPanel = {
  id: string;
  workspace: string;
  tab: string;
  panel: string;
  cwd: string;
  status: "working" | "idle" | "blocked" | "unknown";
  focused: boolean;
};

export type PanelSessionEnrichment = {
  paneId: string;
  sessionId: string;
  messages: Array<{ messageId: string; text: string; timestamp?: string }>;
};

type LiveDraftAnnotation = { id: string; [key: string]: unknown };
type LiveFeedbackBatch = {
  batchId: string;
  messages: Array<{ messageId: string; messageText: string; annotations: LiveDraftAnnotation[] }>;
};
type PendingFeedbackDelivery = {
  deliveryId: string;
  paneId: string;
  sessionId: string;
  batch: LiveFeedbackBatch;

};

// Structured Pi data is optional enrichment only. Herdr remains authoritative
// for whether the pane is live; this map is process-local and is pruned on each
// discovery reconciliation.
const panelSessions = new Map<string, PanelSessionEnrichment>();
// A delivery is held only until the matching local Pi extension claims it.
// It is never persisted and cannot outlive a host restart.
const pendingFeedbackDeliveries = new Map<string, PendingFeedbackDelivery>();

type HerdrAgent = {
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
  focused?: unknown;
  pane_id?: unknown;
  tab_id?: unknown;
  workspace_id?: unknown;
};

type HerdrSnapshot = {
  agents?: unknown;
  tabs?: unknown;
  workspaces?: unknown;
};

type NamedHerdrResource = { workspace_id?: unknown; tab_id?: unknown; label?: unknown };

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PLANNOTATOR_HERDR_PORT must be a valid TCP port");
  return parsed;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function status(value: unknown): HerdrPanel["status"] {
  return value === "working" || value === "idle" || value === "blocked" ? value : "unknown";
}

function resourceLabels(resources: unknown, idKey: "workspace_id" | "tab_id"): Map<string, string> {
  const labels = new Map<string, string>();
  if (!Array.isArray(resources)) return labels;
  for (const resource of resources) {
    if (!resource || typeof resource !== "object") continue;
    const entry = resource as NamedHerdrResource;
    const id = text(entry[idKey]);
    const label = text(entry.label);
    if (id && label) labels.set(id, label);
  }
  return labels;
}

/** The one discovery seam: normalize Herdr's authoritative live snapshot. */
export function panelsFromSnapshot(snapshot: HerdrSnapshot): HerdrPanel[] {
  const workspaceLabels = resourceLabels(snapshot.workspaces, "workspace_id");
  const tabLabels = resourceLabels(snapshot.tabs, "tab_id");
  if (!Array.isArray(snapshot.agents)) return [];

  return snapshot.agents.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const agent = entry as HerdrAgent;
    if (agent.agent !== "pi") return [];
    const paneId = text(agent.pane_id);
    const cwd = text(agent.foreground_cwd) ?? text(agent.cwd);
    if (!paneId || !cwd) return [];
    const workspaceId = text(agent.workspace_id);
    const tabId = text(agent.tab_id);
    return [{
      id: paneId,
      workspace: workspaceId ? workspaceLabels.get(workspaceId) ?? workspaceId : basename(cwd),
      tab: tabId ? tabLabels.get(tabId) ?? tabId : "",
      panel: `Pane ${paneId.split(":").at(-1) ?? paneId}`,
      cwd,
      status: status(agent.agent_status),
      focused: agent.focused === true,
    }];
  });
}

export async function discoverPanels(): Promise<HerdrPanel[]> {
  const { stdout } = await execFileAsync("herdr", ["api", "snapshot"], { maxBuffer: 1024 * 1024, timeout: 2_000 });
  const response = JSON.parse(stdout) as { result?: { snapshot?: HerdrSnapshot } };
  return panelsFromSnapshot(response.result?.snapshot ?? {});
}

function waitingDocument(panel: HerdrPanel): string {
  return [
    `# ${panel.workspace}`,
    panel.tab ? `## ${panel.tab} · ${panel.panel}` : `## ${panel.panel}`,
    "",
    "Waiting for the Pi session to publish its latest assistant response.",
    "",
    `**Status:** ${panel.status}`,
    `**Working directory:** \`${panel.cwd}\``,
  ].join("\n");
}

function documentId(panelId: string, messageId: string): string {
  return `${panelId}:${messageId}`;
}


function overviewDocument(panels: HerdrPanel[]): string {
  if (panels.length === 0) return "# Herdr workspaces\n\nNo live Pi panels found.";
  return [
    "# Herdr workspaces",
    "",
    "Live Pi panels discovered from Herdr. Open **Messages** in the existing sidebar to select a panel.",
    "",
    ...panels.flatMap((panel) => [
      `## ${panel.workspace}`,
      `${panel.tab ? `**Tab:** ${panel.tab} · ` : ""}**Panel:** ${panel.panel} · **Status:** ${panel.status}`,
      `\`${panel.cwd}\``,
      "",
    ]),
  ].join("\n");
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body is too large");
  }
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function annotationMessageId(annotation: unknown): string | null {
  if (!annotation || typeof annotation !== "object") return null;
  const value = (annotation as { messageId?: unknown }).messageId;
  return typeof value === "string" ? value : null;
}

function feedbackBatch(
  body: Record<string, unknown> | null,
  messages: HerdrReviewSnapshot["messages"],
): { paneId: string; batch: LiveFeedbackBatch } | null {
  if (!body || !Array.isArray(body.annotations)) return null;
  const selectedMessageId = text(body.selectedMessageId);
  const sourceMessages = new Map(messages.map((message) => [message.messageId, message]));
  const grouped = new Map<string, LiveDraftAnnotation[]>();
  for (const annotation of body.annotations) {
    if (!annotation || typeof annotation !== "object" || typeof (annotation as { id?: unknown }).id !== "string") return null;
    const messageId = annotationMessageId(annotation) ?? selectedMessageId;
    const source = messageId ? sourceMessages.get(messageId) : null;
    if (!source || !source.assistantMessageId) return null;
    const annotations = grouped.get(messageId) ?? [];
    annotations.push(annotation as LiveDraftAnnotation);
    grouped.set(messageId, annotations);
  }
  if (grouped.size === 0) return null;
  const entries = [...grouped].map(([messageId, annotations]) => {
    const source = sourceMessages.get(messageId)!;
    return {
      paneId: source.paneId,
      message: {
        messageId: source.assistantMessageId!,
        messageText: source.text,
        annotations: structuredClone(annotations),
      },
    };
  });
  const paneId = entries[0].paneId;
  if (entries.some((entry) => entry.paneId !== paneId)) return null;
  return {
    paneId,
    batch: { batchId: randomUUID(), messages: entries.map((entry) => entry.message) },
  };
}

async function queueFeedback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Feedback delivery requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  const { snapshot } = await reviewSnapshot();
  const prepared = feedbackBatch(await requestJson(request), snapshot.messages);
  if (!prepared) {
    writeJson(response, 400, { error: "Feedback must annotate one or more structured responses from one live Pi pane" });
    return;
  }
  const registration = panelSessions.get(prepared.paneId);
  if (!registration) {
    writeJson(response, 409, { error: "The selected Pi pane has not published a live session" });
    return;
  }
  const delivery: PendingFeedbackDelivery = {
    deliveryId: randomUUID(),
    paneId: prepared.paneId,
    sessionId: registration.sessionId,
    batch: prepared.batch,
  };
  pendingFeedbackDeliveries.set(delivery.deliveryId, delivery);
  writeJson(response, 202, { ok: true, deliveryId: delivery.deliveryId });
}

async function claimFeedback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi feedback delivery is loopback-only" });
    return;
  }
  const body = await requestJson(request);
  const paneId = text(body?.paneId);
  const sessionId = text(body?.sessionId);
  if (!paneId || !sessionId || panelSessions.get(paneId)?.sessionId !== sessionId) {
    writeJson(response, 409, { error: "The Pi session registration is no longer current" });
    return;
  }
  const delivery = [...pendingFeedbackDeliveries.values()].find((candidate) =>
    candidate.paneId === paneId && candidate.sessionId === sessionId,
  );
  if (!delivery) {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  // Claim is intentionally destructive. Pi's sendUserMessage is not an
  // idempotent transaction, so acknowledging later could inject the same
  // feedback twice after a restart between send and ACK. At-most-once delivery
  // is safer than a duplicate prompt; the browser has already received 202.
  pendingFeedbackDeliveries.delete(delivery.deliveryId);
  writeJson(response, 200, { deliveryId: delivery.deliveryId, batch: delivery.batch });
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isTailscalePeer(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const parts = ipv4.split(".").map(Number);
  // Tailscale IPv4 addresses are the CGNAT block 100.64.0.0/10. The IPv6
  // range is fd7a:115c:a1e0::/48.
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
    : address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function requestCookie(request: IncomingMessage, name: string): string | null {
  const entry = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function canWriteFeedback(request: IncomingMessage): boolean {
  return isLoopback(request) || isTailscalePeer(request)
    || (browserWriteToken !== null && requestCookie(request, "plannotator_herdr_write") === browserWriteToken);
}

async function savePanelSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi session enrichment is loopback-only" });
    return;
  }
  const body = await requestJson(request);
  const paneId = text(body?.paneId);
  const sessionId = text(body?.sessionId);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!paneId || !sessionId || !messages || messages.length > HERDR_LIVE_MESSAGE_LIMIT) {
    writeJson(response, 400, { error: `paneId, sessionId, and at most ${HERDR_LIVE_MESSAGE_LIMIT} messages are required` });
    return;
  }
  const normalizedMessages = messages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const message = value as Record<string, unknown>;
    const messageId = text(message.messageId);
    const messageText = text(message.text);
    const timestamp = text(message.timestamp) ?? undefined;
    return messageId && messageText ? [{ messageId, text: messageText, ...(timestamp ? { timestamp } : {}) }] : [];
  });
  if (normalizedMessages.length !== messages.length || new Set(normalizedMessages.map((message) => message.messageId)).size !== normalizedMessages.length) {
    writeJson(response, 400, { error: "Invalid structured assistant messages" });
    return;
  }

  const panels = await discoverPanels();
  if (!panels.some((panel) => panel.id === paneId)) {
    writeJson(response, 404, { error: "The Pi panel is no longer live" });
    return;
  }
  panelSessions.set(paneId, { paneId, sessionId, messages: normalizedMessages });
  writeJson(response, 200, { ok: true });
}

export function releasePanelSession(
  enrichments: Map<string, PanelSessionEnrichment>,
  paneId: string,
  sessionId: string,
): boolean {
  if (enrichments.get(paneId)?.sessionId !== sessionId) return false;
  enrichments.delete(paneId);
  for (const [deliveryId, delivery] of pendingFeedbackDeliveries) {
    if (delivery.paneId === paneId && delivery.sessionId === sessionId) pendingFeedbackDeliveries.delete(deliveryId);
  }
  return true;
}

function deletePanelSession(request: IncomingMessage, response: ServerResponse, url: URL): void {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi session enrichment is loopback-only" });
    return;
  }
  const paneId = text(url.searchParams.get("paneId"));
  const sessionId = text(url.searchParams.get("sessionId"));
  if (!paneId || !sessionId) {
    writeJson(response, 400, { error: "paneId and sessionId are required" });
    return;
  }
  releasePanelSession(panelSessions, paneId, sessionId);
  writeJson(response, 200, { ok: true });
}

export function reviewSnapshotFromPanels(
  panels: HerdrPanel[],
  preferredPanelId: string | null = null,
  enrichments: ReadonlyMap<string, PanelSessionEnrichment> = new Map(),
): HerdrReviewSnapshot {
  const selected = panels.find((panel) => panel.id === preferredPanelId)
    ?? panels.find((panel) => panel.focused)
    ?? panels[0]
    ?? null;
  const messages = panels.flatMap((panel) => {
    const paneLabel = panel.workspace;
    const paneDescription = [panel.tab, panel.panel, panel.status].filter(Boolean).join(" · ");
    const responses = enrichments.get(panel.id)?.messages ?? [];
    if (responses.length === 0) {
      return [{
        messageId: documentId(panel.id, "waiting"),
        paneId: panel.id,
        text: waitingDocument(panel),
        label: "Waiting for a response",
        description: "No structured assistant response published yet",
        paneLabel,
        paneDescription,
        agentStatus: panel.status,
        cwd: panel.cwd,
      }];
    }
    return responses.map((response, index) => ({
      // `messageId` is a UI-only opaque key. `paneId` and
      // `assistantMessageId` retain the two real identities separately.
      messageId: documentId(panel.id, response.messageId),
      paneId: panel.id,
      assistantMessageId: response.messageId,
      text: response.text,
      ...(response.timestamp ? { timestamp: response.timestamp } : {}),
      label: `Response ${index + 1}${index === 0 ? " · latest" : ""}`,
      description: "Structured Pi assistant response",
      paneLabel,
      paneDescription,
      agentStatus: panel.status,
      cwd: panel.cwd,
    }));
  });
  const selectedMessage = selected
    ? messages.find((message) => message.paneId === selected.id) ?? null
    : null;
  return {
    messages,
    selectedMessageId: selectedMessage?.messageId ?? null,
    unreadMessageIds: [],
    draftsByMessageId: {},
    sentAnnotationsByMessageId: {},
    reviewRoundStatus: "open",
    deliveryError: null,
  };
}

async function reviewSnapshot(): Promise<{ panels: HerdrPanel[]; snapshot: HerdrReviewSnapshot }> {
  const panels = await discoverPanels();
  const livePaneIds = new Set(panels.map((panel) => panel.id));
  for (const paneId of panelSessions.keys()) {
    if (!livePaneIds.has(paneId)) panelSessions.delete(paneId);
  }
  for (const [deliveryId, delivery] of pendingFeedbackDeliveries) {
    if (!livePaneIds.has(delivery.paneId) || panelSessions.get(delivery.paneId)?.sessionId !== delivery.sessionId) {
      pendingFeedbackDeliveries.delete(deliveryId);
    }
  }
  return { panels, snapshot: reviewSnapshotFromPanels(panels, null, panelSessions) }; 
}

const FILE_BROWSER_EXTENSIONS = /\.(mdx?|txt|html?)$/i;
const FILE_BROWSER_MAX_FILES = 5_000;
const FILE_BROWSER_EXCLUDED_NAMES = new Set([
  "node_modules", ".git", ".claude", ".agents", "dist", "build", ".next",
  "__pycache__", ".obsidian", ".trash", ".venv", "vendor", "target", ".cache",
  "coverage", ".turbo", ".svelte-kit", ".nuxt", ".output", ".parcel-cache",
  ".webpack", ".expo", "_site", "public", ".jekyll-cache", "out", ".docusaurus", "storybook-static",
]);

type WorkspaceStatus = {
  available: boolean;
  rootPath: string;
  repoRoot?: string;
  files: Record<string, {
    path: string;
    repoRelativePath: string;
    oldPath?: string;
    status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "typechange";
    additions: number;
    deletions: number;
    staged: boolean;
    unstaged: boolean;
  }>;
  totals: { files: number; additions: number; deletions: number };
  error?: string;
};
type FileBrowserWalkState = { files: Set<string>; truncated: boolean };
type VaultNode = { name: string; path: string; type: "file" | "folder"; children?: VaultNode[] };

function isFileBrowserExcludedPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, "/").split("/").some((part) => FILE_BROWSER_EXCLUDED_NAMES.has(part));
}

function includeWorkspaceFile(relativePath: string): boolean {
  return FILE_BROWSER_EXTENSIONS.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

function includeWorkspaceChange(relativePath: string): boolean {
  return !isFileBrowserExcludedPath(relativePath);
}

function addWorkspaceFile(state: FileBrowserWalkState, relativePath: string): void {
  if (state.files.has(relativePath)) return;
  if (state.files.size >= FILE_BROWSER_MAX_FILES) {
    state.truncated = true;
    return;
  }
  state.files.add(relativePath);
}

function buildFileTree(paths: string[]): VaultNode[] {
  const root: VaultNode[] = [];
  for (const filePath of paths) {
    let nodes = root;
    let prefix = "";
    for (const [index, name] of filePath.split("/").entries()) {
      prefix = prefix ? `${prefix}/${name}` : name;
      const type = index === filePath.split("/").length - 1 ? "file" : "folder";
      let node = nodes.find((candidate) => candidate.name === name && candidate.type === type);
      if (!node) {
        node = { name, path: prefix, type, ...(type === "folder" ? { children: [] } : {}) };
        nodes.push(node);
      }
      if (node.children) nodes = node.children;
    }
  }
  const sort = (nodes: VaultNode[]) => {
    nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1);
    nodes.forEach((node) => node.children && sort(node.children));
  };
  sort(root);
  return root;
}

async function walkWorkspaceFiles(directory: string, root: string, state: FileBrowserWalkState): Promise<void> {
  if (state.truncated) return;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.truncated) return;
    const fullPath = join(directory, entry.name);
    const relativePath = relative(root, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (!isFileBrowserExcludedPath(relativePath)) await walkWorkspaceFiles(fullPath, root, state);
    } else if (entry.isFile() && includeWorkspaceFile(relativePath)) {
      addWorkspaceFile(state, relativePath);
    }
  }
}

function unavailableWorkspaceStatus(rootPath: string, error: string): WorkspaceStatus {
  return { available: false, rootPath, files: {}, totals: { files: 0, additions: 0, deletions: 0 }, error };
}

function gitStatus(x: string, y: string): WorkspaceStatus["files"][string]["status"] {
  if (x === "?" || y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

async function workspaceStatus(rootPath: string): Promise<WorkspaceStatus> {
  try {
    const { stdout: repoOutput } = await execFileAsync("git", ["--no-optional-locks", "-C", rootPath, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
    const repoRoot = await realpath(repoOutput.trim());
    const rootPathspec = relative(repoRoot, rootPath).replace(/\\/g, "/") || ".";
    const [statusResult, diffResult] = await Promise.all([
      execFileAsync("git", ["--no-optional-locks", "-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", rootPathspec], { timeout: 10_000 }),
      execFileAsync("git", ["--no-optional-locks", "-C", repoRoot, "diff", "--numstat", "-z", "HEAD", "--", rootPathspec], { timeout: 10_000 }),
    ]);
    const counts = new Map<string, { additions: number; deletions: number }>();
    for (const record of diffResult.stdout.split("\0")) {
      const [additionsRaw, deletionsRaw, repoRelativePath] = record.split("\t");
      if (!repoRelativePath) continue;
      counts.set(repoRelativePath, { additions: additionsRaw === "-" ? 0 : Number(additionsRaw) || 0, deletions: deletionsRaw === "-" ? 0 : Number(deletionsRaw) || 0 });
    }
    const files: WorkspaceStatus["files"] = {};
    for (const record of statusResult.stdout.split("\0")) {
      if (record.length < 4) continue;
      const repoRelativePath = record.slice(3);
      const path = resolve(repoRoot, repoRelativePath);
      const relativePath = relative(rootPath, path).replace(/\\/g, "/");
      if (!relativePath || relativePath.startsWith("../") || !includeWorkspaceChange(relativePath)) continue;
      const countsForFile = counts.get(repoRelativePath) ?? { additions: 0, deletions: 0 };
      files[path] = {
        path,
        repoRelativePath,
        status: gitStatus(record[0] ?? " ", record[1] ?? " "),
        additions: countsForFile.additions,
        deletions: countsForFile.deletions,
        staged: record[0] !== " " && record[0] !== "?",
        unstaged: record[1] !== " " && record[1] !== "?",
      };
    }
    const values = Object.values(files);
    return { available: true, rootPath, repoRoot, files, totals: {
      files: values.length,
      additions: values.reduce((sum, file) => sum + file.additions, 0),
      deletions: values.reduce((sum, file) => sum + file.deletions, 0),
    } };
  } catch {
    return unavailableWorkspaceStatus(rootPath, "not-a-git-repo");
  }
}

async function liveWorkspaceDirectory(
  dirPath: string,
  panels: HerdrPanel[],
  options: { exactRoot: boolean },
): Promise<{ root: string; directory: string } | null> {
  let directory: string;
  try {
    directory = await realpath(resolve(dirPath));
  } catch {
    return null;
  }
  for (const panel of panels) {
    try {
      const root = await realpath(resolve(panel.cwd));
      if (directory === root || (!options.exactRoot && directory.startsWith(`${root}/`))) {
        return { root, directory };
      }
    } catch {
      // A pane can close or its cwd can disappear between the Herdr snapshot and this request.
    }
  }
  return null;
}

async function serveWorkspaceFiles(response: ServerResponse, url: URL): Promise<void> {
  const dirPath = text(url.searchParams.get("dirPath"));
  if (!dirPath) {
    writeJson(response, 400, { error: "dirPath is required" });
    return;
  }
  const workspace = await liveWorkspaceDirectory(dirPath, await discoverPanels(), { exactRoot: true });
  if (!workspace) {
    writeJson(response, 403, { error: "Directory is not a currently live Herdr Pi workspace" });
    return;
  }

  const { root } = workspace;
  const status = await workspaceStatus(root);
  const state: FileBrowserWalkState = { files: new Set(), truncated: false };
  // Git changes are seeded first so changed/deleted files remain visible when a
  // large workspace reaches the tree cap.
  for (const change of Object.values(status.files)) {
    addWorkspaceFile(state, relative(root, change.path).replace(/\\/g, "/"));
    if (state.truncated) break;
  }
  if (!state.truncated) await walkWorkspaceFiles(root, root, state);
  writeJson(response, 200, {
    tree: buildFileTree([...state.files].sort()),
    workspaceStatus: status,
    truncated: state.truncated,
    fileLimit: FILE_BROWSER_MAX_FILES,
  });
}

async function serveWorkspaceDocument(response: ServerResponse, url: URL): Promise<void> {
  const requestedPath = text(url.searchParams.get("path"));
  const base = text(url.searchParams.get("base"));
  if (!requestedPath || !base) {
    writeJson(response, 400, { error: "path and a live Herdr workspace base are required" });
    return;
  }
  const workspace = await liveWorkspaceDirectory(base, await discoverPanels(), { exactRoot: false });
  if (!workspace) {
    writeJson(response, 403, { error: "Document base is not a currently live Herdr Pi workspace" });
    return;
  }
  const candidate = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workspace.directory, requestedPath);
  const relativePath = relative(workspace.root, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    writeJson(response, 403, { error: "Document is outside the live Herdr Pi workspace" });
    return;
  }
  try {
    const filepath = await realpath(candidate);
    if (relative(workspace.root, filepath).startsWith("..")) {
      writeJson(response, 403, { error: "Document is outside the live Herdr Pi workspace" });
      return;
    }
    const content = await readFile(filepath, "utf8");
    writeJson(response, 200, { markdown: content, filepath, renderAs: "markdown" });
  } catch {
    writeJson(response, 404, { error: `File not found: ${requestedPath}` });
  }
}

async function servePlan(response: ServerResponse): Promise<void> {
  const { panels, snapshot } = await reviewSnapshot();
  const selected = panels.find((panel) => panel.focused) ?? panels[0] ?? null;
  writeJson(response, 200, {
    // The existing Ex-Plannotator rich editor receives the live state through
    // its documented live-review seam. On phones its built-in picker opens the
    // mobile Messages sheet; desktop keeps the existing left sidebar.
    mode: "annotate-last",
    // Match /ex-plannotator-last: the root document is the selected pane's
    // latest structured assistant response, never the workspace overview.
    plan: snapshot.messages.find((message) => message.messageId === snapshot.selectedMessageId)?.text
      ?? overviewDocument(panels),
    recentMessages: snapshot.messages,
    selectedMessageId: snapshot.selectedMessageId,
    origin: "pi",
    gate: false,
    sharingEnabled: false,
    repoInfo: { display: "Herdr live Pi panels" },
    projectRoot: selected?.cwd ?? process.cwd(),
    liveMessageReview: true,
    // This host receives complete documents in each snapshot and can switch
    // them in place. Reloading on every changed message identity creates an
    // initial EventSource race and is unnecessary here.
    liveMessageReviewReloadOnSelection: false,
    // Feedback is queued only for the current pane/session and claimed by the
    // matching loopback Pi extension before it calls pi.sendUserMessage.
    liveMessageReviewReadOnly: false,
  });
}

function serveEmptyExternalAnnotations(response: ServerResponse): void {
  writeJson(response, 200, { annotations: [], version: 0 });
}

async function serveUnavailableDocExists(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The shared renderer probes source-file links as it renders Markdown. This
  // Herdr host deliberately has no filesystem authority, so report each probe
  // unavailable rather than returning a noisy 404 or inspecting host paths.
  const body = await requestJson(request);
  const paths = Array.isArray(body?.paths) && body.paths.every((path) => typeof path === "string")
    ? body.paths as string[]
    : null;
  if (!paths || paths.length > 500) {
    writeJson(response, 400, { error: "Expected { paths: string[] } with at most 500 paths" });
    return;
  }
  writeJson(response, 200, {
    results: Object.fromEntries(paths.map((path) => [path, { status: "unavailable" }])),
  });
}

function serveExternalAnnotationsStream(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // The rich editor falls back to 500ms polling if this initial snapshot is
  // absent. This read-only host has no external annotations, but it must still
  // satisfy that UI seam to avoid a continuous stream of 404s.
  response.write("data: {\"type\":\"snapshot\",\"annotations\":[]}\n\n");
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
  request.once("close", () => clearInterval(heartbeat));
}

function serve(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#18181b"/><path fill="#fafafa" d="M18 14h28v8H28v8h16v8H28v12h-10z"/></svg>');
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/ai/capabilities") {
    writeJson(response, 200, { available: false, providers: [] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/draft") {
    writeJson(response, 200, { draftGeneration: 0 });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/external-annotations") {
    serveEmptyExternalAnnotations(response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/external-annotations/stream") {
    serveExternalAnnotationsStream(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/doc/exists") {
    void serveUnavailableDocExists(request, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/reference/files") {
    void serveWorkspaceFiles(response, url).catch(() => writeJson(response, 500, { error: "Failed to list live Herdr workspace files" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/doc") {
    void serveWorkspaceDocument(response, url).catch(() => writeJson(response, 500, { error: "Failed to read live Herdr workspace document" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/panels") {
    void discoverPanels().then((panels) => writeJson(response, 200, panels)).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/plan") {
    void servePlan(response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    void reviewSnapshot().then(({ snapshot }) => writeJson(response, 200, snapshot)).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const publish = () => void reviewSnapshot().then(({ snapshot }) => response.write(`data: ${JSON.stringify(snapshot)}\n\n`)).catch(() => {});
    publish();
    const interval = setInterval(publish, 5_000);
    request.once("close", () => clearInterval(interval));
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    const suppliedToken = text(url.searchParams.get("token"));
    const tokenAccepted = browserWriteToken !== null && suppliedToken === browserWriteToken;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(tokenAccepted ? { "set-cookie": `plannotator_herdr_write=${encodeURIComponent(browserWriteToken!)}; Path=/; HttpOnly; SameSite=Strict` } : {}),
    });
    response.end(editorHtml);
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/panel-session") {
    void savePanelSession(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/panel-feedback/claim") {
    void claimFeedback(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    void queueFeedback(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/panel-session") {
    deletePanelSession(request, response, url);
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/session/drafts") {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/draft" && (request.method === "POST" || request.method === "DELETE")) {
    // This service deliberately does not persist review drafts, but responds
    // successfully so generic Plannotator draft housekeeping stays quiet.
    writeJson(response, 200, { ok: true, draftGeneration: 0 });
    return;
  }
  if (url.pathname === "/api/external-annotations" && ["POST", "PATCH", "DELETE"].includes(request.method ?? "")) {
    serveEmptyExternalAnnotations(response);
    return;
  }
  if (request.method === "POST" && (url.pathname === "/api/approve" || url.pathname.startsWith("/api/session/"))) {
    writeJson(response, 501, { error: "Submit feedback from Ex-Plannotator in the selected Pi panel." });
    return;
  }
  writeJson(response, 404, { error: "Not found" });
}

if (import.meta.main) {
  createServer(serve).listen(port, host, () => {
    console.log(`Plannotator Herdr service listening on http://${host}:${port}`);
  });
}
