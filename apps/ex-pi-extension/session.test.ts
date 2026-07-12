import { describe, expect, test } from "bun:test";
import { createLiveMessageReviewSnapshot } from "./session";

describe("Live Message Review Session snapshot", () => {
	test("keeps stable assistant response identities and selects the newest response", () => {
		const messages = [
			{ messageId: "new", text: "Newest response" },
			{ messageId: "old", text: "Older response" },
		];

		expect(createLiveMessageReviewSnapshot(messages)).toEqual({
			messages,
			selectedMessageId: "new",
			unreadMessageIds: [],
			draftsByMessageId: {},
		});
	});

	test("caps the initial active-branch snapshot at 25 messages", () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			messageId: String(index),
			text: `Response ${index}`,
		}));

		expect(createLiveMessageReviewSnapshot(messages).messages).toEqual(messages.slice(0, 25));
	});
});
