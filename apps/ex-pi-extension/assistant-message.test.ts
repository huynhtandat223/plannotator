import { describe, expect, test } from "bun:test";
import {
	getRecentAssistantMessages,
	getRecentAssistantThinking,
} from "./assistant-message";

function contextWithBranch(branch: unknown[]) {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	};
}

describe("active Pi branch snapshot", () => {
	test("returns newest completed assistant responses and excludes other message roles", () => {
		const ctx = contextWithBranch([
			{ id: "assistant-old", type: "message", timestamp: "2026-07-12T01:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Old" }] } },
			{ id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "Question" }] } },
			{ id: "tool", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Result" }] } },
			{ id: "assistant-empty", type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "Hidden" }] } },
			{ id: "assistant-new", type: "message", timestamp: "2026-07-12T02:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "New" }] } },
		]);

		expect(getRecentAssistantMessages(ctx as never, 25)).toEqual([
			{ messageId: "assistant-new", text: "New", timestamp: "2026-07-12T02:00:00.000Z" },
			{ messageId: "assistant-old", text: "Old", timestamp: "2026-07-12T01:00:00.000Z" },
		]);
	});
});

describe("active Pi branch thinking snapshot", () => {
	test("surfaces assistant thinking blocks that the text-only snapshot excludes", () => {
		const ctx = contextWithBranch([
			{ id: "assistant-thinking", type: "message", timestamp: "2026-07-12T01:00:00Z", message: { role: "assistant", content: [{ type: "thinking", text: "Reasoning here" }] } },
			{ id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "Question" }] } },
			{ id: "assistant-mixed", type: "message", timestamp: "2026-07-12T02:00:00Z", message: { role: "assistant", content: [{ type: "thinking", text: "Weighing options" }, { type: "text", text: "Final answer" }] } },
		]);

		// New thinking path surfaces the reasoning blocks, newest first.
		expect(getRecentAssistantThinking(ctx as never, 25)).toEqual([
			{ messageId: "assistant-mixed", text: "Weighing options", timestamp: "2026-07-12T02:00:00.000Z" },
			{ messageId: "assistant-thinking", text: "Reasoning here", timestamp: "2026-07-12T01:00:00.000Z" },
		]);

		// Existing text-only path still excludes thinking-only responses.
		expect(getRecentAssistantMessages(ctx as never, 25)).toEqual([
			{ messageId: "assistant-mixed", text: "Final answer", timestamp: "2026-07-12T02:00:00.000Z" },
		]);
	});
});
