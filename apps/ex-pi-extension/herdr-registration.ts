import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActiveBranchAssistantMessages } from "./assistant-message.js";

const DEFAULT_HERDR_SERVICE_URL = "http://127.0.0.1:19432";

function loopbackServiceUrl(env: NodeJS.ProcessEnv): string {
	const value = env.EX_PLANNOTATOR_HERDR_SERVICE_URL?.trim() || DEFAULT_HERDR_SERVICE_URL;
	const url = new URL(value);
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
		throw new Error("EX_PLANNOTATOR_HERDR_SERVICE_URL must be a loopback HTTP URL");
	}
	return url.origin;
}

export type HerdrSessionRegistration = {
	paneId: string;
	sessionId: string;
	messages: ReturnType<typeof getActiveBranchAssistantMessages>;
};

export function currentHerdrRegistration(
	ctx: Pick<ExtensionContext, "sessionManager">,
	env: NodeJS.ProcessEnv = process.env,
): HerdrSessionRegistration | null {
	const paneId = env.HERDR_PANE_ID?.trim();
	if (env.HERDR_ENV !== "1" || !paneId) return null;
	return {
		paneId,
		sessionId: ctx.sessionManager.getSessionId(),
		// Phase one intentionally mirrors /ex-plannotator-last exactly. The host
		// can grow an N-message view later without changing pane discovery.
		messages: getActiveBranchAssistantMessages(ctx as ExtensionContext).slice(0, 1),
	};
}

export async function reportHerdrSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
	fetcher: typeof fetch = fetch,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const registration = currentHerdrRegistration(ctx, env);
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
