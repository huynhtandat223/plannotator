// Native host companion for Herdr-managed Pi panels. It runs as the same user
// as Herdr, discovers live panels from `herdr api snapshot`, and serves the
// existing Ex-Plannotator UI unchanged. It does not scan host processes,
// persist snapshots, or depend on Docker.

import { execFile, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  getDefaultBranch,
  getSinceBaseSections,
  type GitCommandResult,
  type ReviewGitRuntime,
  type SinceBaseSections,
} from "../../packages/shared/review-core";
import type { WorkspaceStatusPayload } from "../../packages/core/workspace-status-types";
import {
  filterWorkspaceStatusForDirectory,
  getWorkspaceStatusForDirectory,
  parseGitNumstat,
} from "../../packages/shared/workspace-status";
import { readFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ExAICompanionCoordinator } from "./ex-ai-companion";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { startFileBrowserWatchStream } from "./file-browser-watch";
import { startReviewServer, type ReviewServerResult } from "../../packages/server/review";
import { prepareLocalReviewDiff } from "../../packages/server/vcs";
import { loadConfig, resolveAskAiWorkspace, type PlannotatorConfig } from "../../packages/shared/config";
import { SingleFlight } from "../../packages/shared/single-flight";
import { extractFileMentionReferences } from "../../packages/core/file-mention";
import { isWithinProjectRoot, resolveCodeFile } from "../../packages/shared/resolve-file";
import { createAIEndpoints, ProviderRegistry, SessionManager } from "../../packages/ai/index";
import { HerdrPiProvider, HERDR_PI_PROVIDER_ID, type HerdrPiGateway } from "./herdr-pi-provider";
import { discoverPiModels } from "./pi-models";
const execFileAsync = promisify(execFile);
const port = parsePort(process.env.PLANNOTATOR_HERDR_PORT ?? "19432");
const host = process.env.PLANNOTATOR_HERDR_HOST ?? "0.0.0.0";
// Herdr is used over a private Tailnet. Browser feedback is accepted from
// loopback and Tailscale peers; Pi enrichment and feedback claiming remain
// loopback-only because they carry the local Pi session identity.
const browserWriteToken = process.env.PLANNOTATOR_HERDR_WRITE_TOKEN?.trim() || null;
const MAX_ACTION_REQUEST_BODY_BYTES = 16_384;
/** Up to five finalized assistant responses, delivered only from a local Pi pane. */
export const MAX_PANEL_SESSION_BODY_BYTES = 1_000_000;
export const HERDR_LIVE_MESSAGE_LIMIT = 5;
// Focus/status transitions are human-paced, not sub-second events. A 2s poll
// cuts the per-tick `herdr api snapshot` + per-panel `git branch` subprocess
// load ~2.6x versus the old 750ms cadence while staying responsive. Read-only
// HTTP handlers now read the cached snapshot (cachedPanels) instead of spawning
// their own `discoverPanels()` subprocess, so UI freshness no longer depends on
// a tight poll.
export const HERDR_SNAPSHOT_POLL_MS = 2_000;

export type PublishedLiveSnapshot<T> = {
  revision: number;
  value: T;
};

/**
 * Owns one coherent live Herdr snapshot for every HTTP endpoint and SSE
 * subscriber. A changed focus must be published once immediately, rather than
 * allowing /api/plan and a per-client SSE poll to observe unrelated snapshots.
 */
export class LiveSnapshotPublisher<T> {
  private current: PublishedLiveSnapshot<T> | null = null;
  // Cache the serialized form of `current` so the change-detection compare in
  // refresh() does not have to re-stringify the whole (potentially 100KB+)
  // snapshot on every poll tick.
  private currentSerialized: string | null = null;
  private refreshInFlight: Promise<PublishedLiveSnapshot<T>> | null = null;
  private readonly subscribers = new Set<(snapshot: PublishedLiveSnapshot<T>) => void>();

  constructor(private readonly read: () => Promise<T>) {}

  async refresh(): Promise<PublishedLiveSnapshot<T>> {
    // A slow older `herdr api snapshot` must not complete after a newer one
    // and overwrite it. Coalescing keeps observation and publication ordered.
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = (async () => {
      const value = await this.read();
      const serialized = JSON.stringify(value);
      if (this.current && this.currentSerialized === serialized) return this.current;
      const snapshot = { revision: (this.current?.revision ?? 0) + 1, value };
      this.current = snapshot;
      this.currentSerialized = serialized;
      for (const subscriber of this.subscribers) subscriber(snapshot);
      return snapshot;
    })();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  async snapshot(): Promise<PublishedLiveSnapshot<T>> {
    return this.current ?? this.refresh();
  }

  subscribe(subscriber: (snapshot: PublishedLiveSnapshot<T>) => void): () => void {
    this.subscribers.add(subscriber);
    if (this.current) subscriber(this.current);
    return () => this.subscribers.delete(subscriber);
  }
}

// The packaged Ex-Plannotator editor owns every visual decision, including its
// responsive/mobile behavior. This service supplies data only.
const editorHtml = readFileSync(join(import.meta.dir, "..", "ex-pi-extension", "ex-plannotator.html"), "utf8");
const reviewHtml = readFileSync(join(import.meta.dir, "..", "review", "dist", "index.html"), "utf8");

type HerdrReviewSnapshot = {
  /** Monotonic host snapshot version. The browser ignores stale SSE frames. */
  revision?: number;
  messages: Array<{
    messageId: string;
    paneId: string;
    /** Current Pi session identity for the pane; scopes browser-only drafts. */
    piSessionId?: string;
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
    /** Commands advertised by this pane's current Pi session. */
    commands?: HerdrCommandCapability[];
    /** Pi-reported active context usage; null tokens are intentionally unknown. */
    contextUsage?: HerdrContextUsage;
    /** Current model selected in the Pi session. */
    model?: HerdrModel;
    /** Current tool/subagent activity reported by the Pi extension. */
    activity?: HerdrActivity;
    /** Cumulative model tokens charged over the complete Pi session. */
    totalUsedTokens?: number;
    /** Context tokens represented by the latest Pi compaction summary. */
    latestCompactionTokens?: number;
    /** Git branch resolved from this live pane's working directory. */
    gitBranch?: string;
    /** Managed Ex AI companion panes remain visible but cannot create chains. */
    isExAICompanion?: boolean;
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
  workspaceId?: string;
  tabId?: string;
  workspace: string;
  tab: string;
  panel: string;
  cwd: string;
  status: "working" | "idle" | "blocked" | "unknown";
  focused: boolean;
  gitBranch?: string;
};

export type HerdrCommandCapability = {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  arguments?: string[];
};

export type HerdrContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type HerdrModel = {
  id: string;
  provider?: string;
  name?: string;
};

export type HerdrActivity = {
  kind: "tool" | "subagent";
  name?: string;
  count: number;
};

export type PanelSessionEnrichment = {
  paneId: string;
  sessionId: string;
  messages: Array<{ messageId: string; text: string; timestamp?: string }>;
  commands: HerdrCommandCapability[];
  contextUsage?: HerdrContextUsage;
  model?: HerdrModel;
  activity?: HerdrActivity;
  /** Optional while an already-running, pre-metadata Pi extension republishs. */
  totalUsedTokens?: number;
  latestCompactionTokens?: number;
};

type LiveDraftAnnotation = { id: string; [key: string]: unknown };
type LiveCodeDraftAnnotation = LiveDraftAnnotation;
type LiveImageAttachment = { path: string; name: string };
type LiveFeedbackBatch = {
  batchId: string;
  messages: Array<{
    messageId: string;
    messageText: string;
    annotations: LiveDraftAnnotation[];
    codeAnnotations?: LiveCodeDraftAnnotation[];
    globalAttachments?: LiveImageAttachment[];
  }>;
};
type PendingFeedbackDelivery = {
  deliveryId: string;
  paneId: string;
  sessionId: string;
  batch: LiveFeedbackBatch;
};
type PendingInstructionDelivery = {
  deliveryId: string;
  paneId: string;
  sessionId: string;
  content: string;
};
type ActiveGitChangesReview = {
  paneId: string;
  sessionId: string;
  cwd: string;
  compareMode: WorkspaceCompareMode;
  settled: boolean;
  server: ReviewServerResult;
};

type GitChangesReviewIdentity = {
  paneId: string;
  sessionId: string;
  cwd: string;
  compareMode?: WorkspaceCompareMode;
};

// Structured Pi data is optional enrichment only. Herdr remains authoritative
// for whether the pane is live; this map is process-local and is pruned on each
// discovery reconciliation.
export const panelSessions = new Map<string, PanelSessionEnrichment>();
// Event-driven registration waiters keyed by paneId. A freshly created
// companion pane registers asynchronously via /api/session; instead of
// busy-polling the map, callers await a waiter that resolves the moment the
// matching registration lands (F7). Waiters own their own timeout, so a pane
// that never registers still rejects instead of leaking.
const panelSessionWaiters = new Map<string, Set<() => void>>();
export function notifyPanelSessionWaiters(paneId: string): void {
  const waiters = panelSessionWaiters.get(paneId);
  if (!waiters) return;
  panelSessionWaiters.delete(paneId);
  for (const resolve of waiters) resolve();
}
export function waitForPanelSessionRegistration(paneId: string, timeoutMs: number): Promise<PanelSessionEnrichment | undefined> {
  const existing = panelSessions.get(paneId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = panelSessionWaiters.get(paneId);
      if (waiters) {
        waiters.delete(onRegister);
        if (waiters.size === 0) panelSessionWaiters.delete(paneId);
      }
      resolve(panelSessions.get(paneId));
    };
    const onRegister = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    const waiters = panelSessionWaiters.get(paneId) ?? new Set<() => void>();
    waiters.add(onRegister);
    panelSessionWaiters.set(paneId, waiters);
  });
}
// A delivery is held only until the matching local Pi extension claims it.
// It is never persisted and cannot outlive a host restart.
const pendingFeedbackDeliveries = new Map<string, PendingFeedbackDelivery>();
// Browser-originated user instructions are held only until the matching local
// Pi extension claims them. They are not annotation feedback and never persist.
const pendingInstructionDeliveries = new Map<string, PendingInstructionDelivery>();
const exAICompanionDataDir = process.env.PLANNOTATOR_DATA_DIR
  ? resolve(process.env.PLANNOTATOR_DATA_DIR.replace(/^~(?=$|\/)/, homedir()))
  : join(homedir(), ".plannotator");
const exAICompanions = new ExAICompanionCoordinator({
  panels: discoverPanels,
  registration: (paneId) => {
    const registration = panelSessions.get(paneId);
    return registration && { sessionId: registration.sessionId, messages: registration.messages, model: registration.model?.id, commands: registration.commands };
  },
  transcriptPath: findPiSessionFile,
  async create(input) {
    const created = await createProcessPanel(input, await discoverPanels());
    if (!created) throw new Error("Could not create an Ex AI companion Pi pane.");
    const registration = await waitForPanelSessionRegistration(created.paneId, 15_000);
    if (registration) return created;
    throw new Error("The companion Pi pane has not registered yet.");
  },
  async close(paneId) {
    await execFileAsync("herdr", ["pane", "close", paneId], { timeout: 10_000 });
  },
  async send(paneId, prompt) {
    await execFileAsync("herdr", ["pane", "run", paneId, prompt], { timeout: 10_000 });
  },
  async claim(paneId, sessionId, content) {
    const deliveryId = randomUUID();
    pendingInstructionDeliveries.set(deliveryId, { deliveryId, paneId, sessionId, content });
    return deliveryId;
  },
}, exAICompanionDataDir);
const exAIConfig = loadConfig().exAIChat;
const DEFAULT_EX_AI_INSTRUCTION = "Act as a concise first-layer assistant for the paired main Pi session. Inspect the main transcript and workspace when useful. Give clear, actionable guidance. Do not modify files or send messages to the main session unless explicitly asked.";
void exAICompanions.setDefaults({
  model: exAIConfig?.model?.trim() ?? "",
  instruction: exAIConfig?.instruction?.trim() || DEFAULT_EX_AI_INSTRUCTION,
});
// Full review feedback is preformatted Markdown from the existing review UI.
// It deliberately reuses the same session-scoped instruction claim transport
// rather than trying to translate comments back into document annotations.
const activeGitChangesReviews = new Map<string, ActiveGitChangesReview>();
export type SessionFileEntry = {
  type?: unknown;
  id?: unknown;
  modelId?: unknown;
  provider?: unknown;
  tokensBefore?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    provider?: unknown;
    stopReason?: unknown;
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown };
    content?: unknown;
    toolCallId?: unknown;
  };
};
export type SessionFallbackMetadata = Pick<PanelSessionEnrichment, "contextUsage" | "model" | "activity" | "totalUsedTokens" | "latestCompactionTokens">;
type CachedSessionMetadata = {
  file: string | null;
  expiresAt: number;
  mtimeMs?: number;
  size?: number;
  metadata?: SessionFallbackMetadata;
};
const sessionMetadataCache = new Map<string, CachedSessionMetadata>();
const SESSION_METADATA_CACHE_MS = 2_000;
const MAX_SESSION_METADATA_BYTES = 32 * 1024 * 1024;
const PI_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A pane can receive a click from multiple browser tabs (or a retried HTTP
// request) before the first diff has finished preparing. This map coalesces
// that asynchronous launch into exactly one isolated review server.
const pendingGitChangesReviewLaunches = new Map<string, PendingGitChangesReviewLaunch<ActiveGitChangesReview>>();
const UPLOAD_DIR = join(tmpdir(), "plannotator");
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  tiff: "image/tiff", tif: "image/tiff", avif: "image/avif",
};
const ALLOWED_IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_CONTENT_TYPES));

