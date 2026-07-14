# Ex-Plannotator

Ex-Plannotator is an independent fork for persistent, annotation-focused review of responses from a live Pi conversation. It can coexist with the official Plannotator package without changing the official review flows.

## Language

**Live Message Review Session**:
A browser review session that mirrors new assistant responses from one active Pi conversation branch and keeps message annotations until the reviewer closes it.
_Avoid_: Chat session, plan review session

**Official Plannotator**:
The separately installed upstream package whose commands and one-shot review behavior remain unchanged.
_Avoid_: Legacy Plannotator, old Plannotator

**Ex-Plannotator**:
The independently named fork package that owns persistent review commands prefixed with `ex-plannotator-`.
_Avoid_: Plannotator customization, patched official package

**Review Round**:
One fixed discovery of the reviewed assistant responses and Plan Folder paths, followed by one Feedback Batch and the next completed assistant response. A Plan File's content becomes fixed for the round when the reviewer opens it. While the response is pending, reviewed content stays readable but new annotation input is blocked. The Plan Folder is re-scanned only when that next response completes, not watched during the round.
_Avoid_: Chat turn, tool call

**Feedback Batch**:
All draft annotations across reviewed assistant responses and Plan Files that are atomically delivered to Pi by one Send feedback action. Its message and file sections reuse the existing feedback formats.
_Avoid_: Single-message feedback, chat message

**Sent Annotation**:
An immutable comment already delivered to Pi as part of a Feedback Batch. It remains attached to the exact Source Snapshot that was reviewed as history.
_Avoid_: Draft comment, editable feedback

**Reviewed Source**:
An assistant response or Plan File available for annotation. Its Source Identity remains stable across Review Rounds: the Pi message ID for a response, or the normalized path relative to the Plan Folder for a file.
_Avoid_: Document, item

**Source Snapshot**:
An immutable version of a Reviewed Source. An assistant response is identified by its Pi message ID; a Plan File snapshot is captured when opened and combines its Source Identity with a content hash. Draft and Sent Annotations always target a Source Snapshot rather than a mutable file path.
_Avoid_: Current file, source version
