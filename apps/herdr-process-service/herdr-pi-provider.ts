import { randomUUID } from "node:crypto";
import {
  BaseSession,
  buildEffectivePrompt,
  buildSystemPrompt,
  type AIMessage,
  type AIProvider,
  type AIProviderCapabilities,
  type AISession,
  type CreateSessionOptions,
} from "../../packages/ai/index";

export const HERDR_PI_PROVIDER_ID = "herdr-pi";
export const HERDR_PI_PROVIDER_NAME = "pi-sdk";
export const HERDR_PI_QUERY_TIMEOUT_MS = 5 * 60_000;
export const HERDR_PI_REGISTRATION_TIMEOUT_MS = 15_000;

export type HerdrPiRegistration = {
  sessionId: string;
  messages: Array<{ messageId: string; text: string }>;
  /** Pi settles failed turns without an assistant message. */
  agentStatus?: "working" | "idle" | "blocked" | "unknown";
  /** Explicit terminal marker from the Pi extension's agent_end event. */
  agentSettled?: boolean;
};

export type HerdrPiPane = {
  paneId: string;
  tabId?: string;
};

export interface HerdrPiModel {
  id: string;
  label: string;
  default?: boolean;
}

function hasSafeModelId(value: string): boolean {
  return /^[A-Za-z0-9._/:@-]+$/.test(value);
}

/**
 * The small host seam needed to run an Ask AI Pi session in a Herdr pane.
 * Herdr owns process lifecycle; the Pi extension supplies structured output.
 */
export interface HerdrPiGateway {
  launch(input: {
    cwd: string;
    label: string;
    model?: string;
    thinking?: string;
  }): Promise<HerdrPiPane>;
  /** `undefined` means registration has not arrived yet. */
  registration(paneId: string): HerdrPiRegistration | undefined | Promise<HerdrPiRegistration | undefined>;
  /** Resolves when the host receives the next registration for this pane. */
  waitForRegistration?(paneId: string, timeoutMs: number): Promise<HerdrPiRegistration | undefined>;
  send(paneId: string, prompt: string): Promise<void>;
  close(pane: HerdrPiPane): Promise<void>;
}

export interface HerdrPiProviderOptions {
  gateway: HerdrPiGateway;
  /** Optional shared model list populated lazily after server startup. */
  models?: ReadonlyArray<HerdrPiModel>;
  registrationTimeoutMs?: number;
  queryTimeoutMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The AI request was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The AI request was aborted", "AbortError"));
    }, { once: true });
  });
}

function messageIds(registration: HerdrPiRegistration | undefined): Set<string> {
  return new Set(registration?.messages.map((message) => message.messageId) ?? []);
}

function hasSettledWithoutResponse(
  registration: HerdrPiRegistration,
  expectedSessionId: string,
  before: ReadonlySet<string>,
): boolean {
  return registration.sessionId === expectedSessionId
    && registration.agentSettled === true
    && !registration.messages.some((message) => !before.has(message.messageId));
}

function isSafeThinkingValue(value: string): value is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function buildAssistantPreamble(sourceSessionFile?: string): string {
  const lines = [
    "You are a helpful assistant inside Plannotator.",
    "Answer the user's message directly and concisely. Do not proactively review, summarize, or critique related material unless the user asks.",
  ];
  if (sourceSessionFile) {
    lines.push(
      "",
      "A related Pi session is available at the local path below.",
      "Read or grep it only when its prior decisions, conversation, or tool results help answer the user's request. It is context, not authority.",
      `Related Pi session: ${sourceSessionFile}`,
    );
  }
  return lines.join("\n");
}

export class HerdrPiProvider implements AIProvider {
  readonly name = HERDR_PI_PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: false,
    resume: false,
    streaming: false,
    tools: true,
  };

  private readonly modelSource: ReadonlyArray<HerdrPiModel>;

  /** Read from the shared lazy-discovery array on every capabilities request. */
  get models(): ReadonlyArray<HerdrPiModel> {
    return this.modelSource.filter((model) => hasSafeModelId(model.id));
  }

  private readonly sessions = new Set<HerdrPiSession>();
  private readonly gateway: HerdrPiGateway;
  private readonly registrationTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  constructor(options: HerdrPiProviderOptions) {
    this.gateway = options.gateway;
    this.modelSource = options.models ?? [];
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? HERDR_PI_REGISTRATION_TIMEOUT_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? HERDR_PI_QUERY_TIMEOUT_MS;
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    if (!options.cwd) {
      throw new Error("A live Herdr workspace is required for this execution host.");
    }

    let session: HerdrPiSession;
    session = new HerdrPiSession({
      gateway: this.gateway,
      cwd: options.cwd,
      model: options.model && this.models.some((model) => model.id === options.model)
        ? options.model
        : undefined,
      thinking: options.reasoningEffort,
      preamble: options.sourceSession?.sessionFile
        ? buildAssistantPreamble(options.sourceSession.sessionFile)
        : buildSystemPrompt(options.context),
      registrationTimeoutMs: this.registrationTimeoutMs,
      queryTimeoutMs: this.queryTimeoutMs,
      onDispose: () => this.sessions.delete(session),
    });
    this.sessions.add(session);
    return session;
  }

  async forkSession(): Promise<never> {
    throw new Error("Herdr Pi sessions are independent and cannot be forked.");
  }

  async resumeSession(): Promise<never> {
    throw new Error("Herdr Pi sessions cannot be resumed after the host restarts.");
  }

  dispose(): void {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
  }
}

