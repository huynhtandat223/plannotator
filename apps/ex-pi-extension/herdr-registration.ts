import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveBranchAssistantMessages } from "./assistant-message.js";
import { formatLiveFeedbackBatch, type LiveFeedbackBatch } from "./session.js";

const DEFAULT_HERDR_SERVICE_URL = "http://127.0.0.1:19432";
/** Number of finalized structured assistant responses retained per live pane. */
export const HERDR_LIVE_MESSAGE_LIMIT = 5;

function loopbackServiceUrl(env: NodeJS.ProcessEnv): string {
	const value = env.EX_PLANNOTATOR_HERDR_SERVICE_URL?.trim() || DEFAULT_HERDR_SERVICE_URL;
	const url = new URL(value);
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
		throw new Error("EX_PLANNOTATOR_HERDR_SERVICE_URL must be a loopback HTTP URL");
	}
	return url.origin;
}

export type HerdrCommandCapability = {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	arguments?: string[];
};

export const EX_PLANNOTATOR_NEW_COMMAND = "ex-plannotator-new";
export const EX_PLANNOTATOR_MODEL_COMMAND = "ex-plannotator-model";
export const EX_PLANNOTATOR_RELOAD_COMMAND = "ex-plannotator-reload";
export const EX_PLANNOTATOR_THINKING_COMMAND = "ex-plannotator-thinking";

export type HerdrContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

export type HerdrModel = {
	provider?: string;
	id: string;
	name?: string;
};

export type HerdrActivity = {
	kind: "tool" | "subagent";
	name?: string;
	count: number;
};

export type HerdrSessionRegistration = {
	paneId: string;
	sessionId: string;
	messages: ReturnType<typeof getActiveBranchAssistantMessages>;
	commands: HerdrCommandCapability[];
	/** Current context state; tokens are null when Pi cannot estimate them after compaction. */
	contextUsage?: HerdrContextUsage;
	/** Current model selected in the Pi session. */
	model?: HerdrModel;
	/** Running tool or subagent activity, refreshed at tool lifecycle boundaries. */
	activity?: HerdrActivity;
	/** Cumulative model tokens charged over the complete Pi session. */
	totalUsedTokens: number;
	/** Context tokens represented by Pi's latest compaction summary. */
	latestCompactionTokens?: number;
	/** Prevent a nested Pi child that inherited HERDR_PANE_ID from replacing its pane owner. */
	isSubagent?: true;
};

type HerdrExtensionContext = Pick<ExtensionContext, "sessionManager" | "model"> &
	Partial<Pick<ExtensionContext, "getContextUsage" | "modelRegistry">>;

type CompactionEntry = { type?: unknown; tokensBefore?: unknown };
type SessionEntryWithUsage = {
	type?: unknown;
	message?: {
		role?: unknown;
		model?: unknown;
		provider?: unknown;
		usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
	};
};

type ModelChangeEntry = { type?: unknown; provider?: unknown; modelId?: unknown };
const activeToolCallsBySession = new Map<string, Map<string, string>>();

function currentModel(ctx: HerdrExtensionContext): HerdrModel | undefined {
	if (ctx.model?.id) return {
		id: ctx.model.id,
		...(ctx.model.provider ? { provider: ctx.model.provider } : {}),
		...(ctx.model.name ? { name: ctx.model.name } : {}),
	};
	const branch = ctx.sessionManager.getBranch() as Array<SessionEntryWithUsage & ModelChangeEntry>;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "message" && typeof entry.message?.model === "string") {
			return { id: entry.message.model, ...(typeof entry.message.provider === "string" ? { provider: entry.message.provider } : {}) };
		}
		if (entry.type === "model_change" && typeof entry.modelId === "string") {
			return { id: entry.modelId, ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}) };
		}
	}
	return undefined;
}

function currentActivity(ctx: HerdrExtensionContext): HerdrActivity | undefined {
	const activeTools = activeToolCallsBySession.get(ctx.sessionManager.getSessionId());
	if (!activeTools || activeTools.size === 0) return undefined;
	const subagentCount = [...activeTools.values()].filter((toolName) => toolName === "subagent").length;
	if (subagentCount > 0) return { kind: "subagent", count: subagentCount };
	const [name] = activeTools.values();
	return { kind: "tool", name, count: activeTools.size };
}

