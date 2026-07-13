import { randomUUID } from "node:crypto";

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

export type LiveFeedbackBatchMessage = {
	messageId: string;
	messageText: string;
	annotations: LiveDraftAnnotation[];
};

export type LiveFeedbackBatch = {
	batchId: string;
	messages: LiveFeedbackBatchMessage[];
};

export type ReviewRoundStatus = "open" | "submitting" | "delivery_failed" | "waiting" | "agent_stopped";

export type LiveMessageReviewSnapshot = {
	messages: LiveAssistantMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: string[];
	draftsByMessageId: Record<string, LiveDraftAnnotation[]>;
	sentAnnotationsByMessageId: Record<string, LiveDraftAnnotation[]>;
	reviewRoundStatus: ReviewRoundStatus;
	deliveryError: string | null;
};

type SnapshotSubscriber = (snapshot: LiveMessageReviewSnapshot) => void;
type FeedbackDelivery = (batch: LiveFeedbackBatch) => Promise<void> | void;

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function annotationsRecord(
	annotationsByMessageId: Map<string, LiveDraftAnnotation[]>,
): Record<string, LiveDraftAnnotation[]> {
	return Object.fromEntries(
		[...annotationsByMessageId].map(([messageId, annotations]) => [
			messageId,
			cloneAnnotations(annotations),
		]),
	);
}

function quote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function excerpt(text: string, maxChars = 1000): string {
	const trimmed = text.trim();
	return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function stringValue(annotation: LiveDraftAnnotation, key: string): string | undefined {
	const value = annotation[key];
	return typeof value === "string" ? value : undefined;
}

function formatAnnotation(annotation: LiveDraftAnnotation, position: number): string {
	const type = stringValue(annotation, "type");
	const originalText = stringValue(annotation, "originalText") ?? "";
	const comment = stringValue(annotation, "text") ?? "";
	let output = `### ${position}. `;

	if (type === "DELETION") {
		output += `Remove this\n\`\`\`\n${originalText}\n\`\`\`\n> I don't want this in the response.\n`;
	} else if (type === "GLOBAL_COMMENT") {
		output += `General feedback about this response\n> ${comment}\n`;
	} else {
		output += `Feedback on: "${originalText}"\n> ${comment}\n`;
	}

	return output;
}

/**
 * Creates the user message delivered to Pi. Every source response is named by
 * its stable Pi identity and quoted so feedback stays understandable after the
 * conversation moves on to a later response.
 */
export function formatLiveFeedbackBatch(batch: LiveFeedbackBatch): string {
	let output = `# Message Annotations (Feedback Batch: \`${batch.batchId}\`)\n\n`;
	output += "Please address every annotation below. They are grouped by the assistant response where they were created.\n";

	for (const message of batch.messages) {
		output += `\n## Assistant response (Pi message ID: \`${message.messageId}\`)\n\n`;
		output += "This feedback applies to the earlier assistant response excerpted below:\n\n";
		output += `${quote(excerpt(message.messageText))}\n\n`;
		for (const [index, annotation] of message.annotations.entries()) {
			output += `${formatAnnotation(annotation, index + 1)}\n`;
		}
	}

	return `${output}Please address the annotation feedback above.`;
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
		sentAnnotationsByMessageId: {},
		reviewRoundStatus: "open",
		deliveryError: null,
	};
}

