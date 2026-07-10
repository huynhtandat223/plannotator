import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { startReviewServer, handleReviewServerReady } from "@plannotator/server/review";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { registerSession, unregisterSession } from "@plannotator/server/sessions";
import { loadConfig, resolveSharingEnabled } from "@plannotator/shared/config";
import { getReviewApprovedPrompt, getReviewDeniedSuffix } from "@plannotator/shared/prompts";
import type { Origin } from "@plannotator/shared/agents";

// @ts-ignore - Bun import attribute for text
import reviewHtml from "../dist/review.html" with { type: "text" };
const reviewHtmlContent = reviewHtml as unknown as string;

const MAX_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;

function usage(): never {
  console.error("Usage: plannotator-review-folder <folder>");
  process.exit(1);
}

function shellLines(command: string[], cwd: string): string[] {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const message = result.stderr.toString().trim();
    throw new Error(message || `${command.join(" ")} failed`);
  }
  return result.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean);
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return sample.includes(0);
}

function escapePatchPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function fileAsAddedPatch(relativePath: string, text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  const patchPath = escapePatchPath(relativePath);
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewline = normalized.endsWith("\n") ? "" : "\n\\ No newline at end of file";
  return [
    `diff --git a/${patchPath} b/${patchPath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${patchPath}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    body || "+",
    noNewline,
  ].filter(Boolean).join("\n");
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) usage();

  const projectRoot = path.resolve(process.env.PLANNOTATOR_CWD || process.cwd());
  const folder = path.resolve(projectRoot, input);
  const relativeFolder = path.relative(projectRoot, folder);

  if (relativeFolder.startsWith("..") || path.isAbsolute(relativeFolder)) {
    throw new Error("Folder must be inside the current project.");
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error(`Folder not found: ${folder}`);
  }

  let files: string[];
  try {
    files = shellLines([
      "git", "ls-files", "--cached", "--others", "--exclude-standard", "--", relativeFolder || ".",
    ], projectRoot);
  } catch {
    files = shellLines([
      "find", relativeFolder || ".", "-type", "f",
      "-not", "-path", "*/.git/*",
      "-not", "-path", "*/node_modules/*",
    ], projectRoot);
  }

  files = files.slice(0, MAX_FILES);
  const patches: string[] = [];
  let skipped = 0;

  for (const relativePath of files) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (!absolutePath.startsWith(projectRoot + path.sep)) continue;
    const file = Bun.file(absolutePath);
    if (!(await file.exists()) || file.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isBinary(bytes)) {
      skipped++;
      continue;
    }
    patches.push(fileAsAddedPatch(relativePath, new TextDecoder().decode(bytes)));
  }

  if (patches.length === 0) {
    throw new Error(`No reviewable text files found in ${folder}`);
  }

  console.error(`Folder review: ${relativeFolder || "."} (${patches.length} files${skipped ? `, ${skipped} skipped` : ""})`);

  const origin = (process.env.PLANNOTATOR_ORIGIN || "claude-code") as Origin;
  const rawPatch = patches.join("\n\n");
  const sharingEnabled = resolveSharingEnabled(loadConfig());
  const project = (await detectProjectName()) ?? path.basename(projectRoot);

  process.on("exit", () => unregisterSession());

  const server = await startReviewServer({
    rawPatch,
    gitRef: `folder:${relativeFolder || "."}`,
    origin,
    agentCwd: projectRoot,
    sharingEnabled,
    htmlContent: reviewHtmlContent,
    onReady: async (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);
      if (!isRemote) await openBrowser(url);
    },
  });

  registerSession({
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode: "review",
    project,
    startedAt: new Date().toISOString(),
    label: `review-folder-${relativeFolder || project}`,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1000);
  server.stop();

  if (result.exit) {
    console.log("Folder review session closed without feedback.");
  } else if (result.approved) {
    console.log(getReviewApprovedPrompt(origin));
  } else {
    console.log(result.feedback);
    if (result.annotations.length > 0) console.log(getReviewDeniedSuffix(origin));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
