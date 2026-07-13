// PROTOTYPE — throwaway UI for choosing the /ex-plannotator-plan source navigation.
// Three variants, switchable with ?variant=A|B|C on /prototype.html.
import React, { useEffect, useMemo, useState } from "react";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { ThemeProvider } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { ScrollViewportProvider } from "@plannotator/ui/hooks/useScrollViewport";
import { extractFrontmatter, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import { AnnotationType, type Annotation } from "@plannotator/ui/types";

type Source = {
	id: string;
	kind: "response" | "file";
	label: string;
	meta: string;
	text: string;
	unread?: boolean;
};

type Variant = "A" | "B" | "C";

const sources: Source[] = [
	{
		id: "response-1",
		kind: "response",
		label: "Latest response",
		meta: "Today, 11:42 PM",
		unread: true,
		text: `# Implementation approach\n\nI reviewed the plan folder and recommend starting with the session contract before wiring filesystem synchronization.\n\n## Proposed sequence\n\n1. Model response and plan-file sources with stable identities.\n2. Keep drafts scoped to the source where they were created.\n3. Submit all drafts together as one feedback batch.\n\nThe existing \`/ex-plannotator-last\` lifecycle remains untouched.`,
	},
	{
		id: "response-2",
		kind: "response",
		label: "Previous response",
		meta: "Today, 11:35 PM",
		text: `# Folder scan findings\n\nThe plan folder contains three reviewable documents. I found no need to modify Official Plannotator modules.`,
	},
	{
		id: "file-1",
		kind: "file",
		label: "overview.md",
		meta: "plan/overview.md",
		text: `# Ex-Plannotator Plan\n\n## Goal\n\nReview agent responses and planning documents in one persistent browser session.\n\n## Principles\n\n- Plan files are read-only in the browser.\n- The agent applies requested changes.\n- Existing Ex-Plannotator behavior must not regress.`,
	},
	{
		id: "file-2",
		kind: "file",
		label: "session-contract.md",
		meta: "plan/design/session-contract.md",
		text: `# Mixed-source session contract\n\nA review source is either a completed assistant response or a versioned snapshot of a plan file.\n\nDraft annotations stay editable until the reviewer sends the feedback batch.`,
	},
	{
		id: "file-3",
		kind: "file",
		label: "ui-notes.mdx",
		meta: "plan/design/ui-notes.mdx",
		text: `# UI notes\n\nUse the same selection, comment, redline, and annotation-panel interactions for both source types.\n\n> The reviewer should always know which source an annotation belongs to.`,
	},
];

function countFor(sourceId: string, drafts: Record<string, Annotation[]>): number {
	return drafts[sourceId]?.length ?? 0;
}

function SourceButton({
	source,
	selected,
	count,
	onSelect,
	compact = false,
}: {
	source: Source;
	selected: boolean;
	count: number;
	onSelect: () => void;
	compact?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`flex w-full items-start gap-2 rounded-md border text-left transition-colors ${compact ? "px-2 py-1.5" : "px-3 py-2.5"} ${
				selected ? "border-primary/30 bg-primary/10" : "border-transparent hover:bg-muted/60"
			}`}
		>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2 text-xs font-medium">
					<span className="truncate">{source.label}</span>
					{source.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
				</span>
				<span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{source.meta}</span>
			</span>
			{count > 0 && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">{count}</span>}
		</button>
	);
}

function Header({ draftCount }: { draftCount: number }) {
	return (
		<header className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 bg-card px-4">
			<div>
				<h1 className="text-sm font-semibold">Ex-Plannotator Plan</h1>
				<p className="text-[10px] text-muted-foreground">plan/ · 2 responses · 3 plan files</p>
			</div>
			<div className="flex items-center gap-3">
				<span className="text-[10px] text-muted-foreground">All source drafts are included</span>
				<button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
					Send feedback{draftCount ? ` (${draftCount})` : ""}
				</button>
			</div>
		</header>
	);
}

function VariantA({
	selected,
	select,
	drafts,
	draftCount,
	viewer,
	panel,
}: VariantProps) {
	const [tab, setTab] = useState<Source["kind"]>(selected.kind);
	const visible = sources.filter((source) => source.kind === tab);
	function choose(source: Source) {
		select(source);
	}
	return (
		<div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
			<Header draftCount={draftCount} />
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-72 shrink-0 flex-col border-r border-border/50 bg-card">
					<div className="grid grid-cols-2 border-b border-border/50 p-2">
						{(["response", "file"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								onClick={() => setTab(kind)}
								className={`rounded px-2 py-1.5 text-xs font-medium ${tab === kind ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
							>
								{kind === "response" ? "Agent responses" : "Plan files"}
							</button>
						))}
					</div>
					<div className="flex-1 overflow-y-auto p-2">
						{tab === "file" && <p className="px-2 pb-2 text-[10px] text-muted-foreground">Recursive from plan/</p>}
						{visible.map((source) => (
							<SourceButton key={source.id} source={source} selected={selected.id === source.id} count={countFor(source.id, drafts)} onSelect={() => choose(source)} />
						))}
					</div>
				</aside>
				{viewer}
				{panel}
			</div>
		</div>
	);
}

function VariantB({ selected, select, drafts, draftCount, viewer, panel }: VariantProps) {
	return (
		<div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
			<Header draftCount={draftCount} />
			<div className="flex min-h-0 flex-1 flex-col">
				<nav className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-border/50 bg-card px-3">
					{sources.map((source) => (
						<button
							key={source.id}
							type="button"
							onClick={() => select(source)}
							className={`flex h-9 max-w-48 items-center gap-2 rounded-t-md border-x border-t px-3 text-xs ${selected.id === source.id ? "border-border bg-background" : "border-transparent text-muted-foreground hover:bg-muted/50"}`}
						>
							<span>{source.kind === "response" ? "●" : "◇"}</span>
							<span className="truncate">{source.label}</span>
							{countFor(source.id, drafts) > 0 && <span className="text-primary">{countFor(source.id, drafts)}</span>}
						</button>
					))}
				</nav>
				<div className="flex min-h-0 flex-1">
					<div className="flex w-14 shrink-0 flex-col items-center gap-3 border-r border-border/50 bg-card py-3 text-[10px] text-muted-foreground">
						<div className="rounded bg-primary/10 px-2 py-1 text-primary">{selected.kind === "response" ? "AI" : "MD"}</div>
						<span className="[writing-mode:vertical-rl]">{selected.kind === "response" ? "Agent response" : "Plan file"}</span>
					</div>
					{viewer}
					{panel}
				</div>
			</div>
		</div>
	);
}

function VariantC({ selected, select, drafts, draftCount, viewer, panel }: VariantProps) {
	return (
		<div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
			<Header draftCount={draftCount} />
			<div className="flex min-h-0 flex-1">
				<aside className="w-80 shrink-0 overflow-y-auto border-r border-border/50 bg-card p-3">
					<section>
						<div className="mb-2 flex items-center justify-between px-2">
							<h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Agent responses</h2>
							<span className="text-[10px] text-muted-foreground">2</span>
						</div>
						{sources.filter((source) => source.kind === "response").map((source) => (
							<SourceButton compact key={source.id} source={source} selected={selected.id === source.id} count={countFor(source.id, drafts)} onSelect={() => select(source)} />
						))}
					</section>
					<section className="mt-5 border-t border-border/50 pt-4">
						<div className="mb-2 flex items-center justify-between px-2">
							<div>
								<h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Plan files</h2>
								<p className="mt-0.5 font-mono text-[9px] text-muted-foreground">plan/</p>
							</div>
							<span className="text-[10px] text-muted-foreground">3</span>
						</div>
						{sources.filter((source) => source.kind === "file").map((source) => (
							<SourceButton compact key={source.id} source={source} selected={selected.id === source.id} count={countFor(source.id, drafts)} onSelect={() => select(source)} />
						))}
					</section>
				</aside>
				{viewer}
				{panel}
			</div>
		</div>
	);
}

type VariantProps = {
	selected: Source;
	select: (source: Source) => void;
	drafts: Record<string, Annotation[]>;
	draftCount: number;
	viewer: React.ReactNode;
	panel: React.ReactNode;
};

const variants: { key: Variant; name: string }[] = [
	{ key: "A", name: "Two source tabs" },
	{ key: "B", name: "Document tab strip" },
	{ key: "C", name: "Unified source rail" },
];

function currentVariant(): Variant {
	const value = new URLSearchParams(window.location.search).get("variant");
	return value === "B" || value === "C" ? value : "A";
}

function PrototypeSwitcher({ variant, onChange }: { variant: Variant; onChange: (variant: Variant) => void }) {
	const index = variants.findIndex((item) => item.key === variant);
	function cycle(delta: number) {
		onChange(variants[(index + delta + variants.length) % variants.length].key);
	}
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			if (target?.matches("input, textarea, [contenteditable]")) return;
			if (event.key === "ArrowLeft") cycle(-1);
			if (event.key === "ArrowRight") cycle(1);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});
	return (
		<div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-950 px-2 py-2 text-white shadow-2xl ring-1 ring-white/20">
			<button type="button" onClick={() => cycle(-1)} className="rounded-full px-3 py-1 hover:bg-white/15" aria-label="Previous variant">←</button>
			<span className="min-w-44 text-center text-xs font-medium">{variant} — {variants[index].name}</span>
			<button type="button" onClick={() => cycle(1)} className="rounded-full px-3 py-1 hover:bg-white/15" aria-label="Next variant">→</button>
		</div>
	);
}

export function PlanReviewPrototype() {
	const [variant, setVariant] = useState<Variant>(currentVariant);
	const [selected, setSelected] = useState(sources[0]);
	const [drafts, setDrafts] = useState<Record<string, Annotation[]>>({
		"response-2": [{
			id: "sample-response-note",
			blockId: "",
			startOffset: 0,
			endOffset: 0,
			type: AnnotationType.COMMENT,
			text: "Keep this isolation guarantee explicit.",
			originalText: "no need to modify Official Plannotator modules",
			createdA: Date.now() - 10_000,
		}],
		"file-2": [{
			id: "sample-file-note",
			blockId: "",
			startOffset: 0,
			endOffset: 0,
			type: AnnotationType.COMMENT,
			text: "Define the stable file-version identity here.",
			originalText: "versioned snapshot of a plan file",
			createdA: Date.now() - 5_000,
		}],
	});
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const blocks = useMemo(() => parseMarkdownToBlocks(selected.text), [selected.text]);
	const frontmatter = useMemo(() => extractFrontmatter(selected.text).frontmatter, [selected.text]);
	const annotations = drafts[selected.id] ?? [];
	const draftCount = Object.values(drafts).reduce((total, items) => total + items.length, 0);

	function changeVariant(next: Variant) {
		const url = new URL(window.location.href);
		url.searchParams.set("variant", next);
		window.history.replaceState(null, "", url);
		setVariant(next);
	}
	function select(source: Source) {
		setSelected(source);
		setSelectedAnnotationId(null);
	}
	function updateAnnotations(next: Annotation[]) {
		setDrafts((current) => ({ ...current, [selected.id]: next }));
	}

	const viewer = (
		<main ref={setViewport} className="min-w-0 flex-1 overflow-y-auto px-6 py-8">
			<div className="mx-auto mb-3 flex max-w-[900px] items-center justify-between rounded-md border border-border/50 bg-card px-3 py-2">
				<div>
					<span className="text-[10px] font-semibold uppercase tracking-wider text-primary">{selected.kind === "response" ? "Agent response" : "Plan file"}</span>
					<p className="font-mono text-[10px] text-muted-foreground">{selected.meta}</p>
				</div>
				{selected.kind === "file" && <span className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground">Read-only</span>}
			</div>
			<Viewer
				key={selected.id}
				blocks={blocks}
				markdown={selected.text}
				frontmatter={frontmatter}
				annotations={annotations}
				onAddAnnotation={(annotation) => {
					updateAnnotations([...annotations, annotation]);
					setSelectedAnnotationId(annotation.id);
				}}
				onSelectAnnotation={setSelectedAnnotationId}
				selectedAnnotationId={selectedAnnotationId}
				mode="selection"
				taterMode={false}
				disableCodePathValidation
				maxWidth={900}
				copyLabel={selected.kind === "file" ? "Copy file" : "Copy response"}
			/>
		</main>
	);
	const panel = (
		<aside className="flex w-80 shrink-0 flex-col border-l border-border/50 bg-card">
			<div className="border-b border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
				Showing annotations for <strong className="text-foreground">{selected.label}</strong>. Send feedback includes {draftCount} draft{draftCount === 1 ? "" : "s"} across all sources.
			</div>
			<AnnotationPanel
				isOpen
				annotations={annotations}
				blocks={blocks}
				onSelect={setSelectedAnnotationId}
				onDelete={(id) => updateAnnotations(annotations.filter((annotation) => annotation.id !== id))}
				onEdit={(id, updates) => updateAnnotations(annotations.map((annotation) => annotation.id === id ? { ...annotation, ...updates } : annotation))}
				selectedId={selectedAnnotationId}
				sharingEnabled={false}
				width="100%"
			/>
		</aside>
	);
	const props = { selected, select, drafts, draftCount, viewer, panel };

	return (
		<ThemeProvider storageKey="ex-plan-prototype-theme" colorThemeStorageKey="ex-plan-prototype-color-theme">
			<TooltipProvider>
				<ScrollViewportProvider viewport={viewport}>
					{variant === "A" && <VariantA {...props} />}
					{variant === "B" && <VariantB {...props} />}
					{variant === "C" && <VariantC {...props} />}
					<PrototypeSwitcher variant={variant} onChange={changeVariant} />
				</ScrollViewportProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}
