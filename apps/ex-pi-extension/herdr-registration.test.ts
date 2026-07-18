import { describe, expect, test } from "bun:test";
import { currentHerdrRegistration, releaseHerdrSession, reportHerdrSession } from "./herdr-registration";

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
			messages: [{ messageId: "latest", text: "Latest response" }],
		});
	});

	test("does nothing outside a Herdr pane", () => {
		expect(currentHerdrRegistration(context() as never, {})).toBeNull();
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
			messages: [{ messageId: "latest", text: "Latest response" }],
		});
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
