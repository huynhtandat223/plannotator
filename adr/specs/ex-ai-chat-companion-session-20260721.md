# Spec: Ex AI Chat companion sessions for Herdr

Date: 2026-07-21 · Status: ready for agent

## Problem Statement

Ex-Plannotator currently has Ask AI and a Grill action. Grill is a one-shot option-generation and feedback-confirmation flow. It is buggy, and its interaction model does not match the desired workflow.

The desired workflow is a first-layer assistance session that runs beside a live main Pi session. The assistant must be a real Pi session in a real Herdr pane, with the same model changes, commands, extensions, annotations, tools, transcript, and custom behavior available to an ordinary Pi pane. It must know which main session it assists, but remain an independent conversation. It must survive browser reloads and Herdr host-service restarts for as long as the paired main session remains live.

The existing Ask AI feature must remain unchanged. Ex AI Chat therefore needs an independent header action, panel state, transport, lifecycle, and durable pairing contract. It may reuse stable presentation components, but it must not change Ask AI behavior or state.

## Solution

Add **Ex AI Chat** as a separate header action next to the existing annotations and Ask AI actions in Ex-Plannotator's live Herdr mode. It opens a dedicated chat panel with the same familiar user/assistant history and composer experience as Ask AI. Ask AI and Ex AI Chat are mutually exclusive on screen, but hiding either panel does not discard its state or session.

The first time Ex AI Chat is opened for an eligible main `{ paneId, Pi sessionId }`, the panel shows an inline setup view. Global defaults provide a Pi model and base instruction. The user may override those values for this companion before pressing **Start**. Start uses the existing Herdr process-panel creation capability to create a normal Pi process in a new, unfocused tab in the same Herdr workspace and working directory.

The main and companion sessions are independent. A durable one-to-one pairing lets all browser tabs find the same companion and lets the host service recover the relationship after a restart. The companion receives the base instruction, main workspace, and main transcript path through the same first-turn preamble pattern already proven by Herdr Ask AI. It may read the main transcript when useful; new main messages are not copied automatically into its chat.

Ex AI Chat history contains only turns initiated through Ex AI Chat. Activity performed directly in the companion Herdr pane remains part of the real Pi session and model context, but appears in Ex AI Chat only as a collapsed **Companion activity occurred in Herdr** event. Assistant responses produced through Ex AI Chat can be edited and explicitly sent to the paired main session through an idempotent, identity-checked follow-up delivery.

The companion follows the main session lifecycle. Closing or replacing the main Pi session closes its companion. Closing the companion directly leaves the main session untouched and returns Ex AI Chat to a recoverable closed state from which the user may start a replacement.

## User Stories

