import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type PlanFile = { path: string; supported: boolean };
export type PlanFolder = { root: string; files: PlanFile[] };
export type PlanFileSnapshot = PlanFile & { content: string; contentHash: string };

function normalizedRelativePath(folder: string, candidate: string): string {
	return relative(folder, candidate).split(sep).join("/");
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`));
}

export function resolvePlanFolder(cwd: string, argument: string): string {
	const requestedPath = argument.trim().replace(/^@/, "");
	return resolve(cwd, requestedPath || "./plan");
}

export async function discoverPlanFolder(folder: string): Promise<PlanFolder> {
	let root: string;
	try {
		root = await realpath(folder);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { root: resolve(folder), files: [] };
		}
		throw error;
	}
	const files: PlanFile[] = [];
	async function visit(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
			} else if (entry.isFile()) {
				files.push({
					path: normalizedRelativePath(root, path),
					supported: /\.mdx?$/i.test(entry.name),
				});
			}
		}
	}
	await visit(root);
	return { root, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

export async function readPlanFileSnapshot(folder: PlanFolder, file: PlanFile): Promise<PlanFileSnapshot> {
	if (!file.supported) throw new Error(`Unsupported Plan File format: ${file.path}`);
	const requestedPath = resolve(folder.root, file.path);
	if (!isWithinRoot(folder.root, requestedPath)) {
		throw new Error("Plan File is outside the selected Plan Folder.");
	}
	const canonicalPath = await realpath(requestedPath);
	if (!isWithinRoot(folder.root, canonicalPath)) {
		throw new Error("Plan File resolves outside the selected Plan Folder.");
	}
	if (!(await stat(canonicalPath)).isFile()) {
		throw new Error("Plan File is not a regular file.");
	}
	const content = await readFile(canonicalPath, "utf8");
	return {
		...file,
		content,
		contentHash: createHash("sha256").update(content).digest("hex"),
	};
}
