import { describe, expect, test } from "bun:test";
import exPlannotatorThinking from "./thinking-extension";
import { EX_PLANNOTATOR_THINKING_COMMAND } from "./herdr-registration";
import type { LiveMessageReviewServer } from "./server";

function fakePi() {
	const commands: Array<{ name: string; options: { handler: (args: string, ctx: never) => Promise<void> } }> = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	const sentUserMessages: string[] = [];
	return {
		commands,
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
				handlers.set(name, handler);
			},
			events: { on() {}, emit() {} },
		},
	};
}

function waitForDeferredReconciliation(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("Ex-Plannotator thinking command", () => {
	test("registers the thinking review command", () => {
		const pi = fakePi();
		exPlannotatorThinking(pi.api as never);

		expect(EX_PLANNOTATOR_THINKING_COMMAND).toBe("ex-plannotator-thinking");
		expect(pi.commands.map((command) => command.name)).toEqual([EX_PLANNOTATOR_THINKING_COMMAND]);
	});

	test("opens a persistent review pane over the assistant thinking blocks", async () => {
		const opened: Array<{ messages: Array<{ messageId: string; text: string }> }> = [];
		const server: LiveMessageReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			reconcile() {},
			setFeedbackDelivery() {},
			stop() {},
		};
		const pi = fakePi();
		exPlannotatorThinking(pi.api as never, {
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
					{ id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "Reasoning" }, { type: "text", text: "Final" }] } },
				],
				getSessionId: () => "test-session",
			},
			ui: { notify: (message: string) => notices.push(message) },
		};

		await pi.commands.find((command) => command.name === EX_PLANNOTATOR_THINKING_COMMAND)!.options.handler("", context as never);

		expect(opened).toEqual([{ messages: [{ messageId: "assistant", text: "Reasoning" }] }]);
		expect(notices[0]).toContain("Ex-Plannotator thinking opened");
	});

	test("notifies when the active branch has no thinking content", async () => {
		const pi = fakePi();
		exPlannotatorThinking(pi.api as never, {
			startBrowser: async () => { throw new Error("not used"); },
		});
		const notices: Array<{ message: string; level: string }> = [];
		const context = {
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					{ id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Only final text" }] } },
				],
				getSessionId: () => "test-session",
			},
			ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		};

		await pi.commands.find((command) => command.name === EX_PLANNOTATOR_THINKING_COMMAND)!.options.handler("", context as never);

		expect(notices).toEqual([{ message: "No assistant thinking found in the active Pi branch.", level: "error" }]);
	});

	test("reconciles finalized assistant events against the thinking snapshot", async () => {
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
		exPlannotatorThinking(pi.api as never, { startBrowser: async () => server });
		const branch: Array<Record<string, unknown>> = [
			{ id: "initial", type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "Initial reasoning" }] } },
		];
		const context = {
			hasUI: true,
			sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
			ui: { notify() {} },
		};
		await pi.commands.find((command) => command.name === EX_PLANNOTATOR_THINKING_COMMAND)!.options.handler("", context as never);
		const onMessageEnd = pi.handlers.get("message_end")!;

		onMessageEnd({ message: { role: "user", content: "Question" } } as never, context as never);
		expect(reconciliations).toEqual([]);

		branch.push({
			id: "next-thinking",
			type: "message",
			message: { role: "assistant", content: [{ type: "thinking", text: "Next reasoning" }, { type: "text", text: "Answer" }] },
		});
		onMessageEnd({ message: { role: "assistant", content: [] } } as never, context as never);
		await waitForDeferredReconciliation();

		expect(reconciliations).toEqual([{
			messages: [
				{ messageId: "next-thinking", text: "Next reasoning" },
				{ messageId: "initial", text: "Initial reasoning" },
			],
			activeBranchMessageIds: ["next-thinking", "initial"],
		}]);
	});
});
