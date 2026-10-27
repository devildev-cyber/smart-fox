/**
 * Stream plumbing for the two-stage coding solve.
 *
 * Stage 1 (a fast model) streams the talk track — @@MODE@@, @@PROBLEM@@,
 * @@SAY@@ — within seconds, so the candidate can start talking. Stage 2 (the
 * strong model) streams the code. Both are concatenated into ONE stream that the
 * existing parser already understands, so the stage-2 output must not repeat the
 * markers stage 1 already delivered. This filter enforces that: it swallows
 * everything stage 2 emits until its first CONTENT marker (a step, complexity,
 * points, or note).
 */

// A content marker at the start of a line. (MODE / PROBLEM / SAY are the
// talk-track markers that stage 1 owns.)
const CONTENT_MARKER = /^@@(?:STEP|CODE|COMPLEXITY|POINTS|PLAN|NOTE)@@/m;

export class ContinuationFilter {
  #buffer = "";
  #open = false;

  /** Feed a chunk; returns the text that should be forwarded (possibly ""). */
  push(chunk: string): string {
    if (this.#open) return chunk;
    this.#buffer += chunk;
    const match = CONTENT_MARKER.exec(this.#buffer);
    if (!match) return "";
    this.#open = true;
    const out = this.#buffer.slice(match.index);
    this.#buffer = "";
    return out;
  }

  /**
   * Call when stage 2 ends. If it never produced a content marker it answered in
   * plain prose; keep that rather than dropping the whole answer, as POINTS.
   */
  flush(): string {
    if (this.#open) return "";
    const rest = this.#buffer.replace(/^@@[A-Z]+@@[^\n]*\n?/gm, "").trim();
    this.#buffer = "";
    return rest ? `@@POINTS@@\n${rest}` : "";
  }
}
