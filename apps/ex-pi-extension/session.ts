import { randomUUID } from "node:crypto";

export const LIVE_RESPONSE_HISTORY_LIMIT = 4;

export type LiveAssistantMessage = {
	messageId: string;
	text: string;
	timestamp?: string;
};

export type LiveDraftAnnotation = {
	id: string;
	[key: string]: unknown;
};

export type LiveCodeDraftAnnotation = LiveDraftAnnotation & {
	filePath?: string;
	lineStart?: number;
	lineEnd?: number;
	originalCode?: string;
};

export type LiveFeedbackBatchMessage = {
	messageId: string;
	messageText: string;
	annotations: LiveDraftAnnotation[];
	codeAnnotations?: LiveCodeDraftAnnotation[];
};

export type LiveFeedbackBatch = {
	batchId: string;
	messages: LiveFeedbackBatchMessage[];
};

export type ReviewRoundStatus = "open" | "submitting" | "delivery_failed" | "waiting" | "agent_stopped";

export type LiveMessageReviewSnapshot = {
	/** Current compact response picker, ordered oldest to newest for display. */
	messages: LiveAssistantMessage[];
	selectedMessageId: string | null;
	unreadMessageIds: string[];
	draftsByMessageId: Record<string, LiveDraftAnnotation[]>;
	codeDraftsByMessageId: Record<string, LiveCodeDraftAnnotation[]>;
	sentAnnotationsByMessageId: Record<string, LiveDraftAnnotation[]>;
	sentCodeAnnotationsByMessageId: Record<string, LiveCodeDraftAnnotation[]>;
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

function formatCodeAnnotation(annotation: LiveCodeDraftAnnotation, position: number): string {
	const filePath = stringValue(annotation, "filePath") ?? "referenced code";
	const lineStart = typeof annotation.lineStart === "number" ? annotation.lineStart : undefined;
	const lineEnd = typeof annotation.lineEnd === "number" ? annotation.lineEnd : lineStart;
	const lineRange = lineStart === undefined
		? ""
		: lineEnd === lineStart ? ` (line ${lineStart})` : ` (lines ${lineStart}-${lineEnd})`;
	const originalCode = stringValue(annotation, "originalCode");
	const comment = stringValue(annotation, "text") ?? "";
	let output = `### Code feedback ${position}. ${filePath}${lineRange}\n`;
	if (originalCode) output += `\`\`\`\n${originalCode}\n\`\`\`\n`;
	if (comment) output += `> ${comment}\n`;
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
		for (const [index, annotation] of (message.codeAnnotations ?? []).entries()) {
			output += `${formatCodeAnnotation(annotation, index + 1)}\n`;
		}
	}

	return `${output}Please address the annotation feedback above.`;
}

export function createLiveMessageReviewSnapshot(
	messages: LiveAssistantMessage[],
): LiveMessageReviewSnapshot {
	// Pi exposes the active branch newest-first. Keep the live picker compact
	// and chronological, with the newest response selected below.
	const recentMessages = uniqueMessages(messages)
		.slice(0, LIVE_RESPONSE_HISTORY_LIMIT)
		.reverse();
	return {
		messages: recentMessages.map((message) => ({ ...message })),
		selectedMessageId: recentMessages.at(-1)?.messageId ?? null,
		unreadMessageIds: [],
		draftsByMessageId: {},
		codeDraftsByMessageId: {},
		sentAnnotationsByMessageId: {},
		sentCodeAnnotationsByMessageId: {},
		reviewRoundStatus: "open",
		deliveryError: null,
	};
}

