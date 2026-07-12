import { describe, expect, test } from "bun:test";
import { createLiveMessageReviewState } from "./session";
import type { DraftAnnotation } from "./session";

const draft: DraftAnnotation = {
	id: "annotation-1",
	blockId: "block-0",
	startOffset: 0,
	endOffset: 5,
	type: "COMMENT",
	text: "Clarify this",
	originalText: "Hello",
	createdA: 1,
};

describe("Live Message Review Session state", () => {
	test("keeps independent drafts while switching assistant responses", () => {
		const state = createLiveMessageReviewState([
			{ messageId: "new", text: "Newest response" },
			{ messageId: "old", text: "Older response" },
		]);

		state.setDrafts("new", [draft]);
		state.select("old");
		state.setDrafts("old", [{ ...draft, id: "annotation-2", text: "Old note" }]);
		state.select("new");

		expect(state.snapshot()).toEqual({
			messages: [
				{ messageId: "new", text: "Newest response" },
				{ messageId: "old", text: "Older response" },
			],
			selectedMessageId: "new",
			draftsByMessageId: {
				new: [draft],
				old: [{ ...draft, id: "annotation-2", text: "Old note" }],
			},
		});
	});

	test("creates, edits, and deletes drafts only for their stable message identity", () => {
		const state = createLiveMessageReviewState([
			{ messageId: "new", text: "Newest response" },
			{ messageId: "old", text: "Older response" },
		]);

		state.addDraft("new", draft);
		state.editDraft("new", draft.id, { text: "Updated note" });
		state.addDraft("missing", { ...draft, id: "orphan" });
		state.deleteDraft("old", draft.id);

		expect(state.snapshot().draftsByMessageId).toEqual({
			new: [{ ...draft, text: "Updated note" }],
			old: [],
		});

		state.deleteDraft("new", draft.id);
		expect(state.snapshot().draftsByMessageId.new).toEqual([]);
	});

	test("caps the initial branch snapshot at 25 messages", () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			messageId: String(index),
			text: `Response ${index}`,
		}));

		expect(createLiveMessageReviewState(messages).snapshot().messages).toEqual(messages.slice(0, 25));
	});
});
