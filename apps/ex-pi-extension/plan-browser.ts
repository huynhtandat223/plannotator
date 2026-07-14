import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPlanFileSnapshot, type PlanFolder } from "./plan-folder.js";
import { startPlanReviewServer, type PlanReviewServer } from "./plan-server.js";
import type { LiveAssistantMessage } from "./session.js";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const browserAssetPath = resolve(extensionDirectory, "ex-plannotator-plan.html");

export function hasPlanReviewBrowserAsset(): boolean { return existsSync(browserAssetPath); }

export async function startPlanReviewBrowser(ctx: ExtensionContext, options: { folder: PlanFolder; messages: LiveAssistantMessage[] }): Promise<PlanReviewServer> {
	if (!ctx.hasUI) throw new Error("Ex-Plannotator Plan requires an interactive Pi session.");
	if (!hasPlanReviewBrowserAsset()) throw new Error("Ex-Plannotator Plan browser asset is missing. Run the Ex-Plannotator build first.");
	const server = await startPlanReviewServer({
		htmlContent: readFileSync(browserAssetPath, "utf8"),
		messages: options.messages,
		files: options.folder.files,
		readFile: (file) => readPlanFileSnapshot(options.folder, file),
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
	const [command, args] = configuredBrowser ? [configuredBrowser, [url]]
		: platform === "win32" || isWsl ? ["cmd.exe", ["/c", "start", "", url]]
		: platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.once("error", () => {});
	child.unref();
}
