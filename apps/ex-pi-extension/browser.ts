import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startLiveMessageReviewServer, type LiveMessageReviewServer } from "./server.js";
import type { LiveAssistantMessage } from "./session.js";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const browserAssetPath = resolve(extensionDirectory, "ex-plannotator.html");

export function hasExPlannotatorBrowserAsset(): boolean {
	return existsSync(browserAssetPath);
}

export async function startLiveMessageReviewBrowser(
	ctx: ExtensionContext,
	messages: LiveAssistantMessage[],
): Promise<LiveMessageReviewServer> {
	if (!ctx.hasUI) throw new Error("Ex-Plannotator requires an interactive Pi session.");
	if (!hasExPlannotatorBrowserAsset()) {
		throw new Error("Ex-Plannotator browser asset is missing. Run the Ex-Plannotator build first.");
	}
	const server = await startLiveMessageReviewServer({
		htmlContent: readFileSync(browserAssetPath, "utf8"),
		messages,
	});
	await openBrowser(server.url);
	return server;
}

async function openBrowser(url: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	const { release } = await import("node:os");
	const platform = process.platform;
	const isWsl = platform === "linux" && release().toLowerCase().includes("microsoft");
	const configuredBrowser = process.env.EX_PLANNOTATOR_BROWSER || process.env.BROWSER;
	if (configuredBrowser === "none" || configuredBrowser === ":") return;

	let command: string;
	let args: string[];
	if (configuredBrowser) {
		command = configuredBrowser;
		args = [url];
	} else if (platform === "win32" || isWsl) {
		command = "cmd.exe";
		args = ["/c", "start", "", url];
	} else if (platform === "darwin") {
		command = "open";
		args = [url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.once("error", () => {});
	child.unref();
}
