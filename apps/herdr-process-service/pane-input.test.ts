import { describe, expect, test } from "bun:test";
import { paneInputArgs, paneInputDelivery, paneInputQueue } from "./pane-input";

const LIVE = ["w9:p1", "w9:p2"];

describe("paneInputDelivery", () => {
  test("accepts a text event for a live pane", () => {
    expect(paneInputDelivery({ paneId: "w9:p1", kind: "text", text: "/model" }, LIVE))
      .toEqual({ paneId: "w9:p1", kind: "text", text: "/model" });
  });

  test("accepts every allowlisted key and no others", () => {
    expect(paneInputDelivery({ paneId: "w9:p1", kind: "key", key: "tab" }, LIVE))
      .toEqual({ paneId: "w9:p1", kind: "key", key: "tab" });
    // An unmapped key never reaches the Herdr key table — it is refused against
    // the enum first, so the table cannot be probed by guessing names.
    expect(paneInputDelivery({ paneId: "w9:p1", kind: "key", key: "ctrl-c" }, LIVE))
      .toEqual({ error: "That key cannot be sent." });
    expect(paneInputDelivery({ paneId: "w9:p1", kind: "key", key: "up" }, LIVE))
      .toEqual({ error: "That key cannot be sent." });
  });

  test("refuses a pane that is not in the live list", () => {
    // A keystroke aimed at a pane that has since been replaced belongs to
    // nobody, so the caller passes a FRESH list on every call.
    const refusal = paneInputDelivery({ paneId: "w9:gone", kind: "key", key: "enter" }, LIVE);
    expect(refusal).toEqual({ error: "That pane is no longer live. Close Watch and reopen it on a current pane." });
  });

  test("refuses control characters in text rather than normalising them", () => {
    const refusal = paneInputDelivery({ paneId: "w9:p1", kind: "text", text: "/model\n" }, LIVE);
    expect("error" in refusal && refusal.error).toContain("Line breaks");
  });

  test("never guesses at a malformed event", () => {
    // Each of these could be "helpfully" coerced into some action. None is.
    for (const body of [
      null,
      {},
      { paneId: "w9:p1" },
      { paneId: "w9:p1", kind: "keys", key: "tab" },
      { paneId: "w9:p1", kind: "text" },
      { paneId: "w9:p1", kind: "text", text: 42 },
      { paneId: "   ", kind: "key", key: "tab" },
    ]) {
      expect(paneInputDelivery(body as Record<string, unknown> | null, LIVE)).toHaveProperty("error");
    }
  });
});

describe("paneInputArgs", () => {
  test("builds an exact argument vector, with the host's own key names", () => {
    // The browser said `arrow-up`; Herdr is told `up`. The mapping lives host
    // side so a browser can never name a Herdr key directly.
    expect(paneInputArgs({ paneId: "w9:p1", kind: "key", key: "arrow-up" }))
      .toEqual(["pane", "send-keys", "w9:p1", "up"]);
    expect(paneInputArgs({ paneId: "w9:p1", kind: "key", key: "escape" }))
      .toEqual(["pane", "send-keys", "w9:p1", "escape"]);
    // Text is one argv element: no shell, no quoting, no interpolation.
    expect(paneInputArgs({ paneId: "w9:p1", kind: "text", text: "/review 'a b'; rm -rf /" }))
      .toEqual(["pane", "send-text", "w9:p1", "/review 'a b'; rm -rf /"]);
  });
});

describe("paneInputQueue", () => {
  test("serialises per pane, so a slow text cannot be overtaken by its key", async () => {
    // This is the whole interaction: type `/mod`, then press Tab. If the two
    // execFile calls overlap, a slow send-text lets Tab land in an empty
    // composer — and nothing about the result would look wrong.
    const queue = paneInputQueue();
    const order: string[] = [];
    const slow = queue.run("w9:p1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("text");
    });
    const fast = queue.run("w9:p1", async () => { order.push("tab"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["text", "tab"]);
  });

  test("does not serialise across panes — one wedged pane must not stall another", async () => {
    const queue = paneInputQueue();
    const order: string[] = [];
    const slow = queue.run("w9:p1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push("p1");
    });
    const other = queue.run("w9:p2", async () => { order.push("p2"); });
    await Promise.all([slow, other]);
    expect(order).toEqual(["p2", "p1"]);
  });

  test("a failed call neither wedges the queue nor swallows its own error", async () => {
    const queue = paneInputQueue();
    const failed = queue.run("w9:p1", async () => { throw new Error("pane_not_found"); });
    // The caller still sees the failure and can report it to the captain...
    await expect(failed).rejects.toThrow("pane_not_found");
    // ...and the next key still runs.
    await expect(queue.run("w9:p1", async () => "ok")).resolves.toBe("ok");
  });

  test("drains, so a long-lived host does not retain an entry per pane it ever saw", async () => {
    const queue = paneInputQueue();
    await queue.run("w9:p1", async () => undefined);
    await queue.run("w9:p2", async () => undefined);
    // Settled chains delete themselves; the map is not an unbounded ledger.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.pending).toBe(0);
  });
});
