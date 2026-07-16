import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('live-message updates are applied in place without a full-page reload', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  const callback = source.slice(
    source.indexOf('const applyLiveReviewSnapshot'),
    source.indexOf('const handleLiveReviewAction'),
  );

  expect(callback).not.toContain('window.location.reload');
  expect(callback).not.toContain('document.reload');
  expect(callback).toContain('linkedDocHook.restoreSession');
  expect(callback).toContain('setSelectedMessageId(nextSelectedMessageId)');
  expect(callback).toContain("New assistant response ready to review.");
  expect(callback).toContain('announceLiveUpdate');
  expect(callback).toContain('snapshot.draftsByMessageId');
  expect(callback).toContain('messageStateCacheRef.current');
});

test('live-message SSE failures leave the review usable with a status message', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  expect(source).toContain("setLiveReviewUpdateError('Live response updates disconnected. Reconnecting…')");
  expect(source).toContain('role="status" aria-live="polite"');
});

test('live feedback saves the current source before submitting all retained drafts', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  const callback = source.slice(
    source.indexOf('const handleAnnotateFeedback'),
    source.indexOf('const handleAnnotateApprove'),
  );

  expect(callback).toContain('saveLiveReviewDrafts(selectedMessageId)');
  expect(callback).toContain('Promise.all([...liveDraftSaveQueuesRef.current.values()])');
  expect(callback).toContain("fetch('/api/session/feedback'");
  expect(source).toContain('const saveLiveReviewDrafts');
  expect(source).toContain('liveDraftSaveQueuesRef');
  expect(source).toContain('liveDraftSaveVersionsRef');
  expect(source).toContain('preservePendingDraftsForMessageIds');
  expect(source).toContain('liveDraftSaveQueuesRef.current.keys()');
  expect(source).toContain('liveDeliveredDraftMessageIdsRef');
  expect(source).toContain('snapshot.sentMessageIds');
  expect(source).toContain('return createEmptyMessageState(msg)');
  expect(source).toContain('liveDeliveredDraftMessageIdsRef.current.add(selectedMessageId)');
  expect(source).toContain('liveDeliveredDraftMessageIdsRef.current.delete(messageId)');
  expect(source).toContain("replaceDrafts: path === '/api/session/feedback/retry'");
  expect(source).toContain('...(options?.replaceDrafts ? states.keys() : [])');
  expect(source).toContain('globalAttachments: state.linkedDocSession.root.globalAttachments');
  expect(source).toContain('linkedDocuments');
  expect(source).toContain('applyLiveReviewSnapshot(snapshot, {');
});
