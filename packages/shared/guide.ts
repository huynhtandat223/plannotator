export interface GuideDiffRef {
  /** Repo-relative path; must match a DiffFile.path in the current review patch.
   *  Deliberately the only field: the section overview carries all semantics —
   *  per-diff captions/line hints proved to be noise the model shouldn't spend
   *  generation effort on. */
  file: string;
}

export interface GuideSection {
  /** Concept-level title, e.g. "Payment localization module" — never a filename paraphrase. */
  title: string;
  /** Markdown prose: what changed, why it exists, and its key implications.
   *  Semantic order (core first, consequences next, glue grouped last) is
   *  carried by the array position, not by any label field. */
  overview: string;
  /** File references into the provided changeset. Usually 1..n, but a
   *  deliberate prose-only context section (no diffs, real overview text) is
   *  a valid model output and is preserved as-is rather than dropped. */
  diffs: GuideDiffRef[];
}

export interface CodeGuideOutput {
  /** From the PR title when a PR is given, otherwise derived from the changes. */
  title: string;
  /** 1-2 sentence framing shown under the title: why this changeset exists. */
  intent: string;
  /** Ordered sections: core first, consequence next, support last. */
  sections: GuideSection[];
  /** Changed files the model didn't place — rendered in a trailing "Everything else" section. */
  unplacedFiles?: string[];
}

/** UI-side guide shape: server output extended with persisted per-section reviewed state. */
export type CodeGuideData = CodeGuideOutput & { reviewed: boolean[] };
