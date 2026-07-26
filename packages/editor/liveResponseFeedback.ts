import type { Annotation, CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';

export interface LiveResponseFeedbackPayload {
  draftGeneration: number;
  feedback: string;
  annotations: Annotation[];
  codeAnnotations: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  selectedMessageId: string;
  feedbackScope?: 'messages';
}

/**
 * What the host reports about how a live send actually travelled. Extension
 * (Pi) deliveries return no mechanism and keep their existing messaging;
 * `herdr-composer` deliveries additionally say whether a turn start was
 * observed, and the UI must relay that instead of claiming extension-grade
 * delivery.
 */
export interface LiveDeliveryReceipt {
  mechanism?: string;
  confirmed?: boolean;
  note?: string;
}

/** The toast the UI should show for a live send, honest about the mechanism in play. */
export function describeLiveDelivery(
  receipt: LiveDeliveryReceipt,
  agentLabel: string,
  sentWhat: 'message' | 'feedback',
): { title: string; description: string; warning: boolean } | null {
  if (receipt.mechanism !== 'herdr-composer') return null;
  if (receipt.confirmed) {
    return {
      title: sentWhat === 'message' ? `Message typed into the ${agentLabel} pane` : `Feedback typed into the ${agentLabel} pane`,
      description: 'Herdr confirmed the agent started a turn.',
      warning: false,
    };
  }
  return {
    title: sentWhat === 'message' ? 'Message typed, but unconfirmed' : 'Feedback typed, but unconfirmed',
    description: receipt.note
      || 'The text was typed into the pane’s composer, but no turn start was observed. Check the pane before resending — resending may deliver it twice.',
    warning: true,
  };
}

/** Submit one structured assistant response's retryable feedback batch. */
export async function submitLiveResponseFeedback(
  payload: LiveResponseFeedbackPayload,
  fetcher: typeof fetch = fetch,
): Promise<LiveDeliveryReceipt> {
  const response = await fetcher('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.ok) {
    return await response.json().catch(() => ({})) as LiveDeliveryReceipt;
  }
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || 'Failed to send feedback');
}