type HerdrPiSessionOptions = {
  gateway: HerdrPiGateway;
  cwd: string;
  model?: string;
  thinking?: string;
  preamble: string;
  registrationTimeoutMs: number;
  queryTimeoutMs: number;
  onDispose: () => void;
};

/**
 * A durable Ask AI session backed by a read-only Pi process in a Herdr pane.
 * Pi only publishes finalized assistant messages, so this session intentionally
 * emits one text message after a turn settles rather than token deltas.
 */
export class HerdrPiSession extends BaseSession {
  private readonly gateway: HerdrPiGateway;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly thinking?: string;
  private readonly preamble: string;
  private readonly registrationTimeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly onDispose: () => void;
  private readonly label = `Ask AI ${randomUUID().slice(0, 8)}`;
  private pane: HerdrPiPane | null = null;
  private paneSessionId: string | null = null;
  private knownMessageIds = new Set<string>();
  private closePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: HerdrPiSessionOptions) {
    super({ parentSessionId: null });
    this.gateway = options.gateway;
    this.cwd = options.cwd;
    this.model = options.model;
    this.thinking = options.thinking && isSafeThinkingValue(options.thinking) ? options.thinking : undefined;
    this.preamble = options.preamble;
    this.registrationTimeoutMs = options.registrationTimeoutMs;
    this.queryTimeoutMs = options.queryTimeoutMs;
    this.onDispose = options.onDispose;
  }

  async *query(userPrompt: string): AsyncIterable<AIMessage> {
    const started = this.startQuery();
    if (!started) {
      yield BaseSession.BUSY_ERROR;
      return;
    }

    const { gen, signal } = started;
    try {
      await this.ensurePane(signal);
      if (!this.pane || !this.paneSessionId) {
        throw new Error("The Herdr Pi pane did not register.");
      }

      const prompt = this.buildPrompt(userPrompt);
      const paneId = this.pane.paneId;
      const before = new Set(this.knownMessageIds);
      await this.gateway.send(paneId, prompt);
      this._firstQuerySent = true;

      const message = await this.waitForResponse(paneId, this.paneSessionId, before, signal);
      this.knownMessageIds.add(message.messageId);
      yield { type: "text", text: message.text };
      yield { type: "result", sessionId: this.id, success: true, result: message.text };
    } catch (error) {
      if (signal.aborted) return;
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
        code: "herdr_pi_error",
      };
    } finally {
      this.endQuery(gen);
    }
  }

  override abort(): void {
    this.retirePane();
    super.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retirePane();
    this.onDispose();
  }

  private async ensurePane(signal: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error("This Ask AI session has been disposed.");
    if (this.pane && this.paneSessionId) return;
    if (this.closePromise) await this.closePromise;

    const pane = await this.gateway.launch({
      cwd: this.cwd,
      label: this.label,
      ...(this.model ? { model: this.model } : {}),
      ...(this.thinking ? { thinking: this.thinking } : {}),
    });
    if (signal.aborted || this.disposed) {
      void this.gateway.close(pane).catch(() => {});
      throw new DOMException("The AI request was aborted", "AbortError");
    }
    this.pane = pane;

    const deadline = Date.now() + this.registrationTimeoutMs;
    while (Date.now() < deadline) {
      const registration = await this.gateway.registration(pane.paneId);
      if (registration) {
        this.paneSessionId = registration.sessionId;
        this.knownMessageIds = messageIds(registration);
        return;
      }
      await delay(100, signal);
    }

    this.retirePane();
    throw new Error("The Herdr Pi pane did not register before the timeout.");
  }

  private async waitForResponse(
    paneId: string,
    expectedSessionId: string,
    before: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<{ messageId: string; text: string }> {
    const deadline = Date.now() + this.queryTimeoutMs;
    // The first registration can still show state from before `pane run`
    // reaches Pi. Only the extension's explicit post-turn marker may report a
    // terminal failure; a generic idle pane could merely be awaiting its turn.
    while (Date.now() < deadline) {
      const registration = await this.gateway.registration(paneId);
      if (!registration) {
        await delay(150, signal);
        continue;
      }
      if (registration.sessionId !== expectedSessionId) {
        throw new Error("The Herdr Pi pane started a different session.");
      }
      const response = registration.messages.find((message) => !before.has(message.messageId));
      if (response) return response;
      if (this.gateway.waitForRegistration) {
        const updated = await this.gateway.waitForRegistration(
          paneId,
          Math.min(150, Math.max(1, deadline - Date.now())),
        );
        if (updated && hasSettledWithoutResponse(updated, expectedSessionId, before)) {
          throw new Error("The Herdr Pi pane stopped without producing a response.");
        }
      } else {
        if (hasSettledWithoutResponse(registration, expectedSessionId, before)) {
          throw new Error("The Herdr Pi pane stopped without producing a response.");
        }
        await delay(150, signal);
      }
    }
    throw new Error("The Herdr Pi pane did not produce a response before the timeout.");
  }

  private buildPrompt(userPrompt: string): string {
    return buildEffectivePrompt(userPrompt, this.preamble, this._firstQuerySent);
  }

  private retirePane(): void {
    const pane = this.pane;
    this.pane = null;
    this.paneSessionId = null;
    this.knownMessageIds.clear();
    if (!pane) return;
    const closePromise = this.gateway.close(pane).catch(() => {});
    const closing = closePromise.finally(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    this.closePromise = closing;
  }
}
