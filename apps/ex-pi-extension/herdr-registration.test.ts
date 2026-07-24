import { describe, expect, test } from "bun:test";
import { beginHerdrTool, currentHerdrRegistration, endHerdrTool, pollHerdrFeedback, pollHerdrInstruction, releaseHerdrSession, reportHerdrSession } from "./herdr-registration";

function context() {
	return {
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [],
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
			totalUsedTokens: 0,
		});
	});

	test("marks a settled failed turn without changing the normal registration", () => {
		const registration = currentHerdrRegistration(
			context() as never,
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" },
			[],
			true,
		);
		expect(registration?.agentSettled).toBe(true);
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
				getEntries: () => [],
				getBranch: () => branch,
			},
		} as never, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });

		expect(registration?.messages.map((message) => message.messageId)).toEqual([
			"message-7", "message-6", "message-5", "message-4", "message-3",
		]);
	});

	test("publishes context usage and the latest compaction token count", () => {
		const registration = currentHerdrRegistration({
			sessionManager: {
				getSessionId: () => "session-1",
				getEntries: () => [
					{ type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } },
				],
				getBranch: () => [
					{ type: "compaction", tokensBefore: 156_000 },
					{ id: "latest", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Latest response" }] } },
				],
			},
			getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000, percent: 42 }),
		} as never, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });

		expect(registration).toMatchObject({
			contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
			totalUsedTokens: 100,
			latestCompactionTokens: 156_000,
		});
	});

	test("preserves an unknown post-compaction context token count", () => {
		const registration = currentHerdrRegistration({
			sessionManager: { getSessionId: () => "session-1", getBranch: () => [], getEntries: () => [] },
			getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
		} as never, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });

		expect(registration?.contextUsage).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
	});

	test("falls back to a session model window and usage while Pi reloads", () => {
		const registration = currentHerdrRegistration({
			sessionManager: {
				getSessionId: () => "session-1",
				getBranch: () => [{ type: "message", message: { model: "cx/gpt-5.6-terra" } }],
				getEntries: () => [{ type: "message", message: { role: "assistant", usage: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 0 } } }],
			},
		} as never, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });

		expect(registration).toMatchObject({
			contextUsage: { tokens: null, contextWindow: 1_050_000, percent: null },
			totalUsedTokens: 6_200,
		});
	});

	test("reports current model and active subagent activity", () => {
		const sessionManager = {
			getSessionId: () => "session-activity",
			getEntries: () => [],
			getBranch: () => [],
		};
		const context = { sessionManager, model: { id: "cx/gpt-5.6-terra", provider: "9route", name: "9route GPT-5.6 Terra", contextWindow: 1_050_000 } } as never;
		beginHerdrTool(context, "tool-1", "subagent");
		expect(currentHerdrRegistration(context, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" })).toMatchObject({
			model: { id: "cx/gpt-5.6-terra", provider: "9route" },
			activity: { kind: "subagent", count: 1 },
		});
		endHerdrTool(context, "tool-1");
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
