/** A file's LF-normalized text with offset → line mapping. */
export class SourceText {
  private readonly lineStarts: number[] = [0];

  constructor(
    readonly file: string,
    readonly text: string,
  ) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.lineStarts.push(i + 1);
  }

  /** 1-based line and column of an offset. */
  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lineStarts[lo] + 1 };
  }

  /** Trimmed text of the line containing `offset`, capped at 160 characters. */
  snippet(offset: number): string {
    const { line } = this.position(offset);
    const start = this.lineStarts[line - 1];
    const next = this.lineStarts[line];
    return this.text
      .slice(start, next === undefined ? this.text.length : next - 1)
      .trim()
      .slice(0, 160);
  }
}
