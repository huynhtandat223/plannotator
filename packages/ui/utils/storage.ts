/**
 * Cookie-based storage utility
 *
 * Uses cookies instead of localStorage so settings persist across
 * different ports (each hook invocation uses a random port).
 * Cookies are scoped by domain, not port, so localhost:54321 and
 * localhost:54322 share the same cookies.
 */

import { LIVE_MESSAGE_RETENTION } from '@plannotator/core/live-message-window';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Default backend: cookies.
 * Used instead of localStorage so settings persist across the random ports each
 * hook invocation uses (cookies are scoped by domain, not port).
 */
const cookieBackend: StorageBackend = {
  getItem(key) {
    try {
      const match = document.cookie.match(new RegExp(`(?:^|; )${escapeRegex(key)}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      const encoded = encodeURIComponent(value);
      document.cookie = `${key}=${encoded}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    } catch (e) {
      // Cookie not available
    }
  },
  removeItem(key) {
    try {
      document.cookie = `${key}=; path=/; max-age=0`;
    } catch (e) {
      // Cookie not available
    }
  },
};

// Active backend. Defaults to cookies so Plannotator is unchanged. A host
// (e.g. Workspaces) calls setStorageBackend once at startup to persist settings
// through its own storage instead.
let backend: StorageBackend = cookieBackend;

/** Override the storage backend. Call once at app startup. */
export function setStorageBackend(b: StorageBackend): void {
  backend = b;
}

/** Reset to the default (cookie) backend. Mainly for tests. */
export function resetStorageBackend(): void {
  backend = cookieBackend;
}

/**
 * Get a value from storage (default = cookies)
 */
export function getItem(key: string): string | null {
  return backend.getItem(key);
}

/**
 * Set a value in storage (default = cookies)
 */
export function setItem(key: string, value: string): void {
  backend.setItem(key, value);
}

/**
 * Remove a value from storage (default = cookies)
 */
export function removeItem(key: string): void {
  backend.removeItem(key);
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Auto-close tab setting
 * Values: 'off' | '0' (immediate) | '3' | '5' (seconds)
 * Legacy 'true' maps to '0' for backward compatibility.
 */
const AUTO_CLOSE_KEY = 'plannotator-auto-close';

export type AutoCloseDelay = 'off' | '0' | '3' | '5';

export const AUTO_CLOSE_OPTIONS: { value: AutoCloseDelay; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'Tab stays open after submitting' },
  { value: '0', label: 'Immediately', description: 'Tab closes immediately after submitting' },
  { value: '3', label: 'After 3 seconds', description: 'Tab closes 3 seconds after submitting' },
  { value: '5', label: 'After 5 seconds', description: 'Tab closes 5 seconds after submitting' },
];

export function getAutoCloseDelay(): AutoCloseDelay {
  const val = getItem(AUTO_CLOSE_KEY);
  if (val === '0' || val === '3' || val === '5') return val;
  if (val === 'true') return '0'; // backward compat
  return 'off';
}

export function setAutoCloseDelay(delay: AutoCloseDelay): void {
  setItem(AUTO_CLOSE_KEY, delay);
}

/**
 * Message picker visible count — a PER-PANE quota, not a global list length.
 *
 * Each live pane keeps this many rows visible regardless of how noisy its
 * neighbours are; `+N more` pages past it. 'all' shows every retained row.
 *
 * Only values the host can actually satisfy may be offered. The host retains
 * LIVE_MESSAGE_RETENTION responses per pane, so every numeric option must be
 * <= that ceiling; `10` was removed because no host ever retained that many.
 * Default: 3.
 */
const MESSAGE_PICKER_COUNT_KEY = 'plannotator-message-picker-count';

export type MessagePickerCount = '1' | '3' | '5' | 'all';

const MESSAGE_PICKER_NUMERIC_OPTIONS = ['1', '3', '5'] as const;

/**
 * Numeric options are filtered against the single shared retention constant so
 * the picker can never again advertise a window the host cannot fill.
 */
export const MESSAGE_PICKER_COUNT_OPTIONS: { value: MessagePickerCount; label: string }[] = [
  ...MESSAGE_PICKER_NUMERIC_OPTIONS
    .filter((value) => Number(value) <= LIVE_MESSAGE_RETENTION)
    .map((value) => ({ value: value as MessagePickerCount, label: value })),
  { value: 'all', label: 'All' },
];

export function getMessagePickerCount(): MessagePickerCount {
  const val = getItem(MESSAGE_PICKER_COUNT_KEY);
  if (val === '1' || val === '3' || val === '5' || val === 'all') return val;
  // '10' was an option the host could never satisfy. Migrate the stored value
  // to the nearest honest window rather than silently falling back to default.
  if (val === '10') return 'all';
  return '3';
}

export function setMessagePickerCount(value: MessagePickerCount): void {
  setItem(MESSAGE_PICKER_COUNT_KEY, value);
}

/**
 * Last-used "Open in app" target.
 * Stores the app id from the OPEN_IN_APPS catalog (packages/shared/open-in-apps.ts).
 * Defaults to 'reveal' (the file manager) when unset.
 */
const OPEN_IN_APP_KEY = 'plannotator-open-in-app';

export function getLastOpenInApp(): string {
  return getItem(OPEN_IN_APP_KEY) ?? 'reveal';
}

export function setLastOpenInApp(id: string): void {
  setItem(OPEN_IN_APP_KEY, id);
}

/**
 * Storage object with localStorage-like API
 */
export const storage = {
  getItem,
  setItem,
  removeItem,
};
