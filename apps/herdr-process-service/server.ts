// Native host companion for Herdr-managed Pi panels. It runs as the same user
// as Herdr, discovers live panels from `herdr api snapshot`, and serves the
// existing Ex-Plannotator UI unchanged. It does not scan host processes,
// persist snapshots, or depend on Docker.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = parsePort(process.env.PLANNOTATOR_HERDR_PORT ?? "19432");
const host = process.env.PLANNOTATOR_HERDR_HOST ?? "0.0.0.0";
// The packaged Ex-Plannotator editor owns every visual decision, including its
// responsive/mobile behavior. This service supplies data only.
const editorHtml = readFileSync(join(import.meta.dir, "..", "ex-pi-extension", "ex-plannotator.html"), "utf8");

type HerdrReviewSnapshot = {
  messages: Array<{ messageId: string; text: string; timestamp?: string; label: string; description: string }>;
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

// Structured Pi data is optional enrichment only. Herdr remains authoritative
// for whether the pane is live; this map is process-local and is pruned on each
// discovery reconciliation.
const panelSessions = new Map<string, PanelSessionEnrichment>();

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

function paneIdFromDocumentId(value: string): string {
  const marker = value.lastIndexOf(":");
  return marker > 0 ? value.slice(0, marker) : value;
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

async function saveSelection(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJson(request);
  const messageId = text(body?.messageId);
  if (!messageId) {
    writeJson(response, 400, { error: "messageId is required" });
    return;
  }

  const paneId = paneIdFromDocumentId(messageId);
  const panels = await discoverPanels();
  if (!panels.some((panel) => panel.id === paneId)) {
    writeJson(response, 404, { error: "The selected Pi panel is no longer live" });
    return;
  }
  selectedPanelId = paneId;
  const snapshot = reviewSnapshotFromPanels(panels, selectedPanelId, panelSessions);
  writeJson(response, 200, { ok: true, selectedMessageId: snapshot.selectedMessageId });
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
  if (!paneId || !sessionId || !messages || messages.length > 1) {
    writeJson(response, 400, { error: "paneId, sessionId, and at most one message are required" });
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
  if (normalizedMessages.length !== messages.length) {
    writeJson(response, 400, { error: "Invalid structured assistant message" });
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

// Selection is intentionally process-local: it survives a browser refresh but
// is discarded when the service stops. Herdr remains the source of truth for
// which panels are live; an absent panel can never be restored from this state.
let selectedPanelId: string | null = null;

export function reviewSnapshotFromPanels(
  panels: HerdrPanel[],
  preferredPanelId: string | null = null,
  enrichments: ReadonlyMap<string, PanelSessionEnrichment> = new Map(),
): HerdrReviewSnapshot {
  const selected = panels.find((panel) => panel.id === preferredPanelId)
    ?? panels.find((panel) => panel.focused)
    ?? panels[0]
    ?? null;
  const messages = panels.map((panel) => {
    const latest = enrichments.get(panel.id)?.messages[0];
    return {
      messageId: documentId(panel.id, latest?.messageId ?? "waiting"),
      text: latest?.text ?? waitingDocument(panel),
      ...(latest?.timestamp ? { timestamp: latest.timestamp } : {}),
      label: panel.workspace,
      description: [panel.tab, panel.panel, panel.status].filter(Boolean).join(" · "),
    };
  });
  const selectedMessage = selected
    ? messages.find((message) => paneIdFromDocumentId(message.messageId) === selected.id) ?? null
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
  const snapshot = reviewSnapshotFromPanels(panels, selectedPanelId, panelSessions);
  // Forget a no-longer-live selection rather than accumulating stale pane ids.
  selectedPanelId = snapshot.selectedMessageId ? paneIdFromDocumentId(snapshot.selectedMessageId) : null;
  return { panels, snapshot };
}

async function servePlan(response: ServerResponse): Promise<void> {
  const { panels, snapshot } = await reviewSnapshot();
  const selected = panels.find((panel) => panel.id === selectedPanelId) ?? panels.find((panel) => panel.focused) ?? panels[0] ?? null;
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
    // There is no safe feedback-delivery experiment yet, so the browser must
    // not offer editable annotations or a Send action that cannot succeed.
    liveMessageReviewReadOnly: true,
  });
}

function serveEmptyExternalAnnotations(response: ServerResponse): void {
  writeJson(response, 200, { annotations: [], version: 0 });
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
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(editorHtml);
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/session/selection") {
    void saveSelection(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/panel-session") {
    void savePanelSession(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
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
  if (request.method === "POST" && (url.pathname === "/api/feedback" || url.pathname === "/api/approve" || url.pathname.startsWith("/api/session/"))) {
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
