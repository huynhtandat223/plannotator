import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExAICompanionCoordinator, MAX_SUGGESTED_OPTIONS, parseSuggestedOptions } from "./ex-ai-companion";

type Pane = { id: string; workspaceId?: string; cwd: string };
type Registration = { sessionId: string; messages: Array<{ messageId: string; text: string }>; model?: string; commands?: Array<{ name: string; description?: string }> };

function fakeBoundary() {
  const panes: Pane[] = [{ id: "main", workspaceId: "workspace", cwd: "/repo" }];
  const registrations = new Map<string, Registration>([["main", { sessionId: "main-session", messages: [] }]]);
  const created: string[] = [];
  const closed: string[] = [];
  const sent: Array<{ paneId: string; prompt: string }> = [];
  const claims: string[] = [];
  let sendGate: Promise<void> | null = null;
  let rejectClaim = false;
  return {
    panes, registrations, created, closed, sent, claims,
    holdSend(promise: Promise<void>) { sendGate = promise; },
    failClaim() { rejectClaim = true; },
    boundary: {
      panels: async () => panes,
      registration: (paneId: string) => registrations.get(paneId),
      create: async () => {
        const paneId = `companion-${created.length + 1}`;
        created.push(paneId);
        panes.push({ id: paneId, workspaceId: "workspace", cwd: "/repo" });
        registrations.set(paneId, { sessionId: "companion-session", messages: [] });
        return { paneId };
      },
      close: async (paneId: string) => {
        closed.push(paneId);
        const index = panes.findIndex((pane) => pane.id === paneId);
        if (index !== -1) panes.splice(index, 1);
        registrations.delete(paneId);
      },
      send: async (paneId: string, prompt: string) => {
        sent.push({ paneId, prompt });
        if (sendGate) await sendGate;
        const registration = registrations.get(paneId)!;
        registration.messages.unshift({ messageId: `assistant-${sent.length}`, text: `Reply ${sent.length}` });
      },
      claim: async (_paneId: string, _sessionId: string, content: string) => {
        claims.push(content);
        if (rejectClaim) throw new Error("uncertain delivery");
        return "delivery-1";
      },
    },
  };
}