1. As an Ex-Plannotator user, I want an Ex AI Chat action in the pinned header controls, so that assistance is available without entering a comment popover.
2. As an Ex-Plannotator user, I want Ex AI Chat to be visually separate from Ask AI, so that the new workflow does not change the existing feature.
3. As an Ask AI user, I want Ask AI's UI, behavior, history, provider selection, session lifecycle, and APIs to remain unchanged, so that the new feature does not regress my existing workflow.
4. As an Ex-Plannotator user, I want opening Ask AI to hide Ex AI Chat and opening Ex AI Chat to hide Ask AI, so that the document layout does not become crowded.
5. As an Ex-Plannotator user, I want hidden chat panels to retain their state, so that switching between Ask AI and Ex AI Chat does not lose work.
6. As an Ex-Plannotator user, I want Ex AI Chat to use the familiar Ask AI conversation layout, so that user and assistant messages remain easy to scan.
7. As an Ex-Plannotator user, I want Ex AI Chat to have its own controller and state, so that its real-pane semantics do not leak into Ask AI.
8. As an Ex-Plannotator user, I want the first Ex AI Chat open for a main session to show setup inside the chat panel, so that I can configure it without a separate modal.
9. As an Ex-Plannotator user, I want a global default model for Ex AI Chat, so that common sessions require little setup.
10. As an Ex-Plannotator user, I want a global default base instruction for Ex AI Chat, so that companion sessions start with my preferred assistance role.
11. As an Ex-Plannotator user, I want to override the default model before starting a companion, so that a specific main session can use a better-suited model.
12. As an Ex-Plannotator user, I want to override the base instruction before starting a companion, so that its role can match the current task.
13. As an Ex-Plannotator user, I want no companion process to start before I press Start, so that merely opening the panel has no process or model cost.
14. As an Ex-Plannotator user, I want Start to create an ordinary Pi pane through Herdr's existing process-panel behavior, so that the companion has the same runtime as my customized Pi sessions.
15. As a Herdr user, I want the companion created in a new unfocused tab in the main session's workspace and working directory, so that the main pane layout and focus are preserved.
16. As a Pi user, I want the companion to load normal Pi configuration, extensions, commands, tools, annotations, model controls, and custom behavior, so that it is not a restricted hidden provider process.
17. As an Ex AI Chat user, I want model changes and supported commands to operate on the existing companion Pi session, so that using them does not silently replace my conversation.
18. As an Ex AI Chat user, I want model and capability metadata changed directly in Herdr to be reflected by the Ex AI Chat surface, so that both views describe the same real session.
19. As an Ex AI Chat user, I want the companion to know the paired main session's workspace and transcript path, so that it can inspect the main conversation when useful.
20. As an Ex AI Chat user, I want my base instruction and main-session reference added to the first Ex AI Chat turn using the proven Ask AI preamble pattern, so that setup context is hidden from the displayed chat without inventing a separate prompt system.
21. As an Ex AI Chat user, I want subsequent turns to send only my new message, so that setup context is not repeatedly pasted into the conversation.
22. As an Ex AI Chat user, I want the companion to read the latest main transcript when needed rather than receiving every main message automatically, so that it remains an independent first-layer assistant.
23. As an Ex AI Chat user, I want one companion for each live main `{ paneId, Pi sessionId }`, so that assistance never crosses session boundaries.
24. As an Ex AI Chat user, I want changing the selected assistant response within the same main Pi session to preserve the companion, so that response navigation does not fragment assistance.
25. As an Ex AI Chat user, I want switching to another main session to show that session's companion or setup state, so that each main conversation has isolated assistance.
26. As an Ex AI Chat user, I want returning to a previous live main session to restore its Ex AI Chat, so that pane navigation does not lose the conversation.
27. As a user with multiple browser tabs, I want all tabs to resolve to the same companion for a main session, so that duplicate Pi processes are not created.
28. As a user with multiple browser tabs, I want Ex AI Chat turns to be serialized by the host service, so that concurrent sends cannot overlap or corrupt one Pi session.
29. As an Ex AI Chat user, I want browser reload to restore the pair and Ex AI Chat history, so that a UI refresh does not lose my assistance session.
30. As an Ex AI Chat user, I want a Herdr host-service restart to reconnect to an existing live pair and restore its history, so that host maintenance does not create a duplicate companion.
31. As an operator, I want restart recovery to reconcile against fresh Herdr liveness and Pi registration, so that persisted metadata never makes a dead pane appear live.
32. As an operator, I want a missing main session discovered during recovery to close any surviving paired companion, so that restart cannot leave managed orphan panes.
33. As an Ex AI Chat user, I want the history to show only user and assistant turns initiated through Ex AI Chat, so that direct terminal activity does not make the chat UI confusing.
34. As an Ex AI Chat user, I want the displayed user text to omit the hidden setup preamble, so that the history contains what I actually typed.
35. As an Ex AI Chat user, I want assistant content to come from the real Pi session transcript or registration, so that the browser does not maintain a divergent assistant transcript.
36. As an Ex AI Chat user, I want direct companion-pane activity represented by a collapsed event rather than copied messages, so that I know the model context changed without merging two interfaces' histories.
37. As a Herdr user, I want to interact directly with the companion pane as a normal Pi pane, so that Ex AI Chat does not remove native Pi capabilities.
38. As an Ex-Plannotator user, I want companion panes to appear in the existing picker with an **Ex AI companion** badge, so that managed panes remain visible and understandable.
39. As an Ex-Plannotator user, I want Ex AI Chat creation disabled for a selected companion pane, so that companion chains and cycles cannot be created.
40. As a main-session user, I want closing or replacing my main Pi session to close its companion, so that the companion lifecycle follows the session it assists.
41. As a main-session user, I want closing the companion directly to leave the main session running, so that assistance remains optional.
42. As an Ex AI Chat user, I want a directly closed companion to produce a clear closed state, so that I understand why the chat is unavailable.
43. As an Ex AI Chat user, I want to start a replacement after a companion is closed, so that I can recover without restarting the main session.
44. As an Ex AI Chat user, I do not want a closed companion recreated automatically, so that the system never starts an unexpected model process.
45. As an Ex AI Chat user, I want each assistant response to offer **Send to main session**, so that useful assistance can be handed back explicitly.
46. As an Ex AI Chat user, I want Send to main session to open an editor prefilled with the assistant response, so that I can review and revise AI text before delivery.
47. As an Ex AI Chat user, I want only **Confirm send** to enqueue the edited text, so that viewing or editing never affects the main session.
48. As a main-session user, I want confirmed text delivered as a follow-up to the exact paired `{ paneId, sessionId }`, so that it reaches the intended conversation.
49. As an Ex AI Chat user, I want stale or closed main-session errors to preserve my edited draft, so that I can copy or retry safely.
50. As an Ex AI Chat user, I want uncertain delivery retries to be idempotent, so that the main session receives the follow-up at most once.
51. As a main-session user, I want the server to validate current Herdr liveness and Pi registration before accepting a handoff, so that browser state alone cannot target a replaced session.
52. As a security-conscious operator, I want Ex AI Chat mutations to use the existing loopback, Tailscale, or write-token browser authorization and loopback-only Pi claim boundary, so that the feature does not widen host access.
53. As an Ex-Plannotator user, I want Grill removed from Global Comments, so that the broken one-shot option workflow no longer appears.
54. As a maintainer, I want Grill-specific option parsing, option cards, custom-answer, regenerate, Confirm, source-capture, and feedback wiring removed when they have no Ex AI Chat use, so that dead behavior is not retained.
55. As a maintainer, I want stable Ask AI presentation and Herdr pane/session primitives reused only where their contracts match, so that the implementation stays small without coupling unrelated lifecycle semantics.
56. As a maintainer, I want generated Ex-Pi browser bundles rebuilt through the canonical build, so that source and shipped UI remain aligned.

