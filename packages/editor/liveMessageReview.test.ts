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

  expect(callback).toContain('submitLiveResponseFeedback');
  expect(callback).toContain("fetch('/api/feedback'");
  expect(callback).toContain('selectedMessageId: scopedSelectedMessageId');
  expect(callback).toContain('globalAttachments,');
  expect(callback).toContain('clearSelectedLiveFeedback()');
  expect(source).toContain('createEmptyMessageState(targetMessage)');
  expect(source).toContain('globalAttachments: state.linkedDocSession.root.globalAttachments');
  expect(source).toContain('linkedDocHook.restoreSession');
  expect(source).toContain('liveSnapshotMessagesRef.current = snapshot.messages');
});

test('direct live Send and image feedback have distinct eligibility and transports', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');
  const directSend = source.slice(
    source.indexOf('const handleSendGlobalComment'),
    source.indexOf('const handleAnnotateApprove'),
  );

  expect(source).toContain('const canAttachSelectedLiveImageFeedback = liveMessageReview &&');
  expect(source).toContain('Boolean(selectedLiveMessage?.assistantMessageId)');
  expect(source).toContain('const selectedLiveMessageIsWaitingDocument = liveMessageReview &&');
  expect(source).toContain('!selectedLiveMessage.assistantMessageId');
  expect(source).toContain('directMessage={sendsGlobalCommentAsUserMessage}');
  expect(source).toContain('disableSelectionAnnotations={selectedLiveMessageIsWaitingDocument}');
  expect(source).toContain('imageFeedbackTarget={selectedLiveImageFeedbackTarget}');
  expect(source).toContain('onSendGlobalCommentText={sendsGlobalCommentAsUserMessage ? handleSendGlobalComment : undefined}');
  expect(directSend).toContain("fetch('/api/instruction'");
  expect(directSend).not.toContain('globalAttachments');
});

test('unified feedback send contract: empty-global/non-empty-feedback, combined send, no duplication, failure preservation, and non-global behavior', () => {
  const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');

  // 1. Send Feedback allows zero global messages when Send Feedback content is non-empty
  // Check that handleAnnotateFeedback checks if both global comments and non-global feedback are empty
  expect(source).toContain("if ((!globalComments || globalComments.trim().length === 0) && (!nonGlobalFeedback || nonGlobalFeedback.trim().length === 0))");

  // 2 & 3. Combined Global Send delivers both rawText and nonGlobalFeedback without duplication, using deterministic separation
  const directSend = source.slice(
    source.indexOf('const handleSendGlobalComment'),
    source.indexOf('const handleAnnotateApprove'),
  );

  // Check that it calls getNonGlobalFeedbackPayload
  expect(directSend).toContain('const nonGlobalFeedback = getNonGlobalFeedbackPayload(checkedSavedFileChanges);');
  
  // Check the deterministic separation and order: global comment first, then non-global feedback
  expect(directSend).toContain('trimmedRawText && nonGlobalFeedback.trim()');
  expect(directSend).toContain('content = `${trimmedRawText}\\n\\n---\\n\\n${nonGlobalFeedback.trim()}`;');

  // 4. Failure preservation: verify we only clear when successful, and only clear what is sent
  // In handleSendGlobalComment, we only clear non-global feedback if nonGlobalFeedback was non-empty
  expect(directSend).toContain('if (nonGlobalFeedback && nonGlobalFeedback.trim().length > 0) {');
  expect(directSend).toContain('clearSelectedLiveFeedback();');
  // On error/failure, we catch and return false (preserving the popover draft) without calling clear/dismiss
  expect(directSend).toContain('catch (error) {');
  expect(directSend).toContain('return false;');
  
  // Similarly in handleAnnotateFeedback
  const handleFeedback = source.slice(
    source.indexOf('const handleAnnotateFeedback'),
    source.indexOf('const handleSendGlobalComment'),
  );
  expect(handleFeedback).toContain('if (nonGlobalFeedback && nonGlobalFeedback.trim().length > 0) {');
  expect(handleFeedback).toContain('clearSelectedLiveFeedback();');

  // 5. Keep non-global behavior unchanged
  // Verify that the fallback path (non-global, i.e., when sendsGlobalCommentAsUserMessage is false) still fetches /api/feedback or uses submitLiveResponseFeedback
  expect(handleFeedback).toContain('submitLiveResponseFeedback({ ...feedbackPayload');
  expect(handleFeedback).toContain("fetch('/api/feedback'");
});

