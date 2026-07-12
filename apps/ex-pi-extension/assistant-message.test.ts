import { describe, expect, test } from "bun:test";
import { getRecentAssistantMessages } from "./assistant-message";

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
