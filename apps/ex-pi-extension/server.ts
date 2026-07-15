import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getExPlannotatorBindHost, getExPlannotatorUrl } from "./network.js";
import {
	LiveMessageReviewSession,
	type LiveAssistantMessage,
	type LiveDraftAnnotation,
	type LiveFeedbackBatch,
	type LiveMessageReviewSnapshot,
} from "./session.js";

export type LiveFeedbackDelivery = (batch: LiveFeedbackBatch) => Promise<void> | void;
export type LiveAgentResume = () => Promise<void> | void;

export type LiveMessageReviewServer = {
	port: number;
	url: string;
	reconcile(messages: LiveAssistantMessage[], activeBranchMessageIds: string[]): void;
	setFeedbackDelivery(deliverFeedback: LiveFeedbackDelivery): void;
	setResumeAgent?(resumeAgent: LiveAgentResume): void;
	setStopHandler?(handler: () => void): void;
	markAgentStarted?(): void;
	markAgentStopped?(): void;
	stop(): void;
};

const JSON_HEADERS = {
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store",
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, JSON_HEADERS);
	response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return null;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serializeSnapshot(snapshot: LiveMessageReviewSnapshot): string {
	return `data: ${JSON.stringify(snapshot)}\n\n`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type OfficialFeedbackPayload = {
	annotations?: unknown;
	selectedMessageId?: unknown;
	feedbackScope?: unknown;
};

function annotationMessageId(annotation: unknown): string | null {
	if (!annotation || typeof annotation !== "object") return null;
	const value = annotation as { messageId?: unknown };
	return typeof value.messageId === "string" ? value.messageId : null;
}

function officialFeedbackMessages(body: OfficialFeedbackPayload): Array<{ messageId: string; annotations: LiveDraftAnnotation[] }> | null {
	if (!Array.isArray(body.annotations)) return null;
	const grouped = new Map<string, LiveDraftAnnotation[]>();
	for (const annotation of body.annotations) {
		if (!annotation || typeof annotation !== "object" || typeof (annotation as { id?: unknown }).id !== "string") return null;
		const messageId = annotationMessageId(annotation) ?? (
			typeof body.selectedMessageId === "string" ? body.selectedMessageId : null
		);
		if (!messageId) return null;
		const annotations = grouped.get(messageId) ?? [];
		annotations.push(annotation as LiveDraftAnnotation);
		grouped.set(messageId, annotations);
	}
	return [...grouped.entries()].map(([messageId, annotations]) => ({ messageId, annotations }));
}

export async function startLiveMessageReviewServer(options: {
	htmlContent: string;
	messages: LiveAssistantMessage[];
	deliverFeedback?: LiveFeedbackDelivery;
	resumeAgent?: LiveAgentResume;
}): Promise<LiveMessageReviewServer> {
	const session = new LiveMessageReviewSession(options.messages);
	let deliverFeedback = options.deliverFeedback;
	let resumeAgent = options.resumeAgent;
	let stopHandler: (() => void) | undefined;
	const streamCleanups = new Set<() => void>();
	const deliverFeedbackOrThrow: LiveFeedbackDelivery = async (batch) => {
		if (!deliverFeedback) throw new Error("Feedback delivery is unavailable.");
		await deliverFeedback(batch);
	};
	let stop = () => {};
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/") {
			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			});
			response.end(options.htmlContent);
			return;
		}

		if (request.method === "GET" && url.pathname === "/api/plan") {
			const snapshot = session.snapshot();
			const selected = snapshot.messages.find((message) => message.messageId === snapshot.selectedMessageId)
				?? snapshot.messages.at(-1);
			writeJson(response, 200, {
				mode: "annotate-last",
				plan: selected?.text ?? "",
				recentMessages: snapshot.messages,
				// Keep the initial editor selection aligned with the session-owned
				// compact response picker. Later SSE snapshots update it in place.
				selectedMessageId: snapshot.selectedMessageId,
				origin: "pi",
				gate: false,
				sharingEnabled: false,
				// Opt-in extension to the official annotate-last contract. The shared
				// editor uses this to keep the page open and follow this session's
				// retryable review-round state.
				liveMessageReview: true,
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/feedback") {
			try {
				const body = await readJson(request) as OfficialFeedbackPayload | null;
				const messages = body ? officialFeedbackMessages(body) : null;
				if (!messages) {
					writeJson(response, 400, { error: "Invalid feedback payload" });
					return;
				}
				const submitted = await session.submitFeedbackBatch(messages, deliverFeedbackOrThrow);
				if (!submitted) {
					writeJson(response, 409, { error: "Feedback cannot be delivered in the current review-round state." });
					return;
				}
				writeJson(response, 200, { ok: true });
			} catch (error) {
				writeJson(response, 502, { error: `Feedback delivery failed: ${errorMessage(error)}` });
			}
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
			const unsubscribe = session.subscribe((snapshot) => response.write(serializeSnapshot(snapshot)));
			const cleanup = () => {
				unsubscribe();
				streamCleanups.delete(cleanup);
			};
			streamCleanups.add(cleanup);
			request.once("close", cleanup);
			return;
		}

		if (request.method === "PUT" && url.pathname === "/api/session/selection") {
			try {
				const body = await readJson(request) as { messageId?: unknown } | null;
				if (!body || typeof body.messageId !== "string" || !session.select(body.messageId)) {
					writeJson(response, 400, { error: "Unknown message identity" });
					return;
				}
				writeJson(response, 200, session.snapshot());
			} catch {
				writeJson(response, 400, { error: "Invalid JSON body" });
			}
			return;
		}

		if (request.method === "PUT" && url.pathname === "/api/session/drafts") {
			try {
				const body = await readJson(request) as {
					messageId?: unknown;
					annotations?: unknown;
				} | null;
				const validAnnotations = Array.isArray(body?.annotations) && body.annotations.every(
					(annotation): annotation is LiveDraftAnnotation => (
						!!annotation && typeof annotation === "object" && typeof (annotation as { id?: unknown }).id === "string"
					),
				);
				if (
					!body ||
					typeof body.messageId !== "string" ||
					!validAnnotations ||
					!session.replaceDrafts(body.messageId, body.annotations as LiveDraftAnnotation[])
				) {
					writeJson(response, 400, { error: "Invalid draft state" });
					return;
				}
				writeJson(response, 200, session.snapshot());
			} catch {
				writeJson(response, 400, { error: "Invalid JSON body" });
			}
			return;
		}

		if (request.method === "POST" && (url.pathname === "/api/session/feedback" || url.pathname === "/api/session/feedback/retry")) {
			try {
				const submitted = url.pathname === "/api/session/feedback"
					? await session.submitFeedback(deliverFeedbackOrThrow)
					: await session.retryFeedback(deliverFeedbackOrThrow);
				if (!submitted) {
					writeJson(response, 409, { error: "Feedback cannot be delivered in the current review-round state." });
					return;
				}
				writeJson(response, 200, session.snapshot());
			} catch (error) {
				writeJson(response, 502, { error: `Feedback delivery failed: ${errorMessage(error)}` });
			}
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/session/resume") {
			try {
				const resumed = await session.resumeAgent(async () => {
					if (!resumeAgent) throw new Error("Agent resume is unavailable.");
					await resumeAgent();
				});
				if (!resumed) {
					writeJson(response, 409, { error: "The agent is not stopped while a review round is pending." });
					return;
				}
				writeJson(response, 200, session.snapshot());
			} catch (error) {
				writeJson(response, 502, { error: `Agent resume failed: ${errorMessage(error)}` });
			}
			return;
		}

		if (request.method === "POST" && url.pathname === "/api/session/cancel-waiting") {
			if (!session.cancelWaiting()) {
				writeJson(response, 409, { error: "No pending review round can be cancelled." });
				return;
			}
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
		server.listen(0, getExPlannotatorBindHost(), () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Ex-Plannotator server did not bind a TCP port.");
	}
	const port = address.port;
	let stopped = false;

	stop = () => {
		if (stopped) return;
		stopped = true;
		for (const cleanup of streamCleanups) cleanup();
		session.close();
		server.closeAllConnections?.();
		try {
			server.close();
		} catch {
			// A fatal server error may have already closed the listener.
		}
		stopHandler?.();
	};
	server.on("error", stop);

	return {
		port,
		url: getExPlannotatorUrl(port),
		reconcile(messages, activeBranchMessageIds) {
			if (!stopped) session.reconcile(messages, activeBranchMessageIds);
		},
		setFeedbackDelivery(delivery) {
			if (!stopped) deliverFeedback = delivery;
		},
		setResumeAgent(resume) {
			if (!stopped) resumeAgent = resume;
		},
		setStopHandler(handler) {
			if (!stopped) stopHandler = handler;
		},
		markAgentStarted() {
			if (!stopped) session.markAgentStarted();
		},
		markAgentStopped() {
			if (!stopped) session.markAgentStopped();
		},
		stop,
	};
}