type HerdrAgent = {
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  foreground_cwd?: unknown;
  focused?: unknown;
  name?: unknown;
  pane_id?: unknown;
  tab_id?: unknown;
  workspace_id?: unknown;
};

type HerdrSnapshot = {
  agents?: unknown;
  panes?: unknown;
  tabs?: unknown;
  workspaces?: unknown;
};

type HerdrPaneEntry = {
  cwd?: unknown;
  foreground_cwd?: unknown;
  workspace_id?: unknown;
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

function imageExtension(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(lastDot + 1).toLowerCase();
}

function modelName(modelId: string): string {
  const id = modelId.replace(/^.*\//, "");
  if (/^gpt-5\.6-(?:terra|sol|luna)(?:-review)?$/i.test(id)) {
    return id.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_match, letter: string) => ` ${letter.toUpperCase()}`);
  }
  return id;
}

function sessionContextWindow(modelId: string): number | undefined {
  if (/^cx\/gpt-5\.6-(?:terra|sol|luna)(?:-review)?$/i.test(modelId)) return 1_050_000;
  return /(?:gpt-5|claude|gemini)/i.test(modelId) ? 200_000 : undefined;
}

function finiteUsageTokens(usage: SessionFileEntry["message"] extends { usage?: infer T } ? T : never): number {
  if (!usage || typeof usage !== "object") return 0;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0), 0);
}

function contextTokensFromUsage(usage: SessionFileEntry["message"] extends { usage?: infer T } ? T : never): number {
  if (!usage || typeof usage !== "object") return 0;
  // Pi uses the provider's totalTokens for current context. It may be smaller
  // than the billable component sum because cache reads are priced separately.
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  return finiteUsageTokens(usage);
}

function sessionActivity(entries: SessionFileEntry[]): HerdrActivity | undefined {
  const activeCalls = new Map<string, string>();
  for (const entry of entries) {
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      activeCalls.delete(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (!content || typeof content !== "object") continue;
      const toolCall = content as { type?: unknown; id?: unknown; name?: unknown };
      if (toolCall.type === "toolCall" && typeof toolCall.id === "string" && typeof toolCall.name === "string") {
        activeCalls.set(toolCall.id, toolCall.name);
      }
    }
  }
  if (activeCalls.size === 0) return undefined;
  const subagentCount = [...activeCalls.values()].filter((name) => name === "subagent").length;
  if (subagentCount > 0) return { kind: "subagent", count: subagentCount };
  const [name] = activeCalls.values();
  return { kind: "tool", name, count: activeCalls.size };
}

async function findPiSessionFile(sessionId: string): Promise<string | null> {
  if (!PI_SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = join(homedir(), ".pi", "agent", "sessions");
  const suffix = `_${sessionId}.jsonl`;
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectPath = join(root, project.name);
      const files = await readdir(projectPath, { withFileTypes: true });
      const session = files.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
      if (session) return join(projectPath, session.name);
    }
  } catch {
    return null;
  }
  return null;
}

export function sessionFallbackMetadataFromEntries(entries: SessionFileEntry[]): SessionFallbackMetadata {
  let latestModel: HerdrModel | undefined;
  let latestAssistantUsage: SessionFileEntry["message"]["usage"] | undefined;
  let latestAssistantIndex = -1;
  let latestCompactionIndex = -1;
  let latestCompactionTokens: number | undefined;
  let totalUsedTokens = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "model_change" && typeof entry.modelId === "string") {
      latestModel = { id: entry.modelId, ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}), name: modelName(entry.modelId) };
    }
    if (entry.type === "compaction" && typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0) {
      latestCompactionIndex = index;
      latestCompactionTokens = entry.tokensBefore;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const message = entry.message;
    if (typeof message.model === "string") {
      latestModel = { id: message.model, ...(typeof message.provider === "string" ? { provider: message.provider } : {}), name: modelName(message.model) };
    }
    totalUsedTokens += finiteUsageTokens(message.usage);
    if (message.stopReason !== "aborted" && message.stopReason !== "error" && contextTokensFromUsage(message.usage) > 0) {
      latestAssistantUsage = message.usage;
      latestAssistantIndex = index;
    }
  }
  const contextWindow = latestModel ? sessionContextWindow(latestModel.id) : undefined;
  const contextTokens = latestAssistantIndex > latestCompactionIndex && latestAssistantUsage
    ? contextTokensFromUsage(latestAssistantUsage)
    : null;
  const activity = sessionActivity(entries);
  return {
    ...(latestModel ? { model: latestModel } : {}),
    ...(contextWindow ? { contextUsage: { tokens: contextTokens, contextWindow, percent: contextTokens === null ? null : (contextTokens / contextWindow) * 100 } } : {}),
    totalUsedTokens,
    ...(latestCompactionTokens !== undefined ? { latestCompactionTokens } : {}),
    ...(activity ? { activity } : {}),
  };
}

async function sessionFallbackMetadata(sessionId: string): Promise<SessionFallbackMetadata | undefined> {
  const now = Date.now();
  const cached = sessionMetadataCache.get(sessionId);
  if (cached?.expiresAt && cached.expiresAt > now) return cached.metadata;
  const file = cached?.file ?? await findPiSessionFile(sessionId);
  if (!file) {
    sessionMetadataCache.set(sessionId, { file: null, expiresAt: now + SESSION_METADATA_CACHE_MS });
    return undefined;
  }
  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile() || fileStat.size > MAX_SESSION_METADATA_BYTES) return undefined;
    if (cached?.metadata && cached.file === file && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      cached.expiresAt = now + SESSION_METADATA_CACHE_MS;
      return cached.metadata;
    }
    // Stream the JSONL line-by-line instead of reading the whole (up to 32MB)
    // file into a single string plus an intermediate split array (F9). Both
    // metadata reducers need the full ordered entry list, so we still collect
    // entries, but peak allocation drops to one line at a time.
    const entries: SessionFileEntry[] = [];
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as unknown;
          if (value && typeof value === "object") entries.push(value as SessionFileEntry);
        } catch {
          // Skip malformed lines; a partially written tail line is expected.
        }
      }
    } finally {
      rl.close();
    }
    const metadata = sessionFallbackMetadataFromEntries(entries);
    sessionMetadataCache.set(sessionId, { file, expiresAt: now + SESSION_METADATA_CACHE_MS, mtimeMs: fileStat.mtimeMs, size: fileStat.size, metadata });
    return metadata;
  } catch {
    sessionMetadataCache.set(sessionId, { file, expiresAt: now + SESSION_METADATA_CACHE_MS });
    return undefined;
  }
}

async function enrichPanelSessionMetadata(enrichments: ReadonlyMap<string, PanelSessionEnrichment>): Promise<Map<string, PanelSessionEnrichment>> {
  const result = new Map(enrichments);
  await Promise.all([...enrichments.entries()].map(async ([paneId, registration]) => {
    if (registration.contextUsage && registration.model && registration.totalUsedTokens !== undefined && registration.latestCompactionTokens !== undefined && registration.activity) return;
    const fallback = await sessionFallbackMetadata(registration.sessionId);
    if (!fallback) return;
    result.set(paneId, {
      ...registration,
      ...(registration.contextUsage ? {} : fallback.contextUsage ? { contextUsage: fallback.contextUsage } : {}),
      ...(registration.model ? {} : fallback.model ? { model: fallback.model } : {}),
      ...(registration.activity ? {} : fallback.activity ? { activity: fallback.activity } : {}),
      ...(registration.totalUsedTokens !== undefined ? {} : fallback.totalUsedTokens !== undefined ? { totalUsedTokens: fallback.totalUsedTokens } : {}),
      ...(registration.latestCompactionTokens !== undefined ? {} : fallback.latestCompactionTokens !== undefined ? { latestCompactionTokens: fallback.latestCompactionTokens } : {}),
    });
  }));
  return result;
}

function normalizeActivity(value: unknown): HerdrActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const activity = value as Record<string, unknown>;
  const kind = activity.kind;
  const name = text(activity.name) ?? undefined;
  const count = activity.count;
  if ((kind !== "tool" && kind !== "subagent") || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100) return null;
  return { kind, ...(name ? { name } : {}), count };
}

function normalizeModel(value: unknown): HerdrModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  const id = text(model.id);
  const provider = text(model.provider) ?? undefined;
  const name = text(model.name) ?? undefined;
  return id && id.length <= 200 ? { id, ...(provider ? { provider } : {}), ...(name ? { name } : {}) } : null;
}

function normalizeContextUsage(value: unknown): HerdrContextUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const tokens = usage.tokens;
  const contextWindow = usage.contextWindow;
  const percent = usage.percent;
  if ((tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0))
    || typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0
    || (percent !== null && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0))) return null;
  return { tokens, contextWindow, percent };
}

function imageAttachments(value: unknown): LiveImageAttachment[] | null {
  if (!Array.isArray(value)) return null;
  const attachments = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const attachment = entry as Record<string, unknown>;
    const path = text(attachment.path);
    const name = text(attachment.name);
    return path && name && ALLOWED_IMAGE_EXTENSIONS.has(imageExtension(path)) ? [{ path, name }] : [];
  });
  return attachments.length === value.length ? attachments : null;
}

function webRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else headers.set(key, value);
  }
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as unknown as BodyInit;
    init.duplex = "half";
  }
  return new Request(`http://localhost${request.url ?? "/"}`, init);
}

async function uploadImage(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Uploading an image requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  try {
    const file = (await webRequest(request).formData()).get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file) || !("name" in file)) {
      writeJson(response, 400, { error: "No image file was provided" });
      return;
    }
    const upload = file as File;
    const extension = imageExtension(upload.name) || "png";
    if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
      writeJson(response, 400, { error: `File extension .${extension} is not a supported image type` });
      return;
    }
    await mkdir(UPLOAD_DIR, { recursive: true });
    const path = join(UPLOAD_DIR, `${randomUUID()}.${extension}`);
    await Bun.write(path, upload);
    writeJson(response, 200, { path, originalName: upload.name });
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : "Image upload failed" });
  }
}

async function serveImage(response: ServerResponse, url: URL): Promise<void> {
  const path = text(url.searchParams.get("path"));
  if (!path || !ALLOWED_IMAGE_EXTENSIONS.has(imageExtension(path))) {
    writeJson(response, 400, { error: "A supported image path is required" });
    return;
  }
  try {
    const content = await readFile(path);
    response.writeHead(200, { "content-type": IMAGE_CONTENT_TYPES[imageExtension(path)]!, "cache-control": "no-store" });
    response.end(content);
  } catch {
    writeJson(response, 404, { error: "Image not found" });
  }
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
      workspaceId: workspaceId ?? "",
      tabId: tabId ?? "",
      workspace: workspaceId ? workspaceLabels.get(workspaceId) ?? workspaceId : basename(cwd),
      tab: tabId ? tabLabels.get(tabId) ?? tabId : "",
      panel: text(agent.name) ?? `Pane ${paneId.split(":").at(-1) ?? paneId}`,
      cwd,
      status: status(agent.agent_status),
      focused: agent.focused === true,
    }];
  });
}

export async function discoverPanels(): Promise<HerdrPanel[]> {
  return panelsFromSnapshot(await fetchHerdrSnapshot());
}

/** Fetch and parse Herdr's authoritative live snapshot (agents + panes + workspaces). */
export async function fetchHerdrSnapshot(): Promise<HerdrSnapshot> {
  const { stdout } = await execFileAsync("herdr", ["api", "snapshot"], { maxBuffer: 1024 * 1024, timeout: 2_000 });
  const response = JSON.parse(stdout) as { result?: { snapshot?: HerdrSnapshot } };
  return response.result?.snapshot ?? {};
}

