import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlanFolder, resolvePlanFolder } from "./plan-folder";

test("resolves plain, default, and Pi @-injected Plan Folder paths", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ex-plannotator-plan-folder-"));
	try {
		await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
		await mkdir(join(cwd, "plan"), { recursive: true });
		await writeFile(join(cwd, ".pi", "agent", "injected.md"), "# Injected\n");
		await writeFile(join(cwd, "plan", "default.md"), "# Default\n");

		for (const argument of [".pi/agent/", "@.pi/agent/"]) {
			const folder = await discoverPlanFolder(resolvePlanFolder(cwd, argument));
			expect(folder.files).toEqual([{ path: "injected.md", supported: true }]);
		}
		const defaultFolder = await discoverPlanFolder(resolvePlanFolder(cwd, ""));
		expect(defaultFolder.files).toEqual([{ path: "default.md", supported: true }]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
