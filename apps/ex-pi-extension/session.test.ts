import { describe, expect, test } from "bun:test";
import {
	LIVE_RESPONSE_HISTORY_LIMIT,
	createLiveMessageReviewSnapshot,
	formatLiveFeedbackBatch,
	LiveMessageReviewSession,
	type LiveAssistantMessage,
	type LiveFeedbackBatchMessage,
} from "./session";

describe("formatLiveFeedbackBatch", () => {
	test("produces a user message grouping annotations by source response with quotes", () => {
		const batch = {
			batchId: "test-batch-1",
			messages: [
				{
					messageId: "msg-1",
					messageText: "The quick brown fox jumps over the lazy dog near the riverbank.",
					annotations: [
						{ id: "a1", type: "COMMENT", originalText: "brown fox", text: "Make it red" },
						{ id: "a2", type: "DELETION", originalText: "lazy dog", text: "" },
					],
				},
				{
					messageId: "msg-2",
					messageText: "Short reply.",
					annotations: [
						{ id: "a3", type: "GLOBAL_COMMENT", originalText: "", text: "Great work" },
					],
				},
			],
		};

		const output = formatLiveFeedbackBatch(batch);

		expect(output).toContain("msg-1");
		expect(output).toContain("msg-2");
		expect(output).toContain("brown fox");
		expect(output).toContain("Make it red");
		expect(output).toContain("Remove this");
		expect(output).toContain("lazy dog");
		expect(output).toContain("Great work");
		expect(output).toContain("General feedback");
		expect(output).toContain("> The quick brown fox");
		expect(output).toContain("> Short reply.");
		expect(output).toContain("Please address the annotation feedback above.");
	});
});

