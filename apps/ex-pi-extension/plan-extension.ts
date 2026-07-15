import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRecentAssistantMessages } from "./assistant-message.js";
import { startPlanReviewBrowser } from "./plan-browser.js";
import { discoverPlanFolder, readPlanFileSnapshot, resolvePlanFolder } from "./plan-folder.js";
import { formatPlanFeedbackBatch } from "./plan-session.js";
import type { PlanReviewServer } from "./plan-server.js";

export const EX_PLANNOTATOR_PLAN_COMMAND = "ex-plannotator-plan";

type PlanDependencies = {
	startBrowser: (
		ctx: ExtensionContext,
		options: {
			folder: Awaited<ReturnType<typeof discoverPlanFolder>>;
			messages: ReturnType<typeof getRecentAssistantMessages>;
		},
	) => Promise<PlanReviewServer>;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function exPlannotatorPlan(
	pi: ExtensionAPI,
	dependencies: PlanDependencies = { startBrowser: startPlanReviewBrowser },
): void {
	let activeServer: PlanReviewServer | null = null;
	let launchGeneration = 0;
	let sessionIdAtOpen: string | null = null;
	let currentSessionId: string | null = null;
	let activeFolderPath: string | null = null;
	let roundTransitionInFlight = false;
	let pendingResponseTransition: ReturnType<typeof setTimeout> | null = null;

	function closeActiveServer(server = activeServer, stop = true): void {
		if (!server) return;
		if (pendingResponseTransition) {
			clearTimeout(pendingResponseTransition);
			pendingResponseTransition = null;
		}
		if (activeServer === server) activeServer = null;
		activeFolderPath = null;
		roundTransitionInFlight = false;
		sessionIdAtOpen = null;
		if (stop) server.stop();
	}

	function assertCurrentSession(): void {
		if (!sessionIdAtOpen || currentSessionId !== sessionIdAtOpen) {
			throw new Error("The Pi conversation has changed since the Plan review was opened. Close it and open a new review.");
		}
	}

	pi.registerCommand(EX_PLANNOTATOR_PLAN_COMMAND, {
		description: "Review recent assistant responses and a Plan Folder (default: ./plan)",
		handler: async (args, ctx) => {
			const messages = getRecentAssistantMessages(ctx, 25);
			if (messages.length === 0) {
				ctx.ui.notify("No assistant message found in the active Pi branch.", "error");
				return;
			}
			const generation = ++launchGeneration;
			const folderPath = resolvePlanFolder(ctx.cwd, args);
			let server: PlanReviewServer | null = null;
			try {
				const folder = await discoverPlanFolder(folderPath);
				if (generation !== launchGeneration) return;
				server = await dependencies.startBrowser(ctx, { folder, messages });
				if (generation !== launchGeneration) {
					server.stop();
					return;
				}
				closeActiveServer();
				activeServer = server;
				activeFolderPath = folderPath;
				sessionIdAtOpen = ctx.sessionManager.getSessionId();
				currentSessionId = sessionIdAtOpen;
				server.setFeedbackDelivery(async (batch) => {
					assertCurrentSession();
					pi.sendUserMessage(formatPlanFeedbackBatch(batch), { deliverAs: "followUp" });
				});
				server.setResumeAgent(async () => {
					assertCurrentSession();
					pi.sendUserMessage("Continue addressing the previously accepted Plan review feedback.", { deliverAs: "followUp" });
				});
				server.setStopHandler(() => {
					if (activeServer === server) closeActiveServer(server, false);
				});
				ctx.ui.notify(`Ex-Plannotator Plan opened: ${server.url}`, "info");
			} catch (error) {
				if (server && generation !== launchGeneration) server.stop();
				if (generation === launchGeneration) {
					ctx.ui.notify(`Failed to open Ex-Plannotator Plan: ${errorMessage(error)}`, "error");
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || !activeServer || pendingResponseTransition) return;
		const server = activeServer;
		pendingResponseTransition = setTimeout(async () => {
			pendingResponseTransition = null;
			if (activeServer !== server || !activeFolderPath || roundTransitionInFlight) return;
			const folderPath = activeFolderPath;
			const messages = getRecentAssistantMessages(ctx, 25);
			// History belongs to the Plan-review session, not to sent feedback: a
			// response is available for later inspection even when the user starts
			// another response round without annotating it.
			server.recordResponseHistory(messages);
			if (!server.hasNewResponse(messages)) return;
			roundTransitionInFlight = true;
			try {
				const folder = await discoverPlanFolder(folderPath);
				if (activeServer !== server || activeFolderPath !== folderPath) return;
				server.advanceRound(messages, folder.files, (file) => readPlanFileSnapshot(folder, file));
			} catch (error) {
				if (activeServer === server) ctx.ui.notify(`Failed to synchronize the next Plan review round: ${errorMessage(error)}`, "error");
			} finally {
				if (activeServer === server) roundTransitionInFlight = false;
			}
		}, 0);
	});
	pi.on("agent_start", () => activeServer?.markAgentStarted());
	pi.on("agent_end", () => activeServer?.markAgentStopped());
	pi.on("session_shutdown", () => {
		launchGeneration += 1;
		currentSessionId = null;
		closeActiveServer();
	});
}
