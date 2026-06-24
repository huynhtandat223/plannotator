import type { CodeAnnotation, CodeAnnotationScope } from '@plannotator/ui/types';

/** A code annotation's scope, defaulting to 'line' for older/external data. */
export function annotationScope(a: CodeAnnotation): CodeAnnotationScope {
  return a.scope ?? 'line';
}

/**
 * The location prefix for an annotation's copied text. General comments belong
 * to no file, so they carry no prefix; file comments carry just the path; line
 * comments carry path + line range. Never emits the "" / 0 sentinels that stand
 * in for "no file / no line" on file and general comments.
 */
export function copyLocationPrefix(
  a: CodeAnnotation,
  scope: CodeAnnotationScope = annotationScope(a),
): string {
  if (scope === 'general') return '';
  if (scope === 'file') return `${a.filePath}\n`;
  return `${a.filePath}:${a.lineStart}${a.lineEnd !== a.lineStart ? `-${a.lineEnd}` : ''}\n`;
}
