import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveBranchAssistantMessages } from "./assistant-message.js";
import { formatLiveFeedbackBatch, type LiveFeedbackBatch } from "./session.js";

const DEFAULT_HERDR_SERVICE_URL = "http://127.0.0.1:19432";
/** Number of finalized structured assistant responses retained per live pane. */
export const HERDR_LIVE_MESSAGE_LIMIT = 5;

function loopbackServiceUrl(env: NodeJS.ProcessEnv): string {
	const value = env.EX_PLANNOTATOR_HERDR_SERVICE_URL?.trim() || DEFAULT_HERDR_SERVICE_URL;
	const url = new URL(value);
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
		throw new Error("EX_PLANNOTATOR_HERDR_SERVICE_URL must be a loopback HTTP URL");
	}
	return url.origin;
}

export type HerdrCommandCapability = {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
};

export type HerdrSessionRegistration = {
	paneId: string;
	sessionId: string;
	messages: ReturnType<typeof getActiveBranchAssistantMessages>;
	commands: HerdrCommandCapability[];
};

type HerdrFeedbackDelivery = { deliveryId: string; batch: LiveFeedbackBatch };
type HerdrInstructionDelivery = { deliveryId: string; content: string };
type SendPiUserMessage = (content: string, options: { deliverAs: "followUp" }) => void;

function herdrCommandCapabilities(commands: HerdrCommandCapability[]): HerdrCommandCapability[] {
	const seen = new Set<string>();
	return commands.flatMap((command) => {
		if (!command.name || seen.has(command.name)) return [];
		seen.add(command.name);
		return [{
			name: command.name,
			...(command.description ? { description: command.description } : {}),
			source: command.source,
		}];
	});
}

export function currentHerdrRegistration(
	ctx: Pick<ExtensionContext, "sessionManager">,
	env: NodeJS.ProcessEnv = process.env,
	commands: HerdrCommandCapability[] = [],
): HerdrSessionRegistration | null {
	const paneId = env.HERDR_PANE_ID?.trim();
	if (env.HERDR_ENV !== "1" || !paneId) return null;
	return {
		paneId,
		sessionId: ctx.sessionManager.getSessionId(),
		// Newest first, matching /ex-plannotator-last for the first entry while
		// retaining a small structured history for the live workspace viewer.
		messages: getActiveBranchAssistantMessages(ctx as ExtensionContext).slice(0, HERDR_LIVE_MESSAGE_LIMIT),
		commands: herdrCommandCapabilities(commands),
	};
}

export async function reportHerdrSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
	commands: HerdrCommandCapability[] = [],
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env, commands);
	if (!registration) return;
	try {
		await fetcher(`${loopbackServiceUrl(env)}/api/panel-session`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(registration),
			signal: AbortSignal.timeout(1_000),
		});
	} catch {
		// The native viewer is optional. Pi sessions remain fully usable when it
		// is not running; the next lifecycle event will retry registration.
	}
}

export async function pollHerdrFeedback(
	ctx: Pick<ExtensionContext, "sessionManager">,
	sendUserMessage: SendPiUserMessage,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env);
	if (!registration) return;
	try {
		const claim = await fetcher(`${loopbackServiceUrl(env)}/api/panel-feedback/claim`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paneId: registration.paneId, sessionId: registration.sessionId }),
			signal: AbortSignal.timeout(1_000),
		});
		if (claim.status === 204 || !claim.ok) return;
		const delivery = await claim.json() as Partial<HerdrFeedbackDelivery>;
		if (!delivery.deliveryId || !delivery.batch || !Array.isArray(delivery.batch.messages)) return;
		// Pi is the final authority for delivery: this closure belongs to the
		// current pane/session, not to the LAN-facing host.
		sendUserMessage(formatLiveFeedbackBatch(delivery.batch), { deliverAs: "followUp" });
	} catch {
		// Feedback remains queued until a later poll when this optional host is
		// temporarily unavailable. Pi remains usable independently of it.
	}
}

export async function pollHerdrInstruction(
	ctx: Pick<ExtensionContext, "sessionManager">,
	sendUserMessage: SendPiUserMessage,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env);
	if (!registration) return;
	try {
		const claim = await fetcher(`${loopbackServiceUrl(env)}/api/panel-instruction/claim`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paneId: registration.paneId, sessionId: registration.sessionId }),
			signal: AbortSignal.timeout(1_000),
		});
		if (claim.status === 204 || !claim.ok) return;
		const delivery = await claim.json() as Partial<HerdrInstructionDelivery>;
		if (!delivery.deliveryId || !delivery.content?.trim()) return;
		sendUserMessage(delivery.content, { deliverAs: "followUp" });
	} catch {
		// User messages remain queued until the optional local viewer is reachable.
	}
}

export async function releaseHerdrSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const paneId = env.HERDR_PANE_ID?.trim();
	if (env.HERDR_ENV !== "1" || !paneId) return;
	try {
		const params = new URLSearchParams({ paneId, sessionId: ctx.sessionManager.getSessionId() });
		await fetcher(`${loopbackServiceUrl(env)}/api/panel-session?${params}`, {
			method: "DELETE",
			signal: AbortSignal.timeout(1_000),
		});
	} catch {
		// Best effort only; discovery drops closed panes from the next Herdr
		// snapshot even if this in-memory enrichment has not been released yet.
	}
}
