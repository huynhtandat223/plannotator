import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveAssistantMessage } from "./session.js";

type SessionEntry = {
	id: string;
	type: string;
	timestamp?: string | number | Date;
	message?: unknown;
};

type TextBlock = { type?: unknown; text?: unknown };

function assistantText(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return null;
	const text = candidate.content
		.filter((block): block is TextBlock => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
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
): LiveAssistantMessage[] {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const messages: LiveAssistantMessage[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const text = assistantText(entry.message);
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
): LiveAssistantMessage[] {
	return getActiveBranchAssistantMessages(ctx).slice(0, limit);
}
