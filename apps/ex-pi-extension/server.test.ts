import { afterEach, describe, expect, test } from "bun:test";
import { startLiveMessageReviewServer, type LiveMessageReviewServer } from "./server";

const servers: LiveMessageReviewServer[] = [];

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
