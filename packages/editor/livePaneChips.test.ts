import { expect, test } from 'bun:test';
import {
  deriveLivePaneChips,
  DEFAULT_MAX_VISIBLE_PANE_CHIPS,
  type PaneChipSource,
} from './livePaneChips';

const pane = (over: Partial<PaneChipSource> & { messageId: string }): PaneChipSource => ({
  paneId: over.paneId ?? over.messageId,
  paneLabel: 'ws',
  agentStatus: 'idle',
  ...over,
});

test('one chip per pane, labelled workspace · tab', () => {
  const { visible, total } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'p1', paneLabel: 'firstmate', paneTab: 't3H' }),
  ]);
  expect(total).toBe(1);
  expect(visible[0].label).toBe('firstmate · t3H');
  expect(visible[0].workspace).toBe('firstmate');
  expect(visible[0].tab).toBe('t3H');
});

test('collapses multiple rows of the same pane into one chip (latest wins)', () => {
  const { visible, total } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'p1', paneTab: 'old' }),
    pane({ messageId: 'm2', paneId: 'p1', paneTab: 'new' }),
  ]);
  expect(total).toBe(1);
  expect(visible[0].tab).toBe('new');
  expect(visible[0].messageId).toBe('m2');
});

test('selected pane represented by the selected row and marked selected', () => {
  const { visible } = deriveLivePaneChips(
    [
      pane({ messageId: 'm1', paneId: 'p1', paneTab: 'first' }),
      pane({ messageId: 'm2', paneId: 'p1', paneTab: 'second' }),
    ],
    { selectedMessageId: 'm1' },
  );
  expect(visible[0].isSelected).toBe(true);
  expect(visible[0].messageId).toBe('m1');
  expect(visible[0].tab).toBe('first');
});

test('active-first ordering: waiting → blocked → working → idle', () => {
  const { visible } = deriveLivePaneChips(
    [
      pane({ messageId: 'idle', paneId: 'idle', agentStatus: 'idle' }),
      pane({ messageId: 'work', paneId: 'work', agentStatus: 'working' }),
      pane({ messageId: 'block', paneId: 'block', agentStatus: 'blocked' }),
      pane({ messageId: 'wait', paneId: 'wait', agentStatus: 'idle' }),
    ],
    { selectedMessageId: 'wait', reviewRoundStatus: 'waiting' },
  );
  expect(visible.map((c) => c.paneId)).toEqual(['wait', 'block', 'work', 'idle']);
});

test('CTX warning tone triggers at threshold', () => {
  const { visible } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'p1', contextUsage: { tokens: 80, contextWindow: 100, percent: 80 } }),
    pane({ messageId: 'm2', paneId: 'p2', contextUsage: { tokens: 50, contextWindow: 100, percent: 50 } }),
  ]);
  const p1 = visible.find((c) => c.paneId === 'p1')!;
  const p2 = visible.find((c) => c.paneId === 'p2')!;
  expect(p1.contextWarning).toBe(true);
  expect(p1.contextPercent).toBe(80);
  expect(p2.contextWarning).toBe(false);
});

test('CTX warning threshold is inclusive and configurable', () => {
  const at = deriveLivePaneChips(
    [pane({ messageId: 'm1', paneId: 'p1', contextUsage: { tokens: 75, contextWindow: 100, percent: 75 } })],
    { ctxWarnThreshold: 75 },
  );
  expect(at.visible[0].contextWarning).toBe(true);
});

test('null context percent is not a warning', () => {
  const { visible } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'p1', contextUsage: { tokens: null, contextWindow: 100, percent: null } }),
  ]);
  expect(visible[0].contextPercent).toBeNull();
  expect(visible[0].contextWarning).toBe(false);
});

