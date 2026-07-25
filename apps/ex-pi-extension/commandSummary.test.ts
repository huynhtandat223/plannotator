import { expect, test } from 'bun:test';
import {
  COMMAND_SUMMARY_MAX,
  REDACTED,
  commandSummaryFromArgs,
  isBashLikeTool,
  redactSecrets,
  summarizeCommand,
} from './commandSummary';

test('summarizeCommand collapses whitespace to a single line', () => {
  expect(summarizeCommand('npm   run\n  test')).toBe('npm run test');
});

test('summarizeCommand returns undefined for non-strings and blanks', () => {
  expect(summarizeCommand(undefined)).toBeUndefined();
  expect(summarizeCommand(42)).toBeUndefined();
  expect(summarizeCommand('   ')).toBeUndefined();
});

test('summarizeCommand hard-truncates to the max length with an ellipsis', () => {
  // Non-secret-looking tokens so redaction does not collapse the whole string.
  const long = 'echo ' + 'ab '.repeat(100);
  const out = summarizeCommand(long)!;
  expect(out.length).toBeLessThanOrEqual(COMMAND_SUMMARY_MAX);
  expect(out.endsWith('…')).toBe(true);
});

test('redacts key=value secrets but keeps the key', () => {
  expect(redactSecrets('export API_KEY=sk_supersecretvalue123')).toBe(`export API_KEY=${REDACTED}`);
  expect(redactSecrets('PASSWORD=hunter2')).toBe(`PASSWORD=${REDACTED}`);
  expect(redactSecrets('curl -H "token: abc123def"')).toContain(REDACTED);
});

test('redacts bearer tokens (secret body never survives)', () => {
  const out = redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnop"');
  expect(out).toContain(REDACTED);
  expect(out).not.toContain('abcdefghijklmnop');
});

test('redacts credentials embedded in a URL', () => {
  expect(redactSecrets('git clone https://user:p4ssw0rd@github.com/x/y')).toBe(
    `git clone https://user:${REDACTED}@github.com/x/y`,
  );
});

test('redacts provider token prefixes', () => {
  expect(redactSecrets('gh auth login --with-token ghp_0123456789abcdefghij')).toContain(REDACTED);
  expect(redactSecrets('aws configure AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
});

test('redacts long high-entropy blobs', () => {
  const blob = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ubw==';
  expect(redactSecrets(`echo ${blob}`)).toContain(REDACTED);
});

test('redaction runs before truncation so a tail secret cannot survive', () => {
  const cmd = 'run --flag ' + 'x'.repeat(60) + ' TOKEN=sk_secretsecretsecret';
  const out = summarizeCommand(cmd)!;
  expect(out).not.toContain('sk_secretsecretsecret');
});

test('leaves ordinary commands intact', () => {
  expect(summarizeCommand('git status')).toBe('git status');
  expect(summarizeCommand('npm test -- --watch')).toBe('npm test -- --watch');
});

test('isBashLikeTool matches the allowlist case-insensitively', () => {
  expect(isBashLikeTool('bash')).toBe(true);
  expect(isBashLikeTool('Shell')).toBe(true);
  expect(isBashLikeTool('read')).toBe(false);
  expect(isBashLikeTool('grep')).toBe(false);
});

test('commandSummaryFromArgs only summarizes bash-like tools', () => {
  expect(commandSummaryFromArgs('bash', { command: 'npm test' })).toBe('npm test');
  expect(commandSummaryFromArgs('shell', { cmd: 'ls -la' })).toBe('ls -la');
  expect(commandSummaryFromArgs('read', { command: 'npm test' })).toBeUndefined();
  expect(commandSummaryFromArgs('bash', {})).toBeUndefined();
  expect(commandSummaryFromArgs('bash', null)).toBeUndefined();
});

test('commandSummaryFromArgs redacts before returning', () => {
  const out = commandSummaryFromArgs('bash', { command: 'deploy --token=ghp_abcdefghij0123456789' })!;
  expect(out).toContain(REDACTED);
  expect(out).not.toContain('ghp_abcdefghij0123456789');
});
