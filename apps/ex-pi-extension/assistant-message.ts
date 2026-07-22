import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveAssistantMessage } from "./session.js";

type SessionEntry = {
	id: string;
	type: string;
	timestamp?: string | number | Date;
	message?: unknown;
};

type TextBlock = { type?: unknown; text?: unknown };

/**
 * Which assistant content blocks become the Reviewed Source. `"text"` keeps the
 * final response blocks reviewed by /ex-plannotator-last; `"thinking"` surfaces
 * the assistant's reasoning blocks for /ex-plannotator-thinking.
 */
export type AssistantBlockKind = "text" | "thinking";

function assistantText(message: unknown, kind: AssistantBlockKind = "text"): string | null {
	if (!message || typeof message !== "object") return null;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return null;
	const text = candidate.content
		.filter((block): block is TextBlock => !!block && typeof block === "object")
		.filter((block) => block.type === kind && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
	return text.trim() ? text : null;
}

function normalizeTimestamp(value: unknown): string | undefined {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function getActiveBranchAssistantMessages(
	ctx: ExtensionContext,
	kind: AssistantBlockKind = "text",
): LiveAssistantMessage[] {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const messages: LiveAssistantMessage[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const text = assistantText(entry.message, kind);
		if (!text) continue;
		const timestamp = normalizeTimestamp(entry.timestamp);
		messages.push({
			messageId: entry.id,
			text,
			...(timestamp ? { timestamp } : {}),
		});
	}
	return messages;
}

export function getRecentAssistantMessages(
	ctx: ExtensionContext,
	limit = 25,
	kind: AssistantBlockKind = "text",
): LiveAssistantMessage[] {
	return getActiveBranchAssistantMessages(ctx, kind).slice(0, limit);
}

/**
 * Reviewed Source variant that surfaces the assistant's thinking/reasoning
 * blocks instead of the final text blocks. Backs /ex-plannotator-thinking while
 * /ex-plannotator-last keeps its text-only snapshot unchanged.
 */
export function getActiveBranchAssistantThinking(
	ctx: ExtensionContext,
): LiveAssistantMessage[] {
	return getActiveBranchAssistantMessages(ctx, "thinking");
}

export function getRecentAssistantThinking(
	ctx: ExtensionContext,
	limit = 25,
): LiveAssistantMessage[] {
	return getRecentAssistantMessages(ctx, limit, "thinking");
}