export function beginHerdrTool(ctx: HerdrExtensionContext, toolCallId: string, toolName: string): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const activeTools = activeToolCallsBySession.get(sessionId) ?? new Map<string, string>();
	activeTools.set(toolCallId, toolName);
	activeToolCallsBySession.set(sessionId, activeTools);
}

export function endHerdrTool(ctx: HerdrExtensionContext, toolCallId: string): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const activeTools = activeToolCallsBySession.get(sessionId);
	if (!activeTools) return;
	activeTools.delete(toolCallId);
	if (activeTools.size === 0) activeToolCallsBySession.delete(sessionId);
}

export function clearHerdrTools(ctx: HerdrExtensionContext): void {
	activeToolCallsBySession.delete(ctx.sessionManager.getSessionId());
}

function contextWindowFromSession(ctx: HerdrExtensionContext): number | undefined {
	const modelWindow = ctx.model?.contextWindow;
	if (typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0) return modelWindow;
	const branch = ctx.sessionManager.getBranch() as Array<SessionEntryWithUsage & ModelChangeEntry>;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "message") {
			const model = entry.message?.model;
			if (typeof model === "string") return knownContextWindow(model);
		}
		if (entry.type === "model_change" && typeof entry.modelId === "string") return knownContextWindow(entry.modelId);
	}
	return undefined;
}

function knownContextWindow(modelId: string): number | undefined {
	// Pi's runtime model registry is the source of truth. This conservative
	// fallback keeps known gateway model IDs useful during an extension reload,
	// before `ctx.model` becomes available to the handler.
	if (/^cx\/gpt-5\.6-(?:terra|sol|luna)(?:-review)?$/i.test(modelId)) return 1_050_000;
	return /(?:gpt-5|claude|gemini)/i.test(modelId) ? 200_000 : undefined;
}

function contextUsage(ctx: HerdrExtensionContext): HerdrContextUsage | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage) {
		const contextWindow = contextWindowFromSession(ctx);
		return contextWindow === undefined ? undefined : { tokens: null, contextWindow, percent: null };
	}
	if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
	if (usage.tokens !== null && (!Number.isFinite(usage.tokens) || usage.tokens < 0)) return undefined;
	if (usage.percent !== null && !Number.isFinite(usage.percent)) return undefined;
	return {
		tokens: usage.tokens,
		contextWindow: usage.contextWindow,
		percent: usage.percent,
	};
}

function totalUsedTokens(ctx: HerdrExtensionContext): number {
	// `getEntries` is part of Pi's live SessionManager. Keep this optional for
	// compatibility with older/mocked extension contexts while the pane reloads.
	const entries = (ctx.sessionManager as { getEntries?: () => SessionEntryWithUsage[] }).getEntries?.() ?? [];
	return entries.reduce((total, entry) => {
		if (entry.type !== "message" || entry.message?.role !== "assistant") return total;
		const usage = entry.message.usage;
		const usageTokens = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite]
			.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0), 0);
		return total + usageTokens;
	}, 0);
}

function latestCompactionTokens(ctx: HerdrExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch() as CompactionEntry[];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "compaction" && typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0) {
			return entry.tokensBefore;
		}
	}
	return undefined;
}

type HerdrFeedbackDelivery = { deliveryId: string; batch: LiveFeedbackBatch };
type HerdrInstructionDelivery = { deliveryId: string; content: string };
type SendPiUserMessage = (content: string, options: { deliverAs: "followUp" }) => void;

function herdrCommandCapabilities(ctx: HerdrExtensionContext, commands: HerdrCommandCapability[]): HerdrCommandCapability[] {
	const seen = new Set<string>();
	const modelArguments = (ctx.modelRegistry?.getAvailable() ?? [])
		.map((model) => `${model.provider}/${model.id}`)
		.sort((left, right) => left.localeCompare(right));
	return commands.flatMap((command) => {
		if (!command.name || seen.has(command.name)) return [];
		seen.add(command.name);
		return [{
			name: command.name,
			...(command.description ? { description: command.description } : {}),
			source: command.source,
			...(command.name === EX_PLANNOTATOR_MODEL_COMMAND ? { arguments: modelArguments } : {}),
		}];
	});
}

