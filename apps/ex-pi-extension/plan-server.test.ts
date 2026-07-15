import { afterEach, describe, expect, test } from "bun:test";
import { startPlanReviewServer, type PlanReviewServer } from "./plan-server";

const servers: PlanReviewServer[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

describe("Plan review server", () => {
	test("serves the rich editor bootstrap with its explicit Plan capability", async () => {
		const messages = [{ messageId: "m1", text: "Review this response" }];
		const server = await startPlanReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator Plan</title>",
			messages,
			files: [{ path: "design.md", supported: true }],
			readFile: async () => ({ path: "design.md", supported: true, content: "# Design", contentHash: "hash-1" }),
		});
		servers.push(server);

		const response = await fetch(`http://127.0.0.1:${server.port}/api/plan`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			mode: "annotate-last",
			plan: "Review this response",
			recentMessages: messages,
			selectedMessageId: "m1",
			origin: "pi",
			gate: false,
			sharingEnabled: false,
			planReview: {
				sourceMode: "mixed",
				snapshot: {
					messages,
					files: [{ path: "design.md", supported: true }],
					selected: { kind: "message", messageId: "m1" },
					fileSnapshots: {},
					draftsByMessageId: {},
					sentAnnotationsByMessageId: {},
					responseHistory: messages,
					sentMessageSnapshots: {},
					draftsByFileSnapshot: {},
					sentAnnotationsByFileSnapshot: {},
					sentFileSnapshots: {},
					reviewRoundStatus: "open",
					deliveryError: null,
				},
			},
		});
	});

	test("keeps four chronological response-history entries across unannotated round transitions", async () => {
		const initialMessages = Array.from({ length: 4 }, (_, index) => ({
			messageId: `m${4 - index}`,
			text: `Response ${4 - index}`,
		}));
		const server = await startPlanReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator Plan</title>",
			messages: initialMessages,
			files: [],
			readFile: async () => { throw new Error("No file should be read"); },
		});
		servers.push(server);

		server.recordResponseHistory([
			{ messageId: "m5", text: "Response 5" },
			...initialMessages,
		]);
		server.recordResponseHistory([
			{ messageId: "m6", text: "Response 6" },
			{ messageId: "m5", text: "Response 5" },
			...initialMessages,
		]);

		const snapshot = await (await fetch(`http://127.0.0.1:${server.port}/api/session`)).json() as {
			responseHistory: Array<{ messageId: string }>;
		};
		expect(snapshot.responseHistory.map((message) => message.messageId)).toEqual(["m3", "m4", "m5", "m6"]);
		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/selection`, {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "message", messageId: "m5" }),
		})).status).toBe(200);
		const plan = await (await fetch(`http://127.0.0.1:${server.port}/api/plan`)).json() as { plan: string };
		expect(plan.plan).toBe("Response 5");
	});

	test("aggregates message and file drafts, preserves sent snapshots, and keeps sent annotations immutable", async () => {
		const server = await startPlanReviewServer({
			htmlContent: "<!doctype html><title>Ex-Plannotator Plan</title>",
			messages: [{ messageId: "m1", text: "Message source" }],
			files: [{ path: "design.md", supported: true }],
			readFile: async () => ({ path: "design.md", supported: true, content: "# Design", contentHash: "hash-1" }),
		});
		servers.push(server);
		const annotation = { id: "a1", type: "COMMENT", originalText: "source", text: "Clarify" };

		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/drafts`, {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "message", messageId: "m1", annotations: [annotation] }),
		})).status).toBe(200);
		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/selection`, {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "file", path: "design.md" }),
		})).status).toBe(200);
		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/drafts`, {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "file", path: "design.md", contentHash: "hash-1", annotations: [{ ...annotation, id: "a2" }] }),
		})).status).toBe(200);

		let delivered: unknown;
		server.setFeedbackDelivery(async (batch) => { delivered = batch; });
		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/feedback`, { method: "POST" })).status).toBe(200);
		expect(delivered).toMatchObject({ messages: [{ messageId: "m1", annotations: [annotation] }], files: [{ path: "design.md", contentHash: "hash-1", annotations: [{ id: "a2" }] }] });

		const sent = await (await fetch(`http://127.0.0.1:${server.port}/api/session`)).json();
		expect(sent).toMatchObject({
			reviewRoundStatus: "waiting",
			draftsByMessageId: {},
			draftsByFileSnapshot: {},
			sentAnnotationsByMessageId: { m1: [annotation] },
			sentAnnotationsByFileSnapshot: { ["design.md\u0000hash-1"]: [{ id: "a2" }] },
			sentFileSnapshots: { ["design.md\u0000hash-1"]: { content: "# Design", contentHash: "hash-1" } },
		});
		expect((await fetch(`http://127.0.0.1:${server.port}/api/session/drafts`, {
			method: "PUT", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "file", path: "design.md", contentHash: "hash-1", annotations: [] }),
		})).status).toBe(400);
	});
});
