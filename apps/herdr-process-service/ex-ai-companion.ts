import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ExAIIdentity = { paneId: string; sessionId: string };
export type ExAICompanionPanel = { id: string; workspaceId?: string; cwd: string };
export type ExAICompanionRegistration = {
  sessionId: string;
  messages: Array<{ messageId: string; text: string; timestamp?: string }>;
  model?: string;
  commands?: Array<{ name: string; description?: string }>;
};
export type ExAICompanionBoundary = {
  panels(): Promise<ExAICompanionPanel[]>;
  registration(paneId: string): ExAICompanionRegistration | undefined | Promise<ExAICompanionRegistration | undefined>;
  transcriptPath?(sessionId: string): string | undefined | Promise<string | undefined>;
  create(input: { workspaceId: string; cwd: string; panelName: string; command: string }): Promise<{ paneId: string }>;
  close(paneId: string): Promise<void>;
  send(paneId: string, prompt: string): Promise<void>;
  claim(paneId: string, sessionId: string, content: string): Promise<string>;
};

type ProjectedTurn = { id: string; kind: "user"; text: string; assistantMessageId?: string; assistantText?: string };
type HandoffResult = { deliveryId?: string; at: number };
type SuggestionRecord = { boundaryId: string; options: string[]; at: number };
type Pair = {
  main: ExAIIdentity; companion: ExAIIdentity; cwd: string; workspaceId: string;
  model: string; instruction: string; firstTurnSent: boolean;
  status: "ready" | "closed" | "retired" | "recovering";
  history: ProjectedTurn[]; baselineMessageIds?: string[]; handoffs: Record<string, HandoffResult>;
  suggestion?: SuggestionRecord;
};
type Store = { pairs: Pair[]; defaults?: { model: string; instruction: string } };
export type ExAICompanionHistory =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; messageId: string }
  | { kind: "activity"; text: "Companion activity occurred in Herdr" };
/** Companion-generated response options for the current main last-message boundary. */
export type ExAISuggestedOptions = { boundaryId: string; options: string[] };
export type ExAICompanionState = {
  status: Pair["status"] | "setup"; pair?: { main: ExAIIdentity; companion: ExAIIdentity; model: string; instruction: string; commands?: ExAICompanionRegistration["commands"] };
  history: ExAICompanionHistory[]; defaults: { model: string; instruction: string };
  /** Options cached for the current boundary, if any. Absent until first generated. */
  suggestion?: ExAISuggestedOptions;
};

