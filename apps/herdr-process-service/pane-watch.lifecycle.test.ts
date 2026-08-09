/**
 * Lifecycle coverage for the Watch live transport: early disconnect, and the
 * declared concurrent-watch bound.
 *
 * ## Why this file exists, given the spec says not to unit-test the transport
 *
 * The spec's testing decision is to prove behaviour through the real-Herdr
 * integration test rather than around the transport's internals, and the rest
 * of this feature follows that. This file is a deliberate, narrow exception,
 * for a reason worth recording: the defect it covers has **no deterministic
 * external symptom**.
 *
 * A browser that disconnects while a watch is still opening — during
 * authorization, or during the first screen read — used to be invisible,
 * because the `close` listener was attached only after those awaits and Node
 * emits `close` once. Every teardown then stayed inactive. Trying to observe
 * that from outside failed twice, and instructively:
 *
 * - orphaned reads are masked: the first `response.write` to a dead socket
 *   returns false, the transport sets `draining`, and `drain` never fires on a
 *   dead socket — so the poll loop lives on but stops issuing reads, and a
 *   read-count assertion sees nothing wrong;
 * - the leaked capacity slot did not reproduce either — measured with 32
 *   aborts spread across the window, a following watch still connected,
 *   because on this runtime `close` usually lands after the handler's tail.
 *
 * "Usually" is the whole problem. The ordering is a race, and a test that only
 * passes because the race normally resolves the safe way is not evidence. Here
 * the disconnect can be delivered at an exact point, so the property is stated
 * directly: cleanup is armed before anything that can leak.
 *
 * The concurrent-cap case is here for the same reason. A real client cannot be
 * made to open N watches at exactly the same instant, but a fake authorization
 * that never settles parks every open inside the same window on demand — which
 * is precisely the interleaving under which a check-then-act capacity gate
 * stops bounding anything.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { PANE_WATCH_MAX_CONCURRENT, PANE_WATCH_POLL_MS } from "../../packages/core/pane-watch";
import {
  activePaneWatchCount,
  startPaneWatchStream,
  type PaneWatchHerdr,
  type PaneWatchScreen,
} from "./pane-watch";

const PANE = "w9:p1";

function fakeRequest(): IncomingMessage & EventEmitter {
  return new EventEmitter() as IncomingMessage & EventEmitter;
}

function fakeResponse(): ServerResponse & { written: string[] } {
  const emitter = new EventEmitter();
  const written: string[] = [];
  return Object.assign(emitter, {
    written,
    writeHead: () => {},
    write: (chunk: string) => { written.push(chunk); return true; },
    end: () => {},
    setTimeout: () => {},
    headersSent: false,
  }) as unknown as ServerResponse & { written: string[] };
}

/** Event types this response was sent, in order. */
function sentEventTypes(response: { written: string[] }): string[] {
  return response.written
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; reason?: string })
    .map((event) => (event.reason ? `${event.type}:${event.reason}` : event.type));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const screen: PaneWatchScreen = { ansi: "hello", revision: 1, truncated: false };

afterEach(() => {
  // Every test must leave the shared capacity counter where it found it.
  expect(activePaneWatchCount()).toBe(0);
});

test("a disconnect during authorization starts no watch at all", async () => {
  const authorization = deferred<Set<string>>();
  let readCalls = 0;
  let subscriptions = 0;
  let releases = 0;

  const herdr: PaneWatchHerdr = {
    livePaneIds: () => authorization.promise,
    readScreen: async () => { readCalls++; return screen; },
    subscribeLiveness: () => { subscriptions++; return () => { releases++; }; },
  };

  const request = fakeRequest();
  const started = startPaneWatchStream(request, fakeResponse(), PANE, herdr);

  // The viewer goes away while the host is still asking Herdr whether this
  // pane is real. Nothing has been created yet — which is exactly why the
  // listener has to already be attached.
  request.emit("close");
  authorization.resolve(new Set([PANE]));
  await started;

  expect(activePaneWatchCount()).toBe(0);
  // No screen was ever read for a viewer that had already left.
  expect(readCalls).toBe(0);
  expect(subscriptions - releases).toBe(0);

  // And no poll loop was scheduled behind it.
  await Bun.sleep(PANE_WATCH_POLL_MS * 3);
  expect(readCalls).toBe(0);
});