## Implementation Decisions

- Ex AI Chat is an Ex-Plannotator Herdr feature. It is not added to Official Plannotator flows.
- Version one supports Pi companions only. OpenCode and generic command companions are out of scope.
- Ex AI Chat is a first-layer assistance session, not a Grill, evaluator, review mode, annotation mode, or hidden AI provider session.
- The existing Ask AI feature is a preservation boundary. Its feature set, UI, state, transport, provider behavior, and lifecycle remain unchanged.
- Ex AI Chat gets a separate header action, panel controller, state, routes, and lifecycle. It may reuse presentational chat components where that reuse does not alter Ask AI.
- The Ex AI Chat header action is placed with the pinned Close, annotations, and Ask AI controls. It is available only for eligible non-companion live Herdr Pi sessions.
- Ask AI and Ex AI Chat are mutually exclusive only at the layout level. Hiding either panel does not reset it.
- Setup is an inline state of the Ex AI Chat panel. It is not a modal.
- Global settings store the default Pi model and base instruction. The per-main-session setup begins with those defaults and may override them before Start.
- Opening setup is lazy. No Herdr tab, pane, Pi process, or AI session is created until Start succeeds.
- Start reuses the existing Herdr process-panel creation behavior: create a named background tab without focus, then start Pi in the main pane's authorized workspace and working directory.
- The companion is an ordinary interactive Pi process, not the read-only tool-limited process currently used as the Herdr Ask AI provider. Normal Pi discovery and customization remain enabled.
- The pairing cardinality is one live companion per exact main `{ paneId, Pi sessionId }`. A pane that starts a new Pi session represents a new main identity and cannot inherit the old companion.
- Companion metadata explicitly identifies the pane as managed by Ex AI Chat and records its main identity. This metadata drives picker badges, nested-companion prevention, lifecycle reconciliation, and recovery.
- The service owns a small durable companion registry under Plannotator's configured data directory. It is written atomically and stores only the information needed to recover pair identity, setup choices, companion identity, UI-originated turn projection, and delivery idempotency. It is not a second full Pi transcript.
- Fresh Herdr snapshots and current Pi registrations remain authoritative for liveness. Durable records are hints to reconcile, never proof that a pane or session is current.
- On browser or service startup, reconciliation checks both sides of every persisted pair. A live exact pair is reattached; a dead companion yields a closed/restartable state; a dead or replaced main causes the managed companion to close and the pair to retire.
- Concurrent Start calls for one main identity are serialized server-side. After the first succeeds, all callers receive the same pair rather than creating extra panes.
- Chat turn submission is also serialized per companion. A second request receives an observable queued or busy state rather than executing concurrently.
- The companion process registers through the existing Pi-to-Herdr enrichment channel. Ex AI Chat relies on structured Pi session identity and finalized messages, never terminal scraping.
- The first Ex AI Chat turn uses the same effective-prompt approach as Herdr Ask AI: a hidden preamble is combined with the user's first prompt. The preamble contains the configured base instruction, main workspace, main transcript path, and a concise statement that the transcript is optional context rather than authority.
- The displayed first user message contains only the user's input. The hidden preamble is not rendered as a separate chat item.
- Later Ex AI Chat turns send only the new user input. Main transcript updates are not automatically injected.
- The companion may inspect the live main transcript when the user's request or base instruction makes it useful. It is not forced to review or evaluate the currently selected assistant response.
- Ex AI Chat's durable history is a projection of UI-originated turns. The projection records enough identity and display metadata to distinguish Ex AI Chat turns from direct Herdr-pane activity. Final assistant content is resolved from the real companion session data whenever available.
- Direct activity in the companion pane remains normal Pi conversation context. It is not copied into Ex AI Chat as user or assistant bubbles. One or more unprojected activities are summarized as collapsed companion-activity events.
- The Ex AI Chat panel uses Ask AI's familiar conversation presentation, loading/error affordances, and composer conventions. It does not reuse Ask AI's session hook where the hook's hidden-provider semantics conflict with a persistent real pane.
- Model changes and supported commands target the existing companion session. They do not recreate the pair. Registered companion capability and model metadata are the authoritative UI source.
- Companion panes stay visible in the normal live picker and carry an **Ex AI companion** badge. Selecting one never offers creation of another companion.
- Main lifecycle owns companion lifecycle. When a fresh snapshot or registration shows the main pane closed or its Pi session replaced, the service closes the companion pane/tab and retires the pair.
- Direct companion closure never closes the main. The service marks the companion closed and requires explicit Start to create a replacement.
- Send to main session is an explicit action on an Ex AI assistant response. It opens an editor containing the response; editing has no side effects.
- Confirm send creates a follow-up delivery to the exact paired main identity. It reuses the existing browser-authorized, Pi-claimed message bridge rather than invoking a shell command or writing to a transcript.
- Each handoff has a stable client request ID. The host persists a bounded idempotency result long enough for uncertain retries and returns the original result for duplicates. Claiming remains at-most-once.
- The service independently validates the main pane's current Herdr liveness and exact Pi session registration at confirm time. Stale, closed, unauthorized, malformed, and delivery errors never clear the editor draft.
- Multiple browser tabs share server-owned pair and history state. Browser-local state controls only presentation such as whether the panel is open and the current unsent editor draft.
- Existing browser mutation authorization remains unchanged: loopback, approved Tailscale peers, or write-token cookie. Pi registration and delivery claims remain loopback-only.
- Grill UI and behavior are removed: the Global Comment Grill action, option generation, strict 3–5 option parsing, option cards, selected/custom answers, regeneration, Grill Confirm, source identity capture, and Grill-specific feedback request handling.
- Generic, still-used infrastructure may remain: standard chat presentation, general AI transport helpers used elsewhere, Herdr process-panel creation, panel registration, source-session resolution, queue claim behavior, and reusable idempotency mechanics. Grill-only names and contracts must not be retained merely in case they are useful later.
- Canonical Ex-Pi source remains the sole source of truth. Generated browser bundles are rebuilt and never edited directly.

