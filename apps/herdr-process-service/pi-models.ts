/**
 * Pi model discovery—parse `pi --list-models` output into a model list that
 * can be advertised through the AI capabilities endpoint without blocking
 * server startup.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PI_LIST_MODELS_TIMEOUT_MS = 8_000;

export interface PiModel {
  id: string;
  label: string;
}

/**
 * Parse `pi --list-models` output.
 *
 * The table has fixed-width whitespace-separated columns:
 * `provider  model  context  max-out  thinking  images`.
 *
 * Pi's `model` values already contain their provider prefix (for example
 * `cx/gpt-5.6-terra`), so the first two cells form one selectable ID.
 */
export function parsePiListModels(stdout: string): PiModel[] {
  const models: PiModel[] = [];
  const seen = new Set<string>();
  const lines = stdout.split(/\r?\n/);
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Table header: "provider  model  ..."
    if (!headerSeen && /^provider\b.*\bmodel\b/i.test(trimmed)) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue;

    // The first two whitespace-delimited cells are provider and model. Context
    // starts with a numeric size (or `---`), which keeps malformed prose out.
    const match = trimmed.match(/^(?<provider>\S+)\s+(?<model>\S+)\s+(?<context>\d+(?:\.\d+)?[KMG]|---)\b/);
    if (!match?.groups?.provider || !match.groups.model) continue;

    const modelId = `${match.groups.provider}/${match.groups.model}`;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({ id: modelId, label: modelId });
  }

  return models;
}

/**
 * Discover Pi models by running `pi --list-models` in a child process.
 * Returns an empty array on any failure (binary missing, timeout, parse
 * failure) so the caller can safely call this from non-Pi environments.
 */
export async function discoverPiModels(): Promise<PiModel[]> {
  try {
    const { stdout } = await execFileAsync("pi", ["--list-models"], {
      timeout: PI_LIST_MODELS_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    return parsePiListModels(stdout);
  } catch {
    return [];
  }
}
