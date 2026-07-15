import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import exPlannotatorPlan from "./plan-extension";
import type { PlanReviewServer } from "./plan-server";

function fakePi() {
	const commands: Array<{ options: { handler: (args: string, ctx: never) => Promise<void> } }> = [];
	const handlers = new Map<string, (...args: never[]) => unknown>();
	return {
		commands,
		handlers,
		api: {
			registerCommand(_name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) { commands.push({ options }); },
			on(name: string, handler: (...args: never[]) => unknown) { handlers.set(name, handler); },
			sendUserMessage() {},
		},
	};
}

function assistantBranch(id: string, text: string) {
	return [{ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }];
}

test("does not record response history from a new Pi session", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ex-plannotator-plan-extension-"));
	await mkdir(join(cwd, "plan"));
	try {
		const recorded: string[][] = [];
		const server: PlanReviewServer = {
			port: 1234,
			url: "http://127.0.0.1:1234",
			setFeedbackDelivery() {},
			setResumeAgent() {},
			setStopHandler() {},
			markAgentStarted() {},
			markAgentStopped() {},
			recordResponseHistory(messages) { recorded.push(messages.map((message) => message.messageId)); },
			hasNewResponse() { return false; },
			advanceRound() { return false; },
			stop() {},
		};
		const pi = fakePi();
		exPlannotatorPlan(pi.api as never, { startBrowser: async () => server });
		const contextA = {
			cwd,
			sessionManager: { getSessionId: () => "session-a", getBranch: () => assistantBranch("a", "Original") },
			ui: { notify() {} },
		};
		await pi.commands[0].options.handler("", contextA as never);

		const contextB = {
			cwd,
			sessionManager: { getSessionId: () => "session-b", getBranch: () => assistantBranch("b", "New conversation") },
			ui: { notify() {} },
		};
		pi.handlers.get("session_start")!({} as never, contextB as never);
		pi.handlers.get("message_end")!({ message: { role: "assistant" } } as never, contextB as never);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(recorded).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
