import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LiveAssistantMessage } from "./session.js";
import type { Annotation } from "@plannotator/ui/types";
import type { PlanFile, PlanFileSnapshot } from "./plan-folder.js";
import { getExPlannotatorBindHost, getExPlannotatorUrl } from "./network.js";
import {
	PlanReviewSession,
	type PlanFeedbackBatch,
	type PlanFeedbackDelivery,
	type PlanReviewSnapshot,
} from "./plan-session.js";

export type PlanAgentResume = () => Promise<void> | void;
export type PlanReviewServer = {
	port: number;
	url: string;
	setFeedbackDelivery(deliver: PlanFeedbackDelivery): void;
	setResumeAgent(resume: PlanAgentResume): void;
	setStopHandler(handler: () => void): void;
	markAgentStarted(): void;
	markAgentStopped(): void;
	recordResponseHistory(messages: LiveAssistantMessage[]): void;
	hasNewResponse(messages: LiveAssistantMessage[]): boolean;
	advanceRound(messages: LiveAssistantMessage[], files: PlanFile[], readFile: (file: PlanFile) => Promise<PlanFileSnapshot>): boolean;
	stop(): void;
};

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, headers);
	response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}

function event(snapshot: PlanReviewSnapshot): string {
	return `data: ${JSON.stringify(snapshot)}\n\n`;
}

function validAnnotations(value: unknown): value is Annotation[] {
	return Array.isArray(value) && value.every((annotation) => (
		!!annotation && typeof annotation === "object" && typeof (annotation as { id?: unknown }).id === "string"
	));
}

