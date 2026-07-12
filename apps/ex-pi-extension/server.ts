import { createServer } from "node:http";
import { createLiveMessageReviewSnapshot, type LiveAssistantMessage } from "./session.js";

export type LiveMessageReviewServer = {
	port: number;
	url: string;
	stop(): void;
};

export async function startLiveMessageReviewServer(options: {
	htmlContent: string;
	messages: LiveAssistantMessage[];
}): Promise<LiveMessageReviewServer> {
	const snapshot = createLiveMessageReviewSnapshot(options.messages);
	const server = createServer((request, response) => {
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
			response.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			});
			response.end(JSON.stringify({
				messages: snapshot.messages,
				selectedMessageId: snapshot.selectedMessageId,
			}));
			return;
		}

		response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: "Not found" }));
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
		stop() {
			if (stopped) return;
			stopped = true;
			server.closeAllConnections?.();
			server.close();
		},
	};
}