## Testing Decisions

- The highest test seam is the browser-facing **Ex AI companion contract owned by the Herdr service**. Tests should exercise externally observable lifecycle behavior through this contract: setup, Start, pair recovery, turn submission, projected history, direct-activity events, companion closure, main closure, replacement, and send-to-main delivery.
- Tests should assert behavior and identity invariants, not internal map names, storage layout, React state shape, shell command formatting, or private helper calls.
- Service tests use a fake Herdr/Pi boundary to provide snapshots, pane creation results, registration updates, finalized transcript messages, and close events. The contract is considered correct when observable API state and host actions match the stories.
- Pairing tests cover exact `{ paneId, Pi sessionId }` identity, response changes within one session, pane session replacement, companion identity, nested-companion rejection, and concurrent Start coalescing.
- Recovery tests create durable state, construct a fresh service instance, and verify that it reattaches only to a still-live exact pair. They also verify closed-companion and orphan-companion reconciliation.
- Chat tests verify first-turn hidden preamble behavior, clean displayed user text, subsequent prompt behavior, serialized turns, finalized assistant responses, and recovery of projected history.
- Direct-activity tests verify that unprojected companion turns do not become normal chat bubbles and instead produce a collapsed activity event while later Ex AI turns continue in the same Pi session.
- Capability tests verify that model and command changes address the current companion session and do not create a replacement pane.
- Handoff tests verify edit-before-confirm, exact main identity validation, stale-session rejection, draft preservation, stable request IDs, duplicate retry behavior, and one successful Pi claim.
- Lifecycle tests verify that main closure or session replacement closes the companion, while direct companion closure leaves main untouched and exposes explicit replacement setup.
- Authorization tests verify that the new mutating routes preserve existing browser-write and loopback-only claim boundaries.
- UI component tests cover only the Ex AI-specific surface: header visibility and active state, mutual visual exclusion with Ask AI without state reset, inline setup, history rendering, collapsed direct-activity event, closed state, and edit/confirm handoff.
- Ask AI receives preservation/regression coverage rather than implementation changes: its existing tests continue to pass, and a focused integration assertion verifies that Ex AI toggling does not reset or reroute Ask AI.
- Picker tests verify the companion badge and that a selected companion cannot start a nested companion.
- Grill removal tests verify that Global Comment no longer exposes Grill and that no Grill request path remains reachable.
- Existing Herdr service tests are prior art for snapshot normalization, panel/session registration, process-panel creation, identity checks, queue claims, idempotency, and security boundaries.
- Existing live-message scope tests are prior art for pane/session boundary reconciliation and stale browser state removal.
- Existing Ask AI hook and component tests are prior art for chat presentation, loading/error behavior, message rendering, and transport-shaped test doubles. New tests should reuse those visible conventions without coupling Ex AI to the Ask AI session hook.
- End-to-end manual acceptance uses the canonical built Ex-Pi UI in a real Chrome browser and live Herdr/Pi panes. It verifies Start, normal multi-turn chat, model/command behavior, browser reload, service restart, direct companion activity, pane switching, handoff to main exactly once, direct companion close, and main close.
- The focused server, extension, editor, UI, typecheck, formatting, generated-bundle build, service health, and browser checks documented for Ex-Plannotator/Herdr remain required.

