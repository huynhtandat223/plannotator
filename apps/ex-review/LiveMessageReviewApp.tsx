import React, { useEffect, useMemo, useState } from "react";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { MessagesBrowser } from "@plannotator/ui/components/sidebar/MessagesBrowser";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { ScrollViewportProvider } from "@plannotator/ui/hooks/useScrollViewport";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";

type Message = { messageId: string; text: string; timestamp?: string };
type SessionResponse = { messages: Message[]; selectedMessageId: string | null };

export function LiveMessageReviewApp() {
	const [messages, setMessages] = useState<Message[]>([]);
	const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
	const [draftsByMessageId, setDraftsByMessageId] = useState<Record<string, Annotation[]>>({});
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [loadingError, setLoadingError] = useState<string | null>(null);

	useEffect(() => {
		void fetch("/api/session")
			.then(async (response) => {
				if (!response.ok) throw new Error(`Session request failed (${response.status})`);
				return response.json() as Promise<SessionResponse>;
			})
			.then((session) => {
				setMessages(session.messages);
				setSelectedMessageId(session.selectedMessageId);
			})
			.catch((error) => setLoadingError(error instanceof Error ? error.message : String(error)));
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
		setDraftsByMessageId((current) => ({
			...current,
			[selectedMessageId]: updater(current[selectedMessageId] ?? []),
		}));
	}

	function selectMessage(messageId: string) {
		setSelectedMessageId(messageId);
		setSelectedAnnotationId(null);
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
							<MessagesBrowser
								messages={messages}
								selectedMessageId={selectedMessageId}
								onSelect={selectMessage}
								annotationCounts={annotationCounts}
							/>
						</aside>

						<main ref={setViewport} className="min-w-0 flex-1 overflow-y-auto px-6 py-8">
							{loadingError ? (
								<div className="mx-auto max-w-3xl rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
									{loadingError}
								</div>
							) : selectedMessage ? (
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