/**
 * Find a workspace in the snapshot whose label matches `label` AND that has a
 * pane (from the `panes` array, not `agents`) whose resolved cwd matches `cwd`.
 * Uses `panes` so a shell-only workspace still resolves. A workspace whose
 * label matches but has no pane at `cwd` is intentionally treated as not-found
 * so we never reuse a mislabeled workspace rooted at a different path.
 * Returns the matching `workspace_id`, or null.
 */
export function askAiWorkspaceFromSnapshot(
  snapshot: HerdrSnapshot,
  label: string,
  cwd: string,
): string | null {
  const workspaces = Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [];
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
  const targetCwd = resolve(cwd);
  for (const entry of workspaces) {
    if (!entry || typeof entry !== "object") continue;
    const workspace = entry as NamedHerdrResource;
    if (text(workspace.label) !== label) continue;
    const workspaceId = text(workspace.workspace_id);
    if (!workspaceId) continue;
    const hasPaneAtCwd = panes.some((paneEntry) => {
      if (!paneEntry || typeof paneEntry !== "object") return false;
      const pane = paneEntry as HerdrPaneEntry;
      if (text(pane.workspace_id) !== workspaceId) return false;
      const paneCwd = text(pane.foreground_cwd) ?? text(pane.cwd);
      return paneCwd != null && resolve(paneCwd) === targetCwd;
    });
    if (hasPaneAtCwd) return workspaceId;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function formattedWorkingDirectory(cwd: string): string {
  const escapedCwd = escapeHtml(cwd);
  return `<div style="font-family: monospace; font-size: 0.85em; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; background: rgba(120,120,120,0.08); border: 1px solid rgba(120,120,120,0.2); padding: 6px 10px; border-radius: 6px; margin-top: 4px; user-select: all;" title="Working directory — select to copy: ${escapedCwd}">${escapedCwd}</div>`;
}

function waitingDocument(panel: HerdrPanel): string {
  return [
    `# ${panel.workspace}`,
    panel.tab ? `## ${panel.tab} · ${panel.panel}` : `## ${panel.panel}`,
    "",
    "Waiting for the Pi session to publish its latest assistant response.",
    "",
    "**Working directory:**",
    formattedWorkingDirectory(panel.cwd),
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
    ...panels.flatMap((panel) => {
      return [
        `## ${panel.workspace}`,
        `${panel.tab ? `**Tab:** ${panel.tab} · ` : ""}**Panel:** ${panel.panel} · **Status:** ${panel.status}`,
        formattedWorkingDirectory(panel.cwd),
        "",
      ];
    }),
  ].join("\n");
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function requestJson(
  request: IncomingMessage,
  maxBodyBytes = MAX_ACTION_REQUEST_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error("Request body is too large");
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

/** Read the local Pi registration separately from smaller browser action bodies. */
export function readPanelSessionJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return requestJson(request, MAX_PANEL_SESSION_BODY_BYTES);
}

function annotationMessageId(annotation: unknown): string | null {
  if (!annotation || typeof annotation !== "object") return null;
  const value = (annotation as { messageId?: unknown }).messageId;
  return typeof value === "string" ? value : null;
}

export function feedbackBatch(
  body: Record<string, unknown> | null,
  messages: HerdrReviewSnapshot["messages"],
): { paneId: string; batch: LiveFeedbackBatch } | null {
  if (!body || !Array.isArray(body.annotations) || !Array.isArray(body.codeAnnotations)) return null;
  const selectedMessageId = text(body.selectedMessageId);
  const globalAttachments = imageAttachments(body.globalAttachments ?? []);
  if (!globalAttachments) return null;
  const sourceMessages = new Map(messages.map((message) => [message.messageId, message]));


  const grouped = new Map<string, { annotations: LiveDraftAnnotation[]; codeAnnotations: LiveCodeDraftAnnotation[] }>();
  const add = (value: unknown, kind: "annotations" | "codeAnnotations"): boolean => {
    if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") return false;
    const messageId = annotationMessageId(value) ?? selectedMessageId;
    const source = messageId ? sourceMessages.get(messageId) : null;
    if (!source || !source.assistantMessageId) return false;
    const entry = grouped.get(messageId) ?? { annotations: [], codeAnnotations: [] };
    entry[kind].push(value as LiveDraftAnnotation);
    grouped.set(messageId, entry);
    return true;
  };
  for (const annotation of body.annotations) if (!add(annotation, "annotations")) return null;
  for (const annotation of body.codeAnnotations) if (!add(annotation, "codeAnnotations")) return null;
  if (globalAttachments.length > 0) {
    const source = selectedMessageId ? sourceMessages.get(selectedMessageId) : null;
    if (!source?.assistantMessageId) return null;
    const entry = grouped.get(selectedMessageId) ?? { annotations: [], codeAnnotations: [] };
    grouped.set(selectedMessageId, entry);
  }
  if (grouped.size === 0) return null;
  const entries = [...grouped].map(([messageId, drafts]) => {
    const source = sourceMessages.get(messageId)!;
    return {
      paneId: source.paneId,
      message: {
        messageId: source.assistantMessageId!,
        messageText: source.text,
        annotations: structuredClone(drafts.annotations),
        ...(drafts.codeAnnotations.length ? { codeAnnotations: structuredClone(drafts.codeAnnotations) } : {}),
        ...(messageId === selectedMessageId && globalAttachments.length ? { globalAttachments: structuredClone(globalAttachments) } : {}),
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
  const body = await requestJson(request);
  const { snapshot } = await reviewSnapshot();
  const prepared = feedbackBatch(body, snapshot.messages);
  if (!prepared) {
    writeJson(response, 400, { error: "Feedback must annotate one or more structured responses from one live Pi pane" });
    return;
  }
  const registration = panelSessions.get(prepared.paneId);
  if (!registration) {
    writeJson(response, 409, { error: "The selected Pi session is no longer registered" });
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

export function instructionDelivery(
  body: Record<string, unknown> | null,
  messages: HerdrReviewSnapshot["messages"],
): { paneId: string; content: string } | null {
  const paneId = text(body?.paneId);
  const content = text(body?.text);
  if (!paneId || !content || !messages.some((message) => message.paneId === paneId)) return null;
  return { paneId, content };
}

export function commandDelivery(
  body: Record<string, unknown> | null,
  panels: HerdrPanel[],
  enrichments: ReadonlyMap<string, PanelSessionEnrichment>,
): { paneId: string; command: string; args: string } | null {
  const paneId = text(body?.paneId);
  const command = text(body?.command);
  const args = typeof body?.args === "string" ? body.args.trim() : "";
  if (!paneId || !command || !/^[-\w:.]+$/.test(command)) return null;
  const registration = enrichments.get(paneId);
  if (!registration || !panels.some((panel) => panel.id === paneId)) return null;
  if (!registration.commands.some((capability) => capability.name === command)) return null;
  return { paneId, command, args };
}

export async function formatInstructionFileReferences(content: string, root: string): Promise<{ content: string } | { error: string }> {
  const references = extractFileMentionReferences(content);
  if (references.length === 0) return { content };

  const resolved = await Promise.all(references.map(async (reference) => ({
    reference,
    result: await resolveCodeFile(reference.filePath, root),
  })));
  const invalid = resolved.find(({ result }) =>
    result.kind !== "found" || !isWithinProjectRoot(result.path, root),
  );
  if (invalid) {
    return { error: `Could not resolve referenced file: ${invalid.reference.filePath}` };
  }
  const lines = resolved.map(({ reference, result }) => {
    if (result.kind !== "found") throw new Error("Resolved file reference unexpectedly missing");
    const relativePath = relative(root, result.path).replace(/\\/g, "/");
    const location = reference.line === undefined
      ? ""
      : reference.lineEnd === undefined || reference.lineEnd === reference.line
        ? `, line ${reference.line}`
        : `, lines ${reference.line}-${reference.lineEnd}`;
    return `- \`${relativePath}\`${location}`;
  });
  return {
    content: [
      "Referenced workspace files (inspect these before answering):",
      ...lines,
      "",
      content,
    ].join("\n"),
  };
}

async function queueInstruction(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Sending a message requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  const { snapshot } = await reviewSnapshot();
  const body = await requestJson(request);
  const prepared = instructionDelivery(body, snapshot.messages);
  if (!prepared) {
    writeJson(response, 400, { error: "A message and one live Pi pane are required" });
    return;
  }
  const requestedSessionId = text(body?.sessionId);
  const registration = panelSessions.get(prepared.paneId);
  if (!registration || (requestedSessionId && registration.sessionId !== requestedSessionId)) {
    writeJson(response, 409, { error: "The selected Pi pane session is no longer current" });
    return;
  }
  const pane = (await discoverPanels()).find((candidate) => candidate.id === prepared.paneId);
  if (!pane) {
    writeJson(response, 409, { error: "The selected Pi pane is no longer live" });
    return;
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(resolve(pane.cwd));
  } catch {
    writeJson(response, 409, { error: "The selected Pi pane workspace is no longer available" });
    return;
  }
  const references = await formatInstructionFileReferences(prepared.content, workspaceRoot);
  if ("error" in references) {
    writeJson(response, 400, { error: references.error });
    return;
  }
  const delivery: PendingInstructionDelivery = {
    deliveryId: randomUUID(),
    paneId: prepared.paneId,
    sessionId: registration.sessionId,
    content: references.content,
  };
  pendingInstructionDeliveries.set(delivery.deliveryId, delivery);
  writeJson(response, 202, { ok: true, deliveryId: delivery.deliveryId });
}

async function queueCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Running a Pi command requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  const { panels } = await reviewSnapshot();
  const prepared = commandDelivery(await requestJson(request), panels, panelSessions);
  if (!prepared) {
    writeJson(response, 400, { error: "A supported Pi command and one live pane session are required" });
    return;
  }
  // `pane run` writes through Herdr's interactive input path, so Pi performs
  // its normal extension-command dispatch and prompt/skill expansion. This is
  // intentionally distinct from `/api/instruction`, which remains literal
  // `sendUserMessage` text even when it starts with `/`.
  const command = `/${prepared.command}${prepared.args ? ` ${prepared.args}` : ""}`;
  await execFileAsync("herdr", ["pane", "run", prepared.paneId, command], { timeout: 10_000 });
  writeJson(response, 202, { ok: true });
}

function claimingRegistration(body: Record<string, unknown> | null): { paneId: string; sessionId: string } | null {
  const paneId = text(body?.paneId);
  const sessionId = text(body?.sessionId);
  return paneId && sessionId && panelSessions.get(paneId)?.sessionId === sessionId ? { paneId, sessionId } : null;
}

async function claimFeedback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi feedback delivery is loopback-only" });
    return;
  }
  const registration = claimingRegistration(await requestJson(request));
  if (!registration) {
    writeJson(response, 409, { error: "The Pi session registration is no longer current" });
    return;
  }
  const delivery = [...pendingFeedbackDeliveries.values()].find((candidate) =>
    candidate.paneId === registration.paneId && candidate.sessionId === registration.sessionId,
  );
  if (!delivery) {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  // Claim is intentionally destructive. Pi's sendUserMessage is not an
  // idempotent transaction, so at-most-once delivery is safer than duplicates.
  pendingFeedbackDeliveries.delete(delivery.deliveryId);
  writeJson(response, 200, { deliveryId: delivery.deliveryId, batch: delivery.batch });
}

async function claimInstruction(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi message delivery is loopback-only" });
    return;
  }
  const registration = claimingRegistration(await requestJson(request));
  if (!registration) {
    writeJson(response, 409, { error: "The Pi session registration is no longer current" });
    return;
  }
  const delivery = [...pendingInstructionDeliveries.values()].find((candidate) =>
    candidate.paneId === registration.paneId && candidate.sessionId === registration.sessionId,
  );
  if (!delivery) {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  pendingInstructionDeliveries.delete(delivery.deliveryId);
  writeJson(response, 200, { deliveryId: delivery.deliveryId, content: delivery.content });
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

// Herdr is commonly viewed from a private Tailnet. Process-panel actions use
// the same browser authorization as feedback; Pi registration and claim routes
// remain loopback-only because they carry the local Pi session identity.
function canCreateProcessPanel(request: IncomingMessage): boolean {
  return canWriteFeedback(request);
}

/**
 * Only the pane owner's session may replace an existing registration. Older
 * subagent processes inherit HERDR_PANE_ID, so use the advertised Ex review
 * command as a compatibility ownership proof until every process has the
 * explicit `isSubagent` flag.
 */
export function acceptsPanelSessionUpdate(
  current: PanelSessionEnrichment | undefined,
  incoming: PanelSessionEnrichment,
  isSubagent: boolean,
): boolean {
  if (isSubagent) return false;
  if (!current || current.sessionId === incoming.sessionId) return true;
  const currentIsPaneOwner = current.commands.some((command) => command.name === "ex-plannotator-last");
  const incomingIsPaneOwner = incoming.commands.some((command) => command.name === "ex-plannotator-last");
  // Compatibility for already-running old extensions: a short, command-poor
  // registration cannot displace an established pane owner. A new full owner
  // session can still take over after the old process exits or restarts.
  return incomingIsPaneOwner || !currentIsPaneOwner;
}

async function savePanelSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isLoopback(request)) {
    writeJson(response, 403, { error: "Pi session enrichment is loopback-only" });
    return;
  }
  const body = await readPanelSessionJson(request);
  const paneId = text(body?.paneId);
  const sessionId = text(body?.sessionId);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  // Older loaded Ex-Pi extensions do not yet publish command capabilities.
  // Accept their established registration shape so a service upgrade never
  // hides their live messages; they simply have no command picker until Pi
  // reloads the updated extension.
  const commands = body?.commands === undefined ? [] : Array.isArray(body.commands) ? body.commands : null;
  const isSubagent = body?.isSubagent === true;
  if (!paneId || !sessionId || !messages || !commands || messages.length > HERDR_LIVE_MESSAGE_LIMIT || commands.length > 200) {
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
  const normalizedCommands = commands.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const command = value as Record<string, unknown>;
    const name = text(command.name);
    const description = text(command.description) ?? undefined;
    const source = command.source;
    const argumentsList = Array.isArray(command.arguments)
      ? command.arguments.filter((argument): argument is string => typeof argument === "string" && argument.length > 0 && argument.length <= 300).slice(0, 200)
      : undefined;
    return name && /^[-\w:.]+$/.test(name) && (source === "extension" || source === "prompt" || source === "skill")
      ? [{ name, ...(description ? { description } : {}), source, ...(argumentsList?.length ? { arguments: [...new Set(argumentsList)] } : {}) }]
      : [];
  });
  if (normalizedCommands.length !== commands.length || new Set(normalizedCommands.map((command) => command.name)).size !== normalizedCommands.length) {
    writeJson(response, 400, { error: "Invalid Pi command capabilities" });
    return;
  }
  const context = body?.contextUsage;
  const contextUsage = context === undefined ? undefined : normalizeContextUsage(context);
  if (context !== undefined && !contextUsage) {
    writeJson(response, 400, { error: "Invalid Pi context usage" });
    return;
  }
  const modelValue = body?.model;
  const model = modelValue === undefined ? undefined : normalizeModel(modelValue);
  if (modelValue !== undefined && !model) {
    writeJson(response, 400, { error: "Invalid Pi model" });
    return;
  }
  const activityValue = body?.activity;
  const activity = activityValue === undefined ? undefined : normalizeActivity(activityValue);
  if (activityValue !== undefined && !activity) {
    writeJson(response, 400, { error: "Invalid Pi activity" });
    return;
  }
  const totalUsedTokens = body?.totalUsedTokens;
  if (totalUsedTokens !== undefined && (typeof totalUsedTokens !== "number" || !Number.isFinite(totalUsedTokens) || totalUsedTokens < 0)) {
    writeJson(response, 400, { error: "Invalid Pi total token usage" });
    return;
  }
  const compactedTokens = body?.latestCompactionTokens;
  if (compactedTokens !== undefined && (!Number.isFinite(compactedTokens) || typeof compactedTokens !== "number" || compactedTokens < 0)) {
    writeJson(response, 400, { error: "Invalid Pi compaction tokens" });
    return;
  }

  const panels = await discoverPanels();
  if (!panels.some((panel) => panel.id === paneId)) {
    writeJson(response, 404, { error: "The Pi panel is no longer live" });
    return;
  }
  const incoming: PanelSessionEnrichment = {
    paneId,
    sessionId,
    messages: normalizedMessages,
    commands: normalizedCommands,
    ...(typeof totalUsedTokens === "number" ? { totalUsedTokens } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(model ? { model } : {}),
    ...(activity ? { activity } : {}),
    ...(typeof compactedTokens === "number" ? { latestCompactionTokens: compactedTokens } : {}),
  };
  if (!acceptsPanelSessionUpdate(panelSessions.get(paneId), incoming, isSubagent)) {
    // A nested Pi child inherited this pane's HERDR_PANE_ID. It is not the
    // browser-facing session owner and must not cause repeated session resets.
    writeJson(response, 204, null);
    return;
  }
  panelSessions.set(paneId, incoming);
  notifyPanelSessionWaiters(paneId);
  await exAICompanions.reconcile();
  // Publish the new structured response against the same host snapshot used by
  // /api/plan and all connected browsers; do not wait for the next poll.
  await refreshLiveState();
  writeJson(response, 200, { ok: true });
}

function stopGitChangesReview(review: ActiveGitChangesReview): void {
  review.server.stop();
  if (activeGitChangesReviews.get(review.paneId) === review) {
    activeGitChangesReviews.delete(review.paneId);
  }
}

export type PendingGitChangesReviewLaunch<T extends GitChangesReviewIdentity> = {
  sessionId: string;
  cwd: string;
  compareMode?: WorkspaceCompareMode;
  cancelled: boolean;
  promise: Promise<T>;
};

export class GitChangesReviewLaunchSuperseded extends Error {
  constructor() {
    super("The full-review launch was superseded by a newer pane session or workspace");
  }
}

/** Cancel a stale launch without waiting for its Git preparation to finish. */
export function cancelPendingGitChangesReviewLaunch<T extends GitChangesReviewIdentity>(
  pending: Map<string, PendingGitChangesReviewLaunch<T>>,
  paneId: string,
  sessionId?: string,
): void {
  const launch = pending.get(paneId);
  if (!launch || (sessionId !== undefined && launch.sessionId !== sessionId)) return;
  launch.cancelled = true;
  if (pending.get(paneId) === launch) pending.delete(paneId);
}

/**
 * Atomically reuse a matching review or reserve its full asynchronous launch.
 * The reservation is stored before the launch promise reaches its first await,
 * so concurrent browser requests cannot each create their own review server.
 */
export async function reuseOrLaunchGitChangesReview<T extends GitChangesReviewIdentity>(
  active: Map<string, T>,
  pending: Map<string, PendingGitChangesReviewLaunch<T>>,
  paneId: string,
  sessionId: string,
  cwd: string,
  launch: () => Promise<T>,
  disposeSuperseded?: (review: T) => void,
  compareMode?: WorkspaceCompareMode,
): Promise<{ review: T; reused: boolean }> {
  const current = active.get(paneId);
  if (current?.sessionId === sessionId && current.cwd === cwd && current.compareMode === compareMode) {
    return { review: current, reused: true };
  }

  const inFlight = pending.get(paneId);
  if (inFlight?.sessionId === sessionId && inFlight.cwd === cwd && inFlight.compareMode === compareMode && !inFlight.cancelled) {
    try {
      const review = await inFlight.promise;
      if (inFlight.cancelled) {
        throw new GitChangesReviewLaunchSuperseded();
      }
      return { review, reused: true };
    } catch (error) {
      if (inFlight.cancelled) {
        throw new GitChangesReviewLaunchSuperseded();
      }
      throw error;
    }
  }
  // A replacement session/workspace must never inherit or wait on a stale
  // launch. Let its request create a new reservation while the old launch
  // cleans itself up when it eventually resolves.
  if (inFlight) cancelPendingGitChangesReviewLaunch(pending, paneId);

  // Register first, then begin the asynchronous work in a microtask. Besides
  // coalescing concurrent callers, this turns a synchronously-throwing launch
  // into a rejected promise that is cleaned up by the finally below.
  const entry = {
    sessionId,
    cwd,
    ...(compareMode ? { compareMode } : {}),
    cancelled: false,
  } as PendingGitChangesReviewLaunch<T>;
  entry.promise = Promise.resolve().then(launch);
  pending.set(paneId, entry);
  try {
    let review: T;
    try {
      review = await entry.promise;
    } catch (error) {
      // A replacement launch has already taken over; surface the state change
      // rather than leaking an unrelated startup failure to that new session.
      if (entry.cancelled || pending.get(paneId) !== entry) {
        throw new GitChangesReviewLaunchSuperseded();
      }
      throw error;
    }
    if (entry.cancelled || pending.get(paneId) !== entry) {
      disposeSuperseded?.(review);
      throw new GitChangesReviewLaunchSuperseded();
    }
    active.set(paneId, review);
    return { review, reused: false };
  } finally {
    if (pending.get(paneId) === entry) pending.delete(paneId);
  }
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
  for (const [deliveryId, delivery] of pendingInstructionDeliveries) {
    if (delivery.paneId === paneId && delivery.sessionId === sessionId) pendingInstructionDeliveries.delete(deliveryId);
  }
  const review = activeGitChangesReviews.get(paneId);
  if (review?.sessionId === sessionId) stopGitChangesReview(review);
  cancelPendingGitChangesReviewLaunch(pendingGitChangesReviewLaunches, paneId, sessionId);
  return true;
}

async function deletePanelSession(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
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
  const released = releasePanelSession(panelSessions, paneId, sessionId);
  if (released) await refreshLiveState();
  writeJson(response, 200, { ok: true });
}

export function reviewSnapshotFromPanels(
  panels: HerdrPanel[],
  preferredPanelId: string | null = null,
  enrichments: ReadonlyMap<string, PanelSessionEnrichment> = new Map(),
): HerdrReviewSnapshot {
  const livePaneIds = new Set(panels.map((panel) => panel.id));
  const isCompanionPane = (paneId: string) => exAICompanions.isCompanionPane(paneId);

  const selected = panels.find((panel) => panel.id === preferredPanelId)
    ?? panels.find((panel) => panel.focused)
    ?? panels[0]
    ?? null;
  const messages = panels.flatMap((panel) => {
    const paneLabel = panel.workspace;
    const tabPart = (panel.tab && panel.tab !== panel.workspace && !panel.panel.toLowerCase().includes(panel.tab.toLowerCase()))
      ? panel.tab
      : "";
    const paneDescription = [tabPart, panel.panel].filter(Boolean).join(" · ");
    const responses = enrichments.get(panel.id)?.messages ?? [];
    if (responses.length === 0) {
      return [{
        messageId: documentId(panel.id, "waiting"),
        paneId: panel.id,
        ...(enrichments.get(panel.id)?.sessionId ? { piSessionId: enrichments.get(panel.id)!.sessionId } : {}),
        text: waitingDocument(panel),
        label: "Waiting for a response",
        description: "No structured assistant response published yet",
        paneLabel,
        paneDescription,
        agentStatus: panel.status,
        cwd: panel.cwd,
        workspaceId: panel.workspaceId,
        commands: enrichments.get(panel.id)?.commands ?? [],
        ...(enrichments.get(panel.id)?.contextUsage ? { contextUsage: enrichments.get(panel.id)!.contextUsage } : {}),
        ...(enrichments.get(panel.id)?.model ? { model: enrichments.get(panel.id)!.model } : {}),
        ...(enrichments.get(panel.id)?.activity ? { activity: enrichments.get(panel.id)!.activity } : {}),
        ...(enrichments.get(panel.id)?.totalUsedTokens !== undefined ? { totalUsedTokens: enrichments.get(panel.id)!.totalUsedTokens } : {}),
        ...(enrichments.get(panel.id)?.latestCompactionTokens !== undefined ? { latestCompactionTokens: enrichments.get(panel.id)!.latestCompactionTokens } : {}),
        ...(panel.gitBranch ? { gitBranch: panel.gitBranch } : {}),
        ...(isCompanionPane(panel.id) ? { isExAICompanion: true } : {}),
      }];
    }
    return responses.map((response, index) => ({
      // `messageId` is a UI-only opaque key. `paneId` and
      // `assistantMessageId` retain the two real identities separately.
      messageId: documentId(panel.id, response.messageId),
      paneId: panel.id,
      piSessionId: enrichments.get(panel.id)!.sessionId,
      assistantMessageId: response.messageId,
      text: response.text,
      ...(response.timestamp ? { timestamp: response.timestamp } : {}),
      label: `Response ${index + 1}${index === 0 ? " · latest" : ""}`,
      description: "Structured Pi assistant response",
      paneLabel,
      paneDescription,
      agentStatus: panel.status,
      cwd: panel.cwd,
      workspaceId: panel.workspaceId,
      commands: enrichments.get(panel.id)!.commands,
      ...(enrichments.get(panel.id)?.contextUsage ? { contextUsage: enrichments.get(panel.id)!.contextUsage } : {}),
      ...(enrichments.get(panel.id)?.model ? { model: enrichments.get(panel.id)!.model } : {}),
      ...(enrichments.get(panel.id)?.activity ? { activity: enrichments.get(panel.id)!.activity } : {}),
      ...(enrichments.get(panel.id)?.totalUsedTokens !== undefined ? { totalUsedTokens: enrichments.get(panel.id)!.totalUsedTokens } : {}),
      ...(enrichments.get(panel.id)?.latestCompactionTokens !== undefined ? { latestCompactionTokens: enrichments.get(panel.id)!.latestCompactionTokens } : {}),
      ...(panel.gitBranch ? { gitBranch: panel.gitBranch } : {}),
      ...(isCompanionPane(panel.id) ? { isExAICompanion: true } : {}),
    }));
  });
  const selectedMessage = selected
    ? messages.find((message) => message.paneId === selected.id) ?? null
    : null;
  return {
    revision: 0,
    messages,
    selectedMessageId: selectedMessage?.messageId ?? null,
    unreadMessageIds: [],
    draftsByMessageId: {},
    sentAnnotationsByMessageId: {},
    reviewRoundStatus: "open",
    deliveryError: null,
  };
}

export function commandArgv(command: string): string[] | null {
  const argv: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        argv.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (quote || escaped || token === "" && argv.length === 0) return null;
  if (token) argv.push(token);
  return argv.length > 0 ? argv : null;
}

function commandOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(argument: string): string {
  return `'${argument.replace(/'/g, "'\\\"'\\\"'")}'`;
}

type HerdrWorkspaceCreateResponse = {
  result?: { workspace?: { workspace_id?: unknown } };
};

/**
 * Pure create-if-missing orchestration for the opt-in Ask AI workspace.
 * Resolves an existing workspace by label+cwd from the snapshot, otherwise
 * creates one. I/O is injected so this is unit-testable without live Herdr.
 */
export async function resolveOrCreateAskAiWorkspace(
  label: string,
  cwd: string,
  fetchSnapshot: () => Promise<HerdrSnapshot>,
  createWorkspace: (label: string, cwd: string) => Promise<string>,
): Promise<{ workspaceId: string; cwd: string }> {
  const existing = askAiWorkspaceFromSnapshot(await fetchSnapshot(), label, cwd);
  if (existing) return { workspaceId: existing, cwd };
  const workspaceId = await createWorkspace(label, cwd);
  return { workspaceId, cwd };
}

async function createAskAiWorkspaceViaHerdr(label: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "herdr",
    ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
    { timeout: 10_000 },
  );
  let parsed: HerdrWorkspaceCreateResponse;
  try {
    parsed = JSON.parse(stdout) as HerdrWorkspaceCreateResponse;
  } catch {
    throw new Error(`Could not parse 'herdr workspace create' output for Ask AI workspace "${label}".`);
  }
  const workspaceId = text(parsed.result?.workspace?.workspace_id);
  if (!workspaceId) {
    throw new Error(`'herdr workspace create' did not return a workspace_id for Ask AI workspace "${label}".`);
  }
  return workspaceId;
}

// Single-flight guard so two near-simultaneous Ask AI session creates never
// create two workspaces with the same label (see ensureHerdrPiModels for the
// lazy single-flight precedent).
const askAiWorkspaceSingleFlight = new SingleFlight<{ workspaceId: string; cwd: string }>();

/**
 * Ensure the opt-in dedicated Ask AI workspace exists, creating it if missing.
 * Returns `null` when the feature is disabled (no configured cwd), leaving all
 * default Ask AI behavior unchanged. Concurrency-safe via single-flight keyed
 * on the workspace label.
 */
export function ensureAskAiWorkspace(
  config: PlannotatorConfig = loadConfig(),
): Promise<{ workspaceId: string; cwd: string } | null> {
  const settings = resolveAskAiWorkspace(config);
  if (!settings) return Promise.resolve(null);
  const cwd = resolve(settings.cwd.replace(/^~(?=$|\/)/, homedir()));
  return askAiWorkspaceSingleFlight.run(settings.label, () =>
    resolveOrCreateAskAiWorkspace(settings.label, cwd, fetchHerdrSnapshot, createAskAiWorkspaceViaHerdr),
  );
}

export async function resolveHerdrAIWorkspace(
  requestedCwd?: string,
  ensureWorkspace: () => Promise<{ workspaceId: string; cwd: string } | null> = ensureAskAiWorkspace,
): Promise<string> {
  if (!requestedCwd || !isAbsolute(requestedCwd)) {
    // Feature-on: resolve (create-if-missing) the dedicated workspace so Ask AI
    // works without first selecting a live Pi pane. Feature-off: unchanged.
    const ensured = await ensureWorkspace();
    if (ensured) return ensured.cwd;
    throw new Error("Select a live Pi response before starting Ask AI.");
  }
  const requested = resolve(requestedCwd);
  const panels = await discoverPanels();
  const panel = panels.find((candidate) => resolve(candidate.cwd) === requested && candidate.workspaceId);
  if (!panel) {
    throw new Error("The selected workspace is no longer a live Herdr Pi workspace.");
  }
  return panel.cwd;
}

/**
 * Resolve only an exact currently registered pane/session pair. The browser
 * sends opaque IDs, while the trusted local registration supplies any path.
 * Missing persisted-session data intentionally degrades to a normal Ask AI
 * session rather than exposing a host path or blocking assistance.
 */
export async function resolveHerdrAISourceSession(
  requested?: { paneId?: string; sessionId?: string },
  authorizedCwd?: string,
  knownPanels?: ReadonlyArray<HerdrPanel>,
  registrations: ReadonlyMap<string, PanelSessionEnrichment> = panelSessions,
): Promise<{ paneId: string; sessionId: string; sessionFile?: string } | undefined> {
  const paneId = text(requested?.paneId);
  const sessionId = text(requested?.sessionId);
  if (!paneId || !sessionId) return undefined;

  const panels = knownPanels ?? await discoverPanels();
  const panel = panels.find((candidate) => candidate.id === paneId);
  if (!panel) {
    throw new Error("The selected Pi session is no longer live.");
  }
  if (authorizedCwd && resolve(panel.cwd) !== resolve(authorizedCwd)) {
    throw new Error("The selected Pi session does not belong to this workspace.");
  }
  const registration = registrations.get(paneId);
  if (!registration || registration.sessionId !== sessionId) {
    throw new Error("The selected Pi session has changed.");
  }
  return {
    paneId,
    sessionId,
    ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
  };
}

const herdrPiGateway: HerdrPiGateway = {
  async launch({ cwd, label, model, thinking }) {
    const panels = await discoverPanels();
    const owner = panels.find((panel) => resolve(panel.cwd) === resolve(cwd) && panel.workspaceId);
    let workspaceId = owner?.workspaceId;
    let workspaceCwd = owner?.cwd;
    // The dedicated Ask AI workspace may be shell-only (no live pi pane yet), so
    // it is invisible to discoverPanels(). Fall back to the ensured workspace
    // when its cwd matches the request; ensureAskAiWorkspace is the authority
    // that created/validated the workspace_id.
    let ensuredWorkspaceId: string | undefined;
    if (!workspaceId) {
      const ensured = await ensureAskAiWorkspace();
      if (ensured && resolve(ensured.cwd) === resolve(cwd)) {
        workspaceId = ensured.workspaceId;
        workspaceCwd = ensured.cwd;
        ensuredWorkspaceId = ensured.workspaceId;
      }
    }
    if (!workspaceId || !workspaceCwd) {
      throw new Error("The selected workspace is no longer a live Herdr Pi workspace.");
    }
    const command = [
      "pi",
      "--tools", shellQuote("read,grep,find,ls"),
      ...(model ? ["--model", shellQuote(model)] : []),
      ...(thinking ? ["--thinking", shellQuote(thinking)] : []),
    ].join(" ");
    const created = await createProcessPanel({
      workspaceId,
      cwd: workspaceCwd,
      panelName: label,
      command,
    }, panels, ensuredWorkspaceId ? new Set([ensuredWorkspaceId]) : undefined);
    if (!created) throw new Error("Could not create an Ask AI Pi pane in this workspace.");
    return created;
  },
  registration(paneId) {
    const registration = panelSessions.get(paneId);
    return registration && {
      sessionId: registration.sessionId,
      messages: registration.messages,
      model: registration.model?.id,
      commands: registration.commands,
    };
  },
  async send(paneId, prompt) {
    await execFileAsync("herdr", ["pane", "run", paneId, prompt], { timeout: 10_000 });
  },
  async close(pane) {
    if (pane.tabId) {
      await execFileAsync("herdr", ["tab", "close", pane.tabId], { timeout: 10_000 });
      return;
    }
    await execFileAsync("herdr", ["pane", "close", pane.paneId], { timeout: 10_000 });
  },
};

const herdrAIRegistry = new ProviderRegistry();
/** Models populated lazily on the first capabilities call so server startup is never blocked by `pi --list-models`. */
const herdrPiModels = new Array<{ id: string; label: string; default?: boolean }>();
let herdrPiModelsResolved = false;
let herdrPiModelsPromise: Promise<void> | null = null;
async function ensureHerdrPiModels(): Promise<void> {
  if (herdrPiModelsResolved) return;
  herdrPiModelsPromise ??= (async () => {
    const models = await discoverPiModels();
    herdrPiModels.length = 0;
    herdrPiModels.push(...models.map((model, index) => ({
      ...model,
      ...(index === 0 ? { default: true } : {}),
    })));
  })();
  await herdrPiModelsPromise;
  herdrPiModelsResolved = true;
}
if (commandOnPath("pi")) {
  herdrAIRegistry.register(
    new HerdrPiProvider({ gateway: herdrPiGateway, models: herdrPiModels }),
    HERDR_PI_PROVIDER_ID,
  );
}
const herdrAISessionManager = new SessionManager();
const herdrAIEndpoints = createAIEndpoints({
  registry: herdrAIRegistry,
  sessionManager: herdrAISessionManager,
  getCwd: resolveHerdrAIWorkspace,
  getSourceSession: resolveHerdrAISourceSession,
  beforeCapabilities: ensureHerdrPiModels,
});

async function handleHerdrAIRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/ai/")) return false;
  if (url.pathname !== "/api/ai/capabilities" && !canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Ask AI requires a loopback, Tailscale, or write-token browser." });
    return true;
  }
  const handler = herdrAIEndpoints[url.pathname as keyof typeof herdrAIEndpoints];
  if (!handler) {
    writeJson(response, 404, { error: "Not found" });
    return true;
  }
  try {
    const webResponse = await handler(webRequest(request));
    const headers: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => { headers[key] = value; });
    response.writeHead(webResponse.status, headers);
    if (webResponse.body) {
      Readable.fromWeb(webResponse.body as never).pipe(response);
    } else {
      response.end();
    }
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : "Ask AI endpoint error" });
  }
  return true;
}

type HerdrCliResponse = { result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown }; agent?: { pane_id?: unknown } } };
/**
 * Guard for which workspace ids createProcessPanel may spawn a pane in. Accept
 * a workspace that already hosts a live pi pane, OR one explicitly vouched for
 * by the caller (the ensured Ask AI workspace, which may be shell-only and thus
 * absent from `panels`). Both are real, snapshot-backed workspace ids; an
 * arbitrary/unknown workspaceId is still rejected.
 */
