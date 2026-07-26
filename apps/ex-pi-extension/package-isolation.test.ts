import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fingerprint(path: string): string | null {
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Ex-Plannotator build isolation", () => {
	// The bundle is not committed: CI runs the real package build and asserts
	// it yields a servable production bundle ("Ex-Plannotator bundle builds"
	// step); this suite only guards source contracts and build isolation.
	test("live global comment gate targets the selected live pane", () => {
		const repositoryRoot = resolve(import.meta.dir, "../..");
		const editorSource = readFileSync(resolve(repositoryRoot, "packages/editor/App.tsx"), "utf8");
		const gateStart = editorSource.indexOf("const sendsGlobalCommentAsUserMessage");
		const gate = editorSource.slice(gateStart, editorSource.indexOf(";", gateStart));

		expect(gate).toContain("liveMessageReview");
		expect(gate).toContain("selectedLiveMessage?.paneId");
		expect(gate).not.toContain("assistantMessageId");
	});

	test("built browser asset, when present, is a production build", () => {
		// The bundle is gitignored, so a fresh checkout has none — that is fine.
		// But a stale dev-flavored local build must never linger to be served or
		// published: a bundle rebuilt under NODE_ENV=development/test carries
		// jsxDEV calls and README warnings.
		const assetPath = resolve(import.meta.dir, "ex-plannotator.html");
		if (!existsSync(assetPath)) return;
		expect(readFileSync(assetPath, "utf8")).not.toContain("jsxDEV");
	});

	test("built browser asset, when present, ships the image feedback affordances", () => {
		// Truthful image feedback: the live pane's Send message is text-only and
		// image feedback rides its own attach action on /api/feedback. The
		// bundle is gitignored, so a fresh checkout has none — that is fine.
		const assetPath = resolve(import.meta.dir, "ex-plannotator.html");
		if (!existsSync(assetPath)) return;
		const browserAsset = readFileSync(assetPath, "utf8");
		expect(browserAsset).toContain("Attach image feedback");
		expect(browserAsset).toContain("text-message-transport-only");
	});

	test("builds its browser asset without creating or changing working-tree assets", () => {
		const repositoryRoot = resolve(import.meta.dir, "../..");
		const exAsset = resolve(import.meta.dir, "ex-plannotator.html");
		const officialAssets = [
			resolve(import.meta.dir, "../pi-extension/plannotator.html"),
			resolve(import.meta.dir, "../pi-extension/review-editor.html"),
		];
		const officialBefore = officialAssets.map(fingerprint);
		const exBefore = fingerprint(exAsset);

		// Build into a temp directory: a test run must never rewrite the
		// working-tree artifact a user built for install/serving (that is
		// exactly how a dev-flavored bundle got committed once, back when the
		// bundle was tracked).
		const outDir = mkdtempSync(join(tmpdir(), "ex-plannotator-build-"));
		try {
			const build = spawnSync("bun", ["x", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
				cwd: resolve(repositoryRoot, "apps/hook"),
				encoding: "utf8",
				env: { ...process.env, NODE_ENV: "production" },
			});

			expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
			const built = readFileSync(join(outDir, "index.html"), "utf8");
			expect(built).toContain("data-plan-review-sources");
			expect(built).not.toContain("jsxDEV");
			expect(fingerprint(exAsset)).toBe(exBefore);
			expect(officialAssets.map(fingerprint)).toEqual(officialBefore);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 60_000);
});
