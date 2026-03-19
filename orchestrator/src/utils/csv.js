/**
 * Shared CSV utilities — used by quiz-agent and grades-agent.
 */

export function sanitizeCell(value) {
  const s = String(value ?? '');
  if (s.length > 0 && '=+-@\t\r'.includes(s[0])) {
    return `'${s}`;
  }
  return s;
}

export function csvEscape(value) {
  const s = sanitizeCell(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