export async function startPlanReviewServer(options: {
	htmlContent: string;
	messages: LiveAssistantMessage[];
	files: PlanFile[];
	readFile: (file: PlanFile) => Promise<PlanFileSnapshot>;
	deliverFeedback?: PlanFeedbackDelivery;
	resumeAgent?: PlanAgentResume;
}): Promise<PlanReviewServer> {
	const session = new PlanReviewSession(options.messages, options.files, options.readFile);
	let deliverFeedback = options.deliverFeedback;
	let resumeAgent = options.resumeAgent;
	let stopHandler: (() => void) | undefined;
	let stop = () => {};
	const cleanups = new Set<() => void>();
	const deliverOrThrow: PlanFeedbackDelivery = async (batch) => {
		if (!deliverFeedback) throw new Error("Feedback delivery is unavailable.");
		await deliverFeedback(batch);
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "GET" && url.pathname === "/") {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			response.end(options.htmlContent);
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/plan") {
			const snapshot = session.snapshot();
			const selected = snapshot.selected;
			const message = selected?.kind === "message"
				? snapshot.messages.find((candidate) => candidate.messageId === selected.messageId)
					?? snapshot.responseHistory.find((candidate) => candidate.messageId === selected.messageId)
					?? snapshot.sentMessageSnapshots[selected.messageId]
				: undefined;
			const file = selected?.kind === "file"
				? snapshot.fileSnapshots[selected.path]?.contentHash === selected.contentHash
					? snapshot.fileSnapshots[selected.path]
					: snapshot.sentFileSnapshots[`${selected.path}\u0000${selected.contentHash}`]
				: undefined;
			writeJson(response, 200, {
				mode: "annotate-last",
				plan: message?.text ?? file?.content ?? "",
				recentMessages: snapshot.messages,
				...(selected?.kind === "message" ? { selectedMessageId: selected.messageId } : {}),
				origin: "pi",
				gate: false,
				sharingEnabled: false,
				planReview: { sourceMode: "mixed", snapshot },
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/session") {
			writeJson(response, 200, session.snapshot());
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/session/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			response.flushHeaders();
			const unsubscribe = session.subscribe((snapshot) => response.write(event(snapshot)));
			const cleanup = () => { unsubscribe(); cleanups.delete(cleanup); };
			cleanups.add(cleanup);
			request.once("close", cleanup);
			return;
		}
		if (request.method === "PUT" && url.pathname === "/api/session/selection") {
			try {
				const body = await readJson(request) as { kind?: unknown; messageId?: unknown; path?: unknown; contentHash?: unknown } | null;
				const selected = body?.kind === "message" && typeof body.messageId === "string"
					? session.selectMessage(body.messageId)
					: body?.kind === "file" && typeof body.path === "string" && (body.contentHash === undefined || typeof body.contentHash === "string")
						? await session.selectFile(body.path, body.contentHash) : false;
				if (!selected) { writeJson(response, 400, { error: "Unknown or unsupported reviewed source" }); return; }
				writeJson(response, 200, session.snapshot());
			} catch (error) {
				writeJson(response, 400, { error: error instanceof Error ? error.message : "Invalid JSON body" });
			}
			return;
		}
		if (request.method === "PUT" && url.pathname === "/api/session/drafts") {
			try {
				const body = await readJson(request) as {
					kind?: unknown;
					messageId?: unknown;
					path?: unknown;
					contentHash?: unknown;
					annotations?: unknown;
				} | null;
				const replaced = validAnnotations(body?.annotations) && body?.kind === "message" && typeof body.messageId === "string"
					? session.replaceMessageDrafts(body.messageId, body.annotations)
					: validAnnotations(body?.annotations) && body?.kind === "file" && typeof body.path === "string" && typeof body.contentHash === "string"
						? session.replaceFileDrafts(body.path, body.contentHash, body.annotations) : false;
				if (!replaced) { writeJson(response, 400, { error: "Invalid draft state" }); return; }
				writeJson(response, 200, session.snapshot());
			} catch {
				writeJson(response, 400, { error: "Invalid JSON body" });
			}
			return;
		}
		if (request.method === "POST" && (url.pathname === "/api/session/feedback" || url.pathname === "/api/session/feedback/retry")) {
			try {
				const submitted = url.pathname === "/api/session/feedback"
					? await session.submitFeedback(deliverOrThrow)
					: await session.retryFeedback(deliverOrThrow);
				if (!submitted) { writeJson(response, 409, { error: "Feedback cannot be delivered in the current review-round state." }); return; }
				writeJson(response, 200, session.snapshot());
			} catch (error) {
				writeJson(response, 502, { error: `Feedback delivery failed: ${error instanceof Error ? error.message : String(error)}` });
			}
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/session/resume") {
			try {
				const resumed = await session.resumeAgent(async () => {
					if (!resumeAgent) throw new Error("Agent resume is unavailable.");
					await resumeAgent();
				});
				if (!resumed) { writeJson(response, 409, { error: "The agent is not stopped while a review round is pending." }); return; }
				writeJson(response, 200, session.snapshot());
			} catch (error) {
				writeJson(response, 502, { error: `Agent resume failed: ${error instanceof Error ? error.message : String(error)}` });
			}
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/session/cancel-waiting") {
			if (!session.cancelWaiting()) { writeJson(response, 409, { error: "No pending review round can be cancelled." }); return; }
			writeJson(response, 200, session.snapshot());
			return;
		}
		if (request.method === "POST" && (url.pathname === "/api/session/close" || url.pathname === "/api/exit")) {
			writeJson(response, 200, { closed: true });
			queueMicrotask(stop);
			return;
		}
		writeJson(response, 404, { error: "Not found" });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, getExPlannotatorBindHost(), () => { server.removeListener("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Plan review server did not bind a TCP port.");
	}
	let stopped = false;
	stop = () => {
		if (stopped) return;
		stopped = true;
		for (const cleanup of cleanups) cleanup();
		session.close();
		server.closeAllConnections?.();
		server.close();
		stopHandler?.();
	};
	server.on("error", stop);
	return {
		port: address.port,
		url: getExPlannotatorUrl(address.port),
		setFeedbackDelivery(delivery) { if (!stopped) deliverFeedback = delivery; },
		setResumeAgent(resume) { if (!stopped) resumeAgent = resume; },
		setStopHandler(handler) { if (!stopped) stopHandler = handler; },
		markAgentStarted() { if (!stopped) session.markAgentStarted(); },
		markAgentStopped() { if (!stopped) session.markAgentStopped(); },
		recordResponseHistory(messages) { if (!stopped) session.recordResponseHistory(messages); },
		hasNewResponse(messages) { return !stopped && session.hasNewResponse(messages); },
		advanceRound(messages, files, readFile) { return !stopped && session.advanceRound(messages, files, readFile); },
		stop,
	};
}
