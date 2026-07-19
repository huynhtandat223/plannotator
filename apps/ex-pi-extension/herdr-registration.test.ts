import { describe, expect, test } from "bun:test";
import { currentHerdrRegistration, pollHerdrFeedback, pollHerdrInstruction, releaseHerdrSession, reportHerdrSession } from "./herdr-registration";

function context() {
	return {
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [
				{ id: "older", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Older response" }] } },
				{ id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "Question" }] } },
				{ id: "latest", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Latest response" }] } },
			],
		},
	};
}

describe("Herdr session enrichment", () => {
	test("reports the same latest structured assistant response as ex-plannotator-last", () => {
		expect(currentHerdrRegistration(context() as never, {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w:p1",
		})).toEqual({
			paneId: "w:p1",
			sessionId: "session-1",
			messages: [
				{ messageId: "latest", text: "Latest response" },
				{ messageId: "older", text: "Older response" },
			],
			commands: [],
		});
	});

	test("retains only the newest five structured assistant responses", () => {
		const branch = Array.from({ length: 7 }, (_, index) => ({
			id: `message-${index + 1}`,
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: `Response ${index + 1}` }] },
		}));
		const registration = currentHerdrRegistration({
			sessionManager: {
				getSessionId: () => "session-1",
				getBranch: () => branch,
			},
		} as never, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });

		expect(registration?.messages.map((message) => message.messageId)).toEqual([
			"message-7", "message-6", "message-5", "message-4", "message-3",
		]);
	});

	test("does nothing outside a Herdr pane", () => {
		expect(currentHerdrRegistration(context() as never, {})).toBeNull();
	});

	test("marks a nested Pi subagent so the host can reject its registration", () => {
		expect(currentHerdrRegistration(context() as never, {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w:p1",
			PI_SUBAGENT_CHILD: "1",
		})).toMatchObject({
			paneId: "w:p1",
			sessionId: "session-1",
			isSubagent: true,
		});
	});

	test("does not report or claim delivery from a nested Pi subagent", async () => {
		let reported = false;
		let claimed = false;
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1", PI_SUBAGENT_CHILD: "1" };
		await reportHerdrSession(context() as never, async () => {
			reported = true;
			return new Response(null, { status: 204 });
		}, env);
		await pollHerdrFeedback(context() as never, () => {}, async () => {
			claimed = true;
			return new Response(null, { status: 204 });
		}, env);
		await pollHerdrInstruction(context() as never, () => {}, async () => {
			claimed = true;
			return new Response(null, { status: 204 });
		}, env);
		expect(reported).toBe(false);
		expect(claimed).toBe(false);
	});

	test("sends enrichment only to the loopback host endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		await reportHerdrSession(
			context() as never,
			async (input, init) => {
				calls.push({ url: String(input), init });
				return new Response(null, { status: 204 });
			},
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" },
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:19432/api/panel-session");
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			paneId: "w:p1",
			sessionId: "session-1",
			messages: [
				{ messageId: "latest", text: "Latest response" },
				{ messageId: "older", text: "Older response" },
			],
		});
	});

	test("delivers a claimed host feedback batch through the existing Pi feedback formatter", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const delivered: string[] = [];
		await pollHerdrFeedback(
			context() as never,
			(content) => delivered.push(content),
			async (input, init) => {
				calls.push({ url: String(input), init });
				return new Response(JSON.stringify({
					deliveryId: "delivery-1",
					batch: {
						batchId: "batch-1",
						messages: [{
							messageId: "latest",
							messageText: "Latest response",
							annotations: [{ id: "annotation-1", type: "COMMENT", originalText: "Latest", text: "Improve it" }],
							codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
						}],
					},
				}), { status: 200 });
			},
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" },
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:19432/api/panel-feedback/claim");
		expect(delivered[0]).toContain("Feedback Batch: `batch-1`");
		expect(delivered[0]).toContain("Improve it");
		expect(delivered[0]).toContain("Use a safer boundary.");
	});

	test("publishes only explicit command capabilities for the current Pi session", () => {
		const registration = currentHerdrRegistration(context() as never, {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w:p1",
		}, [
			{ name: "handoff-to-continue", description: "Write a handoff", source: "extension" },
			{ name: "handoff-to-continue", description: "duplicate", source: "extension" },
		]);
		expect(registration?.commands).toEqual([{ name: "handoff-to-continue", description: "Write a handoff", source: "extension" }]);
	});

	test("delivers a claimed browser instruction as an unformatted Pi user message", async () => {
		const delivered: string[] = [];
		await pollHerdrInstruction(
			context() as never,
			(content) => delivered.push(content),
			async () => new Response(JSON.stringify({
				deliveryId: "instruction-1",
				content: "Start by checking the logs.",
			}), { status: 200 }),
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" },
		);

		expect(delivered).toEqual(["Start by checking the logs."]);
	});

	test("releases only the registration belonging to the shutting-down Pi session", async () => {
		const calls: string[] = [];
		await releaseHerdrSession(
			context() as never,
			async (input) => {
				calls.push(String(input));
				return new Response(null, { status: 204 });
			},
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" },
		);

		expect(calls).toEqual(["http://127.0.0.1:19432/api/panel-session?paneId=w%3Ap1&sessionId=session-1"]);
	});

	test("never publishes structured messages to a non-loopback URL", async () => {
		let called = false;
		await reportHerdrSession(
			context() as never,
			async () => {
				called = true;
				return new Response(null, { status: 204 });
			},
			{
				HERDR_ENV: "1",
				HERDR_PANE_ID: "w:p1",
				EX_PLANNOTATOR_HERDR_SERVICE_URL: "http://192.0.2.1:19432",
			},
		);
		expect(called).toBe(false);
	});
});
