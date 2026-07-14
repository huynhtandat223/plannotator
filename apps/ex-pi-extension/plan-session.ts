import { randomUUID } from "node:crypto";
import { exportAnnotations, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";
import {
	formatLiveFeedbackBatch,
	type LiveAssistantMessage,
	type LiveDraftAnnotation,
	type ReviewRoundStatus,
} from "./session.js";
import type { PlanFile, PlanFileSnapshot } from "./plan-folder.js";

export type PlanReviewSelection =
	| { kind: "message"; messageId: string }
	| { kind: "file"; path: string; contentHash: string };

export type PlanFileFeedback = {
	path: string;
	contentHash: string;
	content: string;
	annotations: Annotation[];
};

export type PlanFeedbackBatch = {
	batchId: string;
	messages: Array<{ messageId: string; messageText: string; annotations: Annotation[] }>;
	files: PlanFileFeedback[];
};

export type PlanReviewSnapshot = {
	messages: LiveAssistantMessage[];
	files: PlanFile[];
	selected: PlanReviewSelection | null;
	fileSnapshots: Record<string, PlanFileSnapshot>;
	draftsByMessageId: Record<string, Annotation[]>;
	sentAnnotationsByMessageId: Record<string, Annotation[]>;
	sentMessageSnapshots: Record<string, LiveAssistantMessage>;
	draftsByFileSnapshot: Record<string, Annotation[]>;
	sentAnnotationsByFileSnapshot: Record<string, Annotation[]>;
	sentFileSnapshots: Record<string, PlanFileSnapshot>;
	reviewRoundStatus: ReviewRoundStatus;
	deliveryError: string | null;
};

export type PlanFeedbackDelivery = (batch: PlanFeedbackBatch) => Promise<void> | void;
type SnapshotSubscriber = (snapshot: PlanReviewSnapshot) => void;

export function fileSnapshotKey(path: string, contentHash: string): string {
	return `${path}\u0000${contentHash}`;
}

function cloneAnnotations(annotations: Annotation[]): Annotation[] {
	return structuredClone(annotations);
}

function annotationRecord(annotations: Map<string, Annotation[]>): Record<string, Annotation[]> {
	return Object.fromEntries([...annotations].map(([key, value]) => [key, cloneAnnotations(value)]));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Composes the established Last message formatter with the established document
 * annotation exporter. File content and snapshot hashes remain session-only.
 */
export function formatPlanFeedbackBatch(batch: PlanFeedbackBatch): string {
	const sections: string[] = [`# Feedback Batch: \`${batch.batchId}\``];
	if (batch.messages.length > 0) {
		sections.push(`## Message Feedback\n\n${formatLiveFeedbackBatch({
			batchId: batch.batchId,
			messages: batch.messages.map((message) => ({
				...message,
				annotations: message.annotations as unknown as LiveDraftAnnotation[],
			})),
		})}`);
	}
	if (batch.files.length > 0) {
		const fileFeedback = batch.files.map((file) => {
			const documentFeedback = exportAnnotations(
				parseMarkdownToBlocks(file.content),
				file.annotations,
				[],
				`Feedback for ${file.path}`,
				"plan file",
			);
			return `### ${file.path}\n\n${documentFeedback}`;
		});
		sections.push(`## Plan File Feedback\n\n${fileFeedback.join("\n\n")}`);
	}
	return `${sections.join("\n\n")}\n\nPlease address every feedback item above.`;
}

export class PlanReviewSession {
	private readonly subscribers = new Set<SnapshotSubscriber>();
	private readonly fileSnapshots = new Map<string, PlanFileSnapshot>();
	private readonly draftsByMessageId = new Map<string, Annotation[]>();
	private readonly sentAnnotationsByMessageId = new Map<string, Annotation[]>();
	private readonly sentMessageSnapshots = new Map<string, LiveAssistantMessage>();
	private readonly draftsByFileSnapshot = new Map<string, Annotation[]>();
	private readonly sentAnnotationsByFileSnapshot = new Map<string, Annotation[]>();
	private readonly sentFileSnapshots = new Map<string, PlanFileSnapshot>();
	private failedBatch: PlanFeedbackBatch | null = null;
	private deliveryError: string | null = null;
	private reviewRoundStatus: ReviewRoundStatus = "open";
	private agentStoppedWhileSubmitting = false;
	private pendingRound: { messages: LiveAssistantMessage[]; files: PlanFile[]; readFile: (file: PlanFile) => Promise<PlanFileSnapshot> } | null = null;
	private selected: PlanReviewSelection | null;

	constructor(
		private messages: LiveAssistantMessage[],
		private files: PlanFile[],
		private readFile: (file: PlanFile) => Promise<PlanFileSnapshot>,
	) {
		this.selected = messages[0] ? { kind: "message", messageId: messages[0].messageId } : null;
	}

	snapshot(): PlanReviewSnapshot {
		return {
			messages: this.messages.map((message) => ({ ...message })),
			files: this.files.map((file) => ({ ...file })),
			selected: this.selected ? { ...this.selected } : null,
			fileSnapshots: Object.fromEntries([...this.fileSnapshots].map(([path, snapshot]) => [path, { ...snapshot }])),
			draftsByMessageId: annotationRecord(this.draftsByMessageId),
			sentAnnotationsByMessageId: annotationRecord(this.sentAnnotationsByMessageId),
			sentMessageSnapshots: Object.fromEntries([...this.sentMessageSnapshots].map(([id, message]) => [id, { ...message }])),
			draftsByFileSnapshot: annotationRecord(this.draftsByFileSnapshot),
			sentAnnotationsByFileSnapshot: annotationRecord(this.sentAnnotationsByFileSnapshot),
			sentFileSnapshots: Object.fromEntries([...this.sentFileSnapshots].map(([key, file]) => [key, { ...file }])),
			reviewRoundStatus: this.reviewRoundStatus,
			deliveryError: this.deliveryError,
		};
	}

	selectMessage(messageId: string): boolean {
		if (!this.messages.some((message) => message.messageId === messageId) && !this.sentMessageSnapshots.has(messageId)) return false;
		this.selected = { kind: "message", messageId };
		this.publish();
		return true;
	}

	async selectFile(path: string, contentHash?: string): Promise<boolean> {
		if (contentHash) {
			const sentSnapshot = this.sentFileSnapshots.get(fileSnapshotKey(path, contentHash));
			if (!sentSnapshot) return false;
			this.selected = { kind: "file", path, contentHash };
			this.publish();
			return true;
		}
		const file = this.files.find((candidate) => candidate.path === path);
		if (!file || !file.supported) return false;
		if (!this.fileSnapshots.has(path)) this.fileSnapshots.set(path, await this.readFile(file));
		const snapshot = this.fileSnapshots.get(path)!;
		this.selected = { kind: "file", path, contentHash: snapshot.contentHash };
		this.publish();
		return true;
	}

	replaceMessageDrafts(messageId: string, annotations: Annotation[]): boolean {
		if (this.reviewRoundStatus !== "open" || !this.messages.some((message) => message.messageId === messageId)) return false;
		this.replaceDrafts(this.draftsByMessageId, messageId, annotations);
		this.publish();
		return true;
	}

	replaceFileDrafts(path: string, contentHash: string, annotations: Annotation[]): boolean {
		if (this.reviewRoundStatus !== "open") return false;
		const snapshot = this.fileSnapshots.get(path);
		if (!snapshot || snapshot.contentHash !== contentHash) return false;
		this.replaceDrafts(this.draftsByFileSnapshot, fileSnapshotKey(path, contentHash), annotations);
		this.publish();
		return true;
	}

	async submitFeedback(deliver: PlanFeedbackDelivery): Promise<boolean> {
		if (this.reviewRoundStatus !== "open") return false;
		const messages = this.messages.flatMap((message) => {
			const annotations = this.draftsByMessageId.get(message.messageId);
			return annotations?.length ? [{ messageId: message.messageId, messageText: message.text, annotations: cloneAnnotations(annotations) }] : [];
		});
		const files = [...this.fileSnapshots.values()].flatMap((file) => {
			const annotations = this.draftsByFileSnapshot.get(fileSnapshotKey(file.path, file.contentHash));
			return annotations?.length ? [{ path: file.path, contentHash: file.contentHash, content: file.content, annotations: cloneAnnotations(annotations) }] : [];
		});
		if (messages.length === 0 && files.length === 0) return false;
		return this.deliverFeedback({ batchId: randomUUID(), messages, files }, deliver);
	}

	async retryFeedback(deliver: PlanFeedbackDelivery): Promise<boolean> {
		if (this.reviewRoundStatus !== "delivery_failed" || !this.failedBatch) return false;
		return this.deliverFeedback(this.failedBatch, deliver);
	}

	/** Returns whether a finalized assistant response can advance this completed batch. */
	hasNewResponse(messages: LiveAssistantMessage[]): boolean {
		if (this.reviewRoundStatus !== "waiting" && this.reviewRoundStatus !== "agent_stopped" && this.reviewRoundStatus !== "submitting") return false;
		if (this.pendingRound) return false;
		const currentMessageIds = new Set(this.messages.map((message) => message.messageId));
		return messages.some((message) => !currentMessageIds.has(message.messageId));
	}

	/**
	 * Records the one next round after a genuinely new finalized response.
	 * A response arriving while delivery is still pending is staged and opened
	 * exactly once after acceptance, matching the Last delivery semantics.
	 */
	advanceRound(
		messages: LiveAssistantMessage[],
		files: PlanFile[],
		readFile: (file: PlanFile) => Promise<PlanFileSnapshot>,
	): boolean {
		if (!this.hasNewResponse(messages)) return false;
		const round = {
			messages: messages.map((message) => ({ ...message })),
			files: files.map((file) => ({ ...file })),
			readFile,
		};
		if (this.reviewRoundStatus === "submitting") {
			this.pendingRound = round;
			return true;
		}
		this.openNextRound(round);
		return true;
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

	private replaceDrafts(target: Map<string, Annotation[]>, key: string, annotations: Annotation[]): void {
		if (annotations.length === 0) target.delete(key);
		else target.set(key, cloneAnnotations(annotations));
	}

	private async deliverFeedback(batch: PlanFeedbackBatch, deliver: PlanFeedbackDelivery): Promise<boolean> {
		this.deliveryError = null;
		this.agentStoppedWhileSubmitting = false;
		this.reviewRoundStatus = "submitting";
		this.publish();
		try {
			await deliver(batch);
		} catch (error) {
			this.failedBatch = batch;
			this.pendingRound = null;
			this.deliveryError = errorMessage(error);
			this.agentStoppedWhileSubmitting = false;
			this.reviewRoundStatus = "delivery_failed";
			this.publish();
			throw error;
		}

		this.failedBatch = null;
		this.deliveryError = null;
		for (const message of batch.messages) {
			const previous = this.sentAnnotationsByMessageId.get(message.messageId) ?? [];
			this.sentAnnotationsByMessageId.set(message.messageId, [...previous, ...cloneAnnotations(message.annotations)]);
			const source = this.messages.find((candidate) => candidate.messageId === message.messageId);
			if (source) this.sentMessageSnapshots.set(message.messageId, { ...source });
		}
		for (const file of batch.files) {
			const key = fileSnapshotKey(file.path, file.contentHash);
			const previous = this.sentAnnotationsByFileSnapshot.get(key) ?? [];
			this.sentAnnotationsByFileSnapshot.set(key, [...previous, ...cloneAnnotations(file.annotations)]);
			this.sentFileSnapshots.set(key, { path: file.path, supported: true, content: file.content, contentHash: file.contentHash });
		}
		this.draftsByMessageId.clear();
		this.draftsByFileSnapshot.clear();
		const pendingRound = this.pendingRound;
		this.pendingRound = null;
		if (pendingRound) {
			this.agentStoppedWhileSubmitting = false;
			this.openNextRound(pendingRound);
			return true;
		}
		this.reviewRoundStatus = this.agentStoppedWhileSubmitting ? "agent_stopped" : "waiting";
		this.agentStoppedWhileSubmitting = false;
		this.publish();
		return true;
	}

	private openNextRound(round: { messages: LiveAssistantMessage[]; files: PlanFile[]; readFile: (file: PlanFile) => Promise<PlanFileSnapshot> }): void {
		this.messages = round.messages;
		this.files = round.files;
		this.readFile = round.readFile;
		this.fileSnapshots.clear();
		this.selected = this.messages[0] ? { kind: "message", messageId: this.messages[0].messageId } : null;
		this.deliveryError = null;
		this.reviewRoundStatus = "open";
		this.publish();
	}

	private publish(): void {
		const snapshot = this.snapshot();
		for (const subscriber of this.subscribers) subscriber(snapshot);
	}
}
