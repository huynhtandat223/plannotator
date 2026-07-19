import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import exPlannotator, { EX_PLANNOTATOR_COMMAND } from "./index";
import { getRecentAssistantMessages } from "./assistant-message";
import type { LiveMessageReviewServer } from "./server";

function fakePi() {
	const commands: Array<{ name: string; options: { handler: (args: string, ctx: never) => Promise<void> } }> = [];
	const events: string[] = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const sentUserMessages: string[] = [];
	return {
		commands,
		events,
		handlers,
		sentUserMessages,
		api: {
			registerCommand(name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) {
				commands.push({ name, options });
			},
			registerFlag() {},
			registerShortcut() {},
			registerTool() {},
			sendUserMessage(content: string) {
				sentUserMessages.push(content);
			},
			getCommands() { return []; },
			on(name: string, handler: (...args: never[]) => unknown) {
				events.push(name);
				handlers.set(name, handler);
			},
			events: { on() {}, emit() {} },
		},
	};
}

function waitForDeferredReconciliation(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("Ex-Plannotator package surface", () => {
	test("registers only the independent ex-plannotator-last command", () => {
		const pi = fakePi();
		exPlannotator(pi.api as never);

		expect(EX_PLANNOTATOR_COMMAND).toBe("ex-plannotator-last");
		expect(pi.commands.map((command) => command.name)).toEqual(["ex-plannotator-last"]);
	});

	test("opens the active branch snapshot through its command handler", async () => {
		const opened: Array<{ messages: Array<{ messageId: string; text: string }> }> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery() {},
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, {
			startBrowser: async (_ctx, messages) => {
				opened.push({ messages });
				return server;
			},
		});
		const notices: string[] = [];
		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					{ id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Review me" }] } },
					{ id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "Question" }] } },
				],
				getSessionId: () => "test-session",
			},
			ui: { notify: (message: string) => notices.push(message) },
		};

		await pi.commands[0].options.handler("", context as never);

		expect(opened).toEqual([{ messages: [{ messageId: "assistant", text: "Review me" }] }]);
		expect(notices[0]).toContain("Ex-Plannotator opened");

		// Verify delivery callback was wired
		expect(pi.sentUserMessages).toEqual([]);
	});

	test("automatically publishes the latest assistant response for its Herdr pane", async () => {
		const reports: Array<Array<{ messageId: string; text: string }>> = [];
		let releases = 0;
		const pi = fakePi();
		exPlannotator(pi.api as never, {
			startBrowser: async () => { throw new Error("not used"); },
			reportHerdr: async (ctx) => {
				reports.push(getRecentAssistantMessages(ctx as never, 1));
			},
			releaseHerdr: async () => { releases += 1; },
		});
		const branch: Array<Record<string, unknown>> = [
			{ id: "first", type: "message", message: { role: "assistant", content: [{ type: "text", text: "First" }] } },
		];
		const context = {
			sessionManager: { getBranch: () => branch, getSessionId: () => "session-a" },
			ui: { notify() {} },
		};

		await pi.handlers.get("session_start")!({} as never, context as never);
		expect(reports.at(-1)).toEqual([{ messageId: "first", text: "First" }]);
		const reportsAfterSessionStart = reports.length;
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(reports.length).toBeGreaterThan(reportsAfterSessionStart);

		branch.push({ id: "latest", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Latest" }] } });
		pi.handlers.get("message_end")!({ message: { role: "assistant", content: [] } } as never, context as never);
		await waitForDeferredReconciliation();
		expect(reports.at(-1)).toEqual([{ messageId: "latest", text: "Latest" }]);

		const reportCountBeforeAgentLifecycle = reports.length;
		pi.handlers.get("agent_start")!({} as never, context as never);
		pi.handlers.get("agent_end")!({} as never, context as never);
		await Promise.resolve();
		expect(reports).toHaveLength(reportCountBeforeAgentLifecycle + 2);

		await pi.handlers.get("session_shutdown")!({} as never, context as never);
		expect(releases).toBe(1);
	});

	test("reconciles only finalized assistant events against stable active-branch identities", async () => {
		const reconciliations: Array<{
			messages: Array<{ messageId: string; text: string }>;
			activeBranchMessageIds: string[];
		}> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile: (messages, activeBranchMessageIds) => {
				reconciliations.push({ messages, activeBranchMessageIds });
			},
			setFeedbackDelivery() {},
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, { startBrowser: async () => server });
		const branch: Array<Record<string, unknown>> = [
			{ id: "initial", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Initial" }] } },
		];
		const context = {
			hasUI: true,
			sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
			ui: { notify() {} },
		};
		await pi.commands[0].options.handler("", context as never);
		const onMessageEnd = pi.handlers.get("message_end")!;

		onMessageEnd({ message: { role: "user", content: "Question" } } as never, context as never);
		onMessageEnd({ message: { role: "toolResult", content: [] } } as never, context as never);
		expect(reconciliations).toEqual([]);

		onMessageEnd({
			message: { role: "assistant", content: [{ type: "text", text: "Final response" }] },
		} as never, context as never);
		branch.push({
			id: "stable-entry-id",
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "Final response" }] },
		});
		await waitForDeferredReconciliation();

		expect(reconciliations).toEqual([{
			messages: [
				{ messageId: "stable-entry-id", text: "Final response" },
				{ messageId: "initial", text: "Initial" },
			],
			activeBranchMessageIds: ["stable-entry-id", "initial"],
		}]);

		onMessageEnd({
			message: { role: "assistant", content: [{ type: "text", text: "Outside branch" }] },
		} as never, context as never);
		await waitForDeferredReconciliation();
		expect(reconciliations.at(-1)?.messages.some((message) => message.text === "Outside branch")).toBe(false);
	});

	test("coexists with Official Plannotator without command collisions", async () => {
		const pi = fakePi();
		const { default: officialPlannotator } = await import("../pi-extension/index");
		officialPlannotator(pi.api as never);
		exPlannotator(pi.api as never);

		const commandNames = pi.commands.map((command) => command.name);
		expect(commandNames).toContain("plannotator-last");
		expect(commandNames).toContain("ex-plannotator-last");
		expect(new Set(commandNames).size).toBe(commandNames.length);
	});

	test("has a distinct package identity and browser asset from Official Plannotator", () => {
		const exPackage = JSON.parse(readFileSync(resolve(import.meta.dir, "package.json"), "utf8"));
		const officialPackage = JSON.parse(readFileSync(resolve(import.meta.dir, "../pi-extension/package.json"), "utf8"));

		expect(exPackage.name).toBe("@huynhtandat223/ex-plannotator-pi-extension");
		expect(exPackage.name).not.toBe(officialPackage.name);
		expect(exPackage.files).toContain("ex-plannotator.html");
		expect(exPackage.files).toContain("ex-plannotator-plan.html");
		expect(officialPackage.files).not.toContain("ex-plannotator.html");
		expect(exPackage.pi.extensions).toEqual(["./", "./plan-extension.ts"]);
	});

	test("wires and invokes the feedback delivery callback with session identity check", async () => {
		const deliveryCallbacks: Array<(batch: unknown) => Promise<void>> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery(callback) {
				deliveryCallbacks.push(callback as (batch: unknown) => Promise<void>);
			},
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, {
			startBrowser: async () => server,
		});

		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					{ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Review me" }] } },
				],
				getSessionId: () => "test-session",
			},
			ui: { notify() {} },
		};

		await pi.commands[0].options.handler("", context as never);
		expect(deliveryCallbacks).toHaveLength(1);

		// Simulate a message_end to keep currentPiSessionId current
		const onMessageEnd = pi.handlers.get("message_end")!;
		onMessageEnd(
			{ message: { role: "assistant", content: [{ type: "text", text: "New" }] } } as never,
			context as never,
		);

		// Deliver feedback
		const batch = {
			batchId: "batch-1",
			messages: [{
				messageId: "m1",
				messageText: "Review me",
				annotations: [{ id: "a1", type: "COMMENT", originalText: "Review me", text: "Fix this part" }],
			}],
		};
		await deliveryCallbacks[0](batch);

		// Verify sendUserMessage was called with formatted batch
		expect(pi.sentUserMessages).toHaveLength(1);
		expect(pi.sentUserMessages[0]).toContain("batch-1");
		expect(pi.sentUserMessages[0]).toContain("m1");
		expect(pi.sentUserMessages[0]).toContain("Fix this part");
		expect(pi.sentUserMessages[0]).toContain("Please address the annotation feedback above.");
	});

	test("delivery callback rejects after a session switch before message_end", async () => {
		const deliveryCallbacks: Array<(batch: unknown) => Promise<void>> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery(callback) {
				deliveryCallbacks.push(callback as (batch: unknown) => Promise<void>);
			},
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, {
			startBrowser: async () => server,
		});

		const contextA = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [{ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }],
				getSessionId: () => "session-a",
			},
			ui: { notify() {} },
		};

		await pi.commands[0].options.handler("", contextA as never);
		expect(deliveryCallbacks).toHaveLength(1);

		// Switch sessions without a message_end event from the new session.
		const contextB = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [{ id: "m2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Bye" }] } }],
				getSessionId: () => "session-b",
			},
			ui: { notify() {} },
		};
		pi.handlers.get("session_start")!({} as never, contextB as never);

		// Delivery must fail because the active session is now session-b, not session-a.
		const batch = {
			batchId: "batch-1",
			messages: [{
				messageId: "m1",
				messageText: "Hi",
				annotations: [{ id: "a1", type: "COMMENT", originalText: "Hi", text: "Edit" }],
			}],
		};
		await expect(deliveryCallbacks[0](batch)).rejects.toThrow("Pi conversation has changed");
		expect(pi.sentUserMessages).toHaveLength(0);
	});

	test("forwards stopped-agent recovery to Resume without re-delivering feedback", async () => {
		const resumeCallbacks: Array<() => Promise<void>> = [];
		const events: string[] = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery() {},
			setResumeAgent(callback) { resumeCallbacks.push(callback); },
			setStopHandler() {},
			markAgentStarted() { events.push("started"); },
			markAgentStopped() { events.push("stopped"); },
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, { startBrowser: async () => server });
		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [{ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }],
				getSessionId: () => "session-a",
			},
			ui: { notify() {} },
		};

		await pi.commands[0].options.handler("", context as never);
		pi.handlers.get("agent_start")!({} as never, context as never);
		pi.handlers.get("agent_end")!({} as never, context as never);
		await resumeCallbacks[0]();

		expect(events).toEqual(["started", "stopped"]);
		expect(pi.sentUserMessages).toEqual(["Continue addressing the previously accepted annotation feedback."]);
	});

	test("session shutdown and browser close clear the active server without re-stopping it", async () => {
		let stopped = 0;
		let closeHandler: (() => void) | undefined;
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery() {},
			setResumeAgent() {},
			setStopHandler(handler) { closeHandler = handler; },
			markAgentStarted() {},
			markAgentStopped() {},
			stop() { stopped += 1; },
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, { startBrowser: async () => server });
		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [{ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }],
				getSessionId: () => "session-a",
			},
			ui: { notify() {} },
		};

		await pi.commands[0].options.handler("", context as never);
		closeHandler?.();
		pi.handlers.get("session_shutdown")!({} as never, context as never);
		expect(stopped).toBe(0);
	});

	test("session_shutdown clears session identity tracking", async () => {
		const deliveryCallbacks: Array<(batch: unknown) => Promise<void>> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery(callback) {
				deliveryCallbacks.push(callback as (batch: unknown) => Promise<void>);
			},
			stop() {},
		};
		const pi = fakePi();
		exPlannotator(pi.api as never, {
			startBrowser: async () => server,
		});

		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [{ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }],
				getSessionId: () => "session-a",
			},
			ui: { notify() {} },
		};

		await pi.commands[0].options.handler("", context as never);

		// Fire session_shutdown
		const onShutdown = pi.handlers.get("session_shutdown")!;
		onShutdown({} as never, context as never);

		// Delivery should fail because session was cleared
		const batch = {
			batchId: "batch-1",
			messages: [],
		};
		await expect(deliveryCallbacks[0](batch)).rejects.toThrow("Pi conversation has changed");
		expect(pi.sentUserMessages).toHaveLength(0);
	});
});
