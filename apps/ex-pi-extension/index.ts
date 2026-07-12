import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getActiveBranchAssistantMessages,
	getRecentAssistantMessages,
} from "./assistant-message.js";
import { startLiveMessageReviewBrowser } from "./browser.js";
import type { LiveMessageReviewServer } from "./server.js";

export const EX_PLANNOTATOR_COMMAND = "ex-plannotator-last";

type ExPlannotatorDependencies = {
	startBrowser: (
		ctx: ExtensionContext,
		messages: ReturnType<typeof getRecentAssistantMessages>,
	) => Promise<LiveMessageReviewServer>;
};

export default function exPlannotator(
	pi: ExtensionAPI,
	dependencies: ExPlannotatorDependencies = { startBrowser: startLiveMessageReviewBrowser },
): void {
	let activeServer: LiveMessageReviewServer | null = null;
	let pendingReconciliation: ReturnType<typeof setTimeout> | null = null;

	function cancelPendingReconciliation(): void {
		if (!pendingReconciliation) return;
		clearTimeout(pendingReconciliation);
		pendingReconciliation = null;
	}

	pi.registerCommand(EX_PLANNOTATOR_COMMAND, {
		description: "Review recent assistant responses in a persistent Ex-Plannotator tab",
		handler: async (_args, ctx) => {
			const messages = getRecentAssistantMessages(ctx, 25);
			if (messages.length === 0) {
				ctx.ui.notify("No assistant message found in the active Pi branch.", "error");
				return;
			}
			cancelPendingReconciliation();
			activeServer?.stop();
			activeServer = null;
			try {
				activeServer = await dependencies.startBrowser(ctx, messages);
				ctx.ui.notify(`Ex-Plannotator opened: ${activeServer.url}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Failed to open Ex-Plannotator: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
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

	pi.on("session_shutdown", () => {
		cancelPendingReconciliation();
		activeServer?.stop();
		activeServer = null;
	});
}
