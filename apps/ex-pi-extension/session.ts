export const RECENT_MESSAGE_LIMIT = 25;

export type DraftAnnotation = {
	id: string;
	[key: string]: unknown;
};

export type LiveAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

export type LiveMessageReviewSnapshot = {
	messages: LiveAssistantMessage[];
	selectedMessageId: string | null;
	draftsByMessageId: Record<string, DraftAnnotation[]>;
};

export type LiveMessageReviewState = {
	select(messageId: string): void;
	addDraft(messageId: string, draft: DraftAnnotation): void;
	editDraft(messageId: string, draftId: string, updates: Partial<DraftAnnotation>): void;
	deleteDraft(messageId: string, draftId: string): void;
	setDrafts(messageId: string, drafts: DraftAnnotation[]): void;
	snapshot(): LiveMessageReviewSnapshot;
};

export function createLiveMessageReviewState(
	messages: LiveAssistantMessage[],
): LiveMessageReviewState {
	const recentMessages = messages.slice(0, RECENT_MESSAGE_LIMIT);
	let selectedMessageId = recentMessages[0]?.messageId ?? null;
	const draftsByMessageId = new Map<string, DraftAnnotation[]>();
	const knownMessageIds = new Set(recentMessages.map((message) => message.messageId));

	return {
		select(messageId) {
			if (!knownMessageIds.has(messageId)) return;
			selectedMessageId = messageId;
		},
		addDraft(messageId, draft) {
			if (!knownMessageIds.has(messageId)) return;
			const current = draftsByMessageId.get(messageId) ?? [];
			draftsByMessageId.set(messageId, [...current, { ...draft }]);
		},
		editDraft(messageId, draftId, updates) {
			if (!knownMessageIds.has(messageId)) return;
			const current = draftsByMessageId.get(messageId) ?? [];
			draftsByMessageId.set(
				messageId,
				current.map((draft) => draft.id === draftId ? { ...draft, ...updates } : draft),
			);
		},
		deleteDraft(messageId, draftId) {
			if (!knownMessageIds.has(messageId)) return;
			const current = draftsByMessageId.get(messageId) ?? [];
			draftsByMessageId.set(messageId, current.filter((draft) => draft.id !== draftId));
		},
		setDrafts(messageId, drafts) {
			if (!knownMessageIds.has(messageId)) return;
			draftsByMessageId.set(messageId, drafts.map((draft) => ({ ...draft })));
		},
		snapshot() {
			return {
				messages: recentMessages.map((message) => ({ ...message })),
				selectedMessageId,
				draftsByMessageId: Object.fromEntries(
					Array.from(draftsByMessageId, ([messageId, drafts]) => [
						messageId,
						drafts.map((draft) => ({ ...draft })),
					]),
				),
			};
		},
	};
}
