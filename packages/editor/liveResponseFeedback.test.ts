import { describe, expect, mock, test } from 'bun:test';
import { submitLiveResponseFeedback } from './liveResponseFeedback';

const payload = {
  draftGeneration: 7,
  feedback: '## Message Feedback\n\nAttached image: [ui-state] /tmp/ui-state.png',
  annotations: [],
  codeAnnotations: [],
  globalAttachments: [{ path: '/tmp/ui-state.png', name: 'ui-state' }],
  selectedMessageId: 'pane-1:assistant-42',
};

describe('structured live response feedback transport', () => {
  test('serializes image attachments only to the existing feedback endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await submitLiveResponseFeedback(payload, fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/feedback');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(payload);
    expect(String(calls[0].input)).not.toContain('/api/instruction');
  });

  test('rejects failed feedback without mutating the retryable payload', async () => {
    const fetcher = mock(async () => new Response(
      JSON.stringify({ error: 'Pi did not accept feedback' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;
    const before = structuredClone(payload);

    expect(submitLiveResponseFeedback(payload, fetcher)).rejects.toThrow('Pi did not accept feedback');
    expect(payload).toEqual(before);
  });
});
