/**
 * Progress lines for steps that take minutes (build, test and lint commands),
 * so a person or an agent can tell a slow run from a hung one. They go to
 * stderr: `--json` and `--md` output on stdout stays intact. Tests replace
 * `write` to keep their output quiet.
 */
export const progress = {
  write(line: string): void {
    process.stderr.write(`flagrm: ${line}\n`);
  },
};

/** `850ms`, `12s`, `2m14s`, `1h03m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