describe("Ex AI companion contract", () => {
  test("coalesces concurrent Start for one exact main and projects only the typed first turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      const main = { paneId: "main", sessionId: "main-session" };
      const [first, second] = await Promise.all([
        service.start(main, { model: "provider/model", instruction: "Help carefully" }),
        service.start(main, { model: "provider/model", instruction: "Help carefully" }),
      ]);
      expect(fake.created).toEqual(["companion-1"]);
      expect(first.pair?.companion.paneId).toBe("companion-1");
      expect(second.pair).toEqual(first.pair);

      await service.sendTurn(main, "What changed?");
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0].prompt).toContain("Help carefully");
      expect(fake.sent[0].prompt).toContain("Main workspace: /repo");
      expect(fake.sent[0].prompt).toContain("What changed?");
      await service.sendTurn(main, "And now?");
      expect(fake.sent[1].prompt).toBe("And now?");
      expect((await service.state(main)).history).toEqual([
        { kind: "user", text: "What changed?" },
        { kind: "assistant", messageId: "assistant-1", text: "Reply 1" },
        { kind: "user", text: "And now?" },
        { kind: "assistant", messageId: "assistant-2", text: "Reply 2" },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("keeps a live pair recovering until Pi enrichment republished, rejects nested start, and closes only on main replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const first = new ExAICompanionCoordinator(fake.boundary, dir);
      await first.start(main, { model: "provider/model", instruction: "Help" });
      fake.registrations.clear();
      const recovered = new ExAICompanionCoordinator(fake.boundary, dir);
      await recovered.reconcile();
      expect((await recovered.state(main)).status).toBe("recovering");
      expect(fake.closed).toEqual([]);
      fake.registrations.set("main", { sessionId: "main-session", messages: [] });
      fake.registrations.set("companion-1", { sessionId: "companion-session", messages: [] });
      await recovered.reconcile();
      await expect(recovered.start({ paneId: "companion-1", sessionId: "companion-session" }, { model: "provider/model", instruction: "" })).rejects.toThrow("cannot start another companion");
      fake.registrations.set("main", { sessionId: "replacement", messages: [] });
      await recovered.reconcile();
      expect(fake.closed).toEqual(["companion-1"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("preserves projected replies outside the registration window, collapses direct activity, and rejects overlapping turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      await service.sendTurn(main, "First");
      fake.registrations.get("companion-1")!.messages = [{ messageId: "direct-1", text: "Direct pane response" }];
      expect((await service.state(main)).history).toEqual([
        { kind: "user", text: "First" },
        { kind: "assistant", messageId: "assistant-1", text: "Reply 1" },
        { kind: "activity", text: "Companion activity occurred in Herdr" },
      ]);

      let release!: () => void;
      fake.holdSend(new Promise<void>((resolve) => { release = resolve; }));
      const running = service.sendTurn(main, "Slow");
      await Promise.resolve();
      await expect(service.sendTurn(main, "Overlap")).rejects.toThrow("already in progress");
      release();
      await running;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("reserves a handoff before claiming so a restart cannot duplicate an uncertain delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      fake.failClaim();
      await expect(service.handoff(main, "request-uncertain", "edited answer")).rejects.toThrow("uncertain delivery");
      const recovered = new ExAICompanionCoordinator(fake.boundary, dir);
      await expect(recovered.handoff(main, "request-uncertain", "edited answer")).rejects.toThrow("already accepted");
      expect(fake.claims).toEqual(["edited answer"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("recovers only an exact live pair, closes a companion when its main is replaced, and makes handoff idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const first = new ExAICompanionCoordinator(fake.boundary, dir);
      await first.start(main, { model: "provider/model", instruction: "Help" });
      const recovered = new ExAICompanionCoordinator(fake.boundary, dir);
      await recovered.reconcile();
      expect((await recovered.state(main)).status).toBe("ready");
      await recovered.handoff(main, "request-1", "edited answer");
      await recovered.handoff(main, "request-1", "edited answer");
      expect(fake.claims).toEqual(["edited answer"]);
      fake.registrations.set("main", { sessionId: "replacement", messages: [] });
      await recovered.reconcile();
      expect(fake.closed).toEqual(["companion-1"]);
      expect((await recovered.state(main)).status).toBe("retired");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("surfaces live registration model and command metadata on the same pair without recreating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      const companion = fake.registrations.get("companion-1")!;
      companion.model = "provider/upgraded";
      companion.commands = [{ name: "review", description: "Review the diff" }];
      const state = await service.state(main);
      expect(fake.created).toEqual(["companion-1"]);
      expect(state.pair?.model).toBe("provider/upgraded");
      expect(state.pair?.commands).toEqual([{ name: "review", description: "Review the diff" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("stops the exact companion on request without touching the main", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      const state = await service.stop(main);
      expect(state.status).toBe("closed");
      expect(fake.closed).toEqual(["companion-1"]);
      expect(fake.panes.some((pane) => pane.id === "main")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("marks a directly closed companion closed without touching the main and allows an explicit replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      const main = { paneId: "main", sessionId: "main-session" };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      const index = fake.panes.findIndex((pane) => pane.id === "companion-1");
      fake.panes.splice(index, 1);
      fake.registrations.delete("companion-1");
      await service.reconcile();
      expect((await service.state(main)).status).toBe("closed");
      expect(fake.closed).toEqual([]);
      expect(fake.panes.some((pane) => pane.id === "main")).toBe(true);
      await service.start(main, { model: "provider/model", instruction: "Help" });
      expect(fake.created).toEqual(["companion-1", "companion-2"]);
      expect((await service.state(main)).status).toBe("ready");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("generates companion options for a main last-message boundary, de-dupes by boundary, and hides the generating turn from history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      // The companion replies with a numbered option list on its next send.
      fake.boundary.send = async (paneId: string, prompt: string) => {
        fake.sent.push({ paneId, prompt });
        const registration = fake.registrations.get(paneId)!;
        registration.messages.unshift({ messageId: `assistant-${fake.sent.length}`, text: "1. Ship it\n2. Ask for tests\n3. Request a rollback plan" });
      };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      const main = { paneId: "main", sessionId: "main-session" };
      await service.start(main, { model: "provider/model", instruction: "Help" });

      const first = await service.suggestOptions(main, "main-msg-1", "The build is green. What next?");
      expect(first.suggestion?.boundaryId).toBe("main-msg-1");
      expect(first.suggestion?.options).toEqual(["Ship it", "Ask for tests", "Request a rollback plan"]);
      // The prompt carried the main last message to the companion.
      expect(fake.sent[0].prompt).toContain("The build is green. What next?");
      // The generating turn is not projected into Ex AI Chat history nor surfaced as activity.
      expect(first.history).toEqual([]);

      // Same boundary: no new companion send, options are reused.
      const sentCount = fake.sent.length;
      const repeat = await service.suggestOptions(main, "main-msg-1", "The build is green. What next?");
      expect(fake.sent.length).toBe(sentCount);
      expect(repeat.suggestion?.options).toEqual(["Ship it", "Ask for tests", "Request a rollback plan"]);

      // A new boundary regenerates.
      const next = await service.suggestOptions(main, "main-msg-2", "Tests pass now.");
      expect(fake.sent.length).toBe(sentCount + 1);
      expect(next.suggestion?.boundaryId).toBe("main-msg-2");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("selecting a companion option hands it off to the main session idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ex-ai-companion-"));
    try {
      const fake = fakeBoundary();
      fake.boundary.send = async (paneId: string, prompt: string) => {
        fake.sent.push({ paneId, prompt });
        const registration = fake.registrations.get(paneId)!;
        registration.messages.unshift({ messageId: `assistant-${fake.sent.length}`, text: "1. Approve\n2. Revise" });
      };
      const service = new ExAICompanionCoordinator(fake.boundary, dir);
      const main = { paneId: "main", sessionId: "main-session" };
      await service.start(main, { model: "provider/model", instruction: "Help" });
      const state = await service.suggestOptions(main, "main-msg-1", "Ready for review.");
      const chosen = state.suggestion!.options[0];
      const requestId = `suggest:main-msg-1:0`;

      const first = await service.handoff(main, requestId, chosen);
      expect(fake.claims).toEqual(["Approve"]);
      // One click = one delivery; a retry with the same requestId does not re-deliver.
      const again = await service.handoff(main, requestId, chosen);
      expect(fake.claims).toEqual(["Approve"]);
      expect(again.deliveryId).toBe(first.deliveryId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parseSuggestedOptions", () => {
  test("extracts numbered options and trims markers and quotes", () => {
    expect(parseSuggestedOptions('1. "Approve the plan"\n2. Ask for tests\n3. Reduce scope')).toEqual([
      "Approve the plan", "Ask for tests", "Reduce scope",
    ]);
  });

  test("tolerates preamble, bullets, and blank lines without discarding the batch", () => {
    const raw = "Here are some options:\n\n- First idea\n\n- Second idea\n";
    expect(parseSuggestedOptions(raw)).toEqual(["First idea", "Second idea"]);
  });

  test("falls back to non-empty lines when nothing is explicitly marked", () => {
    expect(parseSuggestedOptions("Approve\nAsk for tests")).toEqual(["Approve", "Ask for tests"]);
  });

  test("de-duplicates and clamps to the small set, and never throws on empty input", () => {
    expect(parseSuggestedOptions("")).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `${i + 1}. Option ${i % 2}`).join("\n");
    const parsed = parseSuggestedOptions(many);
    expect(parsed).toEqual(["Option 0", "Option 1"]);
    expect(parsed.length).toBeLessThanOrEqual(MAX_SUGGESTED_OPTIONS);
  });
});
