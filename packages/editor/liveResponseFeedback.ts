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

/** Submit one structured assistant response's retryable feedback batch. */
export async function submitLiveResponseFeedback(
  payload: LiveResponseFeedbackPayload,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || 'Failed to send feedback');
}
