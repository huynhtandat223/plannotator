import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  resolveCursorSandbox,
  resolveUseGlimpse,
  resolveAnnotateHistory,
  resolveUseJina,
  resolveAskAiWorkspace,
  DEFAULT_ASKAI_WORKSPACE_LABEL,
} from "./config";
import type { PlannotatorConfig } from "./config";

const ENV = "PLANNOTATOR_CURSOR_SANDBOX";
const originalEnv = process.env[ENV];

function restoreEnv() {
  if (originalEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = originalEnv;
}

describe("resolveCursorSandbox", () => {
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterAll(restoreEnv);

  test("defaults to true with no env var and no config key", () => {
    expect(resolveCursorSandbox({})).toBe(true);
  });

  test("config.cursorSandbox is honored when the env var is unset", () => {
    expect(resolveCursorSandbox({ cursorSandbox: false })).toBe(false);
    expect(resolveCursorSandbox({ cursorSandbox: true })).toBe(true);
  });

  test("env values 0 / false / disabled turn the sandbox flag off", () => {
    for (const v of ["0", "false", "disabled", "FALSE", "Disabled"]) {
      process.env[ENV] = v;
      expect(resolveCursorSandbox({})).toBe(false);
    }
  });

  test("env wins over the config key in both directions", () => {
    process.env[ENV] = "0";
    expect(resolveCursorSandbox({ cursorSandbox: true })).toBe(false);
    process.env[ENV] = "1";
    expect(resolveCursorSandbox({ cursorSandbox: false })).toBe(true);
  });

  test("env values 1 / true / enabled (and unrecognized values) keep the default", () => {
    for (const v of ["1", "true", "enabled", "TRUE", "anything-else"]) {
      process.env[ENV] = v;
      expect(resolveCursorSandbox({})).toBe(true);
    }
  });
});

// config.json is hand-edited, so boolean settings often arrive as quoted
// strings ("false" instead of false). Each boolean resolver must coerce those
// instead of passing the raw string through to `=== false` checks downstream.
describe("config.json boolean coercion", () => {
  const cases: Array<{
    name: string;
    envVar: string;
    key: keyof PlannotatorConfig;
    resolve: (config: PlannotatorConfig) => boolean;
  }> = [
    {
      name: "resolveUseGlimpse",
      envVar: "PLANNOTATOR_GLIMPSE",
      key: "glimpse",
      resolve: resolveUseGlimpse,
    },
    {
      name: "resolveAnnotateHistory",
      envVar: "PLANNOTATOR_ANNOTATE_HISTORY",
      key: "annotateHistory",
      resolve: resolveAnnotateHistory,
    },
    {
      name: "resolveUseJina",
      envVar: "PLANNOTATOR_JINA",
      key: "jina",
      resolve: (config) => resolveUseJina(false, config),
    },
    {
      name: "resolveCursorSandbox",
      envVar: "PLANNOTATOR_CURSOR_SANDBOX",
      key: "cursorSandbox",
      resolve: resolveCursorSandbox,
    },
  ];

  const originalEnvs = new Map(cases.map((c) => [c.envVar, process.env[c.envVar]]));

  beforeEach(() => {
    for (const c of cases) delete process.env[c.envVar];
  });
  afterAll(() => {
    for (const [envVar, value] of originalEnvs) {
      if (value === undefined) delete process.env[envVar];
      else process.env[envVar] = value;
    }
  });

  const withKey = (c: (typeof cases)[number], value: unknown): PlannotatorConfig =>
    ({ [c.key]: value }) as PlannotatorConfig;

  for (const c of cases) {
    describe(c.name, () => {
      test("real booleans pass through", () => {
        expect(c.resolve(withKey(c, true))).toBe(true);
        expect(c.resolve(withKey(c, false))).toBe(false);
      });

      test("quoted boolean strings coerce (true/false/1/0, any case, padded)", () => {
        for (const v of ["false", "False", "FALSE", "0", " false "]) {
          expect(c.resolve(withKey(c, v))).toBe(false);
        }
        for (const v of ["true", "True", "TRUE", "1", " true "]) {
          expect(c.resolve(withKey(c, v))).toBe(true);
        }
      });

      test("garbage values fall back to the default (true)", () => {
        for (const v of ["yes", "no", "disabled", "", 42, 0, null, {}, []]) {
          expect(c.resolve(withKey(c, v))).toBe(true);
        }
      });

      test("absent key falls back to the default (true)", () => {
        expect(c.resolve({})).toBe(true);
      });

      test("env var still wins over the config key", () => {
        process.env[c.envVar] = "false";
        expect(c.resolve(withKey(c, true))).toBe(false);
        process.env[c.envVar] = "true";
        expect(c.resolve(withKey(c, "false"))).toBe(true);
        delete process.env[c.envVar];
      });
    });
  }
});

describe("resolveAskAiWorkspace", () => {
  const CWD_ENV = "PLANNOTATOR_ASKAI_WORKSPACE_CWD";
  const LABEL_ENV = "PLANNOTATOR_ASKAI_WORKSPACE_LABEL";
  const originalCwd = process.env[CWD_ENV];
  const originalLabel = process.env[LABEL_ENV];

  beforeEach(() => {
    delete process.env[CWD_ENV];
    delete process.env[LABEL_ENV];
  });
  afterAll(() => {
    if (originalCwd === undefined) delete process.env[CWD_ENV];
    else process.env[CWD_ENV] = originalCwd;
    if (originalLabel === undefined) delete process.env[LABEL_ENV];
    else process.env[LABEL_ENV] = originalLabel;
  });

  test("feature is OFF (null) when no cwd is configured anywhere", () => {
    expect(resolveAskAiWorkspace({})).toBeNull();
    expect(resolveAskAiWorkspace({ askAiWorkspace: { label: "x" } })).toBeNull();
  });

  test("config.askAiWorkspace.cwd enables the feature with the default label", () => {
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "/home/me/app" } })).toEqual({
      label: DEFAULT_ASKAI_WORKSPACE_LABEL,
      cwd: "/home/me/app",
    });
  });

  test("config label is honored when set", () => {
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "/home/me/app", label: "custom" } })).toEqual({
      label: "custom",
      cwd: "/home/me/app",
    });
  });

  test("env cwd wins over config cwd and still enables the feature", () => {
    process.env[CWD_ENV] = "/env/path";
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "/config/path" } })).toEqual({
      label: DEFAULT_ASKAI_WORKSPACE_LABEL,
      cwd: "/env/path",
    });
  });

  test("env label wins over config label", () => {
    process.env[CWD_ENV] = "/env/path";
    process.env[LABEL_ENV] = "env-label";
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "/config/path", label: "config-label" } })).toEqual({
      label: "env-label",
      cwd: "/env/path",
    });
  });

  test("blank/whitespace values are ignored", () => {
    process.env[CWD_ENV] = "   ";
    expect(resolveAskAiWorkspace({})).toBeNull();
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "  ", label: "  " } })).toBeNull();
  });

  test("blank env label falls back to config label then default", () => {
    process.env[CWD_ENV] = "/env/path";
    process.env[LABEL_ENV] = "  ";
    expect(resolveAskAiWorkspace({ askAiWorkspace: { cwd: "/config/path", label: "config-label" } })).toEqual({
      label: "config-label",
      cwd: "/env/path",
    });
  });
});
