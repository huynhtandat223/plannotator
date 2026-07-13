import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { startLiveMessageReviewServer, type LiveMessageReviewServer } from "./server";
import type { LiveMessageReviewSnapshot, LiveFeedbackBatch } from "./session";

const servers: LiveMessageReviewServer[] = [];

function createSseSnapshotReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<LiveMessageReviewSnapshot> {
	const decoder = new TextDecoder();
	let received = "";
	return async () => {
		while (!received.includes("\n\n")) {
			const { value, done } = await reader.read();
			if (done) throw new Error("SSE stream ended before its next event.");
			received += decoder.decode(value, { stream: true });
		}
		const delimiter = received.indexOf("\n\n");
		const event = received.slice(0, delimiter);
		received = received.slice(delimiter + 2);
		const data = event.match(/^data: (.+)$/)?.[1];
		if (!data) throw new Error("SSE stream did not contain a data event.");
		return JSON.parse(data) as LiveMessageReviewSnapshot;
	};
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

describe("Live Message Review Session server", () => {
	test("serves the independent browser and a stable recent-message snapshot", async () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			messageId: `message-${index + 1}`,
			text: `Assistant response ${index + 1}`,
			timestamp: `2026-07-12T00:${String(index).padStart(2, "0")}:00.000Z`,
		}));
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages,
		});
		servers.push(server);

		const page = await fetch(server.url);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Ex-Plannotator");

		const response = await fetch(`${server.url}/api/session`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			messages: messages.slice(0, 25),
			selectedMessageId: "message-1",
			unreadMessageIds: [],
			draftsByMessageId: {},
			sentAnnotationsByMessageId: {},
			reviewRoundStatus: "open",
			deliveryError: null,
		});
	});

	test("serves the official annotate-last editor contract", async () => {
		const messages = [
			{ messageId: "newest", text: "Newest response", timestamp: "2026-07-13T00:00:00.000Z" },
			{ messageId: "older", text: "Older response" },
		];
		const server = await startLiveMessageReviewServer({ htmlContent: "<!doctype html>", messages });
		servers.push(server);

		const response = await fetch(`${server.url}/api/plan`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			mode: "annotate-last",
			plan: "Newest response",
			recentMessages: messages,
			selectedMessageId: "newest",
			origin: "pi",
			gate: false,
			sharingEnabled: false,
			liveMessageReview: true,
		});
	});

	test("keeps the official editor's initial selection aligned with a new live response", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html>",
			messages: [{ messageId: "initial", text: "Initial response" }],
		});
		servers.push(server);

		server.reconcile([
			{ messageId: "arrival", text: "New response" },
			{ messageId: "initial", text: "Initial response" },
		], ["arrival", "initial"]);

		const response = await fetch(`${server.url}/api/plan`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			plan: "New response",
			selectedMessageId: "arrival",
		});
	});

	test("maps official editor feedback to stable message batches", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html>",
			messages: [
				{ messageId: "m1", text: "First response" },
				{ messageId: "m2", text: "Second response" },
			],
		});
		servers.push(server);
		let delivered: LiveFeedbackBatch | undefined;
		server.setFeedbackDelivery((batch) => { delivered = batch; });

		const response = await fetch(`${server.url}/api/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				selectedMessageId: "m1",
				feedbackScope: "messages",
				annotations: [
					{ id: "a1", type: "COMMENT", originalText: "First", text: "Clarify" },
					{ id: "a2", messageId: "m2", type: "DELETION", originalText: "Second" },
				],
			}),
		});
		expect(response.status).toBe(200);
		expect(delivered?.messages).toEqual([
			{ messageId: "m1", messageText: "First response", annotations: [{ id: "a1", type: "COMMENT", originalText: "First", text: "Clarify" }] },
			{ messageId: "m2", messageText: "Second response", annotations: [{ id: "a2", messageId: "m2", type: "DELETION", originalText: "Second" }] },
		]);
		expect((await (await fetch(`${server.url}/api/session`)).json()) as LiveMessageReviewSnapshot).toMatchObject({
			reviewRoundStatus: "waiting",
			sentAnnotationsByMessageId: { m1: [{ id: "a1" }], m2: [{ id: "a2" }] },
		});
	});

	test("mirrors live responses idempotently and rehydrates focus, unread state, and drafts", async () => {
		const newest = { messageId: "newest", text: "Newest initial response" };
		const older = { messageId: "older", text: "Older initial response" };
		const arrival = { messageId: "arrival", text: "A completed response" };
		const draft = {
			id: "draft-1",
			blockId: "paragraph-1",
			startOffset: 0,
			endOffset: 5,
			type: "COMMENT",
			text: "Clarify this",
			originalText: "Older",
			createdA: 1,
		};
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [newest, older],
		});
		servers.push(server);

		await fetch(`${server.url}/api/session/selection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "older" }),
		});
		await fetch(`${server.url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "older", annotations: [draft] }),
		});

		server.reconcile([arrival, newest, older], ["arrival", "newest", "older"]);
		server.reconcile([arrival, newest, older], ["arrival", "newest", "older"]);

		const reconnected = await fetch(`${server.url}/api/session`);
		expect(await reconnected.json()).toEqual({
			messages: [arrival, newest, older],
			selectedMessageId: "older",
			unreadMessageIds: ["arrival"],
			draftsByMessageId: { older: [draft] },
			sentAnnotationsByMessageId: {},
			reviewRoundStatus: "open",
			deliveryError: null,
		});

		await fetch(`${server.url}/api/session/selection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "arrival" }),
		});
		expect(await (await fetch(`${server.url}/api/session`)).json()).toMatchObject({
			selectedMessageId: "arrival",
			unreadMessageIds: [],
		});
	});

	test("sends the current full snapshot as the first SSE event after reconnect", async () => {
		const newest = { messageId: "newest", text: "Newest initial response" };
		const older = { messageId: "older", text: "Older initial response" };
		const arrival = { messageId: "arrival", text: "A completed response" };
		const draft = {
			id: "draft-1",
			blockId: "paragraph-1",
			startOffset: 0,
			endOffset: 5,
			type: "COMMENT",
			text: "Clarify this",
			originalText: "Older",
			createdA: 1,
		};
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [newest, older],
		});
		servers.push(server);

		await fetch(`${server.url}/api/session/selection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "older" }),
		});
		await fetch(`${server.url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "older", annotations: [draft] }),
		});
		server.reconcile([arrival, newest, older], ["arrival", "newest", "older"]);

		const abort = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await fetch(`${server.url}/api/session/events`, { signal: abort.signal });
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			reader = response.body?.getReader();
			expect(reader).toBeDefined();
			const readSnapshot = createSseSnapshotReader(reader!);

			expect(await readSnapshot()).toEqual({
				messages: [arrival, newest, older],
				selectedMessageId: "older",
				unreadMessageIds: ["arrival"],
				draftsByMessageId: { older: [draft] },
				sentAnnotationsByMessageId: {},
				reviewRoundStatus: "open",
				deliveryError: null,
			});
		} finally {
			abort.abort();
			await reader?.cancel().catch(() => undefined);
		}
	});

	test("keeps focus and marks a completed response unread while the reviewer reads an older response", async () => {
		const newest = { messageId: "newest", text: "Newest initial response" };
		const older = { messageId: "older", text: "Older initial response" };
		const arrival = { messageId: "arrival", text: "A completed response" };
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [newest, older],
		});
		servers.push(server);

		await fetch(`${server.url}/api/session/selection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "older" }),
		});
		server.reconcile([arrival, newest, older], ["arrival", "newest", "older"]);

		expect(await (await fetch(`${server.url}/api/session`)).json()).toMatchObject({
			selectedMessageId: "older",
			unreadMessageIds: ["arrival"],
		});
	});

	test("auto-selects a completed response while the reviewer is passively waiting", async () => {
		const initial = { messageId: "initial", text: "Initial response" };
		const arrival = { messageId: "arrival", text: "A completed response" };
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [initial],
		});
		servers.push(server);

		server.reconcile([arrival, initial], ["arrival", "initial"]);

		expect(await (await fetch(`${server.url}/api/session`)).json()).toMatchObject({
			selectedMessageId: "arrival",
			unreadMessageIds: [],
		});
	});

	test("removes responses outside the active branch without dropping older active responses", async () => {
		const branchANewest = { messageId: "branch-a-newest", text: "Branch A newest" };
		const shared = { messageId: "shared", text: "Shared ancestor" };
		const oldActive = { messageId: "old-active", text: "Older active response" };
		const branchBNewest = { messageId: "branch-b-newest", text: "Branch B newest" };
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [branchANewest, shared, oldActive],
		});
		servers.push(server);

		server.reconcile(
			[branchBNewest, shared],
			["branch-b-newest", "shared", "old-active"],
		);

		expect(await (await fetch(`${server.url}/api/session`)).json()).toMatchObject({
			messages: [branchBNewest, shared, oldActive],
			selectedMessageId: "branch-b-newest",
		});
	});

	test("owns and releases its HTTP lifecycle", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "message-1", text: "Hello" }],
		});
		servers.push(server);
		const { url, port } = server;

		expect((await fetch(`${url}/api/session`)).status).toBe(200);
		server.stop();
		server.stop();
		servers.splice(servers.indexOf(server), 1);

		await expect(fetch(`${url}/api/session`)).rejects.toThrow();
		const replacement = await new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
			const listener = createServer();
			listener.once("error", reject);
			listener.listen(port, "127.0.0.1", () => resolve(listener));
		});
		await new Promise<void>((resolve) => replacement.close(() => resolve()));
	});

	test("browser disconnect leaves the in-memory session available for reconnect", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const abort = new AbortController();
		const response = await fetch(`${server.url}/api/session/events`, { signal: abort.signal });
		const reader = response.body?.getReader();
		await reader?.read();
		abort.abort();
		await reader?.cancel().catch(() => undefined);

		expect((await fetch(`${server.url}/api/session`)).status).toBe(200);
	});

	test("POST /api/session/close releases the browser server", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;
		expect((await fetch(`${url}/api/session/close`, { method: "POST" })).status).toBe(200);
		servers.splice(servers.indexOf(server), 1);
		await expect(fetch(`${url}/api/session`)).rejects.toThrow();
	});

	test("POST /api/session/feedback submits all drafts as a batch", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [
				{ messageId: "m1", text: "First response" },
				{ messageId: "m2", text: "Second response" },
			],
		});
		servers.push(server);
		const { url } = server;

		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", originalText: "First", text: "Fix this" }] }),
		});
		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m2", annotations: [{ id: "a2", type: "DELETION", originalText: "Second" }] }),
		});

		let deliveredBatch: LiveFeedbackBatch | null = null;
		server.setFeedbackDelivery(async (batch) => {
			deliveredBatch = batch;
		});

		const response = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(response.status).toBe(200);

		const snapshot = (await response.json()) as LiveMessageReviewSnapshot;
		expect(snapshot.reviewRoundStatus).toBe("waiting");
		expect(snapshot.draftsByMessageId).toEqual({});
		expect(snapshot.sentAnnotationsByMessageId).toHaveProperty("m1");
		expect(snapshot.sentAnnotationsByMessageId).toHaveProperty("m2");

		expect(deliveredBatch).not.toBeNull();
		expect(deliveredBatch!.messages).toHaveLength(2);
		expect(deliveredBatch!.messages[0].messageId).toBe("m1");
		expect(deliveredBatch!.messages[1].messageId).toBe("m2");
	});

	test("broadcasts a complete Review Round to an SSE client", async () => {
		const initial = [
			{ messageId: "m2", text: "Second response" },
			{ messageId: "m1", text: "First response" },
		];
		const responseAfterFeedback = { messageId: "m3", text: "Response after feedback" };
		const firstDraft = { id: "a1", type: "COMMENT", text: "Clarify this" };
		const secondDraft = { id: "a2", type: "DELETION", originalText: "Second" };
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: initial,
		});
		servers.push(server);
		const stream = await fetch(`${server.url}/api/session/events`);
		const reader = stream.body?.getReader();
		expect(reader).toBeDefined();
		const readSnapshot = createSseSnapshotReader(reader!);

		try {
			expect((await readSnapshot()).reviewRoundStatus).toBe("open");
			for (const [messageId, annotations] of [["m1", [firstDraft]], ["m2", [secondDraft]]] as const) {
				await fetch(`${server.url}/api/session/drafts`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ messageId, annotations }),
				});
				await readSnapshot();
			}
			let deliveredBatch: LiveFeedbackBatch | undefined;
			server.setFeedbackDelivery(async (batch) => { deliveredBatch = batch; });
			expect((await fetch(`${server.url}/api/session/feedback`, { method: "POST" })).status).toBe(200);
			await readSnapshot(); // submitting
			const waiting = await readSnapshot();
			expect(deliveredBatch?.messages.map((message) => message.messageId)).toEqual(["m2", "m1"]);
			expect(waiting).toMatchObject({
				reviewRoundStatus: "waiting",
				draftsByMessageId: {},
				sentAnnotationsByMessageId: { m1: [firstDraft], m2: [secondDraft] },
			});
			expect((await fetch(`${server.url}/api/session/drafts`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId: "m1", annotations: [{ id: "blocked" }] }),
			})).status).toBe(400);
			expect((await fetch(`${server.url}/api/session/feedback`, { method: "POST" })).status).toBe(409);

			server.reconcile([responseAfterFeedback, ...initial], ["m3", "m2", "m1"]);
			expect(await readSnapshot()).toMatchObject({
				reviewRoundStatus: "open",
				selectedMessageId: "m3",
				sentAnnotationsByMessageId: { m1: [firstDraft], m2: [secondDraft] },
			});
		} finally {
			await reader?.cancel().catch(() => undefined);
		}
	});

	test("completes a Review Round across the browser API", async () => {
		const initial = [
			{ messageId: "m2", text: "Second response" },
			{ messageId: "m1", text: "First response" },
		];
		const responseAfterFeedback = { messageId: "m3", text: "Response after feedback" };
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: initial,
		});
		servers.push(server);
		const { url } = server;

		const firstDraft = { id: "a1", type: "COMMENT", originalText: "First", text: "Clarify this" };
		const secondDraft = { id: "a2", type: "DELETION", originalText: "Second" };
		for (const [messageId, annotations] of [["m1", [firstDraft]], ["m2", [secondDraft]]] as const) {
			const response = await fetch(`${url}/api/session/drafts`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId, annotations }),
			});
			expect(response.status).toBe(200);
		}

		let deliveredBatch: LiveFeedbackBatch | undefined;
		server.setFeedbackDelivery(async (batch) => {
			deliveredBatch = batch;
		});
		expect((await fetch(`${url}/api/session/feedback`, { method: "POST" })).status).toBe(200);
		expect(deliveredBatch?.messages.map((message) => message.messageId)).toEqual(["m2", "m1"]);

		const waiting = await (await fetch(`${url}/api/session`)).json() as LiveMessageReviewSnapshot;
		expect(waiting).toMatchObject({
			reviewRoundStatus: "waiting",
			draftsByMessageId: {},
			sentAnnotationsByMessageId: { m1: [firstDraft], m2: [secondDraft] },
		});
		expect(
			(await fetch(`${url}/api/session/drafts`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a3", type: "COMMENT" }] }),
			})).status,
		).toBe(400);

		server.reconcile([responseAfterFeedback, ...initial], ["m3", "m2", "m1"]);
		const nextRound = await (await fetch(`${url}/api/session`)).json() as LiveMessageReviewSnapshot;
		expect(nextRound).toMatchObject({
			reviewRoundStatus: "open",
			selectedMessageId: "m3",
			sentAnnotationsByMessageId: { m1: [firstDraft], m2: [secondDraft] },
		});

		const unlocked = await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m3", annotations: [{ id: "a4", type: "COMMENT", text: "New round" }] }),
		});
		expect(unlocked.status).toBe(200);
		expect((await unlocked.json()) as LiveMessageReviewSnapshot).toMatchObject({
			draftsByMessageId: { m3: [{ id: "a4", type: "COMMENT", text: "New round" }] },
		});
	});

	test("recovers failed delivery through the retry endpoint without duplicate acceptance", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;
		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", text: "Fix" }] }),
		});

		server.setFeedbackDelivery(async () => { throw new Error("Pi unavailable"); });
		const failed = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(failed.status).toBe(502);
		expect(await failed.json()).toMatchObject({ error: "Feedback delivery failed: Pi unavailable" });
		expect(await (await fetch(`${url}/api/session`)).json()).toMatchObject({
			reviewRoundStatus: "delivery_failed",
			deliveryError: "Pi unavailable",
			draftsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Fix" }] },
		});

		let deliveries = 0;
		server.setFeedbackDelivery(async () => { deliveries += 1; });
		expect((await fetch(`${url}/api/session/feedback/retry`, { method: "POST" })).status).toBe(200);
		expect(deliveries).toBe(1);
		expect((await fetch(`${url}/api/session/feedback/retry`, { method: "POST" })).status).toBe(409);
		expect(deliveries).toBe(1);
	});

	test("resumes an accepted batch after its agent stops without resending feedback", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
			deliverFeedback: async () => {},
		});
		servers.push(server);
		const { url } = server;
		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", text: "Fix" }] }),
		});
		expect((await fetch(`${url}/api/session/feedback`, { method: "POST" })).status).toBe(200);
		server.markAgentStopped();
		expect(await (await fetch(`${url}/api/session`)).json()).toMatchObject({ reviewRoundStatus: "agent_stopped" });

		let resumes = 0;
		server.setResumeAgent(async () => { resumes += 1; });
		expect((await fetch(`${url}/api/session/resume`, { method: "POST" })).status).toBe(200);
		expect(resumes).toBe(1);
		expect(await (await fetch(`${url}/api/session`)).json()).toMatchObject({
			reviewRoundStatus: "waiting",
			sentAnnotationsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Fix" }] },
		});
	});

	test("cancels waiting without reverting sent annotations", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
			deliverFeedback: async () => {},
		});
		servers.push(server);
		const { url } = server;
		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", text: "Sent" }] }),
		});
		await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect((await fetch(`${url}/api/session/cancel-waiting`, { method: "POST" })).status).toBe(200);
		expect(await (await fetch(`${url}/api/session`)).json()).toMatchObject({
			reviewRoundStatus: "open",
			draftsByMessageId: {},
			sentAnnotationsByMessageId: { m1: [{ id: "a1", type: "COMMENT", text: "Sent" }] },
		});
	});

	test("POST /api/session/feedback returns 409 when no drafts exist", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;

		server.setFeedbackDelivery(async () => {});

		const response = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(response.status).toBe(409);
	});

	test("POST /api/session/feedback returns 502 when delivery callback is unavailable", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;

		// deliberately do NOT set a delivery callback

		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", originalText: "Foo", text: "Edit" }] }),
		});

		const response = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(response.status).toBe(502);
	});

	test("POST /api/session/feedback returns 502 when delivery callback throws", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;

		server.setFeedbackDelivery(async () => {
			throw new Error("Delivery simulation failure");
		});

		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", originalText: "Foo", text: "Edit" }] }),
		});

		const response = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(response.status).toBe(502);

		// Failed delivery preserves drafts and exposes a distinct retryable state.
		const snap = await (await fetch(`${url}/api/session`)).json() as LiveMessageReviewSnapshot;
		expect(snap.reviewRoundStatus).toBe("delivery_failed");
		expect(snap.draftsByMessageId).toHaveProperty("m1");
	});

	test("POST /api/session/feedback returns 409 when already waiting", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;

		server.setFeedbackDelivery(async () => {});

		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", originalText: "Foo", text: "Edit" }] }),
		});

		// First submit succeeds
		const first = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(first.status).toBe(200);

		// Second submit while waiting should be 409
		const second = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(second.status).toBe(409);
	});

	test("setFeedbackDelivery replaces the delivery callback at runtime", async () => {
		const server = await startLiveMessageReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator</title>",
			messages: [{ messageId: "m1", text: "First response" }],
		});
		servers.push(server);
		const { url } = server;

		let deliveries: string[] = [];
		server.setFeedbackDelivery(async () => { deliveries.push("first"); });
		server.setFeedbackDelivery(async () => { deliveries.push("second"); });

		await fetch(`${url}/api/session/drafts`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messageId: "m1", annotations: [{ id: "a1", type: "COMMENT", originalText: "Foo", text: "Edit" }] }),
		});

		const response = await fetch(`${url}/api/session/feedback`, { method: "POST" });
		expect(response.status).toBe(200);
		expect(deliveries).toEqual(["second"]);
	});
});
