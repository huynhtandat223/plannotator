import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  appendCaptainEcho,
  buildCaptainEchoAnchors,
  captainEchoScopeKey,
  discardCaptainEchoesForPanes,
  loadCaptainEchoes,
  pruneCaptainEchoes,
  saveCaptainEchoes,
  LIVE_CAPTAIN_ECHO_RETENTION,
  type CaptainEchoStore,
} from './liveCaptainEcho';

/**
 * The captain's own sent messages are echoed browser-locally so the live pane
 * transcript reads two-sided. Nothing here may leak to the host: the wire format
 * stays role-free and the destructive at-most-once claim stays destructive.
 */

const entry = (id: string, text = `text-${id}`) => ({ id, text, timestamp: '2026-07-25T10:00:00.000Z' });

/**
 * Installs an in-memory `sessionStorage`. Defined via `defineProperty` because
 * under happy-dom (`DOM_TESTS=1`) `globalThis.sessionStorage` is a readonly
 * accessor, so plain assignment throws.
 */
function installMemorySessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const mock = {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: mock,
    configurable: true,
    writable: true,
  });
  return store;
}

/** Removes `sessionStorage` entirely, so the "unavailable" path is exercised for real. */
function removeSessionStorage(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => { installMemorySessionStorage(); });
afterEach(() => { removeSessionStorage(); });

test('scope key matches the pane+session shape drafts already use', () => {
  expect(captainEchoScopeKey('pane-1', 'sess-a')).toBe('live:pane-1:sess-a');
});

test('appends newest-first and ignores blank text', () => {
  let store: CaptainEchoStore = {};
  store = appendCaptainEcho(store, 'live:p:s', entry('1', 'first'));
  store = appendCaptainEcho(store, 'live:p:s', entry('2', 'second'));
  expect(store['live:p:s'].map((item) => item.text)).toEqual(['second', 'first']);

  const unchanged = appendCaptainEcho(store, 'live:p:s', entry('3', '   '));
  expect(unchanged).toBe(store);
});

test('bounds each pane+session scope at the single retention constant', () => {
  let store: CaptainEchoStore = {};
  for (let index = 0; index < LIVE_CAPTAIN_ECHO_RETENTION + 7; index += 1) {
    store = appendCaptainEcho(store, 'live:p:s', entry(String(index)));
  }
  expect(store['live:p:s']).toHaveLength(LIVE_CAPTAIN_ECHO_RETENTION);
  // Trimming drops the oldest, so the newest send is still row one.
  expect(store['live:p:s'][0].id).toBe(String(LIVE_CAPTAIN_ECHO_RETENTION + 6));
});

test('a changed Pi session discards that pane and only that pane', () => {
  const store: CaptainEchoStore = {
    'live:pane-1:sess-a': [entry('1')],
    'live:pane-2:sess-b': [entry('2')],
  };
  const next = discardCaptainEchoesForPanes(store, new Set(['pane-1']));
  expect(Object.keys(next)).toEqual(['live:pane-2:sess-b']);
  // No changed panes must not churn identity.
  expect(discardCaptainEchoesForPanes(store, new Set())).toBe(store);
});

test('discard tolerates pane ids that themselves contain colons', () => {
  const store: CaptainEchoStore = { 'live:herd:pane:3:sess-a': [entry('1')] };
  expect(discardCaptainEchoesForPanes(store, new Set(['herd:pane:3'])))
    .toEqual({});
});

test('prune drops panes gone from the snapshot but keeps live panes', () => {
  const store: CaptainEchoStore = {
    'live:pane-1:sess-a': [entry('1')],
    'live:gone:sess-z': [entry('2')],
  };
  const next = pruneCaptainEchoes(store, [{ messageId: 'm1', paneId: 'pane-1', piSessionId: 'sess-a' }]);
  expect(Object.keys(next)).toEqual(['live:pane-1:sess-a']);
});

test('prune keeps a pane whose session id is not yet enriched', () => {
  // A reload restores echoes before enrichment lands; a pane present without a
  // session id must not lose its transcript.
  const store: CaptainEchoStore = { 'live:pane-1:sess-a': [entry('1')] };
  const next = pruneCaptainEchoes(store, [{ messageId: 'waiting', paneId: 'pane-1' }]);
  expect(next).toEqual(store);
});

test('anchors echoes to the first snapshot row of their own pane', () => {
  const store: CaptainEchoStore = { 'live:pane-1:sess-a': [entry('e1')] };
  const anchors = buildCaptainEchoAnchors([
    { messageId: 'pane-1:r2', paneId: 'pane-1', piSessionId: 'sess-a' },
    { messageId: 'pane-1:r1', paneId: 'pane-1', piSessionId: 'sess-a' },
    { messageId: 'pane-2:r1', paneId: 'pane-2', piSessionId: 'sess-b' },
  ], store);

  expect([...anchors.keys()]).toEqual(['pane-1:r2']);
  expect(anchors.get('pane-1:r2')!.map((item) => item.id)).toEqual(['e1']);
});

test('anchors are empty without echoes, so snapshot rows render unchanged', () => {
  expect(buildCaptainEchoAnchors([{ messageId: 'm', paneId: 'p', piSessionId: 's' }], {}).size).toBe(0);
});

test('anchors never target a stale session scope', () => {
  const store: CaptainEchoStore = { 'live:pane-1:sess-old': [entry('e1')] };
  const anchors = buildCaptainEchoAnchors(
    [{ messageId: 'pane-1:r1', paneId: 'pane-1', piSessionId: 'sess-new' }],
    store,
  );
  expect(anchors.size).toBe(0);
});

test('persists to sessionStorage and reloads within the same browser session', () => {
  const raw = installMemorySessionStorage();
  const store = appendCaptainEcho({}, 'live:pane-1:sess-a', entry('e1', 'ahoy'));
  saveCaptainEchoes(store);

  expect([...raw.keys()]).toEqual(['plannotator-live-captain-echo:live:pane-1:sess-a']);
  expect(loadCaptainEchoes()).toEqual(store);
});

test('saving removes scopes the store no longer holds', () => {
  const raw = installMemorySessionStorage();
  saveCaptainEchoes({ 'live:pane-1:sess-a': [entry('e1')], 'live:pane-2:sess-b': [entry('e2')] });
  saveCaptainEchoes({ 'live:pane-2:sess-b': [entry('e2')] });
  expect([...raw.keys()]).toEqual(['plannotator-live-captain-echo:live:pane-2:sess-b']);
});

test('load survives corrupt or foreign entries without throwing', () => {
  const raw = installMemorySessionStorage();
  raw.set('plannotator-live-captain-echo:live:p:s', '{not json');
  raw.set('plannotator-live-captain-echo:live:q:s', JSON.stringify([{ id: 1 }]));
  raw.set('unrelated-key', 'keep me');
  expect(loadCaptainEchoes()).toEqual({});
});

test('storage helpers are no-ops when sessionStorage is unavailable', () => {
  removeSessionStorage();
  expect(() => saveCaptainEchoes({ 'live:p:s': [entry('e1')] })).not.toThrow();
  expect(loadCaptainEchoes()).toEqual({});
});