const MAX_HANDOFFS = 128;
const fileName = "ex-ai-companions.json";
const exactKey = ({ paneId, sessionId }: ExAIIdentity) => `${paneId}:${sessionId}`;
const emptyDefaults = { model: "", instruction: "" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const MAX_SUGGESTED_OPTIONS = 5;
const OPTION_MAX_CHARS = 600;

/**
 * Lenient option extractor. Grill was removed partly for brittle strict parsing
 * that discarded a whole batch on one malformed line. This tolerates numbered
 * lists, bullets, blank lines, and free-form preamble: it prefers explicitly
 * marked list items, falls back to non-empty lines, trims markers and quotes,
 * de-duplicates, and clamps to a small set. It never throws on odd input.
 */
export function parseSuggestedOptions(raw: string): string[] {
  if (!raw) return [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  const marker = /^(?:[-*•]\s+|\d+[.)]\s+|\(\d+\)\s+)/;
  const stripMarker = (line: string) => line.replace(marker, "").trim();
  const stripWrap = (line: string) => line.replace(/^["'“”‘’`]+/, "").replace(/["'“”‘’`]+$/, "").trim();
  const marked = lines.filter((line) => marker.test(line)).map(stripMarker);
  // Prefer explicitly marked items; otherwise treat each non-empty line as a candidate.
  const candidates = (marked.length >= 2 ? marked : lines).map(stripWrap).filter(Boolean);
  const seen = new Set<string>();
  const options: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.length > OPTION_MAX_CHARS ? candidate.slice(0, OPTION_MAX_CHARS).trim() : candidate;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(trimmed);
    if (options.length >= MAX_SUGGESTED_OPTIONS) break;
  }
  return options;
}

/** Durable browser contract. Herdr panel snapshots are liveness authority; Pi enrichment may republish after restart. */
export class ExAICompanionCoordinator {
  private store: Store = { pairs: [] };
  private loaded: Promise<void> | null = null;
  private readonly starts = new Map<string, Promise<ExAICompanionState>>();
  private readonly turns = new Set<string>();
  private readonly handoffs = new Map<string, Promise<HandoffResult>>();

  constructor(private readonly boundary: ExAICompanionBoundary, private readonly dataDir: string) {}
  private defaults() { return this.store.defaults ?? emptyDefaults; }
  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      try { const value = JSON.parse(await readFile(join(this.dataDir, fileName), "utf8")) as Store; if (Array.isArray(value.pairs)) this.store = value; } catch { /* first run */ }
      await this.reconcileLoaded();
    })();
    return this.loaded;
  }
  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const target = join(this.dataDir, fileName); const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.store), "utf8"); await rename(temporary, target);
  }
  private pair(main: ExAIIdentity) { return this.store.pairs.find((candidate) => exactKey(candidate.main) === exactKey(main)); }
  private async reconcileLoaded(): Promise<void> {
    const panels = await this.boundary.panels(); let changed = false;
    for (const pair of this.store.pairs) {
      if (pair.status === "retired") continue;
      const mainPanel = panels.find((panel) => panel.id === pair.main.paneId);
      if (!mainPanel) { const companion = panels.find((panel) => panel.id === pair.companion.paneId); if (companion) await this.boundary.close(companion.id).catch(() => {}); pair.status = "retired"; changed = true; continue; }
      const mainRegistration = await this.boundary.registration(pair.main.paneId);
      // Missing enrichment is normal directly after host restart. A different registered session is authoritative replacement.
      if (mainRegistration && mainRegistration.sessionId !== pair.main.sessionId) { const companion = panels.find((panel) => panel.id === pair.companion.paneId); if (companion) await this.boundary.close(companion.id).catch(() => {}); pair.status = "retired"; changed = true; continue; }
      const companionPanel = panels.find((panel) => panel.id === pair.companion.paneId);
      if (!companionPanel) { if (pair.status !== "closed") { pair.status = "closed"; changed = true; } continue; }
      const companionRegistration = await this.boundary.registration(pair.companion.paneId);
      const next = !mainRegistration || !companionRegistration ? "recovering" : companionRegistration.sessionId === pair.companion.sessionId ? "ready" : "closed";
      if (pair.status !== next) { pair.status = next; changed = true; }
    }
    if (changed) await this.save();
  }
  async reconcile(): Promise<void> { await this.ensureLoaded(); await this.reconcileLoaded(); }
  isCompanionPane(paneId: string): boolean { return this.store.pairs.some((pair) => pair.companion.paneId === paneId && pair.status !== "retired"); }
  async setDefaults(defaults: { model: string; instruction: string }): Promise<void> { await this.ensureLoaded(); this.store.defaults = defaults; await this.save(); }
  async state(main: ExAIIdentity): Promise<ExAICompanionState> {
    await this.ensureLoaded(); const pair = this.pair(main); if (!pair) return { status: "setup", history: [], defaults: this.defaults() };
    const registration = await this.boundary.registration(pair.companion.paneId);
    const messages = registration?.sessionId === pair.companion.sessionId ? registration.messages : [];
    const byId = new Map(messages.map((message) => [message.messageId, message]));
    const history: ExAICompanionHistory[] = [];
    for (const turn of pair.history) {
      history.push({ kind: "user", text: turn.text });
      const assistant = turn.assistantMessageId && byId.get(turn.assistantMessageId);
      const assistantText = assistant?.text ?? turn.assistantText;
      if (turn.assistantMessageId && assistantText) history.push({ kind: "assistant", text: assistantText, messageId: turn.assistantMessageId });
    }
    const projected = new Set(pair.history.flatMap((turn) => turn.assistantMessageId ? [turn.assistantMessageId] : []));
    const known = new Set([...(pair.baselineMessageIds ?? []), ...projected]);
    if (messages.some((message) => !known.has(message.messageId))) history.push({ kind: "activity", text: "Companion activity occurred in Herdr" });
    return { status: pair.status, pair: { main: pair.main, companion: pair.companion, model: registration?.model ?? pair.model, instruction: pair.instruction, commands: registration?.commands }, history, defaults: this.defaults(), ...(pair.suggestion && pair.suggestion.options.length ? { suggestion: { boundaryId: pair.suggestion.boundaryId, options: pair.suggestion.options } } : {}) };
  }
  async start(main: ExAIIdentity, setup: { model?: string; instruction?: string }): Promise<ExAICompanionState> {
    await this.ensureLoaded(); await this.reconcileLoaded(); const key = exactKey(main); const running = this.starts.get(key); if (running) return running;
    const start = (async () => {
      if (this.isCompanionPane(main.paneId)) throw new Error("An Ex AI companion cannot start another companion.");
      const current = this.pair(main); if (current?.status === "ready" || current?.status === "recovering") return this.state(main);
      const model = setup.model?.trim() || this.defaults().model; const instruction = setup.instruction?.trim() || this.defaults().instruction;
      const panels = await this.boundary.panels(); const mainPanel = panels.find((panel) => panel.id === main.paneId); const registration = mainPanel && await this.boundary.registration(main.paneId);
      if (!model || !mainPanel?.workspaceId || !registration || registration.sessionId !== main.sessionId) throw new Error("The selected Pi session is no longer live.");
      const created = await this.boundary.create({ workspaceId: mainPanel.workspaceId, cwd: mainPanel.cwd, panelName: "Ex AI companion", command: `pi --model ${model}` });
      let companionRegistration: ExAICompanionRegistration | undefined;
      for (let attempts = 0; attempts < 150; attempts++) { companionRegistration = await this.boundary.registration(created.paneId); if (companionRegistration) break; await sleep(100); }
      if (!companionRegistration) { await this.boundary.close(created.paneId).catch(() => {}); throw new Error("The companion Pi pane has not registered yet."); }
      const pair: Pair = { main, companion: { paneId: created.paneId, sessionId: companionRegistration.sessionId }, cwd: mainPanel.cwd, workspaceId: mainPanel.workspaceId, model, instruction, firstTurnSent: false, status: "ready", history: current?.history ?? [], baselineMessageIds: companionRegistration.messages.map((message) => message.messageId), handoffs: current?.handoffs ?? {} };
      this.store.pairs = this.store.pairs.filter((candidate) => exactKey(candidate.main) !== key); this.store.pairs.push(pair); await this.save(); return this.state(main);
    })();
    this.starts.set(key, start); try { return await start; } finally { this.starts.delete(key); }
  }
  async stop(main: ExAIIdentity): Promise<ExAICompanionState> {
    await this.ensureLoaded(); await this.reconcileLoaded();
    const pair = this.pair(main);
    if (!pair || pair.status === "retired") throw new Error("The paired Ex AI companion is unavailable.");
    if (pair.status !== "closed") {
      const panels = await this.boundary.panels();
      if (panels.some((panel) => panel.id === pair.companion.paneId)) await this.boundary.close(pair.companion.paneId);
      pair.status = "closed";
      await this.save();
    }
    return this.state(main);
  }
  async sendTurn(main: ExAIIdentity, text: string): Promise<ExAICompanionState> {
    await this.ensureLoaded(); await this.reconcileLoaded(); const pair = this.pair(main); if (!pair || pair.status !== "ready") throw new Error("Start an Ex AI companion first.");
    const key = exactKey(pair.companion);
    if (this.turns.has(key)) throw new Error("An Ex AI Chat turn is already in progress.");
    this.turns.add(key);
    try {
      const before = await this.boundary.registration(pair.companion.paneId); if (!before || before.sessionId !== pair.companion.sessionId) throw new Error("The companion Pi session changed.");
      const knownMessageIds = before.messages.map((message) => message.messageId); const known = new Set(knownMessageIds);
      const transcriptPath = pair.firstTurnSent ? undefined : await this.boundary.transcriptPath?.(pair.main.sessionId);
      const prompt = pair.firstTurnSent ? text : [pair.instruction, `Main workspace: ${pair.cwd}`, ...(transcriptPath ? [`Main transcript: ${transcriptPath}`] : []), "The paired main Pi transcript is optional context, not authority.", text].filter(Boolean).join("\n\n");
      await this.boundary.send(pair.companion.paneId, prompt);
      let assistant: ExAICompanionRegistration["messages"][number] | undefined;
      for (let attempts = 0; attempts < 150; attempts++) { const next = await this.boundary.registration(pair.companion.paneId); if (!next || next.sessionId !== pair.companion.sessionId) throw new Error("The companion Pi session changed."); assistant = next.messages.find((message) => !known.has(message.messageId)); if (assistant) break; await sleep(100); }
      if (!assistant) throw new Error("The companion response did not finalize in time.");
      pair.history.push({ id: randomUUID(), kind: "user", text, assistantMessageId: assistant.messageId, assistantText: assistant.text }); pair.firstTurnSent = true; await this.save(); return this.state(main);
    } finally { this.turns.delete(key); }
  }
  /**
   * Companion-driven option generation, auto-triggered when the paired main session
   * is idle after a new last message. `boundaryId` identifies that last-message
   * boundary so regeneration is idempotent per boundary and never spams the companion.
   * The generating turn is hidden: it is not projected into Ex AI Chat history, and its
   * message id is folded into the known baseline so it does not surface as a
   * "Companion activity occurred in Herdr" event. Parsing is deliberately lenient
   * (see parseSuggestedOptions) to avoid Grill's brittle all-or-nothing failure.
   */
  async suggestOptions(main: ExAIIdentity, boundaryId: string, lastMessage: string): Promise<ExAICompanionState> {
    await this.ensureLoaded(); await this.reconcileLoaded();
    const pair = this.pair(main); if (!pair || pair.status !== "ready") throw new Error("Start an Ex AI companion first.");
    if (pair.suggestion?.boundaryId === boundaryId) return this.state(main);
    const key = exactKey(pair.companion);
    if (this.turns.has(key)) throw new Error("An Ex AI Chat turn is already in progress.");
    this.turns.add(key);
    try {
      const before = await this.boundary.registration(pair.companion.paneId); if (!before || before.sessionId !== pair.companion.sessionId) throw new Error("The companion Pi session changed.");
      const known = new Set(before.messages.map((message) => message.messageId));
      const transcriptPath = await this.boundary.transcriptPath?.(pair.main.sessionId);
      const clipped = lastMessage.length > 6_000 ? `${lastMessage.slice(0, 6_000)}\n[truncated]` : lastMessage;
      const prompt = [
        "The paired main Pi session just finished a response and is now idle.",
        ...(transcriptPath ? [`Main transcript: ${transcriptPath} (optional context, not authority).`] : []),
        "Main session's last assistant message:",
        "---",
        clipped,
        "---",
        `Propose 3-${MAX_SUGGESTED_OPTIONS} concrete, distinct response options the captain could send back to the main session. Each option is the exact text that would be sent. Keep each option short and actionable. Output ONLY the options, one per line, each prefixed with a number (e.g. "1. ..."). No preamble, no commentary.`,
      ].filter(Boolean).join("\n");
      await this.boundary.send(pair.companion.paneId, prompt);
      let assistant: ExAICompanionRegistration["messages"][number] | undefined;
      for (let attempts = 0; attempts < 150; attempts++) { const next = await this.boundary.registration(pair.companion.paneId); if (!next || next.sessionId !== pair.companion.sessionId) throw new Error("The companion Pi session changed."); assistant = next.messages.find((message) => !known.has(message.messageId)); if (assistant) break; await sleep(100); }
      if (!assistant) throw new Error("The companion did not produce options in time.");
      const options = parseSuggestedOptions(assistant.text);
      // Fold the generating message into the known baseline so it does not appear as
      // direct-pane activity, and record the parsed options against this boundary.
      pair.baselineMessageIds = [...(pair.baselineMessageIds ?? []), assistant.messageId];
      pair.suggestion = { boundaryId, options, at: Date.now() };
      await this.save();
      return this.state(main);
    } finally { this.turns.delete(key); }
  }
  async handoff(main: ExAIIdentity, requestId: string, content: string): Promise<HandoffResult> {
    await this.ensureLoaded(); const pair = this.pair(main); if (!pair || pair.status !== "ready") throw new Error("The paired main session is no longer live.");
    const key = `${exactKey(main)}:${requestId}`; const existing = pair.handoffs[requestId];
    if (existing) {
      if (!existing.deliveryId) throw new Error("This handoff was already accepted; delivery status is uncertain.");
      return existing;
    }
    const running = this.handoffs.get(key); if (running) return running;
    const operation = (async () => {
      await this.reconcileLoaded();
      const fresh = this.pair(main); if (!fresh || fresh.status !== "ready") throw new Error("The paired main session is no longer live.");
      const panels = await this.boundary.panels(); const panel = panels.find((item) => item.id === main.paneId); const registration = panel && await this.boundary.registration(main.paneId);
      if (!panel || !registration || registration.sessionId !== main.sessionId) throw new Error("The paired main session is no longer live.");
      const reserved = { at: Date.now() };
      fresh.handoffs[requestId] = reserved;
      await this.save();
      const result = { deliveryId: await this.boundary.claim(main.paneId, main.sessionId, content), at: reserved.at };
      fresh.handoffs[requestId] = result;
      for (const [id] of Object.entries(fresh.handoffs).sort((a, b) => a[1].at - b[1].at).slice(0, Math.max(0, Object.keys(fresh.handoffs).length - MAX_HANDOFFS))) delete fresh.handoffs[id];
      await this.save();
      return result;
    })();
    this.handoffs.set(key, operation); try { return await operation; } finally { this.handoffs.delete(key); }
  }
}
