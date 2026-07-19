import { describe, expect, test } from "bun:test";
import {
  commandArgv,
  commandDelivery,
  feedbackBatch,
  instructionDelivery,
  scoutDelivery,
  panelsFromSnapshot,
  releasePanelSession,
  reviewSnapshotFromPanels,
  managedScouts,
  panelSessions,
  type HerdrPanel,
  type PanelSessionEnrichment,
} from "./server";

describe("feedbackBatch", () => {
  test("attributes global image attachments to the selected structured live response", () => {
    const messages = [{
      messageId: "w:p1:pi-message-1",
      paneId: "w:p1",
      assistantMessageId: "pi-message-1",
      text: "Structured response",
      label: "Response 1 · latest",
      description: "Structured Pi assistant response",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "working" as const,
      cwd: "/one",
    }];

    expect(feedbackBatch({
      annotations: [],
      codeAnnotations: [],
      selectedMessageId: "w:p1:pi-message-1",
      globalAttachments: [{ path: "/tmp/plannotator/reference.png", name: "reference" }],
    }, messages)).toEqual({
      paneId: "w:p1",
      batch: expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: "pi-message-1",
          annotations: [],
          globalAttachments: [{ path: "/tmp/plannotator/reference.png", name: "reference" }],
        })],
      }),
    });
  });

  test("attributes code-only feedback to the selected structured live response", () => {
    const messages = [{
      messageId: "w:p1:pi-message-1",
      paneId: "w:p1",
      assistantMessageId: "pi-message-1",
      text: "Structured response",
      label: "Response 1 · latest",
      description: "Structured Pi assistant response",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "working" as const,
      cwd: "/one",
    }];

    expect(feedbackBatch({
      annotations: [],
      codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
      selectedMessageId: "w:p1:pi-message-1",
    }, messages)).toEqual({
      paneId: "w:p1",
      batch: expect.objectContaining({
        messages: [expect.objectContaining({
          messageId: "pi-message-1",
          annotations: [],
          codeAnnotations: [{ id: "code-1", filePath: "src/app.ts", lineStart: 12, text: "Use a safer boundary." }],
        })],
      }),
    });
  });
});

describe("commandArgv", () => {
  test("parses executable arguments without shell evaluation", () => {
    expect(commandArgv('pi --model "claude sonnet"')).toEqual(["pi", "--model", "claude sonnet"]);
    expect(commandArgv("pi 'two words'")).toEqual(["pi", "two words"]);
  });

  test("rejects empty and incomplete commands", () => {
    expect(commandArgv("   ")).toBeNull();
    expect(commandArgv("pi \\")).toBeNull();
    expect(commandArgv("pi 'unterminated")).toBeNull();
  });
});

describe("commandDelivery", () => {
  const panel: HerdrPanel = { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "idle", focused: true };
  const registrations = new Map<string, PanelSessionEnrichment>([
    ["w:p1", {
      paneId: "w:p1",
      sessionId: "session-1",
      messages: [],
      commands: [{ name: "handoff-to-continue", description: "Write a handoff", source: "extension" }],
    }],
  ]);

  test("accepts an explicitly supported command for the current live pane session", () => {
    expect(commandDelivery({ paneId: "w:p1", command: "handoff-to-continue", args: "preserve this task" }, [panel], registrations)).toEqual({
      paneId: "w:p1",
      command: "handoff-to-continue",
      args: "preserve this task",
    });
  });

  test("rejects a raw slash-prefixed message and commands absent from this pane session", () => {
    expect(commandDelivery({ paneId: "w:p1", command: "/handoff-to-continue" }, [panel], registrations)).toBeNull();
    expect(commandDelivery({ paneId: "w:p1", command: "continue-handoff" }, [panel], registrations)).toBeNull();
    expect(commandDelivery({ paneId: "w:p2", command: "handoff-to-continue" }, [panel], registrations)).toBeNull();
  });

  test("drops the capability when the pane session is replaced", () => {
    const replaced = new Map(registrations);
    replaced.set("w:p1", { paneId: "w:p1", sessionId: "session-2", messages: [], commands: [] });
    expect(commandDelivery({ paneId: "w:p1", command: "handoff-to-continue" }, [panel], replaced)).toBeNull();
  });
});

