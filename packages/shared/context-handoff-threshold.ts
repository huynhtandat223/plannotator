/**
 * Single source of truth for the context-window "high-water" percent that both
 * the handoff warning banner (PR #26, apps/herdr-process-service/context-handoff.ts)
 * and the live pane-chip CTX warning tone (PR #27, packages/editor/livePaneChips.ts)
 * read from.
 *
 * Before this constant the two surfaces disagreed: the banner fired at 72%
 * (PLANNOTATOR_HANDOFF_HIGH_PERCENT default) while the chip tone flipped at 75%,
 * so at 72–74% the banner said "context high" but the chip stayed calm. Anchoring
 * both to one number keeps them consistent at the boundary. We adopt the existing
 * #26 high-water (72%) as the single default source. The Herdr host publishes
 * any effective PLANNOTATOR_HANDOFF_HIGH_PERCENT override to the editor so the
 * chip and banner also agree under custom configuration.
 */
export const CONTEXT_HANDOFF_HIGH_PERCENT = 72;
