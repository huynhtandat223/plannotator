/**
 * Regression guard for the live message retention cap.
 *
 * The original defect was not the number, it was FOUR numbers: the extension
 * snapshot cap (4), the extension registration cap (5), a 25-slice in the
 * extension host, and a UI selector offering 10/All that no host could satisfy.
 * That disagreement is what made 10/All silently inert.
 *
 * These tests read the extension cap, the server 400 bound, and the UI option
 * ceiling and assert each is anchored to the one exported constant. They are
 * deliberately source-level for the two call sites that are not exported
 * values, because a literal reappearing inline is exactly the regression.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_MESSAGE_RETENTION } from "./live-message-window";
import { LIVE_RESPONSE_HISTORY_LIMIT } from "../../apps/ex-pi-extension/session";
import { HERDR_LIVE_MESSAGE_LIMIT as EXTENSION_REGISTRATION_LIMIT } from "../../apps/ex-pi-extension/herdr-registration";
import { MESSAGE_PICKER_COUNT_OPTIONS } from "../ui/utils/storage";

const repoRoot = join(import.meta.dir, "..", "..");
const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

describe("one retention constant, end to end", () => {
	test("the extension retention caps both read from the shared constant", () => {
		expect(LIVE_RESPONSE_HISTORY_LIMIT).toBe(LIVE_MESSAGE_RETENTION);
		expect(EXTENSION_REGISTRATION_LIMIT).toBe(LIVE_MESSAGE_RETENTION);
	});

	test("the server 400 bound reads from the shared constant", () => {
		// Source-level on purpose: importing the herdr server module executes a
		// module-scope readFileSync of apps/review/dist/index.html, so an import
		// here would make this test depend on a prior build (it fails in CI, which
		// tests without building). The regression risk is a literal reappearing at
		// the bound, and that is exactly what these assertions catch.
		const source = read("apps/herdr-process-service/server.ts");
		expect(source).toContain("export const HERDR_LIVE_MESSAGE_LIMIT = LIVE_MESSAGE_RETENTION;");
		// The 400 rejection must be driven by that symbol, never a hardcoded number.
		expect(source).toContain("messages.length > HERDR_LIVE_MESSAGE_LIMIT");
		expect(source).toContain("at most ${HERDR_LIVE_MESSAGE_LIMIT} messages are required");
	});

	test("every numeric UI option is within the shared constant's ceiling", () => {
		const numeric = MESSAGE_PICKER_COUNT_OPTIONS
			.filter((option) => option.value !== "all")
			.map((option) => Number(option.value));
		expect(numeric.length).toBeGreaterThan(0);
		for (const value of numeric) expect(value).toBeLessThanOrEqual(LIVE_MESSAGE_RETENTION);
	});

	test("the picker offers exactly the decided window and no inert 10", () => {
		expect(MESSAGE_PICKER_COUNT_OPTIONS.map((option) => option.label)).toEqual([
			"1",
			"3",
			"5",
			"All",
		]);
	});

	test("each retention call site imports the cap rather than restating it", () => {
		// These three import the shared module directly.
		const directImporters = [
			"apps/ex-pi-extension/session.ts",
			"apps/ex-pi-extension/herdr-registration.ts",
			"apps/herdr-process-service/server.ts",
			"packages/ui/utils/storage.ts",
		];
		for (const path of directImporters) {
			expect(read(path)).toContain("live-message-window");
		}
		// The extension host reaches the same constant through session.ts's
		// re-export; what matters is that it names a symbol, not a literal.
		expect(read("apps/ex-pi-extension/index.ts")).toContain("LIVE_RESPONSE_HISTORY_LIMIT");
	});

	test("the previously divergent literals are gone from their slice sites", () => {
		// The 25-slice in the extension host and the bare `= 5` / `= 4` caps.
		expect(read("apps/ex-pi-extension/index.ts")).not.toContain(".slice(0, 25)");
		expect(read("apps/ex-pi-extension/herdr-registration.ts"))
			.not.toContain("HERDR_LIVE_MESSAGE_LIMIT = 5");
		expect(read("apps/ex-pi-extension/session.ts"))
			.not.toContain("LIVE_RESPONSE_HISTORY_LIMIT = 4");
		expect(read("apps/herdr-process-service/server.ts"))
			.not.toContain("HERDR_LIVE_MESSAGE_LIMIT = 5");
	});

	test("retention is the decided 20 per pane", () => {
		expect(LIVE_MESSAGE_RETENTION).toBe(20);
	});

	test("published text is never truncated on the way to the picker", () => {
		// Spec deviation guard (decision-preview-truncation.md, Option A):
		// `text` doubles as the annotatable document body and the feedback-quote
		// source, and refetch-on-selection is disabled, so no truncation helper
		// may reappear in the snapshot build path.
		for (const path of [
			"apps/herdr-process-service/server.ts",
			"apps/ex-pi-extension/session.ts",
			"apps/ex-pi-extension/herdr-registration.ts",
		]) {
			expect(read(path)).not.toContain("toLiveMessagePreview");
		}
	});
});
