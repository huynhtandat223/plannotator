import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getActiveBranchAssistantMessages,
	getRecentAssistantMessages,
} from "./assistant-message.js";
import { startLiveMessageReviewBrowser } from "./browser.js";
import { formatLiveFeedbackBatch } from "./session.js";
import type { LiveMessageReviewServer } from "./server.js";
import { beginHerdrTool, clearHerdrTools, endHerdrTool, EX_PLANNOTATOR_MODEL_COMMAND, EX_PLANNOTATOR_NEW_COMMAND, EX_PLANNOTATOR_RELOAD_COMMAND, pollHerdrFeedback, pollHerdrInstruction, releaseHerdrSession, reportHerdrSession } from "./herdr-registration.js";

export const EX_PLANNOTATOR_COMMAND = "ex-plannotator-last";

type ExPlannotatorDependencies = {
	startBrowser: (
		ctx: ExtensionContext,
		messages: ReturnType<typeof getRecentAssistantMessages>,
	) => Promise<LiveMessageReviewServer>;
	reportHerdr: (ctx: ExtensionContext, commands?: ReturnType<ExtensionAPI["getCommands"]>) => Promise<void>;
	releaseHerdr: (ctx: ExtensionContext) => Promise<void>;
	pollHerdrFeedback: (ctx: ExtensionContext, sendUserMessage: (content: string, options: { deliverAs: "followUp" }) => void) => Promise<void>;
	pollHerdrInstruction: (ctx: ExtensionContext, sendUserMessage: (content: string, options: { deliverAs: "followUp" }) => void) => Promise<void>;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function exPlannotator(
	pi: ExtensionAPI,
	overrides: Partial<ExPlannotatorDependencies> = {},
): void {
	const dependencies: ExPlannotatorDependencies = {
		startBrowser: startLiveMessageReviewBrowser,
		reportHerdr: (ctx, commands) => reportHerdrSession(ctx, undefined, undefined, commands),
		releaseHerdr: releaseHerdrSession,
		pollHerdrFeedback,
		pollHerdrInstruction,
		...overrides,
	};
	let activeServer: LiveMessageReviewServer | null = null;
	let pendingReconciliation: ReturnType<typeof setTimeout> | null = null;
	let piSessionIdAtOpen: string | null = null;
	let currentPiSessionId: string | null = null;
	let herdrFeedbackPoll: ReturnType<typeof setInterval> | null = null;

	function stopHerdrFeedbackPoll(): void {
		if (!herdrFeedbackPoll) return;
		clearInterval(herdrFeedbackPoll);
		herdrFeedbackPoll = null;
	}

	function startHerdrFeedbackPoll(ctx: ExtensionContext): void {
		stopHerdrFeedbackPoll();
		const poll = () => {
			void dependencies.reportHerdr(ctx, pi.getCommands());
			void dependencies.pollHerdrInstruction(ctx, pi.sendUserMessage.bind(pi));
			void dependencies.pollHerdrFeedback(ctx, pi.sendUserMessage.bind(pi));
		};
		poll();
		herdrFeedbackPoll = setInterval(poll, 750);
	}

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

	pi.registerCommand(EX_PLANNOTATOR_NEW_COMMAND, {
		description: "Start a new Pi session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.registerCommand(EX_PLANNOTATOR_MODEL_COMMAND, {
		description: "Switch Pi model",
		handler: async (args, ctx) => {
			const [provider, ...modelId] = args.trim().split("/");
			const model = provider && modelId.length > 0
				? ctx.modelRegistry.find(provider, modelId.join("/"))
				: undefined;
			if (!model) {
				ctx.ui.notify("Choose a model as provider/model.", "error");
				return;
			}
			if (!await pi.setModel(model)) ctx.ui.notify(`Could not select ${provider}/${modelId.join("/")}.`, "error");
		},
	});

	pi.registerCommand(EX_PLANNOTATOR_RELOAD_COMMAND, {
		description: "Reload Pi extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

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

	pi.on("session_start", async (_event, ctx) => {
		currentPiSessionId = ctx.sessionManager.getSessionId();
		await dependencies.reportHerdr(ctx, pi.getCommands());
		startHerdrFeedbackPoll(ctx);
	});

	// Context usage is updated after every provider response. Tool boundaries
	// publish independently so the live pane reports both ordinary tools and
	// concurrently running subagents while the response is still in progress.
	pi.on("turn_end", (_event, ctx) => {
		void dependencies.reportHerdr(ctx, pi.getCommands());
	});

	pi.on("tool_execution_start", (event, ctx) => {
		beginHerdrTool(ctx, event.toolCallId, event.toolName);
		void dependencies.reportHerdr(ctx, pi.getCommands());
	});

	pi.on("tool_execution_end", (event, ctx) => {
		endHerdrTool(ctx, event.toolCallId);
		void dependencies.reportHerdr(ctx, pi.getCommands());
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const session = activeServer;
		cancelPendingReconciliation();
		pendingReconciliation = setTimeout(() => {
			pendingReconciliation = null;
			void dependencies.reportHerdr(ctx, pi.getCommands());
			if (!session || activeServer !== session) return;
			const activeBranchMessages = getActiveBranchAssistantMessages(ctx);
			session.reconcile(
				activeBranchMessages.slice(0, 25),
				activeBranchMessages.map((message) => message.messageId),
			);
		}, 0);
	});

	// Herdr may start after Pi has already emitted session_start. Republish on
	// each lifecycle event so its in-memory enrichment returns without requiring
	// the user to restart the active Pi pane.
	pi.on("agent_start", (_event, ctx) => {
		void dependencies.reportHerdr(ctx, pi.getCommands());
		activeServer?.markAgentStarted?.();
	});

	pi.on("agent_end", (_event, ctx) => {
		void dependencies.reportHerdr(ctx, pi.getCommands());
		activeServer?.markAgentStopped?.();
	});

	pi.on("session_tree", (_event, ctx) => {
		void dependencies.reportHerdr(ctx, pi.getCommands());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearHerdrTools(ctx);
		closeActiveServer();
		stopHerdrFeedbackPoll();
		await dependencies.releaseHerdr(ctx);
	});
}
