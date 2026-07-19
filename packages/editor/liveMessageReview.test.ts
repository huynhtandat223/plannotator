import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('live-message updates are applied in place without a full-page reload', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  const callback = source.slice(
    source.indexOf('const applyLiveReviewSnapshot'),
    source.indexOf('const handleLiveReviewAction'),
  );

  expect(callback).toContain("snapshot.reviewRoundStatus === 'open' && liveMessageReviewReloadOnSelection");
  expect(callback).toContain('window.location.reload');
  expect(callback).not.toContain('document.reload');
  expect(callback).toContain('linkedDocHook.restoreSession');
  expect(callback).toContain('setSelectedMessageId(nextSelectedMessageId)');
  expect(callback).toContain("toast('Agent response received'");
  expect(callback).toContain('liveSnapshotMessagesRef.current = snapshot.messages');
  expect(callback).toContain('changedLivePaneSessionIds');
  expect(callback).toContain('messageStateCacheRef.current');
});

test('live-message SSE failures leave the review usable with a status message', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  expect(source).toContain('setLiveReviewDeliveryError(snapshot.deliveryError)');
  expect(source).toContain("status === 'delivery_failed'");
  expect(source).toContain('Feedback delivery failed.');
});

test('live feedback saves the current source before submitting all retained drafts', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  const callback = source.slice(
    source.indexOf('const handleAnnotateFeedback'),
    source.indexOf('const handleAnnotateApprove'),
  );

  expect(callback).toContain("fetch('/api/feedback'");
  expect(callback).toContain('selectedMessageId: scopedSelectedMessageId');
  expect(callback).toContain('clearSelectedLiveFeedback()');
  expect(source).toContain('createEmptyMessageState(targetMessage)');
  expect(source).toContain('globalAttachments: state.linkedDocSession.root.globalAttachments');
  expect(source).toContain('linkedDocHook.restoreSession');
  expect(source).toContain('liveSnapshotMessagesRef.current = snapshot.messages');
});
