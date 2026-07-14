import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { ScrollViewportProvider } from "@plannotator/ui/hooks/useScrollViewport";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";

type Message = { messageId: string; text: string; timestamp?: string };
type PlanFile = { path: string; supported: boolean };
type PlanFileSnapshot = PlanFile & { content: string; contentHash: string };
type Selected = { kind: "message"; messageId: string } | { kind: "file"; path: string; contentHash: string } | null;
type ReviewRoundStatus = "open" | "submitting" | "delivery_failed" | "waiting" | "agent_stopped";
type Session = {
	messages: Message[];
	files: PlanFile[];
	selected: Selected;
	fileSnapshots: Record<string, PlanFileSnapshot>;
	draftsByMessageId: Record<string, Annotation[]>;
	sentAnnotationsByMessageId: Record<string, Annotation[]>;
	sentMessageSnapshots: Record<string, Message>;
	draftsByFileSnapshot: Record<string, Annotation[]>;
	sentAnnotationsByFileSnapshot: Record<string, Annotation[]>;
	sentFileSnapshots: Record<string, PlanFileSnapshot>;
	reviewRoundStatus: ReviewRoundStatus;
	deliveryError: string | null;
};

function fileSnapshotKey(path: string, contentHash: string): string {
	return `${path}\u0000${contentHash}`;
}