export class LiveMessageReviewSession {
	private readonly subscribers = new Set<SnapshotSubscriber>();
	/** Retains sources with existing drafts outside the compact visible picker. */
	private readonly messageSnapshots = new Map<string, LiveAssistantMessage>();
	private messages: LiveAssistantMessage[];
	private selectedMessageId: string | null;
	private readonly unreadMessageIds = new Set<string>();
	private readonly draftsByMessageId = new Map<string, LiveDraftAnnotation[]>();
	private readonly codeDraftsByMessageId = new Map<string, LiveCodeDraftAnnotation[]>();
	private readonly sentAnnotationsByMessageId = new Map<string, LiveDraftAnnotation[]>();
	private readonly sentCodeAnnotationsByMessageId = new Map<string, LiveCodeDraftAnnotation[]>();
	private readonly messagesReceivedWhileSubmitting = new Set<string>();
	private agentStoppedWhileSubmitting = false;
	private failedBatch: LiveFeedbackBatch | null = null;
	private deliveryError: string | null = null;
	private reviewRoundStatus: ReviewRoundStatus = "open";

	constructor(messages: LiveAssistantMessage[]) {
		const initial = createLiveMessageReviewSnapshot(messages);
		for (const message of initial.messages) this.messageSnapshots.set(message.messageId, { ...message });
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
			codeDraftsByMessageId: annotationsRecord(this.codeDraftsByMessageId),
			sentAnnotationsByMessageId: annotationsRecord(this.sentAnnotationsByMessageId),
			sentCodeAnnotationsByMessageId: annotationsRecord(this.sentCodeAnnotationsByMessageId),
			reviewRoundStatus: this.reviewRoundStatus,
			deliveryError: this.deliveryError,
		};
	}

	reconcile(activeBranchMessages: LiveAssistantMessage[], activeBranchMessageIds: string[]): void {
		const activeMessages = uniqueMessages(activeBranchMessages);
		const incoming = activeMessages.slice(0, LIVE_RESPONSE_HISTORY_LIMIT);
		const activeIds = new Set(activeBranchMessageIds);
		// Compare against every retained source, not just the four visible rows.
		// A response returning to the compact picker is not a new arrival.
		const newMessages = incoming.filter((message) => !this.messageSnapshots.has(message.messageId));
		const retainedStateIds = new Set([
			...this.messageSnapshots.keys(),
			...this.draftsByMessageId.keys(),
			...this.codeDraftsByMessageId.keys(),
			...this.sentAnnotationsByMessageId.keys(),
			...this.sentCodeAnnotationsByMessageId.keys(),
			...(this.failedBatch?.messages.map((message) => message.messageId) ?? []),
		]);
		const removedMessageIds = [...retainedStateIds].filter((messageId) => !activeIds.has(messageId));
		const visibleMessagesChanged = incoming.length !== this.messages.length || incoming.some((message, index) => {
			const current = this.messages[this.messages.length - index - 1];
			return !current || current.messageId !== message.messageId || current.text !== message.text || current.timestamp !== message.timestamp;
		});
		if (newMessages.length === 0 && removedMessageIds.length === 0 && !visibleMessagesChanged) return;

		const wasOpen = this.reviewRoundStatus === "open";
		const wasSubmitting = this.reviewRoundStatus === "submitting";
		const wasWaitingForAgent = this.reviewRoundStatus === "waiting" || this.reviewRoundStatus === "agent_stopped";
		for (const message of incoming) this.messageSnapshots.set(message.messageId, { ...message });
		this.messages = incoming
			.reverse()
			.map((message) => ({ ...message }));

		for (const messageId of removedMessageIds) {
			this.unreadMessageIds.delete(messageId);
			this.draftsByMessageId.delete(messageId);
			this.codeDraftsByMessageId.delete(messageId);
			this.sentAnnotationsByMessageId.delete(messageId);
			this.sentCodeAnnotationsByMessageId.delete(messageId);
			this.messageSnapshots.delete(messageId);
			this.messagesReceivedWhileSubmitting.delete(messageId);
		}
		for (const message of newMessages) {
			this.unreadMessageIds.add(message.messageId);
			if (wasSubmitting) this.messagesReceivedWhileSubmitting.add(message.messageId);
		}
		const retainedMessageIds = new Set([
			...this.messages.map((message) => message.messageId),
			...this.draftsByMessageId.keys(),
			...this.codeDraftsByMessageId.keys(),
			...(this.failedBatch?.messages.map((message) => message.messageId) ?? []),
		]);
		for (const messageId of this.messageSnapshots.keys()) {
			if (!retainedMessageIds.has(messageId)) this.messageSnapshots.delete(messageId);
		}
		const newestArrival = newMessages[0];
		if (newestArrival && (wasWaitingForAgent || wasOpen)) {
			// An open live review follows a completed assistant response so it is
			// immediately editable; existing drafts remain keyed to their source.
			if (wasWaitingForAgent) this.reviewRoundStatus = "open";
			this.selectedMessageId = newestArrival.messageId;
		} else if (!this.messages.some((message) => message.messageId === this.selectedMessageId)) {
			this.selectedMessageId = this.messages.at(-1)?.messageId ?? null;
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

	replaceDrafts(
		messageId: string,
		annotations: LiveDraftAnnotation[],
		codeAnnotations: LiveCodeDraftAnnotation[] = [],
	): boolean {
		if (this.reviewRoundStatus !== "open") return false;
		if (!this.messageSnapshots.has(messageId)) return false;
		if (annotations.length === 0) this.draftsByMessageId.delete(messageId);
		else this.draftsByMessageId.set(messageId, cloneAnnotations(annotations));
		if (codeAnnotations.length === 0) this.codeDraftsByMessageId.delete(messageId);
		else this.codeDraftsByMessageId.set(messageId, cloneAnnotations(codeAnnotations));
		this.publish();
		return true;
	}

	async submitFeedback(deliver: FeedbackDelivery): Promise<boolean> {
		const sourceIds = new Set([
			...this.draftsByMessageId.keys(),
			...this.codeDraftsByMessageId.keys(),
		]);
		const messages = [...sourceIds].flatMap((messageId) => {
			const annotations = this.draftsByMessageId.get(messageId) ?? [];
			const codeAnnotations = this.codeDraftsByMessageId.get(messageId) ?? [];
			return annotations.length || codeAnnotations.length
				? [{ messageId, annotations, ...(codeAnnotations.length ? { codeAnnotations } : {}) }]
				: [];
		});
		return this.submitFeedbackBatch(messages, deliver, true);
	}

	/**
	 * Delivers annotations submitted by a compatible document editor. The
	 * message identity is validated against this review round before it enters
	 * the same retryable delivery state machine as the live-session UI.
	 */
	async submitFeedbackBatch(
		annotationsByMessage: Array<{
			messageId: string;
			annotations: LiveDraftAnnotation[];
			codeAnnotations?: LiveCodeDraftAnnotation[];
		}>,
		deliver: FeedbackDelivery,
		includeRetainedSources = false,
	): Promise<boolean> {
		if (this.reviewRoundStatus !== "open") return false;
		const messagesById = includeRetainedSources ? this.messageSnapshots : new Map(this.messages.map((message) => [message.messageId, message]));
		const messages: LiveFeedbackBatchMessage[] = [];
		for (const entry of annotationsByMessage) {
			const message = messagesById.get(entry.messageId);
			const codeAnnotations = entry.codeAnnotations ?? [];
			if (!message || (entry.annotations.length === 0 && codeAnnotations.length === 0)) return false;
			const existing = messages.find((candidate) => candidate.messageId === entry.messageId);
			if (existing) {
				existing.annotations.push(...cloneAnnotations(entry.annotations));
				(existing.codeAnnotations ??= []).push(...cloneAnnotations(codeAnnotations));
			} else messages.push({
				messageId: message.messageId,
				messageText: message.text,
				annotations: cloneAnnotations(entry.annotations),
				...(codeAnnotations.length ? { codeAnnotations: cloneAnnotations(codeAnnotations) } : {}),
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
			if (message.codeAnnotations?.length) {
				const existingCode = this.sentCodeAnnotationsByMessageId.get(message.messageId) ?? [];
				this.sentCodeAnnotationsByMessageId.set(message.messageId, [
					...existingCode,
					...cloneAnnotations(message.codeAnnotations),
				]);
			}
		}
		for (const message of batch.messages) {
			this.draftsByMessageId.delete(message.messageId);
			this.codeDraftsByMessageId.delete(message.messageId);
		}
		const responseReceivedDuringDelivery = [...this.messages].reverse().find((message) => (
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