export function isKnownProcessPanelWorkspace(
  workspaceId: string,
  panels: ReadonlyArray<HerdrPanel>,
  extraWorkspaceIds?: ReadonlySet<string>,
): boolean {
  return panels.some((panel) => panel.workspaceId === workspaceId) || extraWorkspaceIds?.has(workspaceId) === true;
}

export async function createProcessPanel(
  body: Record<string, unknown> | null,
  panels: HerdrPanel[],
  extraWorkspaceIds?: ReadonlySet<string>,
): Promise<{ paneId: string; panelName: string } | null> {
  const workspaceId = text(body?.workspaceId);
  const cwd = text(body?.cwd);
  const panelName = text(body?.panelName);
  const command = text(body?.command);
  if (!workspaceId || !cwd || !panelName || panelName.length > 80 || !command || !isAbsolute(cwd)) return null;
  if (!isKnownProcessPanelWorkspace(workspaceId, panels, extraWorkspaceIds)) return null;
  const argv = commandArgv(command);
  if (!argv) return null;
  let directory: Awaited<ReturnType<typeof stat>>;
  try {
    directory = await stat(cwd);
  } catch {
    return null;
  }
  if (!directory.isDirectory()) return null;

  // A dedicated background tab preserves every existing pane and its focus.
  // `tab create` opens the tab with an empty shell root pane; `agent start
  // --tab` then adds the Pi pane beside it. Close that initial root pane so
  // the tab holds exactly the one named Pi panel instead of a stray shell.
  const tabResult = await execFileAsync("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", panelName, "--no-focus"], { timeout: 10_000 });
  const parsedTab = (JSON.parse(tabResult.stdout) as HerdrCliResponse).result;
  const tabId = text(parsedTab?.tab?.tab_id);
  const rootPaneId = text(parsedTab?.root_pane?.pane_id);
  if (!tabId) throw new Error("Herdr did not return the new tab");
  try {
    const agentResult = await execFileAsync("herdr", ["agent", "start", panelName, "--workspace", workspaceId, "--tab", tabId, "--cwd", cwd, "--no-focus", "--", ...argv], { timeout: 10_000 });
    const paneId = text((JSON.parse(agentResult.stdout) as HerdrCliResponse).result?.agent?.pane_id);
    if (!paneId) throw new Error("Herdr did not return the new Pi pane");
    // The agent lands in its own pane; retire the leftover empty root pane.
    if (rootPaneId && rootPaneId !== paneId) {
      await execFileAsync("herdr", ["pane", "close", rootPaneId], { timeout: 10_000 }).catch(() => {});
    }
    return { paneId, panelName };
  } catch (error) {
    // Avoid leaving an empty tab behind if the process command cannot start.
    await execFileAsync("herdr", ["tab", "close", tabId]).catch(() => {});
    throw error;
  }
}