function FileTree({ files, snapshots, selected, onSelect, annotationCounts }: {
	files: PlanFile[];
	snapshots: Record<string, PlanFileSnapshot>;
	selected: Selected;
	onSelect: (file: PlanFile) => void;
	annotationCounts: Map<string, number>;
}) {
	if (!files.length) return <p className="p-4 text-center text-xs text-muted-foreground">No files found in this Plan Folder.</p>;
	return <div className="space-y-0.5 p-2">{files.map((file) => {
		const snapshot = snapshots[file.path];
		const isSelected = selected?.kind === "file" && selected.path === file.path && !!snapshot && selected.contentHash === snapshot.contentHash;
		const count = snapshot ? annotationCounts.get(fileSnapshotKey(file.path, snapshot.contentHash)) ?? 0 : 0;
		return <button key={file.path} type="button" onClick={() => onSelect(file)} disabled={!file.supported} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50"} disabled:cursor-not-allowed disabled:opacity-60`}>
			<span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
			{!file.supported && <span className="shrink-0 text-[10px] text-muted-foreground">Unsupported</span>}
			{count > 0 && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-primary/30 bg-primary/10 px-1 text-[10px] font-semibold text-primary">{count}</span>}
		</button>;
	})}</div>;
}

export function PlanReviewApp() {
	const [session, setSession] = useState<Session | null>(null);
	const [tab, setTab] = useState<"messages" | "files">("messages");
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [annotationsOpen, setAnnotationsOpen] = useState(false);
	const [desktopLayout, setDesktopLayout] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
	const queue = useRef(Promise.resolve());

	function apply(next: Session) {
		setSession(next);
		if (next.selected?.kind === "file") setTab("files");
	}

	function queueMutation(mutation: () => Promise<void>) {
		queue.current = queue.current.then(mutation).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
	}

	function select(body: unknown) {
		setSelectedAnnotationId(null);
		queueMutation(async () => {
			const response = await fetch("/api/session/selection", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? "Could not select source");
			apply(await response.json() as Session);
		});
	}

	function replaceDrafts(body: unknown, next: Annotation[]) {
		queueMutation(async () => {
			const response = await fetch("/api/session/drafts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body as object, annotations: next }) });
			if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? "Could not save annotations");
			apply(await response.json() as Session);
		});
	}

	function postAction(path: string) {
		queueMutation(async () => {
			const response = await fetch(path, { method: "POST" });
			if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? "Review action failed");
			apply(await response.json() as Session);
		});
	}

	useEffect(() => {
		const query = window.matchMedia("(min-width: 1024px)");
		const update = () => setDesktopLayout(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		let cancelled = false;
		let events: EventSource | null = null;
		fetch("/api/session")
			.then(async (response) => {
				if (!response.ok) throw new Error("Could not load review session");
				return response.json() as Promise<Session>;
			})
			.then((next) => {
				if (cancelled) return;
				apply(next);
				events = new EventSource("/api/session/events");
				events.onmessage = (event) => { if (!cancelled) apply(JSON.parse(event.data) as Session); };
				events.onerror = () => !cancelled && setError("Review updates disconnected. Reconnecting…");
			})
			.catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
		return () => { cancelled = true; events?.close(); };
	}, []);

	const selectedMessageId = session?.selected?.kind === "message" ? session.selected.messageId : null;
	const selectedMessage = selectedMessageId ? session?.messages.find((message) => message.messageId === selectedMessageId) ?? session?.sentMessageSnapshots[selectedMessageId] ?? null : null;
	const selectedFileKey = session?.selected?.kind === "file" ? fileSnapshotKey(session.selected.path, session.selected.contentHash) : null;
	const selectedFile = session?.selected?.kind === "file"
		? session.fileSnapshots[session.selected.path]?.contentHash === session.selected.contentHash
			? session.fileSnapshots[session.selected.path]
			: session.sentFileSnapshots[selectedFileKey!]
		: null;
	const draftAnnotations = selectedMessageId ? session?.draftsByMessageId[selectedMessageId] ?? [] : selectedFileKey ? session?.draftsByFileSnapshot[selectedFileKey] ?? [] : [];
	const sentAnnotations = selectedMessageId ? session?.sentAnnotationsByMessageId[selectedMessageId] ?? [] : selectedFileKey ? session?.sentAnnotationsByFileSnapshot[selectedFileKey] ?? [] : [];
	const annotations = [...sentAnnotations, ...draftAnnotations];
	const markdown = selectedMessage?.text ?? selectedFile?.content ?? "";
	const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);
	const frontmatter = useMemo(() => extractFrontmatter(markdown).frontmatter, [markdown]);
	const selectedIsCurrent = selectedMessageId
		? session?.messages.some((message) => message.messageId === selectedMessageId) ?? false
		: session?.selected?.kind === "file"
			? session.fileSnapshots[session.selected.path]?.contentHash === session.selected.contentHash
			: false;
	const inputLocked = session?.reviewRoundStatus !== "open" || !selectedIsCurrent;
	const draftCount = useMemo(() => {
		if (!session) return 0;
		return [...Object.values(session.draftsByMessageId), ...Object.values(session.draftsByFileSnapshot)].reduce((count, drafts) => count + drafts.length, 0);
	}, [session]);
	const messageAnnotationCounts = useMemo(() => new Map(session?.messages.map((message) => [message.messageId, (session.draftsByMessageId[message.messageId]?.length ?? 0) + (session.sentAnnotationsByMessageId[message.messageId]?.length ?? 0)]) ?? []), [session]);
	const fileAnnotationCounts = useMemo(() => new Map(Object.keys(session?.fileSnapshots ?? {}).map((path) => {
		const snapshot = session!.fileSnapshots[path];
		const key = fileSnapshotKey(path, snapshot.contentHash);
		return [key, (session!.draftsByFileSnapshot[key]?.length ?? 0) + (session!.sentAnnotationsByFileSnapshot[key]?.length ?? 0)];
	})), [session]);
	const historicalMessages = useMemo(() => session ? Object.values(session.sentMessageSnapshots).filter((message) => !session.messages.some((current) => current.messageId === message.messageId)) : [], [session]);
	const historicalFiles = useMemo(() => session ? Object.entries(session.sentFileSnapshots).filter(([key, snapshot]) => {
		const current = session.fileSnapshots[snapshot.path];
		return !current || key !== fileSnapshotKey(current.path, current.contentHash);
	}) : [], [session]);

	function updateDrafts(updater: (current: Annotation[]) => Annotation[]) {
		if (inputLocked || !session?.selected) return;
		const next = updater(draftAnnotations);
		if (session.selected.kind === "message") replaceDrafts({ kind: "message", messageId: session.selected.messageId }, next);
		else replaceDrafts({ kind: "file", path: session.selected.path, contentHash: session.selected.contentHash }, next);
	}

	return <ThemeProvider storageKey="ex-plannotator-plan-theme" colorThemeStorageKey="ex-plannotator-plan-color-theme"><TooltipProvider><ScrollViewportProvider viewport={viewport}>
		<div className="flex min-h-screen flex-col bg-background text-foreground lg:h-screen lg:min-h-0 lg:flex-row">
			<aside className="fixed inset-x-0 top-0 z-20 flex h-52 flex-col overflow-y-auto border-b border-border/50 bg-card lg:static lg:h-auto lg:w-72 lg:shrink-0 lg:border-b-0 lg:border-r">
				<div className="border-b border-border/50 px-4 py-3"><h1 className="text-sm font-semibold">Ex-Plannotator Plan</h1><p className="text-[10px] text-muted-foreground">Messages and Plan Files</p></div>
				<div className="grid grid-cols-2 border-b border-border/50 p-1"><button type="button" onClick={() => setTab("messages")} className={`rounded px-2 py-1.5 text-xs ${tab === "messages" ? "bg-muted font-medium" : "text-muted-foreground"}`}>Messages</button><button type="button" onClick={() => setTab("files")} className={`rounded px-2 py-1.5 text-xs ${tab === "files" ? "bg-muted font-medium" : "text-muted-foreground"}`}>Files</button></div>
				{tab === "messages" ? <div className="space-y-0.5 p-2">{session?.messages.map((message, index) => { const count = messageAnnotationCounts.get(message.messageId) ?? 0; return <button key={message.messageId} type="button" onClick={() => select({ kind: "message", messageId: message.messageId })} className={`flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs ${session.selected?.kind === "message" && session.selected.messageId === message.messageId ? "bg-primary/10 text-primary" : "hover:bg-muted/50"}`}><span className="font-mono text-muted-foreground">#{index + 1}</span><span className="min-w-0 flex-1 line-clamp-2">{message.text}</span>{count > 0 && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-primary/30 bg-primary/10 px-1 text-[10px] font-semibold text-primary">{count}</span>}</button>; })}{historicalMessages.length > 0 && <><p className="px-2 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sent history</p>{historicalMessages.map((message) => <button key={message.messageId} type="button" onClick={() => select({ kind: "message", messageId: message.messageId })} className={`flex w-full items-start gap-2 rounded px-2 py-2 text-left text-xs ${session?.selected?.kind === "message" && session.selected.messageId === message.messageId ? "bg-primary/10 text-primary" : "hover:bg-muted/50"}`}><span className="min-w-0 flex-1 line-clamp-2">{message.text}</span><span className="text-[10px] text-muted-foreground">Sent</span></button>)}</>}</div> : <div><FileTree files={session?.files ?? []} snapshots={session?.fileSnapshots ?? {}} selected={session?.selected ?? null} onSelect={(file) => select({ kind: "file", path: file.path })} annotationCounts={fileAnnotationCounts} />{historicalFiles.length > 0 && <div className="space-y-0.5 px-2 pb-2"><p className="px-2 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sent history</p>{historicalFiles.map(([key, snapshot]) => <button key={key} type="button" onClick={() => select({ kind: "file", path: snapshot.path, contentHash: snapshot.contentHash })} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${session?.selected?.kind === "file" && fileSnapshotKey(session.selected.path, session.selected.contentHash) === key ? "bg-primary/10 text-primary" : "hover:bg-muted/50"}`}><span className="min-w-0 flex-1 truncate font-mono">{snapshot.path}</span><span className="text-[10px] text-muted-foreground">Sent</span></button>)}</div>}</div>}
			</aside>
			<main ref={setViewport} className="min-w-0 flex-1 overflow-y-auto px-4 pb-60 pt-56 sm:px-6 lg:px-6 lg:py-8">
				{error && <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
				{session?.reviewRoundStatus === "waiting" && <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">Waiting for Pi’s next response. Sent annotations remain readable; new annotation input is locked.</div>}
				{session?.reviewRoundStatus === "delivery_failed" && <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-destructive/40 p-3 text-sm text-destructive">Feedback was not delivered{session.deliveryError ? `: ${session.deliveryError}` : ""}. Drafts remain available for retry.</div>}
				{session?.reviewRoundStatus === "agent_stopped" && <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">Pi accepted feedback but stopped before responding. Resume or cancel waiting; do not resend the batch.</div>}
				{session?.reviewRoundStatus === "submitting" && <div className="mx-auto mb-4 max-w-3xl rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary">Sending feedback…</div>}
				{selectedFile === undefined && session?.selected?.kind === "file" ? <div className="py-20 text-center text-sm text-muted-foreground">Loading Plan File…</div> : selectedFile || selectedMessage ? <Viewer key={selectedFile ? `${selectedFile.path}:${selectedFile.contentHash}` : selectedMessage!.messageId} blocks={blocks} markdown={markdown} frontmatter={frontmatter} annotations={annotations} onAddAnnotation={(annotation) => { updateDrafts((current) => [...current, annotation]); setSelectedAnnotationId(annotation.id); }} onSelectAnnotation={setSelectedAnnotationId} selectedAnnotationId={selectedAnnotationId} mode="selection" taterMode={false} disableCodePathValidation maxWidth={900} copyLabel={selectedFile ? "Copy file" : "Copy response"} readOnly={inputLocked} allowImages={false} /> : <div className="py-20 text-center text-sm text-muted-foreground">Loading review sources…</div>}
			</main>
			<aside className="fixed inset-x-0 bottom-0 z-30 max-h-[45vh] overflow-y-auto border-t border-border/50 bg-card lg:static lg:flex lg:max-h-none lg:w-80 lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-l lg:border-t-0">
				<div className="space-y-2 border-b border-border/50 p-3">
					{!desktopLayout && <button type="button" onClick={() => setAnnotationsOpen(true)} className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium">Annotations{annotations.length ? ` (${annotations.length})` : ""}</button>}
					{session?.reviewRoundStatus === "delivery_failed" ? <button type="button" onClick={() => postAction("/api/session/feedback/retry")} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Retry feedback</button> : <button type="button" onClick={() => postAction("/api/session/feedback")} disabled={inputLocked || draftCount === 0} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-45">{session?.reviewRoundStatus === "submitting" ? "Sending feedback…" : `Send feedback${draftCount ? ` (${draftCount})` : ""}`}</button>}
					{session?.reviewRoundStatus === "agent_stopped" && <button type="button" onClick={() => postAction("/api/session/resume")} className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Resume</button>}
					{(session?.reviewRoundStatus === "waiting" || session?.reviewRoundStatus === "agent_stopped") && <button type="button" onClick={() => postAction("/api/session/cancel-waiting")} className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium">Cancel waiting</button>}
					<button type="button" onClick={() => postAction("/api/session/close")} className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium">Close</button>
					<p className="text-[10px] leading-snug text-muted-foreground">One Send feedback action includes every draft annotation across Messages and Files.</p>
				</div>
				<AnnotationPanel isOpen={desktopLayout || annotationsOpen} annotations={annotations} blocks={blocks} onSelect={setSelectedAnnotationId} onDelete={(id) => { if (sentAnnotations.some((annotation) => annotation.id === id)) return; updateDrafts((current) => current.filter((annotation) => annotation.id !== id)); if (selectedAnnotationId === id) setSelectedAnnotationId(null); }} onEdit={(id, updates) => { if (sentAnnotations.some((annotation) => annotation.id === id)) return; updateDrafts((current) => current.map((annotation) => annotation.id === id ? { ...annotation, ...updates } : annotation)); }} onClose={() => setAnnotationsOpen(false)} selectedId={selectedAnnotationId} sharingEnabled={false} readOnly={inputLocked} width="100%" />
			</aside>
		</div>
	</ScrollViewportProvider></TooltipProvider></ThemeProvider>;
}
