import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getActiveBranchAssistantMessages,
	getRecentAssistantMessages,
} from "./assistant-message.js";
import { startLiveMessageReviewBrowser } from "./browser.js";
import { formatLiveFeedbackBatch } from "./session.js";
import type { LiveMessageReviewServer } from "./server.js";

export const EX_PLANNOTATOR_COMMAND = "ex-plannotator-last";

type ExPlannotatorDependencies = {
	startBrowser: (
		ctx: ExtensionContext,
		messages: ReturnType<typeof getRecentAssistantMessages>,
	) => Promise<LiveMessageReviewServer>;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function exPlannotator(
	pi: ExtensionAPI,
	dependencies: ExPlannotatorDependencies = { startBrowser: startLiveMessageReviewBrowser },
): void {
	let activeServer: LiveMessageReviewServer | null = null;
	let pendingReconciliation: ReturnType<typeof setTimeout> | null = null;
	let piSessionIdAtOpen: string | null = null;
	let currentPiSessionId: string | null = null;

	function cancelPendingReconciliation(): void {
		if (!pendingReconciliation) return;
		clearTimeout(pendingReconciliation);
		pendingReconciliation = null;
	}

	function closeActiveServer(server = activeServer, stop = true): void {
		if (!server) return;
		if (activeServer === server) activeServer = null;
		cancelPendingReconciliation();
		piSessionIdAtOpen = null;
		currentPiSessionId = null;
		if (stop) server.stop();
	}

	pi.registerCommand(EX_PLANNOTATOR_COMMAND, {
		description: "Review recent assistant responses in a persistent Ex-Plannotator tab, approve, annotate, and send feedback in batches",
		handler: async (_args, ctx) => {
			const messages = getRecentAssistantMessages(ctx, 25);
			if (messages.length === 0) {
				ctx.ui.notify("No assistant message found in the active Pi branch.", "error");
				return;
			}
			closeActiveServer();
			try {
				const server = await dependencies.startBrowser(ctx, messages);
				activeServer = server;
				piSessionIdAtOpen = ctx.sessionManager.getSessionId();
				currentPiSessionId = piSessionIdAtOpen;
				server.setFeedbackDelivery(async (batch) => {
					if (!currentPiSessionId || currentPiSessionId !== piSessionIdAtOpen) {
						throw new Error(
							"The Pi conversation has changed since the review was opened. " +
							"Close the Ex-Plannotator and open it again.",
						);
					}
					pi.sendUserMessage(formatLiveFeedbackBatch(batch), { deliverAs: "followUp" });
				});
				server.setResumeAgent?.(async () => {
					if (!currentPiSessionId || currentPiSessionId !== piSessionIdAtOpen) {
						throw new Error("The Pi conversation has changed since the review was opened.");
					}
					pi.sendUserMessage("Continue addressing the previously accepted annotation feedback.", { deliverAs: "followUp" });
				});
				server.setStopHandler?.(() => {
					if (activeServer === server) closeActiveServer(server, false);
				});
				ctx.ui.notify(`Ex-Plannotator opened: ${server.url}`, "info");
			} catch (error) {
				activeServer = null;
				ctx.ui.notify(
					`Failed to open Ex-Plannotator: ${errorMessage(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentPiSessionId = ctx.sessionManager.getSessionId();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || !activeServer) return;
		const session = activeServer;
		cancelPendingReconciliation();
		pendingReconciliation = setTimeout(() => {
			pendingReconciliation = null;
			if (activeServer !== session) return;
			const activeBranchMessages = getActiveBranchAssistantMessages(ctx);
			session.reconcile(
				activeBranchMessages.slice(0, 25),
				activeBranchMessages.map((message) => message.messageId),
			);
		}, 0);
	});

	pi.on("agent_start", () => {
		activeServer?.markAgentStarted?.();
	});

	pi.on("agent_end", () => {
		activeServer?.markAgentStopped?.();
	});

	pi.on("session_shutdown", () => {
		closeActiveServer();
	});
}