async function queueProcessPanel(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canCreateProcessPanel(request)) {
    writeJson(response, 403, { error: "Creating a Pi panel requires a loopback, Tailscale, or write-token browser." });
    return;
  }
  const panels = await discoverPanels();
  const panel = await createProcessPanel(await requestJson(request), panels);
  if (!panel) {
    writeJson(response, 400, { error: "A live workspace, existing absolute working directory, panel name, and valid command are required" });
    return;
  }
  writeJson(response, 201, panel);
}

async function closeProcessPanel(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!canCreateProcessPanel(request)) {
    writeJson(response, 403, { error: "Closing a Pi panel requires a loopback, Tailscale, or write-token browser." });
    return;
  }
  const paneId = text(url.searchParams.get("paneId"));
  const panels = await discoverPanels();
  if (!paneId || !panels.some((panel) => panel.id === paneId)) {
    writeJson(response, 404, { error: "The selected Pi panel is no longer live" });
    return;
  }
  await execFileAsync("herdr", ["pane", "close", paneId], { timeout: 10_000 });
  writeJson(response, 200, { ok: true });
}

type HerdrLiveState = { panels: HerdrPanel[]; snapshot: HerdrReviewSnapshot };

type CachedGitBranch = { branch: string | undefined; expiresAt: number };
const gitBranchCache = new Map<string, CachedGitBranch>();
const GIT_BRANCH_CACHE_MS = 2_000;

