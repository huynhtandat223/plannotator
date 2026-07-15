import { expect, test } from 'bun:test';
import { filterPlanReviewFiles, resolvePlanReviewMessage, type PlanReviewSnapshot } from './PlanReviewSourcesBrowser';

test('filters plan review file paths case-insensitively without changing their order', () => {
  const files = [
    { path: 'architecture/Overview.md', supported: true },
    { path: 'architecture/api.md', supported: true },
    { path: 'notes.txt', supported: false },
  ];

  expect(filterPlanReviewFiles(files, 'ARCH')).toEqual([
    { path: 'architecture/Overview.md', supported: true },
    { path: 'architecture/api.md', supported: true },
  ]);
  expect(filterPlanReviewFiles(files, '  ')).toBe(files);
  expect(filterPlanReviewFiles(files, 'missing')).toEqual([]);
});

test('resolves a history-only response independently of sent annotations', () => {
  const snapshot: PlanReviewSnapshot = {
    messages: [{ messageId: 'current', text: 'Current response' }],
    responseHistory: [{ messageId: 'history', text: 'Unannotated prior response' }],
    files: [],
    selected: { kind: 'message', messageId: 'history' },
    fileSnapshots: {},
    draftsByMessageId: {},
    sentAnnotationsByMessageId: {},
    sentMessageSnapshots: {},
    draftsByFileSnapshot: {},
    sentAnnotationsByFileSnapshot: {},
    sentFileSnapshots: {},
  };

  expect(resolvePlanReviewMessage(snapshot, 'history')).toEqual({
    messageId: 'history', text: 'Unannotated prior response',
  });
});
