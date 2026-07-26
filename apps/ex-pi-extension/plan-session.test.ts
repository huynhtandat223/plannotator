import { expect, test } from "bun:test";
import type { Annotation } from "@plannotator/ui/types";
import { PLAN_RESPONSE_HISTORY_LIMIT, PlanReviewSession } from "./plan-session";

function messagesThrough(newest: number) {
	return Array.from({ length: newest }, (_, index) => {
		const number = newest - index;
		return { messageId: `m${number}`, text: `Response ${number}` };
	});
}

function commentAnnotation(id: string): Annotation {
	return {
		id,
		blockId: "b1",
		startOffset: 0,
		endOffset: 4,
		type: "COMMENT",
		text: "Fix this",
		originalText: "Resp",
		createdA: 1,
	} as Annotation;
}

function noFileReads(): never {
	throw new Error("No file should be read");
}

test("keeps the latest chronological response history through unannotated Plan review rounds", () => {
	const session = new PlanReviewSession(messagesThrough(2), [], async () => {
		throw new Error("No file should be read");
	});

	for (let round = 3; round <= 6; round += 1) {
		session.recordResponseHistory(messagesThrough(round));
	}

	const snapshot = session.snapshot();
	expect(PLAN_RESPONSE_HISTORY_LIMIT).toBe(4);
	expect(snapshot.responseHistory.map((message) => message.messageId)).toEqual(["m3", "m4", "m5", "m6"]);
	expect(snapshot.reviewRoundStatus).toBe("open");
});

test("keeps a round staged during failed delivery and opens it once the retry succeeds", async () => {
	const session = new PlanReviewSession(messagesThrough(1), [], noFileReads);
	expect(session.replaceMessageDrafts("m1", [commentAnnotation("a1")])).toBe(true);

	// The next response finalizes while delivery is still in flight, staging a
	// pending round; then delivery fails. The staged round must survive the
	// failure — nothing restages it before the retry.
	await expect(session.submitFeedback(() => {
		expect(session.advanceRound(messagesThrough(2), [], noFileReads)).toBe(true);
		throw new Error("delivery transport failed");
	})).rejects.toThrow("delivery transport failed");
	expect(session.snapshot().reviewRoundStatus).toBe("delivery_failed");

	expect(await session.retryFeedback(() => {})).toBe(true);

	const snapshot = session.snapshot();
	expect(snapshot.reviewRoundStatus).toBe("open");
	expect(snapshot.messages.map((message) => message.messageId)).toEqual(["m2", "m1"]);
	expect(snapshot.selected).toEqual({ kind: "message", messageId: "m2" });
	expect(snapshot.sentAnnotationsByMessageId.m1?.map((annotation) => annotation.id)).toEqual(["a1"]);
});

test("returns to waiting after a retried delivery with no staged round", async () => {
	const session = new PlanReviewSession(messagesThrough(1), [], noFileReads);
	expect(session.replaceMessageDrafts("m1", [commentAnnotation("a1")])).toBe(true);

	await expect(session.submitFeedback(() => {
		throw new Error("delivery transport failed");
	})).rejects.toThrow("delivery transport failed");

	expect(await session.retryFeedback(() => {})).toBe(true);
	expect(session.snapshot().reviewRoundStatus).toBe("waiting");
});