export class LiveMessageReviewSession {
	private readonly subscribers = new Set<SnapshotSubscriber>();
	private messages: LiveAssistantMessage[];
	private selectedMessageId: string | null;
	private readonly unreadMessageIds = new Set<string>();
	private readonly draftsByMessageId = new Map<string, LiveDraftAnnotation[]>();
	private readonly sentAnnotationsByMessageId = new Map<string, LiveDraftAnnotation[]>();
	private readonly messagesReceivedWhileSubmitting = new Set<string>();
	private agentStoppedWhileSubmitting = false;
	private failedBatch: LiveFeedbackBatch | null = null;
	private deliveryError: string | null = null;
	private reviewRoundStatus: ReviewRoundStatus = "open";

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
			draftsByMessageId: annotationsRecord(this.draftsByMessageId),
			sentAnnotationsByMessageId: annotationsRecord(this.sentAnnotationsByMessageId),
			reviewRoundStatus: this.reviewRoundStatus,
			deliveryError: this.deliveryError,
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
		const wasSubmitting = this.reviewRoundStatus === "submitting";
		const wasWaitingForAgent = this.reviewRoundStatus === "waiting" || this.reviewRoundStatus === "agent_stopped";
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
			this.sentAnnotationsByMessageId.delete(messageId);
			this.messagesReceivedWhileSubmitting.delete(messageId);
		}
		for (const message of newMessages) {
			this.unreadMessageIds.add(message.messageId);
			if (wasSubmitting) this.messagesReceivedWhileSubmitting.add(message.messageId);
		}
		if (wasWaitingForAgent && newMessages.length > 0) {
			this.reviewRoundStatus = "open";
			this.selectedMessageId = newMessages[0].messageId;
		} else if (passivelyWaiting && newMessages.length > 0) {
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
		if (this.reviewRoundStatus !== "open") return false;
		if (!this.messages.some((message) => message.messageId === messageId)) return false;
		if (annotations.length === 0) this.draftsByMessageId.delete(messageId);
		else this.draftsByMessageId.set(messageId, cloneAnnotations(annotations));
		this.publish();
		return true;
	}

	async submitFeedback(deliver: FeedbackDelivery): Promise<boolean> {
		const messages = this.messages.flatMap((message) => {
			const annotations = this.draftsByMessageId.get(message.messageId);
			return annotations?.length
				? [{ messageId: message.messageId, annotations }]
				: [];
		});
		return this.submitFeedbackBatch(messages, deliver);
	}

	/**
	 * Delivers annotations submitted by a compatible document editor. The
	 * message identity is validated against this review round before it enters
	 * the same retryable delivery state machine as the live-session UI.
	 */
	async submitFeedbackBatch(
		annotationsByMessage: Array<{ messageId: string; annotations: LiveDraftAnnotation[] }>,
		deliver: FeedbackDelivery,
	): Promise<boolean> {
		if (this.reviewRoundStatus !== "open") return false;
		const messagesById = new Map(this.messages.map((message) => [message.messageId, message]));
		const messages: LiveFeedbackBatchMessage[] = [];
		for (const entry of annotationsByMessage) {
			const message = messagesById.get(entry.messageId);
			if (!message || entry.annotations.length === 0) return false;
			const existing = messages.find((candidate) => candidate.messageId === entry.messageId);
			if (existing) existing.annotations.push(...cloneAnnotations(entry.annotations));
			else messages.push({
				messageId: message.messageId,
				messageText: message.text,
				annotations: cloneAnnotations(entry.annotations),
			});
		}
		if (messages.length === 0) return false;
		return this.deliverFeedback({ batchId: randomUUID(), messages }, deliver);
	}

	async retryFeedback(deliver: FeedbackDelivery): Promise<boolean> {
		if (this.reviewRoundStatus !== "delivery_failed" || !this.failedBatch) return false;
		return this.deliverFeedback(this.failedBatch, deliver);
	}

	markAgentStarted(): void {
		if (this.reviewRoundStatus !== "agent_stopped") return;
		this.reviewRoundStatus = "waiting";
		this.publish();
	}

	markAgentStopped(): void {
		if (this.reviewRoundStatus === "submitting") {
			this.agentStoppedWhileSubmitting = true;
			return;
		}
		if (this.reviewRoundStatus !== "waiting") return;
		this.reviewRoundStatus = "agent_stopped";
		this.publish();
	}

	async resumeAgent(resume: () => Promise<void> | void): Promise<boolean> {
		if (this.reviewRoundStatus !== "agent_stopped") return false;
		this.reviewRoundStatus = "waiting";
		this.publish();
		try {
			await resume();
			return true;
		} catch (error) {
			this.reviewRoundStatus = "agent_stopped";
			this.deliveryError = errorMessage(error);
			this.publish();
			throw error;
		}
	}

	cancelWaiting(): boolean {
		if (this.reviewRoundStatus !== "waiting" && this.reviewRoundStatus !== "agent_stopped") return false;
		this.reviewRoundStatus = "open";
		this.deliveryError = null;
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

	private async deliverFeedback(batch: LiveFeedbackBatch, deliver: FeedbackDelivery): Promise<boolean> {
		this.messagesReceivedWhileSubmitting.clear();
		this.agentStoppedWhileSubmitting = false;
		this.deliveryError = null;
		this.reviewRoundStatus = "submitting";
		this.publish();
		try {
			await deliver(batch);
		} catch (error) {
			this.messagesReceivedWhileSubmitting.clear();
			this.agentStoppedWhileSubmitting = false;
			this.failedBatch = batch;
			this.deliveryError = errorMessage(error);
			this.reviewRoundStatus = "delivery_failed";
			this.publish();
			throw error;
		}

		this.failedBatch = null;
		this.deliveryError = null;
		for (const message of batch.messages) {
			const existing = this.sentAnnotationsByMessageId.get(message.messageId) ?? [];
			this.sentAnnotationsByMessageId.set(message.messageId, [
				...existing,
				...cloneAnnotations(message.annotations),
			]);
		}
		this.draftsByMessageId.clear();
		const responseReceivedDuringDelivery = this.messages.find((message) => (
			this.messagesReceivedWhileSubmitting.has(message.messageId)
		));
		this.messagesReceivedWhileSubmitting.clear();
		this.reviewRoundStatus = responseReceivedDuringDelivery
			? "open"
			: this.agentStoppedWhileSubmitting ? "agent_stopped" : "waiting";
		this.agentStoppedWhileSubmitting = false;
		if (responseReceivedDuringDelivery) {
			this.selectedMessageId = responseReceivedDuringDelivery.messageId;
			this.unreadMessageIds.delete(responseReceivedDuringDelivery.messageId);
		}
		this.publish();
		return true;
	}

	private publish(): void {
		const snapshot = this.snapshot();
		for (const subscriber of this.subscribers) subscriber(snapshot);
	}
}