export function currentHerdrRegistration(
	ctx: HerdrExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
	commands: HerdrCommandCapability[] = [],
): HerdrSessionRegistration | null {
	const paneId = env.HERDR_PANE_ID?.trim();
	if (env.HERDR_ENV !== "1" || !paneId) return null;
	const usage = contextUsage(ctx);
	const model = currentModel(ctx);
	const activity = currentActivity(ctx);
	const compactedTokens = latestCompactionTokens(ctx);
	return {
		paneId,
		sessionId: ctx.sessionManager.getSessionId(),
		...(env.PI_SUBAGENT_CHILD === "1" ? { isSubagent: true as const } : {}),
		// Newest first, matching /ex-plannotator-last for the first entry while
		// retaining a small structured history for the live workspace viewer.
		messages: getActiveBranchAssistantMessages(ctx as ExtensionContext).slice(0, HERDR_LIVE_MESSAGE_LIMIT),
		commands: herdrCommandCapabilities(ctx, commands),
		totalUsedTokens: totalUsedTokens(ctx),
		...(usage ? { contextUsage: usage } : {}),
		...(model ? { model } : {}),
		...(activity ? { activity } : {}),
		...(compactedTokens !== undefined ? { latestCompactionTokens: compactedTokens } : {}),
	};
}

export async function reportHerdrSession(
	ctx: HerdrExtensionContext,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
	commands: HerdrCommandCapability[] = [],
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env, commands);
	if (!registration || registration.isSubagent) return;
	try {
		await fetcher(`${loopbackServiceUrl(env)}/api/panel-session`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(registration),
			signal: AbortSignal.timeout(1_000),
		});
	} catch {
		// The native viewer is optional. Pi sessions remain fully usable when it
		// is not running; the next lifecycle event will retry registration.
	}
}

export async function pollHerdrFeedback(
	ctx: HerdrExtensionContext,
	sendUserMessage: SendPiUserMessage,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env);
	if (!registration || registration.isSubagent) return;
	try {
		const claim = await fetcher(`${loopbackServiceUrl(env)}/api/panel-feedback/claim`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paneId: registration.paneId, sessionId: registration.sessionId }),
			signal: AbortSignal.timeout(1_000),
		});
		if (claim.status === 204 || !claim.ok) return;
		const delivery = await claim.json() as Partial<HerdrFeedbackDelivery>;
		if (!delivery.deliveryId || !delivery.batch || !Array.isArray(delivery.batch.messages)) return;
		// Pi is the final authority for delivery: this closure belongs to the
		// current pane/session, not to the LAN-facing host.
		sendUserMessage(formatLiveFeedbackBatch(delivery.batch), { deliverAs: "followUp" });
	} catch {
		// Feedback remains queued until a later poll when this optional host is
		// temporarily unavailable. Pi remains usable independently of it.
	}
}

export async function pollHerdrInstruction(
	ctx: HerdrExtensionContext,
	sendUserMessage: SendPiUserMessage,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env);
	if (!registration || registration.isSubagent) return;
	try {
		const claim = await fetcher(`${loopbackServiceUrl(env)}/api/panel-instruction/claim`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paneId: registration.paneId, sessionId: registration.sessionId }),
			signal: AbortSignal.timeout(1_000),
		});
		if (claim.status === 204 || !claim.ok) return;
		const delivery = await claim.json() as Partial<HerdrInstructionDelivery>;
		if (!delivery.deliveryId || !delivery.content?.trim()) return;
		sendUserMessage(delivery.content, { deliverAs: "followUp" });
	} catch {
		// User messages remain queued until the optional local viewer is reachable.
	}
}

export async function releaseHerdrSession(
	ctx: HerdrExtensionContext,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const paneId = env.HERDR_PANE_ID?.trim();
	if (env.HERDR_ENV !== "1" || !paneId) return;
	try {
		const params = new URLSearchParams({ paneId, sessionId: ctx.sessionManager.getSessionId() });
		await fetcher(`${loopbackServiceUrl(env)}/api/panel-session?${params}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(1_000),
		});
	} catch {
		// Best effort only; discovery drops closed panes from the next Herdr
		// snapshot even if this in-memory enrichment has not been released yet.
	}
}