## Out of Scope

- Changing, replacing, or redesigning existing Ask AI.
- Retaining or repairing Grill as a user-facing workflow.
- OpenCode, Claude, Codex, or arbitrary-command companion providers.
- More than one companion for a main Pi session.
- Companion-of-companion chains or cycles.
- Showing Ask AI and Ex AI Chat simultaneously.
- Automatically attaching the currently selected response, annotations, or review draft to Ex AI Chat prompts.
- Automatically forwarding new main-session messages into the companion conversation.
- Automatically sending Ex AI responses to the main session.
- Automatically recreating a companion that the user closed directly.
- Mirroring all direct companion-pane messages as Ex AI Chat bubbles.
- Persisting a duplicate full Pi transcript.
- A standalone terminal emulator or custom replacement for the Herdr pane.
- Making companion persistence authoritative over Herdr snapshots or Pi registration.
- Changes to Official Plannotator server runtimes or document UI behavior unrelated to Ex-Plannotator.

## Further Notes

- “Main session” means the exact live Pi session selected in a non-companion Herdr pane, identified by both Herdr pane ID and Pi session ID.
- “Companion” means a normal Pi session created in a managed Herdr pane and paired one-to-one with a main session.
- “Ex AI Chat” means the browser chat projection and controls for that companion. It is not the companion itself and is not a second AI transcript.
- The relationship is intentionally asymmetric: the companion can read the main transcript and explicitly send an edited response back, while the main session does not automatically ingest companion activity.
- Reusing Ask AI means reusing proven presentation and first-turn prompt conventions. It does not mean sharing Ask AI state, hidden provider lifecycle, or `/api/ai/*` ownership.
- The first Ex AI turn initializes the base instruction and main transcript reference. Until that first Ex AI turn, direct use of the companion pane has only its normal Pi context.
- The existing Herdr rule remains: live snapshot and current Pi registration are authority. Recovery must be conservative when either side is uncertain.
