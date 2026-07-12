import React from "react";

export type LiveMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

type LiveMessagesBrowserProps = {
	messages: LiveMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: Set<string>;
	onSelect: (messageId: string) => void;
	annotationCounts: Map<string, number>;
};

const PREVIEW_MAX_CHARS = 140;

function previewText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > PREVIEW_MAX_CHARS
		? `${normalized.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
		: normalized;
}

function formatTimestamp(timestamp?: string): string | null {
	if (!timestamp) return null;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString([], {
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
		day: "numeric",
	});
}

export function LiveMessagesBrowser({
	messages,
	selectedMessageId,
	unreadMessageIds,
	onSelect,
	annotationCounts,
}: LiveMessagesBrowserProps) {
	if (messages.length === 0) {
		return <div className="p-4 text-center text-xs text-muted-foreground">No assistant messages found.</div>;
	}

	return (
		<div className="p-2">
			<div className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				Assistant responses — newest first
			</div>
			<div className="space-y-0.5">
				{messages.map((message, index) => {
					const isSelected = message.messageId === selectedMessageId;
					const isUnread = unreadMessageIds.has(message.messageId);
					const timestamp = formatTimestamp(message.timestamp);
					const annotationCount = annotationCounts.get(message.messageId) ?? 0;
					return (
						<button
							key={message.messageId}
							type="button"
							onClick={() => onSelect(message.messageId)}
							className={`flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${
								isSelected
									? "border-primary/30 bg-primary/10 text-primary"
									: "border-transparent text-foreground hover:bg-muted/50"
							}`}
						>
							<span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] text-muted-foreground">
								#{index + 1}{index === 0 ? " ★" : ""}
							</span>
							<span className="min-w-0 flex-1">
								<span className="line-clamp-2 leading-snug">{previewText(message.text)}</span>
								{timestamp && <span className="mt-0.5 block text-[10px] text-muted-foreground">{timestamp}</span>}
							</span>
							{isUnread && (
								<span
									className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary"
									title="Unread response"
									aria-label="Unread response"
								/>
							)}
							{annotationCount > 0 && (
								<span
									className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 px-1 text-[10px] font-semibold text-primary"
									title={`${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`}
								>
									{annotationCount}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
