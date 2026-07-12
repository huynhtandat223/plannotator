import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { ScrollViewportProvider } from "@plannotator/ui/hooks/useScrollViewport";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";
import { LiveMessagesBrowser, type LiveMessage } from "./LiveMessagesBrowser";

type SessionResponse = {
	messages: LiveMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: string[];
	draftsByMessageId: Record<string, Annotation[]>;
};

async function putSessionState(path: string, body: unknown): Promise<void> {
	const response = await fetch(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`Session update failed (${response.status})`);
}

export function LiveMessageReviewApp() {
	const [messages, setMessages] = useState<LiveMessage[]>([]);
	const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
	const [unreadMessageIds, setUnreadMessageIds] = useState<Set<string>>(new Set());
	const [draftsByMessageId, setDraftsByMessageId] = useState<Record<string, Annotation[]>>({});
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [loadingError, setLoadingError] = useState<string | null>(null);
	const mutationQueue = useRef(Promise.resolve());

	function applySnapshot(session: SessionResponse) {
		setMessages(session.messages);
		setSelectedMessageId(session.selectedMessageId);
		setUnreadMessageIds(new Set(session.unreadMessageIds));
		setDraftsByMessageId(session.draftsByMessageId);
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
	const annotations = selectedMessageId ? draftsByMessageId[selectedMessageId] ?? [] : [];
	const blocks = useMemo(() => parseMarkdownToBlocks(selectedMessage?.text ?? ""), [selectedMessage?.text]);
	const frontmatter = useMemo(
		() => extractFrontmatter(selectedMessage?.text ?? "").frontmatter,
		[selectedMessage?.text],
	);
	const annotationCounts = useMemo(
		() => new Map(Object.entries(draftsByMessageId).map(([messageId, drafts]) => [messageId, drafts.length])),
		[draftsByMessageId],
	);

	function updateDrafts(updater: (current: Annotation[]) => Annotation[]) {
		if (!selectedMessageId) return;
		const messageId = selectedMessageId;
		const currentAnnotations = draftsByMessageId[messageId] ?? [];
		const annotations = updater(currentAnnotations);
		queueMutation(() => putSessionState("/api/session/drafts", { messageId, annotations }));
		setDraftsByMessageId((current) => {
			const next = { ...current };
			if (annotations.length === 0) delete next[messageId];
			else next[messageId] = annotations;
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
								/>
							) : (
								<div className="py-20 text-center text-sm text-muted-foreground">Loading responses…</div>
							)}
						</main>

						<AnnotationPanel
							isOpen
							annotations={annotations}
							blocks={blocks}
							onSelect={setSelectedAnnotationId}
							onDelete={(id) => {
								updateDrafts((current) => current.filter((annotation) => annotation.id !== id));
								if (selectedAnnotationId === id) setSelectedAnnotationId(null);
							}}
							onEdit={(id, updates) => {
								updateDrafts((current) => current.map((annotation) => (
									annotation.id === id ? { ...annotation, ...updates } : annotation
								)));
							}}
							selectedId={selectedAnnotationId}
							sharingEnabled={false}
							width={320}
						/>
					</div>
				</ScrollViewportProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}