test("a disconnect during the first screen read leaves nothing running", async () => {
  const firstRead = deferred<PaneWatchScreen>();
  let readCalls = 0;
  let subscriptions = 0;
  let releases = 0;

  const herdr: PaneWatchHerdr = {
    livePaneIds: async () => new Set([PANE]),
    readScreen: () => { readCalls++; return firstRead.promise; },
    subscribeLiveness: () => { subscriptions++; return () => { releases++; }; },
  };

  const request = fakeRequest();
  const started = startPaneWatchStream(request, fakeResponse(), PANE, herdr);

  // Let authorization complete and the first read begin.
  await Bun.sleep(0);
  expect(readCalls).toBe(1);

  request.emit("close");
  firstRead.resolve(screen);
  await started;

  // The capacity slot is returned and the liveness subscription released...
  expect(activePaneWatchCount()).toBe(0);
  expect(subscriptions - releases).toBe(0);

  // ...and no further read is ever issued: the poll was never scheduled onward
  // for a viewer that had already gone.
  await Bun.sleep(PANE_WATCH_POLL_MS * 4);
  expect(readCalls).toBe(1);
});

test("a watch that is never disconnected still polls, so the guards are not vacuous", async () => {
  let readCalls = 0;
  const herdr: PaneWatchHerdr = {
    livePaneIds: async () => new Set([PANE]),
    readScreen: async () => { readCalls++; return { ansi: `frame ${readCalls}`, revision: readCalls, truncated: false }; },
    subscribeLiveness: () => () => {},
  };

  const request = fakeRequest();
  await startPaneWatchStream(request, fakeResponse(), PANE, herdr);
  expect(activePaneWatchCount()).toBe(1);

  await Bun.sleep(PANE_WATCH_POLL_MS * 3);
  expect(readCalls).toBeGreaterThan(1);

  request.emit("close");
  expect(activePaneWatchCount()).toBe(0);

  const settled = readCalls;
  await Bun.sleep(PANE_WATCH_POLL_MS * 3);
  expect(readCalls).toBe(settled);
});

test("concurrent opens never exceed the declared watch limit", async () => {
  // Authorization that never settles on its own parks every open inside the
  // same window — the interleaving a check-then-act capacity gate cannot
  // survive, because each open reads the counter before any has taken a slot.
  const authorization = deferred<Set<string>>();
  const herdr: PaneWatchHerdr = {
    livePaneIds: () => authorization.promise,
    readScreen: async () => screen,
    subscribeLiveness: () => () => {},
  };

  const surplus = 4;
  const opens = Array.from({ length: PANE_WATCH_MAX_CONCURRENT + surplus }, () => {
    const request = fakeRequest();
    const response = fakeResponse();
    return { request, response, started: startPaneWatchStream(request, response, PANE, herdr) };
  });

  // Reservation happens before the first await, so the bound already holds
  // while every one of these is still waiting on Herdr.
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);

  authorization.resolve(new Set([PANE]));
  await Promise.all(opens.map((open) => open.started));

  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);

  // The surplus opens were refused, and refused for the honest reason.
  const refused = opens.filter((open) => sentEventTypes(open.response).includes("ended:capacity"));
  expect(refused.length).toBe(surplus);
  // Nobody was told a session ended or that their pane was unknown.
  for (const open of opens) {
    const events = sentEventTypes(open.response);
    expect(events.includes("ended:pane-gone")).toBe(false);
    expect(events.includes("ended:unauthorized")).toBe(false);
  }

  for (const open of opens) open.request.emit("close");
  expect(activePaneWatchCount()).toBe(0);
});

test("a refused open releases nothing it did not take, and the next open succeeds", async () => {
  const herdr: PaneWatchHerdr = {
    livePaneIds: async () => new Set([PANE]),
    readScreen: async () => screen,
    subscribeLiveness: () => () => {},
  };

  const held = Array.from({ length: PANE_WATCH_MAX_CONCURRENT }, () => {
    const request = fakeRequest();
    return { request, started: startPaneWatchStream(request, fakeResponse(), PANE, herdr) };
  });
  await Promise.all(held.map((open) => open.started));
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);

  // One over the line: refused, and it must not decrement a slot it never held.
  const rejectedResponse = fakeResponse();
  const rejectedRequest = fakeRequest();
  await startPaneWatchStream(rejectedRequest, rejectedResponse, PANE, herdr);
  expect(sentEventTypes(rejectedResponse)).toEqual(["ended:capacity"]);
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);
  // A refused open's own close must not double-release either.
  rejectedRequest.emit("close");
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);

  held[0]!.request.emit("close");
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT - 1);

  // The freed slot is genuinely reusable.
  const revivedRequest = fakeRequest();
  const revivedResponse = fakeResponse();
  await startPaneWatchStream(revivedRequest, revivedResponse, PANE, herdr);
  expect(sentEventTypes(revivedResponse)).toContain("ready");
  expect(activePaneWatchCount()).toBe(PANE_WATCH_MAX_CONCURRENT);

  for (const open of held.slice(1)) open.request.emit("close");
  revivedRequest.emit("close");
  expect(activePaneWatchCount()).toBe(0);
});
