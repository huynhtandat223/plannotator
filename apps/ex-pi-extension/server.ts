import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	LiveMessageReviewSession,
	type LiveAssistantMessage,
	type LiveDraftAnnotation,
	type LiveMessageReviewSnapshot,
} from "./session.js";

export type LiveMessageReviewServer = {
	port: number;
	url: string;
	reconcile(messages: LiveAssistantMessage[], activeBranchMessageIds: string[]): void;
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

export async function startLiveMessageReviewServer(options: {
	htmlContent: string;
	messages: LiveAssistantMessage[];
}): Promise<LiveMessageReviewServer> {
	const session = new LiveMessageReviewSession(options.messages);
	const streamCleanups = new Set<() => void>();
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

		if (request.method === "GET" && url.pathname === "/api/session") {
			writeJson(response, 200, session.snapshot());
			return;
		}

		if (request.method === "GET" && url.pathname === "/api/session/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
			});
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

		writeJson(response, 404, { error: "Not found" });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
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

	return {
		port,
		url: `http://127.0.0.1:${port}`,
		reconcile(messages, activeBranchMessageIds) {
			if (!stopped) session.reconcile(messages, activeBranchMessageIds);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			for (const cleanup of streamCleanups) cleanup();
			session.close();
			server.closeAllConnections?.();
			server.close();
		},
	};
}
