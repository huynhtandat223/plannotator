import { describe, expect, test } from "bun:test";
import { beginHerdrTool, clearHerdrTools, currentHerdrRegistration, endHerdrTool, HERDR_ACTIVITY_TRAIL_LIMIT, HERDR_LIVE_MESSAGE_LIMIT, pollHerdrFeedback, pollHerdrInstruction, releaseHerdrSession, reportHerdrSession, resetHerdrActivityTrail } from "./herdr-registration";

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

	test("retains only the newest responses allowed by the shared retention cap", () => {
		// Sized from the shared constant so raising retention cannot leave this
		// test asserting a stale window; the cap itself is asserted in
		// packages/core/live-message-window.test.ts.
		const total = HERDR_LIVE_MESSAGE_LIMIT + 2;
		const branch = Array.from({ length: total }, (_, index) => ({
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

		// Newest-first, exactly `HERDR_LIVE_MESSAGE_LIMIT` entries.
		const expected = Array.from(
			{ length: HERDR_LIVE_MESSAGE_LIMIT },
			(_, index) => `message-${total - index}`,
		);
		expect(registration?.messages.map((message) => message.messageId)).toEqual(expected);
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

	test("builds an ordered names-only activity trail, collapsing repeats", () => {
		const sessionManager = { getSessionId: () => "session-trail", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, model: { id: "cx/gpt-5.6-terra", contextWindow: 1_050_000 } } as never;
		resetHerdrActivityTrail(ctx);
		beginHerdrTool(ctx, "t1", "read");
		endHerdrTool(ctx, "t1");
		beginHerdrTool(ctx, "t2", "grep");
		endHerdrTool(ctx, "t2");
		beginHerdrTool(ctx, "t3", "grep");
		endHerdrTool(ctx, "t3");
		beginHerdrTool(ctx, "t4", "grep");
		beginHerdrTool(ctx, "t5", "subagent");
		const registration = currentHerdrRegistration(ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" });
		expect(registration?.activityTrail).toEqual([
			{ kind: "tool", name: "read", count: 1 },
			{ kind: "tool", name: "grep", count: 3 },
			{ kind: "subagent", name: "subagent", count: 1 },
		]);
		clearHerdrTools(ctx);
	});

	test("attaches a redacted command summary to bash tool entries only", () => {
		const sessionManager = { getSessionId: () => "session-cmd", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, model: { id: "cx/gpt-5.6-terra", contextWindow: 1_050_000 } } as never;
		resetHerdrActivityTrail(ctx);
		// A bash tool carries a redacted, single-line command; distinct commands do NOT collapse.
		beginHerdrTool(ctx, "t1", "bash", { command: "npm test" });
		endHerdrTool(ctx, "t1");
		beginHerdrTool(ctx, "t2", "bash", { command: "export API_KEY=sk_livesecretvalue123456" });
		endHerdrTool(ctx, "t2");
		// A non-bash tool stays names-only even if args happen to carry a command.
		beginHerdrTool(ctx, "t3", "read", { command: "cat secrets.env" });
		endHerdrTool(ctx, "t3");
		const trail = currentHerdrRegistration(ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" })?.activityTrail;
		expect(trail).toEqual([
			{ kind: "tool", name: "bash", count: 1, command: "npm test" },
			{ kind: "tool", name: "bash", count: 1, command: expect.stringContaining("‹redacted›") },
			{ kind: "tool", name: "read", count: 1 },
		]);
		// The raw secret never reaches the wire.
		expect(trail?.[1]?.command).not.toContain("sk_livesecretvalue123456");
		clearHerdrTools(ctx);
	});

	test("bounds the trail so long turns cannot blow up the SSE frame", () => {
		const sessionManager = { getSessionId: () => "session-bound", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, model: { id: "cx/gpt-5.6-terra", contextWindow: 1_050_000 } } as never;
		resetHerdrActivityTrail(ctx);
		// Distinct names so nothing collapses; exceed the cap by 5.
		const total = HERDR_ACTIVITY_TRAIL_LIMIT + 5;
		for (let i = 0; i < total; i += 1) {
			beginHerdrTool(ctx, `t${i}`, `tool-${i}`);
			endHerdrTool(ctx, `t${i}`);
		}
		const trail = currentHerdrRegistration(ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" })?.activityTrail;
		expect(trail).toHaveLength(HERDR_ACTIVITY_TRAIL_LIMIT);
		// The OLDEST entries are dropped: the trail keeps the most recent tools.
		expect(trail?.[trail.length - 1]).toEqual({ kind: "tool", name: `tool-${total - 1}`, count: 1 });
		expect(trail?.[0]).toEqual({ kind: "tool", name: `tool-${total - HERDR_ACTIVITY_TRAIL_LIMIT}`, count: 1 });
		clearHerdrTools(ctx);
	});

	test("resetHerdrActivityTrail starts a fresh trail per turn", () => {
		const sessionManager = { getSessionId: () => "session-reset", getEntries: () => [], getBranch: () => [] };
		const ctx = { sessionManager, model: { id: "cx/gpt-5.6-terra", contextWindow: 1_050_000 } } as never;
		beginHerdrTool(ctx, "t1", "read");
		endHerdrTool(ctx, "t1");
		resetHerdrActivityTrail(ctx);
		expect(currentHerdrRegistration(ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1" })?.activityTrail).toBeUndefined();
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
