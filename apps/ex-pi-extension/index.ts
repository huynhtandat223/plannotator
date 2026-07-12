import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRecentAssistantMessages } from "./assistant-message.js";
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

	pi.registerCommand(EX_PLANNOTATOR_COMMAND, {
		description: "Review recent assistant responses in a persistent Ex-Plannotator tab",
		handler: async (_args, ctx) => {
			const messages = getRecentAssistantMessages(ctx, 25);
			if (messages.length === 0) {
				ctx.ui.notify("No assistant message found in the active Pi branch.", "error");
				return;
			}
			activeServer?.stop();
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

	pi.on("session_shutdown", () => {
		activeServer?.stop();
		activeServer = null;
	});
}
