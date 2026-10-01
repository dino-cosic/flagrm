/**
 * Text utilities shared by discovery and scanning: line endings and bracket
 * matching. Masks are in scan.ts, offset-to-line lookup in source-text.ts.
 */

/** Strip `\r` before `\n` so downstream logic can assume bare `\n`. */
export function toLf(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

/**
 * Find the index of the bracket matching the one at `openIndex`.
 * Only characters where mask[i] === 1 are considered. Returns -1 when unbalanced.
 */
export function matchBracket(text: string, mask: Uint8Array, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (!mask[i]) continue;
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