describe("scoutDelivery", () => {
  const panel: HerdrPanel = { id: "w:p1", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "idle", focused: true };
  const source = {
    messageId: "w:p1:assistant-1", paneId: "w:p1", piSessionId: "session-1", assistantMessageId: "assistant-1",
    text: "I will replace the auth flow.", label: "Response 1 · latest", description: "Structured Pi assistant response",
    paneLabel: "one", paneDescription: "Pane p1", agentStatus: "idle" as const, cwd: "/one", workspaceId: "workspace-1",
  };
  const snapshot = { messages: [source], selectedMessageId: source.messageId, unreadMessageIds: [], draftsByMessageId: {}, sentAnnotationsByMessageId: {}, reviewRoundStatus: "open" as const, deliveryError: null };
  const registrations = new Map<string, PanelSessionEnrichment>([["w:p1", { paneId: "w:p1", sessionId: "session-1", messages: [{ messageId: "assistant-1", text: source.text }], commands: [] }]]);

  test("uses only the live registered structured source response to build a bounded Scout briefing", () => {
    const delivery = scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: source.messageId, question: "Find the unsafe assumptions." }, snapshot, [panel], registrations);
    expect(delivery?.request.sourceSessionId).toBe("session-1");
    expect(delivery?.request.prompt).toContain("Ideal direction");
    expect(delivery?.request.prompt).toContain(source.text);
    expect(delivery?.request.prompt).toContain("Find the unsafe assumptions.");
  });

  test("rejects waiting documents, foreign messages, and replaced source sessions", () => {
    expect(scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: "w:p1:waiting", question: "Inspect" }, snapshot, [panel], registrations)).toBeNull();
    expect(scoutDelivery({ sourcePaneId: "w:p1", sourceMessageId: source.messageId, question: "Inspect" }, snapshot, [panel], new Map([["w:p1", { ...registrations.get("w:p1")!, sessionId: "session-2" }]]))).toBeNull();
  });
});

describe("instructionDelivery", () => {
  test("accepts a text instruction for a live pane before it has an assistant response", () => {
    expect(instructionDelivery({ paneId: "w:p1", text: "Please start by checking the logs." }, [{
      messageId: "w:p1:waiting",
      paneId: "w:p1",
      piSessionId: "session-1",
      text: "Waiting for the Pi session to publish its latest assistant response.",
      label: "Waiting for a response",
      description: "No structured assistant response published yet",
      paneLabel: "one",
      paneDescription: "Pane p1",
      agentStatus: "idle" as const,
      cwd: "/one",
    }])).toEqual({ paneId: "w:p1", content: "Please start by checking the logs." });
  });

  test("rejects instructions without live pane text", () => {
    expect(instructionDelivery({ paneId: "w:p1", text: "   " }, [])).toBeNull();
    expect(instructionDelivery({ paneId: "closed:p1", text: "Hello" }, [])).toBeNull();
  });
});