describe("LiveMessageReviewSession", () => {
	function sessionWith(
		messages: LiveAssistantMessage[],
	): LiveMessageReviewSession {
		return new LiveMessageReviewSession(messages);
	}

	test("starts in open status with empty drafts and sent annotations", () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		const snap = session.snapshot();
		expect(snap.reviewRoundStatus).toBe("open");
		expect(snap.draftsByMessageId).toEqual({});
		expect(snap.sentAnnotationsByMessageId).toEqual({});
	});

	test("replaceDrafts blocks mutation while waiting", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		// Before submit: replaceDrafts succeeds
		expect(session.replaceDrafts("m1", [{ id: "a1", type: "COMMENT" }])).toBe(true);

		// Submit to go to waiting
		await session.submitFeedback(async () => {});

		// After submit: replaceDrafts is rejected
		expect(session.replaceDrafts("m1", [{ id: "a2", type: "COMMENT" }])).toBe(false);
	});

	test("submitFeedback fails when there are no drafts", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		const result = await session.submitFeedback(async () => {});
		expect(result).toBe(false);
		expect(session.snapshot().reviewRoundStatus).toBe("open");
	});

	test("submitFeedback collects all drafts across messages into one batch", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
			{ messageId: "m2", text: "Second response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Clarify" },
		]);
		session.replaceDrafts("m2", [
			{ id: "a2", type: "DELETION", originalText: "bar" },
		]);

		let capturedBatch: unknown = null;
		const result = await session.submitFeedback(async (batch) => {
			capturedBatch = batch;
		});

		expect(result).toBe(true);
		expect(capturedBatch).toBeDefined();
		const batch = capturedBatch as { batchId: string; messages: LiveFeedbackBatchMessage[] };
		expect(batch.batchId).toBeDefined();
		expect(batch.batchId.length).toBeGreaterThan(0);
		expect(batch.messages).toHaveLength(2);
		expect(batch.messages[0].messageId).toBe("m1");
		expect(batch.messages[0].annotations).toEqual([
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Clarify" },
		]);
		expect(batch.messages[1].messageId).toBe("m2");
		expect(batch.messages[1].annotations).toEqual([
			{ id: "a2", type: "DELETION", originalText: "bar" },
		]);
	});

	test("submitFeedback transitions through submitting to waiting with sent annotations", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);
		let capturedBatch: unknown = null;

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		const done = session.submitFeedback(async (batch) => {
			capturedBatch = batch;
			// While in the delivery callback, status should be "submitting"
			expect(session.snapshot().reviewRoundStatus).toBe("submitting");
		});

		// During delivery, status is submitting
		expect(session.snapshot().reviewRoundStatus).toBe("submitting");

		await done;

		// After delivery, status is waiting
		const snap = session.snapshot();
		expect(snap.reviewRoundStatus).toBe("waiting");
		expect(snap.draftsByMessageId).toEqual({});
		expect(snap.sentAnnotationsByMessageId).toEqual({
			m1: [{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" }],
		});
	});

	test("keeps a failed batch retryable and accepts it only once", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);
		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await expect(
			session.submitFeedback(async () => {
				throw new Error("Delivery rejected");
			}),
		).rejects.toThrow("Delivery rejected");

		expect(session.snapshot()).toMatchObject({
			reviewRoundStatus: "delivery_failed",
			draftsByMessageId: { m1: [{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" }] },
			sentAnnotationsByMessageId: {},
		});

		let deliveries = 0;
		expect(await session.retryFeedback(async () => { deliveries += 1; })).toBe(true);
		expect(deliveries).toBe(1);
		expect(session.snapshot().reviewRoundStatus).toBe("waiting");
		expect(await session.retryFeedback(async () => { deliveries += 1; })).toBe(false);
		expect(deliveries).toBe(1);
	});

	test("preserves an agent stop received while feedback acceptance is still pending", async () => {
		const session = sessionWith([{ messageId: "m1", text: "First response" }]);
		let acceptDelivery: (() => void) | undefined;
		const deliveryPending = new Promise<void>((resolve) => { acceptDelivery = resolve; });
		session.replaceDrafts("m1", [{ id: "a1", type: "COMMENT", text: "Continue" }]);
		const submission = session.submitFeedback(() => deliveryPending);

		session.markAgentStopped();
		acceptDelivery?.();
		await submission;

		expect(session.snapshot()).toMatchObject({
			reviewRoundStatus: "agent_stopped",
			sentAnnotationsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Continue" }] },
		});
	});

	test("offers Resume only after an accepted batch stops before a response", async () => {
		const session = sessionWith([{ messageId: "m1", text: "First response" }]);
		session.replaceDrafts("m1", [{ id: "a1", type: "COMMENT", text: "Continue" }]);
		await session.submitFeedback(async () => {});

		session.markAgentStarted();
		session.markAgentStopped();
		expect(session.snapshot().reviewRoundStatus).toBe("agent_stopped");

		let resumes = 0;
		expect(await session.resumeAgent(async () => { resumes += 1; })).toBe(true);
		expect(resumes).toBe(1);
		expect(session.snapshot()).toMatchObject({
			reviewRoundStatus: "waiting",
			sentAnnotationsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Continue" }] },
		});
	});

	test("cancelWaiting unlocks drafts without reverting sent annotations", async () => {
		const session = sessionWith([{ messageId: "m1", text: "First response" }]);
		session.replaceDrafts("m1", [{ id: "a1", type: "COMMENT", text: "Sent" }]);
		await session.submitFeedback(async () => {});

		expect(session.cancelWaiting()).toBe(true);
		expect(session.snapshot()).toMatchObject({
			reviewRoundStatus: "open",
			draftsByMessageId: {},
			sentAnnotationsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Sent" }] },
		});
		expect(session.replaceDrafts("m1", [{ id: "a2", type: "COMMENT", text: "New" }])).toBe(true);
		expect(session.cancelWaiting()).toBe(false);
	});

	test("rejects a second submitFeedback while waiting", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await session.submitFeedback(async () => {});

		expect(session.snapshot().reviewRoundStatus).toBe("waiting");

		// Second submit should be rejected
		const second = await session.submitFeedback(async () => {});
		expect(second).toBe(false);
	});

	test("keeps a compact chronological latest-four picker and makes a live response editable", () => {
		const session = sessionWith(Array.from({ length: 6 }, (_, index) => ({
			messageId: `m${6 - index}`,
			text: `Response ${6 - index}`,
		})));

		let snapshot = session.snapshot();
		expect(LIVE_RESPONSE_HISTORY_LIMIT).toBe(4);
		expect(snapshot.messages.map((message) => message.messageId)).toEqual(["m3", "m4", "m5", "m6"]);
		expect(snapshot.selectedMessageId).toBe("m6");

		session.reconcile([
			{ messageId: "m7", text: "Response 7" },
			...Array.from({ length: 6 }, (_, index) => ({ messageId: `m${6 - index}`, text: `Response ${6 - index}` })),
	], ["m7", "m6", "m5", "m4", "m3", "m2", "m1"]);

		snapshot = session.snapshot();
		expect(snapshot.messages.map((message) => message.messageId)).toEqual(["m4", "m5", "m6", "m7"]);
		expect(snapshot.selectedMessageId).toBe("m7");
		expect(session.replaceDrafts("m7", [{ id: "editable" }])).toBe(true);
	});

	test("preserves a draft when a visible response is updated in place", async () => {
		const session = sessionWith([{ messageId: "m1", text: "Original response" }]);
		session.replaceDrafts("m1", [{ id: "draft", type: "COMMENT", text: "Keep this" }]);

		session.reconcile([{ messageId: "m1", text: "Updated response" }], ["m1"]);

		expect(session.snapshot().draftsByMessageId).toEqual({
			m1: [{ id: "draft", type: "COMMENT", text: "Keep this" }],
		});
		let delivered: LiveFeedbackBatchMessage[] = [];
		await session.submitFeedback(async (batch) => { delivered = batch.messages; });
		expect(delivered).toEqual([{
			messageId: "m1",
			messageText: "Updated response",
			annotations: [{ id: "draft", type: "COMMENT", text: "Keep this" }],
		}]);
	});

	test("retains and delivers a draft after its response leaves the compact picker", async () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			messageId: `m${5 - index}`,
			text: `Response ${5 - index}`,
		}));
		const session = sessionWith(messages);
		expect(session.replaceDrafts("m2", [{ id: "retained" }])).toBe(true);

		session.reconcile(
			[{ messageId: "m6", text: "Response 6" }, ...messages],
			["m6", "m5", "m4", "m3", "m2", "m1"],
		);
		expect(session.snapshot().messages.map((message) => message.messageId)).toEqual(["m3", "m4", "m5", "m6"]);

		let delivered: LiveFeedbackBatchMessage[] = [];
		expect(await session.submitFeedback(async (batch) => { delivered = batch.messages; })).toBe(true);
		expect(delivered).toEqual([
			{ messageId: "m2", messageText: "Response 2", annotations: [{ id: "retained" }] },
		]);
	});

	test("retains code drafts after their response leaves the compact picker", async () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			messageId: `m${5 - index}`,
			text: `Response ${5 - index}`,
		}));
		const session = sessionWith(messages);
		session.replaceDrafts("m2", [], [{
			id: "code-draft",
			filePath: "src/example.ts",
			lineStart: 4,
			lineEnd: 5,
			originalCode: "const value = 1;",
			text: "Use the configured value.",
		}]);

		session.reconcile(
			[{ messageId: "m6", text: "Response 6" }, ...messages],
			["m6", "m5", "m4", "m3", "m2", "m1"],
		);

		let output = "";
		expect(await session.submitFeedback(async (batch) => { output = formatLiveFeedbackBatch(batch); })).toBe(true);
		expect(output).toContain("src/example.ts (lines 4-5)");
		expect(output).toContain("Use the configured value.");
	});

	test("retains attachments and linked-document drafts after their response leaves the compact picker", async () => {
		const messages = Array.from({ length: 5 }, (_, index) => ({
			messageId: `m${5 - index}`,
			text: `Response ${5 - index}`,
		}));
		const session = sessionWith(messages);
		session.replaceDrafts("m2", [], [], [{ path: "/tmp/mockup.png", name: "mockup" }], [{
			filepath: "docs/design.md",
			annotations: [{ id: "linked-draft", type: "COMMENT", originalText: "Original", text: "Clarify this" }],
			globalAttachments: [{ path: "/tmp/linked.png", name: "linked" }],
		}]);

		session.reconcile(
			[{ messageId: "m6", text: "Response 6" }, ...messages],
			["m6", "m5", "m4", "m3", "m2", "m1"],
		);

		expect(session.snapshot().retainedMessages).toEqual([{ messageId: "m2", text: "Response 2" }]);
		let output = "";
		expect(await session.submitFeedback(async (batch) => { output = formatLiveFeedbackBatch(batch); })).toBe(true);
		expect(output).toContain("[mockup] `/tmp/mockup.png`");
		expect(output).toContain("Linked document: docs/design.md");
		expect(output).toContain("[linked] `/tmp/linked.png`");
		expect(output).toContain("Clarify this");
	});

	test("reconcile selects the newest message and unlocks round after waiting", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await session.submitFeedback(async () => {});

		expect(session.snapshot().reviewRoundStatus).toBe("waiting");

		// A new assistant message arrives
		session.reconcile(
			[
				{ messageId: "m2", text: "New response after feedback" },
				{ messageId: "m1", text: "First response" },
			],
			["m2", "m1"],
		);

		const snap = session.snapshot();
		expect(snap.reviewRoundStatus).toBe("open");
		expect(snap.selectedMessageId).toBe("m2");
	});

	test("a completed response received during delivery opens the next round after delivery succeeds", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);
		let acceptDelivery: (() => void) | undefined;
		const deliveryPending = new Promise<void>((resolve) => {
			acceptDelivery = resolve;
		});

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);
		const submission = session.submitFeedback(() => deliveryPending);

		session.reconcile(
			[
				{ messageId: "m2", text: "Response completed during delivery" },
				{ messageId: "m1", text: "First response" },
			],
			["m2", "m1"],
		);
		expect(session.snapshot().reviewRoundStatus).toBe("submitting");

		acceptDelivery?.();
		await submission;

		const snap = session.snapshot();
		expect(snap.reviewRoundStatus).toBe("open");
		expect(snap.selectedMessageId).toBe("m2");
		expect(snap.unreadMessageIds).toEqual([]);
		expect(snap.sentAnnotationsByMessageId.m1).toHaveLength(1);
	});

	test("reconcile does not advance from waiting when there are no new messages", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await session.submitFeedback(async () => {});

		expect(session.snapshot().reviewRoundStatus).toBe("waiting");

		// Same messages, no new ones
		session.reconcile(
			[{ messageId: "m1", text: "First response" }],
			["m1"],
		);

		expect(session.snapshot().reviewRoundStatus).toBe("waiting");
	});

	test("sent annotations remain visible after reconcile", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await session.submitFeedback(async () => {});

		// Reconcile with a new message
		session.reconcile(
			[
				{ messageId: "m2", text: "Second response" },
				{ messageId: "m1", text: "First response" },
			],
			["m2", "m1"],
		);

		const snap = session.snapshot();
		expect(snap.sentAnnotationsByMessageId).toEqual({
			m1: [{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" }],
		});
	});

	test("sent annotations are immutable: replaceDrafts does not affect them", async () => {
		const session = sessionWith([
			{ messageId: "m1", text: "First response" },
		]);

		session.replaceDrafts("m1", [
			{ id: "a1", type: "COMMENT", originalText: "foo", text: "Edit this" },
		]);

		await session.submitFeedback(async () => {});

		// After delivery, the new round starts. Drafts are cleared.
		// Even if we try to replace drafts for m1, sent annotations stay.
		// Actually in the new round, we can add NEW drafts for m1 too.
		session.reconcile(
			[
				{ messageId: "m2", text: "Second response" },
				{ messageId: "m1", text: "First response" },
			],
			["m2", "m1"],
		);

		// Now we're in open status again. We can add new drafts.
		session.replaceDrafts("m1", [
			{ id: "b1", type: "COMMENT", originalText: "bar", text: "New comment" },
		]);

		const snap = session.snapshot();
		// Sent annotations for m1 still exist
		expect(snap.sentAnnotationsByMessageId.m1).toHaveLength(1);
		expect(snap.sentAnnotationsByMessageId.m1[0].id).toBe("a1");
		// New drafts are separate
		expect(snap.draftsByMessageId.m1).toHaveLength(1);
		expect(snap.draftsByMessageId.m1[0].id).toBe("b1");
	});
});

describe("Live Message Review Session snapshot", () => {
	test("keeps stable assistant response identities and selects the newest response", () => {
		const newestFirstMessages = [
			{ messageId: "new", text: "Newest response" },
			{ messageId: "old", text: "Older response" },
		];

		expect(createLiveMessageReviewSnapshot(newestFirstMessages)).toEqual({
			revision: 0,
			messages: [...newestFirstMessages].reverse(),
			retainedMessages: [],
			selectedMessageId: "new",
			unreadMessageIds: [],
			draftsByMessageId: {},
			codeDraftsByMessageId: {},
			attachmentsByMessageId: {},
			linkedDocDraftsByMessageId: {},
			sentAnnotationsByMessageId: {},
			sentCodeAnnotationsByMessageId: {},
			reviewRoundStatus: "open",
			deliveryError: null,
		});
	});

	test("caps the initial active-branch snapshot at the compact latest-four history", () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			messageId: String(index),
			text: `Response ${index}`,
		}));

		expect(createLiveMessageReviewSnapshot(messages).messages).toEqual(messages.slice(0, 4).reverse());
	});
});
