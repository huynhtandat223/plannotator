export const RECENT_MESSAGE_LIMIT = 25;

export type LiveAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

export type LiveMessageReviewSnapshot = {
	messages: LiveAssistantMessage[];
	selectedMessageId: string | null;
};

export function createLiveMessageReviewSnapshot(
	messages: LiveAssistantMessage[],
): LiveMessageReviewSnapshot {
	const recentMessages = messages.slice(0, RECENT_MESSAGE_LIMIT);
	return {
		messages: recentMessages.map((message) => ({ ...message })),
		selectedMessageId: recentMessages[0]?.messageId ?? null,
	};
}