describe("panelsFromSnapshot", () => {
  test("lists only live Pi agents with Herdr workspace and tab labels", () => {
    expect(panelsFromSnapshot({
      workspaces: [{ workspace_id: "workspace-1", label: "pi-harness" }],
      tabs: [{ tab_id: "tab-1", workspace_id: "workspace-1", label: "plannotator" }],
      agents: [
        {
          agent: "pi",
          agent_status: "working",
          foreground_cwd: "/home/me/codes/pi-harness",
          pane_id: "workspace-1:p9",
          tab_id: "tab-1",
          workspace_id: "workspace-1",
          focused: true,
        },
        {
          agent: "claude",
          agent_status: "working",
          cwd: "/home/me/codes/other",
          pane_id: "workspace-1:p10",
        },
      ],
    })).toEqual([{
      id: "workspace-1:p9",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      workspace: "pi-harness",
      tab: "plannotator",
      panel: "Pane p9",
      cwd: "/home/me/codes/pi-harness",
      status: "working",
      focused: true,
    }]);
  });

  test("uses stable fallbacks when Herdr has no resource labels", () => {
    expect(panelsFromSnapshot({
      agents: [{ agent: "pi", agent_status: "idle", cwd: "/work/repo", pane_id: "w:p1" }],
    })).toEqual([{
      id: "w:p1",
      workspaceId: "",
      tabId: "",
      workspace: "repo",
      tab: "",
      panel: "Pane p1",
      cwd: "/work/repo",
      status: "idle",
      focused: false,
    }]);
  });

  test("renders each pane's structured response history newest-first while retaining pane and Pi message identities", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session-1", commands: [], messages: [
        { messageId: "pi-message-1", text: "Newest response", timestamp: "2026-07-18T00:00:00.000Z" },
        { messageId: "pi-message-0", text: "Older response" },
      ] }],
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", commands: [], messages: [{ messageId: "pi-message-2", text: "Second pane response" }] }],
    ]);

    const snapshot = reviewSnapshotFromPanels(panels, "w:p2", enrichments);
    expect(snapshot.selectedMessageId).toBe("w:p2:pi-message-2");
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        messageId: "w:p1:pi-message-1",
        paneId: "w:p1",
        piSessionId: "session-1",
        assistantMessageId: "pi-message-1",
        text: "Newest response",
        timestamp: "2026-07-18T00:00:00.000Z",
        label: "Response 1 · latest",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p1:pi-message-0",
        paneId: "w:p1",
        assistantMessageId: "pi-message-0",
        text: "Older response",
        label: "Response 2",
        paneLabel: "one",
      }),
      expect.objectContaining({
        messageId: "w:p2:pi-message-2",
        paneId: "w:p2",
        piSessionId: "session-2",
        assistantMessageId: "pi-message-2",
        text: "Second pane response",
        paneLabel: "two",
      }),
    ]);
  });

  test("selects the newest response in the focused pane by default", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "session", commands: [], messages: [
        { messageId: "newest", text: "Newest" },
        { messageId: "older", text: "Older" },
      ] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, null, enrichments).selectedMessageId).toBe("w:p1:newest");
  });

  test("shows a truthful waiting document until the Pi extension enriches a live pane", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    const snapshot = reviewSnapshotFromPanels(panels);
    expect(snapshot.selectedMessageId).toBe("w:p1:waiting");
    expect(snapshot.messages[0].text).toContain("Waiting for the Pi session");
    expect(snapshot.messages[0].text).not.toContain("**Status:**");
  });

  test("escapes the waiting document working directory while preserving its copyable value", () => {
    const cwd = '/work/\"><img src=x onerror=alert(1)>';
    const snapshot = reviewSnapshotFromPanels([
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd, status: "working", focused: true },
    ]);

    expect(snapshot.messages[0].text).toContain('title="Working directory — select to copy: /work/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(snapshot.messages[0].text).toContain('/work/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(snapshot.messages[0].text).not.toContain('<img src=x');
  });

  test("keeps a live user pane selection across assistant message changes", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
      { id: "w:p2", workspace: "two", tab: "", panel: "Pane p2", cwd: "/two", status: "idle", focused: false },
    ];
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p2", { paneId: "w:p2", sessionId: "session-2", commands: [], messages: [{ messageId: "new-message", text: "New response" }] }],
    ]);

    expect(reviewSnapshotFromPanels(panels, "w:p2", enrichments).selectedMessageId).toBe("w:p2:new-message");
  });

  test("falls back when the remembered panel is no longer live", () => {
    const panels: HerdrPanel[] = [
      { id: "w:p1", workspace: "one", tab: "", panel: "Pane p1", cwd: "/one", status: "working", focused: true },
    ];

    expect(reviewSnapshotFromPanels(panels, "w:p2").selectedMessageId).toBe("w:p1:waiting");
  });

  test("does not let a shutting-down previous session remove a newer pane registration", () => {
    const enrichments = new Map<string, PanelSessionEnrichment>([
      ["w:p1", { paneId: "w:p1", sessionId: "new-session", commands: [], messages: [{ messageId: "message", text: "Newest response" }] }],
    ]);

    expect(releasePanelSession(enrichments, "w:p1", "old-session")).toBe(false);
    expect(enrichments.get("w:p1")?.sessionId).toBe("new-session");
    expect(releasePanelSession(enrichments, "w:p1", "new-session")).toBe(true);
    expect(enrichments.has("w:p1")).toBe(false);
  });

  test("includes scouts in reviewSnapshotFromPanels and handles pruning and status sync", () => {
    managedScouts.clear();
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: null,
      delivered: false,
    });

    // Test 1: includes scout when live panel matches key/cwd
    const panel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "working", focused: true };
    let snapshot = reviewSnapshotFromPanels([panel], null, new Map());
    expect(snapshot.scouts).toEqual([
      {
        workspaceKey: "workspace-1:/one",
        workspaceId: "workspace-1",
        cwd: "/one",
        paneId: "w:p2",
        status: "running",
      },
    ]);

    // Test 2: transitions running -> ready when delivered is true and panel is idle
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: true,
    });
    const idlePanel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "idle", focused: true };
    snapshot = reviewSnapshotFromPanels([idlePanel], null, new Map());
    expect(snapshot.scouts?.[0].status).toBe("ready");
    expect(managedScouts.get("workspace-1:/one")?.status).toBe("ready");
    expect(managedScouts.get("workspace-1:/one")?.pending).toBeNull();

    // Test 3: remains running if panel is working
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "running",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: true,
    });
    const workingPanel: HerdrPanel = { id: "w:p2", workspaceId: "workspace-1", workspace: "one", tab: "", panel: "Ex-Plannotator Scout", cwd: "/one", status: "working", focused: true };
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    expect(snapshot.scouts?.[0].status).toBe("running");

    // Test 4: handles failed status and includes error
    managedScouts.set("workspace-1:/one", {
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "failed",
      pending: { requestId: "req-1", sourcePaneId: "w:p1", sourceSessionId: "s-1", sourceAssistantMessageId: "a-1", prompt: "Go" },
      delivered: false,
      error: "Could not deliver prompt",
    });
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    expect(snapshot.scouts?.[0]).toEqual({
      workspaceKey: "workspace-1:/one",
      workspaceId: "workspace-1",
      cwd: "/one",
      paneId: "w:p2",
      status: "failed",
      error: "Could not deliver prompt",
    });

    // Test 5: prunes duplicate/stale mappings
    managedScouts.set("workspace-1:/two", {
      workspaceKey: "workspace-1:/two",
      workspaceId: "workspace-1",
      cwd: "/two",
      paneId: "w:p2",
      status: "ready",
      pending: null,
      delivered: false,
    });
    snapshot = reviewSnapshotFromPanels([workingPanel], null, new Map());
    // Since workingPanel cwd is /one, the workspace-1:/two mapping is stale and is pruned
    expect(snapshot.scouts?.length).toBe(1);
    expect(managedScouts.has("workspace-1:/two")).toBe(false);

    managedScouts.clear();
  });
});