async function gitBranch(cwd: string): Promise<string | undefined> {
  const cached = gitBranchCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.branch;
  const result = await runHerdrGit(["--no-optional-locks", "branch", "--show-current"], { cwd, timeoutMs: 2_000 });
  const branch = result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  gitBranchCache.set(cwd, { branch, expiresAt: Date.now() + GIT_BRANCH_CACHE_MS });
  return branch;
}

// Fingerprint of the only two inputs the prune loops react to: the live pane
// set and each pane's registered sessionId. When both are unchanged from the
// previous tick no prune condition can newly fire, so the five map scans are
// skipped (F11). Staleness stays self-correcting because any pane close or
// session change alters this key and re-runs the full prune.
let lastPruneKey: string | null = null;

async function readLiveState(): Promise<HerdrLiveState> {
  const panels = await discoverPanels();
  const livePaneIds = new Set(panels.map((panel) => panel.id));
  const pruneKey = `${[...livePaneIds].sort().join(",")}|${[...panelSessions.entries()]
    .map(([paneId, registration]) => `${paneId}:${registration.sessionId}`)
    .sort()
    .join(",")}`;
  if (pruneKey !== lastPruneKey) {
    lastPruneKey = pruneKey;
    for (const paneId of panelSessions.keys()) {
      if (!livePaneIds.has(paneId)) panelSessions.delete(paneId);
    }
    for (const review of activeGitChangesReviews.values()) {
      if (!livePaneIds.has(review.paneId) || panelSessions.get(review.paneId)?.sessionId !== review.sessionId) {
        stopGitChangesReview(review);
      }
    }
    for (const [paneId, launch] of pendingGitChangesReviewLaunches) {
      if (!livePaneIds.has(paneId) || panelSessions.get(paneId)?.sessionId !== launch.sessionId) {
        cancelPendingGitChangesReviewLaunch(pendingGitChangesReviewLaunches, paneId, launch.sessionId);
      }
    }
    for (const [deliveryId, delivery] of pendingFeedbackDeliveries) {
      if (!livePaneIds.has(delivery.paneId) || panelSessions.get(delivery.paneId)?.sessionId !== delivery.sessionId) {
        pendingFeedbackDeliveries.delete(deliveryId);
      }
    }
    for (const [deliveryId, delivery] of pendingInstructionDeliveries) {
      if (!livePaneIds.has(delivery.paneId) || panelSessions.get(delivery.paneId)?.sessionId !== delivery.sessionId) {
        pendingInstructionDeliveries.delete(deliveryId);
      }
    }
  }
  const [panelsWithGitBranches, enrichedSessions] = await Promise.all([
    Promise.all(panels.map(async (panel) => {
      const branch = await gitBranch(panel.cwd);
      return { ...panel, ...(branch ? { gitBranch: branch } : {}) };
    })),
    enrichPanelSessionMetadata(panelSessions),
  ]);
  return { panels: panelsWithGitBranches, snapshot: reviewSnapshotFromPanels(panelsWithGitBranches, null, enrichedSessions) };
}

const liveSnapshotPublisher = new LiveSnapshotPublisher(readLiveState);

async function refreshLiveState(): Promise<PublishedLiveSnapshot<HerdrLiveState>> {
  const published = await liveSnapshotPublisher.refresh();
  // Fresh Herdr snapshots are liveness authority for durable Ex AI pair reconciliation.
  await exAICompanions.reconcile();
  return published;
}

async function reviewSnapshot(): Promise<HerdrLiveState> {
  return (await refreshLiveState()).value;
}

async function currentLiveState(): Promise<PublishedLiveSnapshot<HerdrLiveState>> {
  return liveSnapshotPublisher.snapshot();
}

// Read-only file-browsing handlers only need the current panel set, not a
// fresh `herdr api snapshot` subprocess. The 2s poll loop keeps this cache
// current, so reads become near-instant instead of spawning a subprocess per
// request. The cached panels are a superset of discoverPanels() (they carry
// gitBranch enrichment), which is safe for id/cwd lookups.
async function cachedPanels(): Promise<HerdrPanel[]> {
  return (await liveSnapshotPublisher.snapshot()).value.panels;
}

const FILE_BROWSER_EXTENSIONS = /\.(mdx?|txt|html?)$/i;
const FILE_MENTION_EXTENSIONS = /(?:\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|r|dart|ex|exs|vue|svelte|astro|zig|proto)|(?:^|\/)(?:Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Vagrantfile|Brewfile|Justfile))$/i;
const FILE_BROWSER_MAX_FILES = 5_000;
const FILE_MENTION_MAX_FILES = 10_000;
const FILE_MENTION_CACHE_TTL_MS = 30_000;
const FILE_MENTION_MAX_RESULTS = 8;
const FILE_BROWSER_EXCLUDED_NAMES = new Set([
  "node_modules", ".git", ".claude", ".agents", "dist", "build", ".next",
  "__pycache__", ".obsidian", ".trash", ".venv", "vendor", "target", ".cache",
  "coverage", ".turbo", ".svelte-kit", ".nuxt", ".output", ".parcel-cache",
  ".webpack", ".expo", "_site", "public", ".jekyll-cache", "out", ".docusaurus", "storybook-static",
]);

type WorkspaceFileStatus = WorkspaceStatusPayload["files"][string]["status"];
type WorkspaceStatus = WorkspaceStatusPayload;
type FileBrowserWalkState = { files: Set<string>; truncated: boolean };
type FileMentionCacheEntry = { startedAt: number; promise: Promise<string[]> };
type VaultNode = { name: string; path: string; type: "file" | "folder"; children?: VaultNode[] };
const fileMentionCache = new Map<string, FileMentionCacheEntry>();

function isFileBrowserExcludedPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, "/").split("/").some((part) => FILE_BROWSER_EXCLUDED_NAMES.has(part));
}

function includeWorkspaceFile(relativePath: string): boolean {
  return FILE_BROWSER_EXTENSIONS.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

function includeFileMention(relativePath: string): boolean {
  return FILE_MENTION_EXTENSIONS.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
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

async function walkFileMentions(directory: string, root: string, files: string[]): Promise<void> {
  if (files.length >= FILE_MENTION_MAX_FILES) return;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= FILE_MENTION_MAX_FILES) return;
    const fullPath = join(directory, entry.name);
    const relativePath = relative(root, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (!isFileBrowserExcludedPath(relativePath)) await walkFileMentions(fullPath, root, files);
    } else if (entry.isFile() && includeFileMention(relativePath)) {
      files.push(relativePath);
    }
  }
}

function cachedFileMentions(root: string): Promise<string[]> {
  const entry = fileMentionCache.get(root);
  if (entry && Date.now() - entry.startedAt < FILE_MENTION_CACHE_TTL_MS) return entry.promise;
  const promise = (async () => {
    const files: string[] = [];
    await walkFileMentions(root, root, files);
    return files.sort((a, b) => a.localeCompare(b));
  })();
  fileMentionCache.set(root, { startedAt: Date.now(), promise });
  return promise;
}

