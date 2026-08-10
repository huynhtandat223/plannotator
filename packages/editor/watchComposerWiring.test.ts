/**
 * App-level wiring for the Watch live composer.
 *
 * The overlay's own behaviour is covered by mounting it
 * (`components/LivePaneWatchOverlay.test.tsx`). What cannot be reached that way
 * is the half that lives in `App.tsx`: which pane a send is addressed to, which
 * session identity rides along, and what the request is NOT allowed to carry.
 * Those are one-line properties with large consequences — a send that reads the
 * current selection instead of the pinned target retargets silently, and a send
 * that picks up the feedback payload turns a message into a review submission —
 * so they are asserted here against the source, the same way this package
 * already pins the direct-message and image-feedback transports
 * (`liveMessageReview.test.ts`).
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, 'App.tsx'), 'utf8');

/** The two Watch transport handlers, and nothing else. */
const watchHandlers = source.slice(
  source.indexOf('const handleWatchSendMessage'),
  source.indexOf('const clearSelectedLiveFeedback'),
);

test('opening Watch captures the whole target — pane, agent, session, and advertised commands', () => {
  const openHandler = source.slice(
    source.indexOf('const handleOpenLiveWatch'),
    source.indexOf('const handleCloseLiveWatch'),
  );
  expect(openHandler).toContain('agent: selectedLiveMessage?.agent');
  expect(openHandler).toContain('piSessionId: selectedLiveMessage?.piSessionId');
  expect(openHandler).toContain('commands: (selectedLiveMessage?.commands ?? [])');
});

test('a Watch send addresses the captured target, never the current selection', () => {
  // This is the whole point of pinning: the picker behind the overlay may have
  // moved on, and a message must still go where the captain was looking.
  expect(watchHandlers).toContain('const target = watchTarget;');
  expect(watchHandlers).toContain('paneId: target.paneId');
  expect(watchHandlers).not.toContain('selectedLiveMessage');
});

test('the captured session rides along for extension delivery, and only for it', () => {
  // The host rejects a replacement session rather than queueing to it — but only
  // if the browser says which session it meant. Composer kinds have no
  // registration to match, so sending one would be noise.
  expect(watchHandlers).toContain("livePaneFeedbackDelivery(target.agent) === 'pi-extension' && target.piSessionId");
  expect(watchHandlers).toContain('{ sessionId: target.piSessionId }');
  // The command path pins the session that advertised the command.
  expect(watchHandlers).toContain("fetch('/api/command'");
  expect(watchHandlers).toContain('...(target.piSessionId ? { sessionId: target.piSessionId } : {})');
});

test('a Watch message carries only its own text — never saved feedback or annotations', () => {
  // The compatibility viewer path deliberately appends the non-global feedback
  // payload to a global comment. A composer labelled "Message this pane" must
  // not do that silently, so it touches none of that machinery at all.
  expect(watchHandlers).toContain("fetch('/api/instruction'");
  for (const forbidden of [
    'getNonGlobalFeedbackPayload',
    'globalAttachments',
    'annotations',
    'clearSelectedLiveFeedback',
    '\\n\\n---\\n\\n',
  ]) {
    expect(watchHandlers).not.toContain(forbidden);
  }
});

test('the overlay is given a live status for the pinned pane and a replaced-session signal', () => {
  // Status must be current (the composer refuses to type into a busy pane), and
  // it is resolved BY the pinned pane id — a refresh of the same pane, not a
  // retarget.
  expect(source).toContain('recentMessages.find((message) => message.paneId === watchTarget.paneId)');
  expect(source).toContain('watchPaneNow.piSessionId !== watchTarget.piSessionId');
  expect(source).toContain('agentStatus={watchPaneNow?.agentStatus}');
  expect(source).toContain('sessionReplaced={watchSessionReplaced}');
  expect(source).toContain('piSessionId={watchTarget.piSessionId}');
  expect(source).toContain('onSendMessage={handleWatchSendMessage}');
  expect(source).toContain('onRunCommand={handleWatchRunCommand}');
});
