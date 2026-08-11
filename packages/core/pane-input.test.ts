import { describe, expect, test } from "bun:test";
import {
  PANE_INPUT_KEYS,
  PANE_INPUT_MAX_TEXT,
  PANE_INPUT_PATH,
  isPaneInputKey,
  paneInputTextRefusal,
} from "./pane-input";

describe("pane input key allowlist", () => {
  test("is closed — an unknown key name is not a key", () => {
    // The allowlist IS the attack surface: the host maps only these to Herdr
    // key names, so anything not here cannot be requested by a browser.
    for (const key of PANE_INPUT_KEYS) expect(isPaneInputKey(key)).toBe(true);
    for (const notAKey of ["ctrl-c", "f1", "up", "ENTER", "", "enter ", 3, null, undefined, {}]) {
      expect(isPaneInputKey(notAKey)).toBe(false);
    }
  });

  test("carries no modifier chords, function keys, or pane lifecycle", () => {
    // Ctrl+C is a signal, not input. Nothing here can move, resize or close a
    // pane; adding such a key would make this a control channel for the pane
    // itself rather than for its composer.
    const names = PANE_INPUT_KEYS.join(" ");
    for (const forbidden of ["ctrl", "alt", "meta", "shift", "f1", "close", "kill", "resize"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("paneInputTextRefusal", () => {
  test("refuses control characters, because every one of them is a key press", () => {
    // A newline smuggled inside `text` would be a submit the captain never
    // pressed — which is the exact failure this whole path exists to avoid.
    expect(paneInputTextRefusal("/model\n")).toContain("Line breaks");
    expect(paneInputTextRefusal("a\tb")).toContain("Line breaks");
    expect(paneInputTextRefusal("bell")).toContain("control characters");
    expect(paneInputTextRefusal("esc[A")).toContain("control characters");
    expect(paneInputTextRefusal("del")).toContain("control characters");
  });

  test("allows ordinary command text, including the leading slash", () => {
    // The whole point: this is the path `/model` is supposed to take.
    expect(paneInputTextRefusal("/model")).toBeNull();
    expect(paneInputTextRefusal("/review src/app.ts --deep")).toBeNull();
    expect(paneInputTextRefusal("$skill run")).toBeNull();
    // Non-ASCII prose is data like any other.
    expect(paneInputTextRefusal("kiểm tra lại giúp tôi — 50%")).toBeNull();
  });

  test("refuses nothing-to-type and oversized input, each in its own words", () => {
    expect(paneInputTextRefusal("")).toBe("Type something first.");
    const long = "x".repeat(PANE_INPUT_MAX_TEXT + 1);
    expect(paneInputTextRefusal(long)).toContain("Send it as a message instead");
    expect(paneInputTextRefusal("x".repeat(PANE_INPUT_MAX_TEXT))).toBeNull();
  });
});

test("the endpoint path is stated once so client and host cannot disagree", () => {
  expect(PANE_INPUT_PATH).toBe("/api/pane-input");
});
