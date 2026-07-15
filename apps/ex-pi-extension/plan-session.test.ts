import { expect, test } from "bun:test";
import { PLAN_RESPONSE_HISTORY_LIMIT, PlanReviewSession } from "./plan-session";

function messagesThrough(newest: number) {
	return Array.from({ length: newest }, (_, index) => {
		const number = newest - index;
		return { messageId: `m${number}`, text: `Response ${number}` };
	});
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