function scoreFileMention(path: string, query: string): number {
  const normalizedQuery = query.replace(/^\.?\//, "").toLowerCase();
  if (!normalizedQuery) return 0;
  const normalizedPath = path.toLowerCase();
  const filename = basename(normalizedPath);
  if (normalizedPath === normalizedQuery) return 0;
  if (filename === normalizedQuery) return 1;
  if (normalizedPath.startsWith(normalizedQuery)) return 2;
  if (filename.startsWith(normalizedQuery)) return 3;
  if (normalizedPath.includes(normalizedQuery)) return 4;
  return Number.POSITIVE_INFINITY;
}

/** Search only the workspace belonging to a current live pane; never expose arbitrary host paths. */
export async function searchLiveWorkspaceFiles(paneId: string, query: string, panels: HerdrPanel[]): Promise<string[] | null> {
  const pane = panels.find((candidate) => candidate.id === paneId);
  if (!pane) return null;
  const workspace = await liveWorkspaceDirectory(pane.cwd, panels, { exactRoot: true });
  if (!workspace) return null;
  const files = await cachedFileMentions(workspace.root);
  return files
    .map((path) => ({ path, score: scoreFileMention(path, query) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, FILE_MENTION_MAX_RESULTS)
    .map((candidate) => candidate.path);
}

function unavailableWorkspaceStatus(rootPath: string, error: string): WorkspaceStatus {
  return { available: false, rootPath, files: {}, totals: { files: 0, additions: 0, deletions: 0 }, error };
}

function gitStatusFromDiff(status: string): WorkspaceFileStatus {
  switch (status[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "typechange";
    default: return "modified";
  }
}

function pathIsInWorkspace(rootPath: string, repoRoot: string, repoRelativePath: string): boolean {
  const path = resolve(repoRoot, repoRelativePath);
  const pathFromRoot = relative(rootPath, path).replace(/\\/g, "/");
  return !!pathFromRoot && !pathFromRoot.startsWith("../") && !isAbsolute(pathFromRoot) && includeWorkspaceChange(pathFromRoot);
}

function parseNameStatus(output: string): Array<{ status: WorkspaceFileStatus; repoRelativePath: string; oldRepoRelativePath?: string }> {
  const fields = output.split("\0").filter(Boolean);
  const changes: Array<{ status: WorkspaceFileStatus; repoRelativePath: string; oldRepoRelativePath?: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index] ?? "";
    const repoRelativePath = fields[index + 1];
    if (!status || !repoRelativePath) continue;
    index += 1;
    const renameOrCopy = status.startsWith("R") || status.startsWith("C");
    const oldRepoRelativePath = renameOrCopy ? repoRelativePath : undefined;
    const newRepoRelativePath = renameOrCopy ? fields[++index] : repoRelativePath;
    if (!newRepoRelativePath) continue;
    changes.push({
      status: gitStatusFromDiff(status),
      repoRelativePath: newRepoRelativePath,
      oldRepoRelativePath,
    });
  }
  return changes;
}

async function runHerdrGit(
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? 10_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? (error instanceof Error ? error.message : "git failed"),
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

const herdrGitRuntime: ReviewGitRuntime = {
  runGit: runHerdrGit,
  async readTextFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
};

export type WorkspaceCompareMode = "since-base" | "head" | "unstaged" | "staged";

function parseWorkspaceCompareMode(value: unknown): WorkspaceCompareMode | null {
  return value === "since-base" || value === "head" || value === "unstaged" || value === "staged" ? value : null;
}

function workspaceCompareDiffType(mode: WorkspaceCompareMode): "since-base" | "uncommitted" | "unstaged" | "staged" {
  return mode === "head" ? "uncommitted" : mode;
}

function workspaceCompareLabel(mode: WorkspaceCompareMode, base?: string): string {
  if (mode === "since-base") return `All changes since ${base ?? "base"}`;
  if (mode === "head") return "Working tree vs HEAD";
  if (mode === "unstaged") return "Unstaged changes";
  return "Staged changes";
}

const WORKSPACE_STATUS_CACHE_MS = 2_000;
const workspaceStatusCache = new Map<string, { expiresAt: number; inFlight: boolean; status: Promise<WorkspaceStatus> }>();

export async function workspaceStatus(rootPath: string, compareMode: WorkspaceCompareMode = "since-base"): Promise<WorkspaceStatus> {
  const cacheKey = `${rootPath}\0${compareMode}`;
  const now = Date.now();
  const existing = workspaceStatusCache.get(cacheKey);
  if (existing && (existing.inFlight || existing.expiresAt > now)) return existing.status;

  const status = computeWorkspaceStatus(rootPath, compareMode);
  const entry = { expiresAt: 0, inFlight: true, status };
  workspaceStatusCache.set(cacheKey, entry);
  try {
    const resolved = await status;
    if (workspaceStatusCache.get(cacheKey) === entry) {
      entry.inFlight = false;
      entry.expiresAt = Date.now() + WORKSPACE_STATUS_CACHE_MS;
    }
    return resolved;
  } catch (error) {
    if (workspaceStatusCache.get(cacheKey) === entry) workspaceStatusCache.delete(cacheKey);
    throw error;
  }
}

async function computeWorkspaceStatus(rootPath: string, compareMode: WorkspaceCompareMode): Promise<WorkspaceStatus> {
  try {
    const repoResult = await runHerdrGit(["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd: rootPath });
    if (repoResult.exitCode !== 0 || !repoResult.stdout.trim()) throw new Error("not a git repository");
    const repoRoot = await realpath(repoResult.stdout.trim());
    const workspace = filterWorkspaceStatusForDirectory(
      await getWorkspaceStatusForDirectory(rootPath),
      rootPath,
      includeWorkspaceChange,
    );
    if (!workspace.available) return workspace;
    if (compareMode !== "since-base") {
      const rootPathspec = relative(repoRoot, rootPath).replace(/\\/g, "/") || ".";
      const diffType = workspaceCompareDiffType(compareMode);
      const diffArgs = diffType === "uncommitted"
        ? ["--no-optional-locks", "diff", "--numstat", "-z", "HEAD", "--", rootPathspec]
        : diffType === "staged"
          ? ["--no-optional-locks", "diff", "--cached", "--numstat", "-z", "--", rootPathspec]
          : ["--no-optional-locks", "diff", "--numstat", "-z", "--", rootPathspec];
      const nameArgs = diffType === "uncommitted"
        ? ["--no-optional-locks", "diff", "--name-status", "-z", "HEAD", "--", rootPathspec]
        : diffType === "staged"
          ? ["--no-optional-locks", "diff", "--cached", "--name-status", "-z", "--", rootPathspec]
          : ["--no-optional-locks", "diff", "--name-status", "-z", "--", rootPathspec];
      const [names, countsResult] = await Promise.all([
        runHerdrGit(nameArgs, { cwd: repoRoot }),
        runHerdrGit(diffArgs, { cwd: repoRoot }),
      ]);
      if (names.exitCode !== 0 || countsResult.exitCode !== 0) throw new Error("git diff failed");
      const counts = parseGitNumstat(countsResult.stdout);
      const files: WorkspaceStatus["files"] = {};
      for (const change of parseNameStatus(names.stdout)) {
        if (!pathIsInWorkspace(rootPath, repoRoot, change.repoRelativePath)) continue;
        const countsForFile = counts.get(change.repoRelativePath) ?? { additions: 0, deletions: 0 };
        const oldCounts = change.oldRepoRelativePath
          ? counts.get(change.oldRepoRelativePath) ?? { additions: 0, deletions: 0 }
          : { additions: 0, deletions: 0 };
        files[resolve(repoRoot, change.repoRelativePath)] = {
          path: resolve(repoRoot, change.repoRelativePath),
          repoRelativePath: change.repoRelativePath,
          oldPath: change.oldRepoRelativePath ? resolve(repoRoot, change.oldRepoRelativePath) : undefined,
          status: change.status,
          additions: countsForFile.additions + oldCounts.additions,
          deletions: countsForFile.deletions + oldCounts.deletions,
          staged: compareMode === "staged",
          unstaged: compareMode === "unstaged",
        };
      }
      if (compareMode !== "staged") {
        for (const change of Object.values(workspace.files)) {
          if (change.status !== "untracked") continue;
          files[change.path] = { ...change, staged: false, unstaged: true };
        }
      }
      const values = Object.values(files);
      return {
        available: true,
        rootPath,
        repoRoot,
        files,
        totals: {
          files: values.length,
          additions: values.reduce((sum, file) => sum + file.additions, 0),
          deletions: values.reduce((sum, file) => sum + file.deletions, 0),
        },
      };
    }
    const defaultBranch = await getDefaultBranch(herdrGitRuntime, repoRoot);
    const baseResolves = (await herdrGitRuntime.runGit(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${defaultBranch}^{commit}`],
      { cwd: repoRoot },
    )).exitCode === 0;
    const sinceBase = baseResolves
      ? await getSinceBaseSections(herdrGitRuntime, defaultBranch, repoRoot)
      : null;
    const mergeBase = sinceBase?.mergeBase || "HEAD";
    const rootPathspec = relative(repoRoot, rootPath).replace(/\\/g, "/") || ".";
    const [committedResult, totalCounts] = await Promise.all([
      runHerdrGit(
        ["--no-optional-locks", "diff", "--name-status", "-z", "--end-of-options", `${mergeBase}..HEAD`, "--", rootPathspec],
        { cwd: repoRoot },
      ),
      runHerdrGit(
        ["--no-optional-locks", "diff", "--numstat", "-z", "--end-of-options", mergeBase, "--", rootPathspec],
        { cwd: repoRoot },
      ),
    ]);
    if (committedResult.exitCode !== 0 || totalCounts.exitCode !== 0) throw new Error("git diff failed");
    const counts = parseGitNumstat(totalCounts.stdout);

    const files = { ...workspace.files };
    for (const change of parseNameStatus(committedResult.stdout)) {
      if (files[resolve(repoRoot, change.repoRelativePath)] || !pathIsInWorkspace(rootPath, repoRoot, change.repoRelativePath)) continue;
      const countsForFile = counts.get(change.repoRelativePath) ?? { additions: 0, deletions: 0 };
      const oldCounts = change.oldRepoRelativePath
        ? counts.get(change.oldRepoRelativePath) ?? { additions: 0, deletions: 0 }
        : { additions: 0, deletions: 0 };
      files[resolve(repoRoot, change.repoRelativePath)] = {
        path: resolve(repoRoot, change.repoRelativePath),
        repoRelativePath: change.repoRelativePath,
        oldPath: change.oldRepoRelativePath ? resolve(repoRoot, change.oldRepoRelativePath) : undefined,
        status: change.status,
        additions: countsForFile.additions + oldCounts.additions,
        deletions: countsForFile.deletions + oldCounts.deletions,
        staged: false,
        unstaged: false,
      };
    }
    // Since-base counts are the composite merge-base → working-tree diff. Keep
    // untracked line counts from workspace-status; Git's tracked diff excludes
    // them by design.
    for (const [path, change] of Object.entries(files)) {
      if (change.status === "untracked") continue;
      const count = counts.get(change.repoRelativePath);
      if (count) files[path] = { ...change, ...count };
    }
    const filteredSinceBase: SinceBaseSections | undefined = sinceBase && {
      ...sinceBase,
      files: Object.fromEntries(
        Object.entries(sinceBase.files).filter(([repoRelativePath]) => pathIsInWorkspace(rootPath, repoRoot, repoRelativePath)),
      ),
    };
    const values = Object.values(files);
    return { available: true, rootPath, repoRoot, ...(filteredSinceBase ? { sinceBase: filteredSinceBase } : {}), files, totals: {
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

export async function serveWorkspaceFilesStream(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  panels?: HerdrPanel[],
): Promise<void> {
  const livePanels = panels ?? await cachedPanels();
  const rawDirPaths = url.searchParams.getAll("dirPath");
  if (rawDirPaths.length === 0) {
    writeJson(response, 400, { error: "Missing dirPath parameter" });
    return;
  }

  const subscriptions: Array<{ dirPath: string; clientDirPath: string }> = [];
  for (const rawDirPath of rawDirPaths) {
    const workspace = await liveWorkspaceDirectory(rawDirPath, livePanels, { exactRoot: true });
    if (!workspace) {
      writeJson(response, 403, { error: "Directory is not a currently live Herdr Pi workspace" });
      return;
    }
    if (!subscriptions.some(({ dirPath }) => dirPath === workspace.root)) {
      subscriptions.push({ dirPath: workspace.root, clientDirPath: rawDirPath });
    }
  }
  await startFileBrowserWatchStream(request, response, subscriptions);
}

function livePanePathspec(root: string, cwd: string): string | null {
  const relativePath = relative(root, cwd).replace(/\\/g, "/");
  if (relativePath === "") return null;
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return `:(top)${relativePath}`;
}

/** Launch an isolated full-review server for one captured, live Pi pane. */
async function openGitChangesReview(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Opening a full review requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  const body = await requestJson(request);
  const paneId = text(body?.paneId);
  const compareMode = body?.compareMode === undefined ? "since-base" : parseWorkspaceCompareMode(body.compareMode);
  if (!compareMode) {
    writeJson(response, 400, { error: "Invalid Git compare mode" });
    return;
  }
  if (!paneId) {
    writeJson(response, 400, { error: "A live Pi pane is required" });
    return;
  }

  const panels = await discoverPanels();
  const pane = panels.find((candidate) => candidate.id === paneId);
  if (!pane) {
    writeJson(response, 404, { error: "The selected Pi pane is no longer live" });
    return;
  }
  const workspace = await liveWorkspaceDirectory(pane.cwd, panels, { exactRoot: true });
  if (!workspace) {
    writeJson(response, 403, { error: "Directory is not a currently live Herdr Pi workspace" });
    return;
  }
  const registration = panelSessions.get(paneId);
  if (!registration) {
    writeJson(response, 409, { error: "The selected Pi pane has not published a live session" });
    return;
  }
  const requestedSessionId = registration.sessionId;
  while (true) {
    const existing = activeGitChangesReviews.get(paneId);
    if (existing?.settled) stopGitChangesReview(existing);
    const liveExisting = activeGitChangesReviews.get(paneId);
    if (liveExisting && (liveExisting.sessionId !== requestedSessionId || liveExisting.cwd !== workspace.root || liveExisting.compareMode !== compareMode)) {
      stopGitChangesReview(liveExisting);
    }

    let launched: { review: ActiveGitChangesReview; reused: boolean };
    try {
      launched = await reuseOrLaunchGitChangesReview(
        activeGitChangesReviews,
        pendingGitChangesReviewLaunches,
        paneId,
        requestedSessionId,
        workspace.root,
        async () => {
        const repoResult = await runHerdrGit(["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd: workspace.root });
        if (repoResult.exitCode !== 0 || !repoResult.stdout.trim()) {
          throw new Error("The current pane folder is not a Git repository");
        }
        const repoRoot = await realpath(repoResult.stdout.trim());
        const pathspec = livePanePathspec(repoRoot, workspace.root);
        const config = loadConfig();
        const prepared = await prepareLocalReviewDiff({
          cwd: workspace.root,
          // Prefer the same composite Git Changes view when the VCS offers it;
          // prepareLocalReviewDiff falls back to its first valid mode otherwise.
          configuredDiffType: "since-base",
          requestedDiffType: workspaceCompareDiffType(compareMode),
          hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
          ...(pathspec ? { pathspec } : {}),
        });
        const captured = { paneId, sessionId: requestedSessionId };
        // A Tailnet client cannot reach a WSL loopback listener. Bind the isolated
        // review on the Herdr service interface, but never assume that the process's
        // `localhost` is the reviewer's browser.
        const server = await startReviewServer({
          rawPatch: prepared.rawPatch,
          gitRef: prepared.gitRef,
          // Herdr is often opened from another Tailnet device. Keep a random port,
          // but bind it on the same interface as the host service so the browser
          // which clicked the UI can reach it.
          port: 0,
          hostname: host,
          error: prepared.error,
          htmlContent: reviewHtml,
          origin: "pi",
          diffType: prepared.diffType,
          ...(pathspec ? { pathspec, reviewRoot: repoRoot } : {}),
          ...(pathspec ? { agentReviewScope: `This review is restricted to the live Herdr pane directory: ${workspace.root}. Do not inspect or report files outside that directory.` } : {}),
          gitContext: prepared.gitContext,
          initialBase: prepared.base,
          agentCwd: workspace.root,
          sharingEnabled: false,
          onDecision: async (decision) => {
            if (decision.exit) return;
            const current = panelSessions.get(captured.paneId);
            if (current?.sessionId !== captured.sessionId) {
              throw new Error("The Pi pane session changed since this review was opened. Reopen the review from the current pane.");
            }
            const content = decision.approved ? "LGTM - no changes requested." : decision.feedback.trim();
            if (!content) return;
            const delivery: PendingInstructionDelivery = {
              deliveryId: randomUUID(),
              paneId: captured.paneId,
              sessionId: captured.sessionId,
              content,
            };
            pendingInstructionDeliveries.set(delivery.deliveryId, delivery);
          },
        });
        const review: ActiveGitChangesReview = { ...captured, cwd: workspace.root, compareMode, settled: false, server };
        // Give the review tab time to receive its submission response before the
        // isolated listener closes, matching the standalone review command.
        void server.waitForDecision().finally(() => {
          review.settled = true;
          setTimeout(() => stopGitChangesReview(review), 1_500);
        });
          return review;
        },
        stopGitChangesReview,
        compareMode,
      );
    } catch (error) {
      if (error instanceof GitChangesReviewLaunchSuperseded) {
        writeJson(response, 409, { error: "The selected Pi pane session changed while the full review was opening" });
        return;
      }
      throw error;
    }
    const { review, reused } = launched;

    if (review.sessionId === requestedSessionId && review.cwd === workspace.root) {
      // A request captured its session before preparing the patch. Do not hand
      // that review to a replacement session that arrived while it waited.
      if (panelSessions.get(paneId)?.sessionId !== requestedSessionId) {
        if (activeGitChangesReviews.get(paneId) === review) stopGitChangesReview(review);
        writeJson(response, 409, { error: "The selected Pi pane session changed while the full review was opening" });
        return;
      }
      // Opening a browser from this WSL service would target Windows' default
      // browser, not necessarily the browser that initiated this request. Return
      // only the ephemeral port; the UI opens it against its current host.
      writeJson(response, reused ? 200 : 201, { ok: true, port: review.server.port, hostname: review.server.hostname, reused });
      return;
    }

    // The only in-flight launch belonged to a session that was replaced while
    // this request waited. Retire it, then reserve a review for this session.
    if (activeGitChangesReviews.get(paneId) === review) stopGitChangesReview(review);
  }
}

async function serveFileMentionSearch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Searching workspace files requires a loopback browser or PLANNOTATOR_HERDR_WRITE_TOKEN." });
    return;
  }
  const paneId = text(url.searchParams.get("paneId"));
  const query = (url.searchParams.get("q") ?? "").trim();
  if (!paneId) {
    writeJson(response, 400, { error: "paneId is required" });
    return;
  }
  const paths = await searchLiveWorkspaceFiles(paneId, query, await cachedPanels());
  if (!paths) {
    writeJson(response, 403, { error: "Pane is not a currently live Herdr Pi workspace" });
    return;
  }
  writeJson(response, 200, { paths });
}

async function serveWorkspaceFiles(response: ServerResponse, url: URL): Promise<void> {
  const dirPath = text(url.searchParams.get("dirPath"));
  const requestedCompareMode = url.searchParams.get("compare");
  const compareMode = requestedCompareMode === null ? "since-base" : parseWorkspaceCompareMode(requestedCompareMode);
  if (!compareMode) {
    writeJson(response, 400, { error: "Invalid Git compare mode" });
    return;
  }
  if (!dirPath) {
    writeJson(response, 400, { error: "dirPath is required" });
    return;
  }
  const workspace = await liveWorkspaceDirectory(dirPath, await cachedPanels(), { exactRoot: true });
  if (!workspace) {
    writeJson(response, 403, { error: "Directory is not a currently live Herdr Pi workspace" });
    return;
  }

  const { root } = workspace;
  const status = await workspaceStatus(root, compareMode);
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
    compareMode,
    compareLabel: workspaceCompareLabel(compareMode, status.sinceBase?.base),
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
  const workspace = await liveWorkspaceDirectory(base, await cachedPanels(), { exactRoot: false });
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

async function serveExAICompanion(response: ServerResponse, url: URL): Promise<void> {
  const paneId = text(url.searchParams.get("paneId"));
  const sessionId = text(url.searchParams.get("sessionId"));
  if (!paneId || !sessionId) {
    writeJson(response, 400, { error: "paneId and sessionId are required" });
    return;
  }
  await Promise.all([exAICompanions.reconcile(), ensureHerdrPiModels()]);
  const state = await exAICompanions.state({ paneId, sessionId });
  writeJson(response, 200, {
    ...state,
    defaults: {
      ...state.defaults,
      model: herdrPiModels.some((model) => model.id === state.defaults.model)
        ? state.defaults.model
        : herdrPiModels.find((model) => model.default)?.id || herdrPiModels[0]?.id || "",
    },
    models: herdrPiModels.map(({ id, label }) => ({ id, label })),
  });
}

async function mutateExAICompanion(request: IncomingMessage, response: ServerResponse, action: "start" | "turn" | "handoff" | "stop"): Promise<void> {
  if (!canWriteFeedback(request)) {
    writeJson(response, 403, { error: "Ex AI Chat requires a loopback, Tailscale, or write-token browser." });
    return;
  }
  const body = await requestJson(request);
  const paneId = text(body?.paneId);
  const sessionId = text(body?.sessionId);
  if (!paneId || !sessionId) {
    writeJson(response, 400, { error: "paneId and sessionId are required" });
    return;
  }
  const main = { paneId, sessionId };
  if (action === "start") {
    const model = text(body?.model);
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
    if (!model || model.length > 300 || instruction.length > 8_000) {
      writeJson(response, 400, { error: "A valid model and base instruction are required" });
      return;
    }
    writeJson(response, 201, await exAICompanions.start(main, { model, instruction }));
    return;
  }
  if (action === "stop") {
    writeJson(response, 200, await exAICompanions.stop(main));
    return;
  }
  if (action === "turn") {
    const turn = text(body?.text);
    if (!turn || turn.length > 16_000) {
      writeJson(response, 400, { error: "A message is required" });
      return;
    }
    writeJson(response, 202, await exAICompanions.sendTurn(main, turn));
    return;
  }
  const requestId = text(body?.requestId);
  const content = text(body?.text);
  if (!requestId || requestId.length > 200 || !content || content.length > 16_000) {
    writeJson(response, 400, { error: "A stable request ID and message are required" });
    return;
  }
  const result = await exAICompanions.handoff(main, requestId, content);
  writeJson(response, 202, { ...await exAICompanions.state(main), handoff: result });
}

async function servePlan(response: ServerResponse): Promise<void> {
  const { revision, value: { panels, snapshot } } = await refreshLiveState();
  const selected = panels.find((panel) => panel.focused) ?? panels[0] ?? null;
  writeJson(response, 200, {
    // The existing Ex-Plannotator rich editor receives the live state through
    // its documented live-review seam. On phones its built-in picker opens the
    // mobile Messages sheet; desktop keeps the existing left sidebar.
    revision,
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
  if (request.method === "GET" && url.pathname === "/api/image") {
    void serveImage(response, url);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/upload") {
    void uploadImage(request, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#18181b"/><path fill="#fafafa" d="M18 14h28v8H28v8h16v8H28v12h-10z"/></svg>');
    return;
  }
  if (url.pathname.startsWith("/api/ai/")) {
    void handleHerdrAIRequest(request, response, url);
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
  if (request.method === "GET" && url.pathname === "/api/reference/files/stream") {
    void serveWorkspaceFilesStream(request, response, url).catch(() => writeJson(response, 500, { error: "Failed to watch live Herdr workspace files" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/reference/files") {
    void serveWorkspaceFiles(response, url).catch(() => writeJson(response, 500, { error: "Failed to list live Herdr workspace files" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/file-search") {
    void serveFileMentionSearch(request, response, url).catch(() => writeJson(response, 500, { error: "Failed to search live Herdr workspace files" }));
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
    void servePlan(response).catch((error: unknown) => {
      console.error("[plannotator-herdr] Failed to build live plan snapshot", error);
      writeJson(response, 503, { error: "Herdr snapshot unavailable" });
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/ex-ai-companion") {
    void serveExAICompanion(response, url).catch((error: unknown) => writeJson(response, 503, { error: error instanceof Error ? error.message : "Ex AI Chat unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ex-ai-companion/start") {
    void mutateExAICompanion(request, response, "start").catch((error: unknown) => writeJson(response, 409, { error: error instanceof Error ? error.message : "Could not start Ex AI Chat" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ex-ai-companion/turn") {
    void mutateExAICompanion(request, response, "turn").catch((error: unknown) => writeJson(response, 409, { error: error instanceof Error ? error.message : "Could not send Ex AI Chat turn" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ex-ai-companion/stop") {
    void mutateExAICompanion(request, response, "stop").catch((error: unknown) => writeJson(response, 409, { error: error instanceof Error ? error.message : "Could not stop Ex AI Chat" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ex-ai-companion/handoff") {
    void mutateExAICompanion(request, response, "handoff").catch((error: unknown) => writeJson(response, 409, { error: error instanceof Error ? error.message : "Could not hand off Ex AI Chat response" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    void refreshLiveState()
      .then(({ revision, value: { snapshot } }) => writeJson(response, 200, { ...snapshot, revision }))
      .catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    let closed = false;
    const publish = ({ revision, value: { snapshot } }: PublishedLiveSnapshot<HerdrLiveState>) => {
      if (!closed) response.write(`data: ${JSON.stringify({ ...snapshot, revision })}\n\n`);
    };
    const unsubscribe = liveSnapshotPublisher.subscribe(publish);
    // Refresh once after subscribing: a focus change between the initial
    // snapshot and EventSource connection is emitted to this browser directly.
    void refreshLiveState().catch(() => {});
    request.once("close", () => {
      closed = true;
      unsubscribe();
    });
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
  if (request.method === "POST" && url.pathname === "/api/panel-instruction/claim") {
    void claimInstruction(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/instruction") {
    void queueInstruction(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/git-changes/review") {
    void openGitChangesReview(request, response).catch((error: unknown) => writeJson(response, 500, { error: error instanceof Error ? error.message : "Could not open full review" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/command") {
    void queueCommand(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/process-panels") {
    void queueProcessPanel(request, response).catch((error: unknown) => writeJson(response, 503, { error: error instanceof Error ? error.message : "Could not create Pi panel" }));
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/process-panels") {
    void closeProcessPanel(request, response, url).catch((error: unknown) => writeJson(response, 503, { error: error instanceof Error ? error.message : "Could not close Pi panel" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    void queueFeedback(request, response).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/panel-session") {
    void deletePanelSession(request, response, url).catch(() => writeJson(response, 503, { error: "Herdr snapshot unavailable" }));
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
  // Herdr's focus and pane status are the host's live selection authority.
  // One shared refresh loop publishes transitions to every connected browser.
  void refreshLiveState().catch(() => {});
  const refreshTimer = setInterval(() => void refreshLiveState().catch(() => {}), HERDR_SNAPSHOT_POLL_MS);
  const server = createServer(serve);
  server.on("close", () => {
    clearInterval(refreshTimer);
    herdrAISessionManager.disposeAll();
    herdrAIRegistry.disposeAll();
  });
  server.listen(port, host, () => {
    console.log(`Plannotator Herdr service listening on http://${host}:${port}`);
  });
}
