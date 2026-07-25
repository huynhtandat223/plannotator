// Builds the short, redacted, single-line command summary that a bash-like tool
// entry carries on the live activity trail (see herdr-registration.ts). This is
// the ONLY place a raw tool command is inspected; the output is deliberately
// lossy so no secret ever reaches the wire or the DOM.
//
// SECURITY MODEL (conservative by design):
//   1. Redact obvious secret-looking substrings (tokens, key=value secrets,
//      Authorization headers, URL creds, long high-entropy blobs) → `‹redacted›`.
//   2. Collapse whitespace to a single line.
//   3. Hard-truncate to COMMAND_SUMMARY_MAX chars with an ellipsis.
// Redaction runs BEFORE truncation so a secret at the tail can't survive by
// being cut off mid-token. Full commands are never logged or returned.

/** Hard cap on a summarized command; short enough to render inline in a chip. */
export const COMMAND_SUMMARY_MAX = 80;

/** Placeholder substituted for any redacted secret-looking span. */
export const REDACTED = '‹redacted›';

// Tool names whose `args.command`/`args.cmd` we summarize. Everything else stays
// names-only. Kept as an allowlist so a new tool never leaks its args by default.
const BASH_LIKE_TOOLS = new Set(['bash', 'shell', 'sh', 'run', 'exec', 'command']);

export const isBashLikeTool = (toolName: string): boolean =>
  BASH_LIKE_TOOLS.has(toolName.toLowerCase());

// Denylist of secret-looking patterns. Ordered; each run before truncation.
// These are intentionally aggressive: over-redaction is a display nuisance,
// under-redaction leaks a credential.
const REDACTION_PATTERNS: RegExp[] = [
  // key=value / key:value where key hints at a secret.
  /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|auth|credential|private[_-]?key|session|cookie|bearer)[A-Za-z0-9_-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
  // Authorization / bearer headers.
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  // Credentials embedded in a URL: scheme://user:pass@host
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
  // Common cloud/provider token prefixes followed by a long body.
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|AKIA|ASIA|AIza|ya29)[-_A-Za-z0-9]{12,}\b/g,
  // Long high-entropy blobs (base64/hex-ish) that are almost certainly secrets.
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
];

/**
 * Redact obvious secret-looking substrings. Conservative: prefers over-redaction.
 *
 * Order matters. The specific credential patterns (bearer, url creds, provider
 * prefixes, entropy blobs) run BEFORE the generic key=value rule, because the
 * generic value matcher only captures a single whitespace-delimited token — so
 * `Authorization: Bearer <tok>` must have its token redacted by the bearer rule
 * first, otherwise the trailing token would survive.
 */
export const redactSecrets = (input: string): string => {
  let out = input;
  // bearer <token>
  out = out.replace(REDACTION_PATTERNS[1], (_m, scheme) => `${scheme} ${REDACTED}`);
  // url creds
  out = out.replace(REDACTION_PATTERNS[2], (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  // provider token prefixes + long entropy blobs
  out = out.replace(REDACTION_PATTERNS[3], REDACTED);
  out = out.replace(REDACTION_PATTERNS[4], REDACTED);
  // key=value forms last: keep the key, hide the value.
  out = out.replace(REDACTION_PATTERNS[0], (_m, key) => `${key}=${REDACTED}`);
  return out;
};

/**
 * Produce a safe, single-line, redacted, hard-truncated summary of a command,
 * or undefined when there is no usable command string. The returned string is
 * safe to place on the wire and in the DOM.
 */
export const summarizeCommand = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  const redacted = redactSecrets(collapsed);
  return redacted.length > COMMAND_SUMMARY_MAX
    ? redacted.slice(0, COMMAND_SUMMARY_MAX - 1).trimEnd() + '…'
    : redacted;
};

/**
 * Extract a summarizable command string from a tool's args, for bash-like tools
 * only. Non-bash tools return undefined so the trail stays names-only for them.
 */
export const commandSummaryFromArgs = (toolName: string, args: unknown): string | undefined => {
  if (!isBashLikeTool(toolName)) return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const candidate = record.command ?? record.cmd ?? record.script;
  return summarizeCommand(candidate);
};
