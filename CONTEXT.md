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
One Feedback Batch followed by the next completed assistant response. While that response is pending, reviewed content stays readable but new annotation input is blocked.
_Avoid_: Chat turn, tool call

**Feedback Batch**:
All draft annotations across reviewed assistant responses that are delivered to Pi by one Send feedback action.
_Avoid_: Single-message feedback, chat message

**Sent Annotation**:
An immutable comment already delivered to Pi as part of a Feedback Batch. It remains attached to its reviewed assistant response as review history.
_Avoid_: Draft comment, editable feedback
