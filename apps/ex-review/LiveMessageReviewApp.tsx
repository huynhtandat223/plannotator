import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { ScrollViewportProvider } from "@plannotator/ui/hooks/useScrollViewport";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";
import { LiveMessagesBrowser, type LiveMessage } from "./LiveMessagesBrowser";

type ReviewRoundStatus = "open" | "submitting" | "delivery_failed" | "waiting" | "agent_stopped";

type SessionResponse = {
	messages: LiveMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: string[];
	draftsByMessageId: Record<string, Annotation[]>;
	sentAnnotationsByMessageId: Record<string, Annotation[]>;
	reviewRoundStatus: ReviewRoundStatus;
	deliveryError: string | null;
};

async function putSessionState(path: string, body: unknown): Promise<void> {
	const response = await fetch(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`Session update failed (${response.status})`);
}

async function postSessionAction(path: string): Promise<void> {
	const response = await fetch(path, { method: "POST" });
	if (!response.ok) {
		const result = await response.json().catch(() => null) as { error?: unknown } | null;
		throw new Error(typeof result?.error === "string" ? result.error : `Session action failed (${response.status})`);
	}
}

export function LiveMessageReviewApp() {
	const [messages, setMessages] = useState<LiveMessage[]>([]);
	const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
	const [unreadMessageIds, setUnreadMessageIds] = useState<Set<string>>(new Set());
	const [draftsByMessageId, setDraftsByMessageId] = useState<Record<string, Annotation[]>>({});
	const [sentAnnotationsByMessageId, setSentAnnotationsByMessageId] = useState<Record<string, Annotation[]>>({});
	const [reviewRoundStatus, setReviewRoundStatus] = useState<ReviewRoundStatus>("open");
	const [deliveryError, setDeliveryError] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [loadingError, setLoadingError] = useState<string | null>(null);
	const mutationQueue = useRef(Promise.resolve());

	function applySnapshot(session: SessionResponse) {
		setMessages(session.messages);
		setSelectedMessageId(session.selectedMessageId);
		setUnreadMessageIds(new Set(session.unreadMessageIds));
		setDraftsByMessageId(session.draftsByMessageId);
		setSentAnnotationsByMessageId(session.sentAnnotationsByMessageId);
		setReviewRoundStatus(session.reviewRoundStatus);
		setDeliveryError(session.deliveryError);
	}

	function queueMutation(mutation: () => Promise<void>) {
		mutationQueue.current = mutationQueue.current
			.then(mutation)
			.catch((error) => setLoadingError(error instanceof Error ? error.message : String(error)));
	}

	useEffect(() => {
		let cancelled = false;
		let source: EventSource | null = null;

		// Hydrate from the initial GET snapshot first, then open the SSE stream.
		// Every new SSE subscriber immediately receives the authoritative full
		// snapshot, so sequencing avoids a race where an older GET response
		// overwrites state that the SSE has already advanced.
		fetch("/api/session")
			.then(async (response) => {
				if (!response.ok) throw new Error(`Session request failed (${response.status})`);
				return response.json() as Promise<SessionResponse>;
			})
			.then((session) => {
				if (cancelled) return;
				applySnapshot(session);
				setLoadingError(null);

				source = new EventSource("/api/session/events");
				source.onmessage = (event) => {
					if (cancelled) return;
					try {
						applySnapshot(JSON.parse(event.data) as SessionResponse);
						setLoadingError(null);
					} catch {
						setLoadingError("Ex-Plannotator received an invalid session update.");
					}
				};
				source.onerror = () => {
					if (!cancelled) setLoadingError("Live updates disconnected. Reconnecting…");
				};
			})
			.catch((error) => {
				if (!cancelled) setLoadingError(error instanceof Error ? error.message : String(error));
			});

		return () => {
			cancelled = true;
			if (source) source.close();
		};
	}, []);

	const selectedMessage = messages.find((message) => message.messageId === selectedMessageId) ?? null;
	const draftAnnotations = selectedMessageId ? draftsByMessageId[selectedMessageId] ?? [] : [];
	const sentAnnotations = selectedMessageId ? sentAnnotationsByMessageId[selectedMessageId] ?? [] : [];
	const annotations = [...sentAnnotations, ...draftAnnotations];
	const inputLocked = reviewRoundStatus !== "open";
	const blocks = useMemo(() => parseMarkdownToBlocks(selectedMessage?.text ?? ""), [selectedMessage?.text]);
	const frontmatter = useMemo(
		() => extractFrontmatter(selectedMessage?.text ?? "").frontmatter,
		[selectedMessage?.text],
	);
	const annotationCounts = useMemo(
		() => new Map(messages.map((message) => [
			message.messageId,
			(draftsByMessageId[message.messageId]?.length ?? 0) + (sentAnnotationsByMessageId[message.messageId]?.length ?? 0),
		])),
		[draftsByMessageId, messages, sentAnnotationsByMessageId],
	);
	const draftCount = useMemo(
		() => Object.values(draftsByMessageId).reduce((total, drafts) => total + drafts.length, 0),
		[draftsByMessageId],
	);

	function updateDrafts(updater: (current: Annotation[]) => Annotation[]) {
		if (!selectedMessageId || inputLocked) return;
		const messageId = selectedMessageId;
		const currentAnnotations = draftsByMessageId[messageId] ?? [];
		const nextAnnotations = updater(currentAnnotations);
		queueMutation(() => putSessionState("/api/session/drafts", { messageId, annotations: nextAnnotations }));
		setDraftsByMessageId((current) => {
			const next = { ...current };
			if (nextAnnotations.length === 0) delete next[messageId];
			else next[messageId] = nextAnnotations;
			return next;
		});
	}

	function selectMessage(messageId: string) {
		setSelectedMessageId(messageId);
		setUnreadMessageIds((current) => {
			const next = new Set(current);
			next.delete(messageId);
			return next;
		});
		setSelectedAnnotationId(null);
		queueMutation(() => putSessionState("/api/session/selection", { messageId }));
	}

	function submitFeedback() {
		if (inputLocked || draftCount === 0) return;
		queueMutation(async () => {
			await postSessionAction("/api/session/feedback");
			setLoadingError(null);
		});
	}

	function runAction(path: string) {
		queueMutation(async () => {
			await postSessionAction(path);
			setLoadingError(null);
		});
	}

	return (
		<ThemeProvider storageKey="ex-plannotator-theme" colorThemeStorageKey="ex-plannotator-color-theme">
			<TooltipProvider>
				<ScrollViewportProvider viewport={viewport}>
					<div className="flex h-screen min-h-0 bg-background text-foreground">
						<aside className="w-72 shrink-0 border-r border-border/50 bg-card">
							<div className="flex h-12 items-center border-b border-border/50 px-4">
								<div>
									<h1 className="text-sm font-semibold">Ex-Plannotator</h1>
									<p className="text-[10px] text-muted-foreground">Live message review</p>
								</div>
							</div>
							<LiveMessagesBrowser
								messages={messages}
								selectedMessageId={selectedMessageId}
								unreadMessageIds={unreadMessageIds}
								onSelect={selectMessage}
								annotationCounts={annotationCounts}
							/>
						</aside>

						<main ref={setViewport} className="min-w-0 flex-1 overflow-y-auto px-6 py-8">
							{loadingError && (
								<div className="mx-auto mb-4 max-w-3xl rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
									{loadingError}
								</div>
							)}
							{reviewRoundStatus === "waiting" && (
								<div className="mx-auto mb-4 flex max-w-3xl items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
									<span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
									Waiting for agent. Sent annotations are locked until its next completed response.
								</div>
							)}
							{reviewRoundStatus === "delivery_failed" && (
								<div className="mx-auto mb-4 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
									Feedback was not delivered{deliveryError ? `: ${deliveryError}` : ""}. Retry safely; Pi did not accept this batch.
								</div>
							)}
							{reviewRoundStatus === "agent_stopped" && (
								<div className="mx-auto mb-4 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
									Pi accepted the feedback, but the agent stopped before responding. Resume or cancel waiting; do not resend the batch.
								</div>
							)}
							{reviewRoundStatus === "submitting" && (
								<div className="mx-auto mb-4 max-w-3xl rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
									Sending feedback…
								</div>
							)}
							{selectedMessage ? (
								<Viewer
									key={selectedMessage.messageId}
									blocks={blocks}
									markdown={selectedMessage.text}
									frontmatter={frontmatter}
									annotations={annotations}
									onAddAnnotation={(annotation) => {
										updateDrafts((current) => [...current, annotation]);
										setSelectedAnnotationId(annotation.id);
									}}
									onSelectAnnotation={setSelectedAnnotationId}
									selectedAnnotationId={selectedAnnotationId}
									mode="selection"
									taterMode={false}
									disableCodePathValidation
									maxWidth={900}
									copyLabel="Copy response"
									readOnly={inputLocked}
								/>
							) : (
								<div className="py-20 text-center text-sm text-muted-foreground">Loading responses…</div>
							)}
						</main>

						<aside className="flex w-80 shrink-0 flex-col border-l border-border/50 bg-card">
							<div className="space-y-2 border-b border-border/50 p-3">
								{reviewRoundStatus === "delivery_failed" ? (
									<button
										type="button"
										onClick={() => runAction("/api/session/feedback/retry")}
										className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
									>
										Retry feedback
									</button>
								) : (
									<button
										type="button"
										onClick={submitFeedback}
										disabled={inputLocked || draftCount === 0}
										className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
									>
										{reviewRoundStatus === "submitting" ? "Sending feedback…" : `Send feedback${draftCount ? ` (${draftCount})` : ""}`}
									</button>
								)}
								{reviewRoundStatus === "agent_stopped" && (
									<button type="button" onClick={() => runAction("/api/session/resume")} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
										Resume
									</button>
								)}
								{(reviewRoundStatus === "waiting" || reviewRoundStatus === "agent_stopped") && (
									<button type="button" onClick={() => runAction("/api/session/cancel-waiting")} className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted">
										Cancel waiting
									</button>
								)}
								<button type="button" onClick={() => runAction("/api/session/close")} className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted">
									Close
								</button>
								<p className="text-[10px] leading-snug text-muted-foreground">
									{inputLocked
										? "Navigation and sent annotations stay available while this Review Round waits."
										: "Sends every draft annotation across all assistant responses in one batch."}
								</p>
							</div>
							<AnnotationPanel
								isOpen
								annotations={annotations}
								blocks={blocks}
								onSelect={setSelectedAnnotationId}
								onDelete={(id) => {
									if (sentAnnotations.some((annotation) => annotation.id === id)) return;
									updateDrafts((current) => current.filter((annotation) => annotation.id !== id));
									if (selectedAnnotationId === id) setSelectedAnnotationId(null);
								}}
								onEdit={(id, updates) => {
									if (sentAnnotations.some((annotation) => annotation.id === id)) return;
									updateDrafts((current) => current.map((annotation) => (
										annotation.id === id ? { ...annotation, ...updates } : annotation
									)));
								}}
								selectedId={selectedAnnotationId}
								sharingEnabled={false}
								readOnly={inputLocked}
								width="100%"
							/>
						</aside>
					</div>
				</ScrollViewportProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}
