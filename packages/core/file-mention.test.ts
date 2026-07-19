import { describe, expect, test } from "bun:test";
import { extractFileMentionReferences, findActiveFileMention, replaceActiveFileMention } from "./file-mention";

describe("findActiveFileMention", () => {
  test("keeps a typed line range separate from the file query", () => {
    const text = "Please inspect @app.tsx:100-140";
    expect(findActiveFileMention(text, text.length)).toEqual({
      start: 15,
      end: 31,
      query: "app.tsx",
      lineSuffix: ":100-140",
    });
  });

  test("allows an incomplete line range while it is being typed", () => {
    expect(findActiveFileMention("@src/App.tsx:12-", 16)).toEqual({
      start: 0,
      end: 16,
      query: "src/App.tsx",
      lineSuffix: ":12-",
    });
  });

  test("does not mistake an email address for a file mention", () => {
    expect(findActiveFileMention("Contact me@example.com", 22)).toBeNull();
  });
});

describe("extractFileMentionReferences", () => {
  test("extracts unique paths and line ranges without matching email addresses", () => {
    expect(extractFileMentionReferences("See @src/App.tsx:100-140 and @src/App.tsx:100-140; email me@example.com")).toEqual([
      { filePath: "src/App.tsx", line: 100, lineEnd: 140 },
    ]);
  });
});

describe("replaceActiveFileMention", () => {
  test("canonicalizes a selected path and preserves the typed line range", () => {
    const text = "Please inspect @App.tsx:100-140";
    const mention = findActiveFileMention(text, text.length)!;
    expect(replaceActiveFileMention(text, mention, "packages/editor/App.tsx")).toEqual({
      text: "Please inspect @packages/editor/App.tsx:100-140",
      cursor: 47,
    });
  });
});
