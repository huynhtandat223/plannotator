import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Ex-Plannotator build isolation", () => {
	test("builds its browser into only the Ex package asset", () => {
		const exPackage = JSON.parse(readFileSync(resolve(import.meta.dir, "package.json"), "utf8"));
		const officialPackage = JSON.parse(readFileSync(resolve(import.meta.dir, "../pi-extension/package.json"), "utf8"));
		const rootPackage = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"));

		expect(exPackage.scripts.build).toContain("../ex-review");
		expect(exPackage.scripts.build).toContain("ex-plannotator.html");
		expect(exPackage.scripts.build).not.toContain("../hook");
		expect(officialPackage.scripts.build).not.toContain("ex-review");
		expect(officialPackage.scripts.build).not.toContain("ex-plannotator.html");
		expect(rootPackage.scripts["build:ex-pi"]).toBe("bun run --cwd apps/ex-pi-extension build");
	});
});
