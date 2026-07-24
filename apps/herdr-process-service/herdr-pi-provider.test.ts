import { describe, expect, test } from "bun:test";
import {
  HerdrPiProvider,
  type HerdrPiGateway,
} from "./herdr-pi-provider";

type Registration = {
  sessionId: string;
  messages: Array<{ messageId: string; text: string }>;
  agentStatus?: "working" | "idle" | "blocked" | "unknown";
};

function context() {
  return { mode: "plan-review" as const, plan: { plan: "# Test" } };
}

async function messages(session: Awaited<ReturnType<HerdrPiProvider["createSession"]>>): Promise<unknown[]> {
  const output: unknown[] = [];
  for await (const message of session.query("Reply exactly.")) output.push(message);
  return output;
}

describe("HerdrPiSession", () => {
  test("returns an SSE error when Pi settles a failed turn without an assistant message", async () => {
    const registrations = new Map<string, Registration>();
    let paneId = "";
    let registrationReads = 0;
    const gateway: HerdrPiGateway = {
      async launch() {
        paneId = "pane-1";
        registrations.set(paneId, { sessionId: "pi-session", messages: [], agentStatus: "idle" });
        return { paneId };
      },
      registration: (id) => {
        const registration = registrations.get(id);
        registrationReads += 1;
        return registration;
      },
      async waitForRegistration(id) {
        const registration = registrations.get(id);
        return registration && { ...registration, agentSettled: true };
      },
      async send(id) {
        registrations.set(id, { sessionId: "pi-session", messages: [], agentStatus: "idle" });
      },
      async close() {},
    };
    const provider = new HerdrPiProvider({ gateway, registrationTimeoutMs: 20, queryTimeoutMs: 400 });
    const session = await provider.createSession({ context: context(), cwd: "/repo" });

    await expect(messages(session)).resolves.toEqual([
      {
        type: "error",
        error: "The Herdr Pi pane stopped without producing a response.",
        code: "herdr_pi_error",
      },
    ]);
  });

  test("does not mistake a working pane with no message for a completed failed turn", async () => {
    const registrations = new Map<string, Registration>();
    const gateway: HerdrPiGateway = {
      async launch() {
        registrations.set("pane-1", { sessionId: "pi-session", messages: [], agentStatus: "idle" });
        return { paneId: "pane-1" };
      },
      registration: () => registrations.get("pane-1"),
      async waitForRegistration() {
        return registrations.get("pane-1");
      },
      async send() {
        registrations.set("pane-1", { sessionId: "pi-session", messages: [], agentStatus: "working" });
      },
      async close() {},
    };
    const provider = new HerdrPiProvider({ gateway, registrationTimeoutMs: 20, queryTimeoutMs: 400 });
    const session = await provider.createSession({ context: context(), cwd: "/repo" });

    await expect(messages(session)).resolves.toEqual([
      {
        type: "error",
        error: "The Herdr Pi pane did not produce a response before the timeout.",
        code: "herdr_pi_error",
      },
    ]);
  });

  test("returns a newly published assistant message before inspecting settled status", async () => {
    const registrations = new Map<string, Registration>();
    const gateway: HerdrPiGateway = {
      async launch() {
        registrations.set("pane-1", { sessionId: "pi-session", messages: [], agentStatus: "idle" });
        return { paneId: "pane-1" };
      },
      registration: () => registrations.get("pane-1"),
      async waitForRegistration() {
        return registrations.get("pane-1");
      },
      async send() {
        registrations.set("pane-1", {
          sessionId: "pi-session",
          messages: [{ messageId: "answer-1", text: "OK" }],
          agentStatus: "idle",
        });
      },
      async close() {},
    };
    const provider = new HerdrPiProvider({ gateway, registrationTimeoutMs: 20, queryTimeoutMs: 100 });
    const session = await provider.createSession({ context: context(), cwd: "/repo" });

    await expect(messages(session)).resolves.toEqual([
      { type: "text", text: "OK" },
      { type: "result", sessionId: session.id, success: true, result: "OK" },
    ]);
  });
});
