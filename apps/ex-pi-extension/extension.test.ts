import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import exPlannotator, { EX_PLANNOTATOR_COMMAND } from "./index";
import type { LiveMessageReviewServer } from "./server";

function fakePi() {
	const commands: Array<{ name: string; options: { handler: (args: string, ctx: never) => Promise<void> } }> = [];
	const events: string[] = [];
	return {
		commands,
		events,
		api: {
			registerCommand(name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) {
				commands.push({ name, options });
			},
			registerFlag() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string) {
				events.push(name);
			},
			events: { on() {}, emit() {} },
		},
	};
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
		const server: LiveMessageReviewServer = { port: 1234, url: "http://127.0.0.1:1234", stop() {} };
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
			},
			ui: { notify: (message: string) => notices.push(message) },
		};

		await pi.commands[0].options.handler("", context as never);

		expect(opened).toEqual([{ messages: [{ messageId: "assistant", text: "Review me" }] }]);
		expect(notices[0]).toContain("Ex-Plannotator opened");
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
		expect(officialPackage.files).not.toContain("ex-plannotator.html");
		expect(exPackage.pi.extensions).toEqual(["./"]);
	});
});
