import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fingerprint(path: string): string | null {
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Ex-Plannotator build isolation", () => {
	test("builds its browser asset without creating or changing Official Plannotator assets", () => {
		const repositoryRoot = resolve(import.meta.dir, "../..");
		const exAsset = resolve(import.meta.dir, "ex-plannotator.html");
		const planAsset = resolve(import.meta.dir, "ex-plannotator-plan.html");
		const officialAssets = [
			resolve(import.meta.dir, "../pi-extension/plannotator.html"),
			resolve(import.meta.dir, "../pi-extension/review-editor.html"),
		];
		const officialBefore = officialAssets.map(fingerprint);
		const lastBefore = fingerprint(exAsset);

		const build = spawnSync("bun", ["run", "--cwd", "apps/ex-pi-extension", "build:plan"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});

		expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
		expect(fingerprint(exAsset)).toBe(lastBefore);
		expect(existsSync(planAsset)).toBe(true);
		expect(readFileSync(planAsset, "utf8")).toContain("data-plan-review-sources");
		expect(officialAssets.map(fingerprint)).toEqual(officialBefore);
	}, 60_000);
});