test('overflow collapses beyond maxVisible', () => {
  const sources = Array.from({ length: 9 }, (_, i) =>
    pane({ messageId: `m${i}`, paneId: `p${i}`, agentStatus: 'idle' }),
  );
  const { visible, overflow, total } = deriveLivePaneChips(sources, { maxVisible: 6 });
  expect(total).toBe(9);
  expect(visible).toHaveLength(6);
  expect(overflow).toHaveLength(3);
});

test('default maxVisible is 6', () => {
  const sources = Array.from({ length: 10 }, (_, i) =>
    pane({ messageId: `m${i}`, paneId: `p${i}` }),
  );
  const { visible } = deriveLivePaneChips(sources);
  expect(visible).toHaveLength(DEFAULT_MAX_VISIBLE_PANE_CHIPS);
});

test('selected pane is pulled into visible even when it sorts into overflow', () => {
  // 7 idle panes; the selected one is last in first-seen order so it would
  // otherwise fall into overflow.
  const sources = Array.from({ length: 7 }, (_, i) =>
    pane({ messageId: `m${i}`, paneId: `p${i}`, agentStatus: 'idle' }),
  );
  const { visible, overflow } = deriveLivePaneChips(sources, {
    maxVisible: 6,
    selectedMessageId: 'm6',
  });
  expect(visible.some((c) => c.paneId === 'p6')).toBe(true);
  expect(overflow.some((c) => c.paneId === 'p6')).toBe(false);
  expect(visible).toHaveLength(6);
  expect(overflow).toHaveLength(1);
});

test('duplicate workspace-only labels are disambiguated by pane-id suffix', () => {
  const { visible } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'ws:paneA', paneLabel: 'firstmate', paneTab: undefined }),
    pane({ messageId: 'm2', paneId: 'ws:paneB', paneLabel: 'firstmate', paneTab: undefined }),
  ]);
  const labels = visible.map((c) => c.label);
  expect(new Set(labels).size).toBe(2);
  expect(labels.every((l) => l.startsWith('firstmate'))).toBe(true);
});

test('falls back to panel description then pane-id when no workspace/tab', () => {
  const { visible } = deriveLivePaneChips([
    pane({ messageId: 'm1', paneId: 'x:99', paneLabel: undefined, paneTab: undefined, paneDescription: 'Pane detail' }),
    pane({ messageId: 'm2', paneId: 'y:42', paneLabel: undefined, paneTab: undefined, paneDescription: undefined }),
  ]);
  const byPane = new Map(visible.map((c) => [c.paneId, c.label]));
  expect(byPane.get('x:99')).toBe('Pane detail');
  expect(byPane.get('y:42')).toBe('Pane 42');
});

test('recent commands are extracted from the trail, newest-last, bounded', () => {
  const trail = [
    { kind: 'tool' as const, name: 'read', count: 1 },
    { kind: 'tool' as const, name: 'bash', count: 1, command: 'npm test' },
    { kind: 'tool' as const, name: 'bash', count: 1, command: 'git status' },
    { kind: 'tool' as const, name: 'bash', count: 1, command: 'ls' },
  ];
  const { visible } = deriveLivePaneChips(
    [pane({ messageId: 'm1', paneId: 'p1', activityTrail: trail })],
    { recentCommandLimit: 2 },
  );
  expect(visible[0].recentCommands).toEqual(['git status', 'ls']);
});

test('reviewRoundStatus only affects the selected pane chip', () => {
  const { visible } = deriveLivePaneChips(
    [
      pane({ messageId: 'sel', paneId: 'sel', agentStatus: 'idle' }),
      pane({ messageId: 'other', paneId: 'other', agentStatus: 'idle' }),
    ],
    { selectedMessageId: 'sel', reviewRoundStatus: 'waiting' },
  );
  const sel = visible.find((c) => c.paneId === 'sel')!;
  const other = visible.find((c) => c.paneId === 'other')!;
  expect(sel.activity?.label).toBe('Waiting on you');
  expect(other.activity?.label).toBe('Idle');
});
