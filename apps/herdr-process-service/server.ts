// Native host companion for Herdr-managed Pi panels. It runs as the same user
// as Herdr, discovers live panels from `herdr api snapshot`, and serves the
// existing Ex-Plannotator UI unchanged. It does not scan host processes,
// persist snapshots, or depend on Docker.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = parsePort(process.env.PLANNOTATOR_HERDR_PORT ?? "19432");
const host = process.env.PLANNOTATOR_HERDR_HOST ?? "0.0.0.0";
// LAN viewers may read the shared workspace, but feedback changes a live Pi
// conversation. A token is therefore required for non-loopback writes.
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

function requestCookie(request: IncomingMessage, name: string): string | null {
  const entry = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function canWriteFeedback(request: IncomingMessage): boolean {
  return isLoopback(request) || (browserWriteToken !== null && requestCookie(request, "plannotator_herdr_write") === browserWriteToken);
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
