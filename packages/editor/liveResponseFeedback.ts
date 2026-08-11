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

/**
 * The receipt for a send whose delivery mechanism the caller already knows from
 * the capability registry — used by surfaces that must show a result inline
 * rather than only as a toast.
 *
 * Composer kinds reuse {@link describeLiveDelivery} verbatim, so there is one
 * confirmed/unconfirmed vocabulary rather than two. What this adds is the
 * extension case, which `describeLiveDelivery` deliberately leaves to its
 * callers: the host answers a Pi send with `{ ok, deliveryId }` and nothing
 * more, so the only honest word is **queued**. "Sent", "received" or
 * "delivered" would each claim an acknowledgement that does not exist — the
 * extension claims the item out-of-band and never reports back to the browser.
 */
export function describeLiveSendReceipt(
  receipt: LiveDeliveryReceipt,
  agentLabel: string,
  mechanism: 'pi-extension' | 'herdr-composer' | null,
  sentWhat: 'message' | 'feedback' = 'message',
): { title: string; description: string; warning: boolean } {
  const composer = describeLiveDelivery(receipt, agentLabel, sentWhat);
  if (composer) return composer;
  if (mechanism === 'pi-extension') {
    return {
      title: sentWhat === 'message' ? `Message queued for ${agentLabel}` : `Feedback queued for ${agentLabel}`,
      description: `Queued for the selected ${agentLabel} session. Plannotator cannot see the session claim it, so this is not a delivery confirmation.`,
      warning: false,
    };
  }
  // A mechanism-less receipt from a composer-capable pane means the host
  // answered in a shape this build does not recognise. Say that, rather than
  // upgrading silence into success.
  return {
    title: sentWhat === 'message' ? 'Message sent, but the result is unclear' : 'Feedback sent, but the result is unclear',
    description: 'The host accepted the request but did not say how it was delivered. Check the pane before sending again.',
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
