import { afterEach, describe, expect, test } from "bun:test";
import { startLiveMessageReviewServer, type LiveMessageReviewServer } from "./server";
import type { LiveMessageReviewSnapshot } from "./session";

const servers: LiveMessageReviewServer[] = [];

async function readFirstSseSnapshot(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<LiveMessageReviewSnapshot> {
	const decoder = new TextDecoder();
	let received = "";
	while (!received.includes("\n\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error("SSE stream ended before its first event.");
		received += decoder.decode(value, { stream: true });
	}
	const firstData = received.slice(0, received.indexOf("\n\n")).match(/^data: (.+)$/)?.[1];
	if (!firstData) throw new Error("SSE stream did not start with a data event.");
	return JSON.parse(firstData) as LiveMessageReviewSnapshot;
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

			expect(await readFirstSseSnapshot(reader!)).toEqual({
				messages: [arrival, newest, older],
				selectedMessageId: "older",
				unreadMessageIds: ["arrival"],
				draftsByMessageId: { older: [draft] },
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
		const { url } = server;

		expect((await fetch(`${url}/api/session`)).status).toBe(200);
		server.stop();
		servers.splice(servers.indexOf(server), 1);

		await expect(fetch(`${url}/api/session`)).rejects.toThrow();
	});
});
