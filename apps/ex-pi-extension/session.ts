export const RECENT_MESSAGE_LIMIT = 25;

export type LiveAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

export type LiveDraftAnnotation = {
	id: string;
	[key: string]: unknown;
};

export type LiveMessageReviewSnapshot = {
	messages: LiveAssistantMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: string[];
	draftsByMessageId: Record<string, LiveDraftAnnotation[]>;
};

type SnapshotSubscriber = (snapshot: LiveMessageReviewSnapshot) => void;

function uniqueMessages(messages: LiveAssistantMessage[]): LiveAssistantMessage[] {
	const seen = new Set<string>();
	return messages.filter((message) => {
		if (seen.has(message.messageId)) return false;
		seen.add(message.messageId);
		return true;
	});
}

function cloneAnnotations(annotations: LiveDraftAnnotation[]): LiveDraftAnnotation[] {
	return structuredClone(annotations);
}

export function createLiveMessageReviewSnapshot(
	messages: LiveAssistantMessage[],
): LiveMessageReviewSnapshot {
	const recentMessages = uniqueMessages(messages).slice(0, RECENT_MESSAGE_LIMIT);
	return {
		messages: recentMessages.map((message) => ({ ...message })),
		selectedMessageId: recentMessages[0]?.messageId ?? null,
		unreadMessageIds: [],
		draftsByMessageId: {},
	};
}

export class LiveMessageReviewSession {
	private readonly subscribers = new Set<SnapshotSubscriber>();
	private messages: LiveAssistantMessage[];
	private selectedMessageId: string | null;
	private readonly unreadMessageIds = new Set<string>();
	private readonly draftsByMessageId = new Map<string, LiveDraftAnnotation[]>();

	constructor(messages: LiveAssistantMessage[]) {
		const initial = createLiveMessageReviewSnapshot(messages);
		this.messages = initial.messages;
		this.selectedMessageId = initial.selectedMessageId;
	}

	snapshot(): LiveMessageReviewSnapshot {
		return {
			messages: this.messages.map((message) => ({ ...message })),
			selectedMessageId: this.selectedMessageId,
			unreadMessageIds: this.messages
				.filter((message) => this.unreadMessageIds.has(message.messageId))
				.map((message) => message.messageId),
			draftsByMessageId: Object.fromEntries(
				[...this.draftsByMessageId].map(([messageId, annotations]) => [
					messageId,
					cloneAnnotations(annotations),
				]),
			),
		};
	}

	reconcile(activeBranchMessages: LiveAssistantMessage[], activeBranchMessageIds: string[]): void {
		const incoming = uniqueMessages(activeBranchMessages);
		const activeIds = new Set(activeBranchMessageIds);
		const currentIds = new Set(this.messages.map((message) => message.messageId));
		const newMessages = incoming.filter((message) => !currentIds.has(message.messageId));
		const removedMessageIds = this.messages
			.filter((message) => !activeIds.has(message.messageId))
			.map((message) => message.messageId);
		if (newMessages.length === 0 && removedMessageIds.length === 0) return;

		const previousNewestId = this.messages[0]?.messageId ?? null;
		const hasDrafts = [...this.draftsByMessageId.values()].some((annotations) => annotations.length > 0);
		const passivelyWaiting = !hasDrafts && this.selectedMessageId === previousNewestId;
		const incomingIds = new Set(incoming.map((message) => message.messageId));
		this.messages = [
			...incoming.map((message) => ({ ...message })),
			...this.messages.filter((message) => (
				activeIds.has(message.messageId) && !incomingIds.has(message.messageId)
			)),
		];

		for (const messageId of removedMessageIds) {
			this.unreadMessageIds.delete(messageId);
			this.draftsByMessageId.delete(messageId);
		}
		for (const message of newMessages) this.unreadMessageIds.add(message.messageId);
		if (passivelyWaiting && newMessages.length > 0) {
			this.selectedMessageId = newMessages[0].messageId;
		} else if (!this.messages.some((message) => message.messageId === this.selectedMessageId)) {
			this.selectedMessageId = this.messages[0]?.messageId ?? null;
		}
		if (this.selectedMessageId) this.unreadMessageIds.delete(this.selectedMessageId);
		this.publish();
	}

	select(messageId: string): boolean {
		if (!this.messages.some((message) => message.messageId === messageId)) return false;
		const changed = this.selectedMessageId !== messageId || this.unreadMessageIds.has(messageId);
		this.selectedMessageId = messageId;
		this.unreadMessageIds.delete(messageId);
		if (changed) this.publish();
		return true;
	}

	replaceDrafts(messageId: string, annotations: LiveDraftAnnotation[]): boolean {
		if (!this.messages.some((message) => message.messageId === messageId)) return false;
		if (annotations.length === 0) this.draftsByMessageId.delete(messageId);
		else this.draftsByMessageId.set(messageId, cloneAnnotations(annotations));
		this.publish();
		return true;
	}

	subscribe(subscriber: SnapshotSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber(this.snapshot());
		return () => this.subscribers.delete(subscriber);
	}

	close(): void {
		this.subscribers.clear();
	}

	private publish(): void {
		const snapshot = this.snapshot();
		for (const subscriber of this.subscribers) subscriber(snapshot);
	}
}
