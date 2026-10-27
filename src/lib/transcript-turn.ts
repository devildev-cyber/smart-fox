/**
 * Decides WHAT slice of the live transcript is sent to the answer model, and
 * WHEN a pause counts as the end of the interviewer's turn. Pure (no React / DOM)
 * so every threshold below is unit-tested instead of buried in the session page.
 *
 * The model gets two distinct things:
 *   - the TURN       what the interviewer just said and hasn't been answered yet
 *                    (this is what to answer — kept to whole sentences, newest
 *                    kept when it has to be cut, because the ask is at the end)
 *   - the CONTEXT    a little earlier, already-handled speech, only so a terse
 *                    follow-up ("and why?") can be interpreted
 */

import {
  isCjkChar,
  joinTokens,
  normWord,
  splitSentences,
  tokenize,
} from "./caption-reconciler";

// All sizes are in "speech units": one per Latin word, half per CJK character
// (a Chinese character carries about half a word of meaning), so the same limit
// is fair across languages.
export const TURN_LIMITS = {
  // The unanswered turn. Long enough for a real multi-part question with its
  // setup; short enough that a backlog of stale talk can't bury the ask.
  turnMaxUnits: 110,
  // Earlier, already-answered speech sent as background only.
  contextSentences: 3,
  contextMaxUnits: 60,
  // Typed-question flow: recent speech as background for an explicit question.
  recentSentences: 6,
  recentMaxUnits: 140,
  // Regenerate / recovery: re-read a wider tail, ignoring the answered marker.
  wideSentences: 8,
  wideMaxUnits: 160,
  // Below this a pause is just filler ("okay", "right", "so"), not a turn —
  // unless it's a question mark, since "Why?" is a legitimate follow-up.
  minTurnUnits: 3,
  // A last sentence this short is probably a terse question that needs its
  // setup, so the sentence before it travels with it.
  terseLastUnits: 7,
} as const;

// Multipliers on the user's base pause. A finished question can be answered
// sooner; trailing off with no punctuation more likely means they're still
// thinking, so wait longer before treating it as done.
const PAUSE_AFTER_QUESTION = 0.7;
const PAUSE_AFTER_STATEMENT = 1;
const PAUSE_UNFINISHED = 2;

/** Speech-unit length of a text (see TURN_LIMITS). */
export function speechUnits(text: string): number {
  let units = 0;
  for (const token of tokenize(text)) units += isCjkChar(token) ? 0.5 : 1;
  return units;
}

// Keep only the END of a single over-long run, since the ask is at the end.
function trimToTailUnits(text: string, maxUnits: number): string {
  const tokens = tokenize(text);
  let units = 0;
  let start = tokens.length;
  while (start > 0) {
    const next = isCjkChar(tokens[start - 1]) ? 0.5 : 1;
    if (units + next > maxUnits) break;
    units += next;
    start -= 1;
  }
  return joinTokens(tokens.slice(start));
}

// Take whole sentences from the end until the budget is used. If even the last
// sentence alone is over budget, keep its tail rather than nothing.
function tailWithinUnits(sentences: string[], maxUnits: number): string {
  const kept: string[] = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const units = speechUnits(sentences[i]);
    if (kept.length > 0 && total + units > maxUnits) break;
    kept.unshift(sentences[i]);
    total += units;
  }
  const joined = kept.join(" ").trim();
  return kept.length === 1 && total > maxUnits ? trimToTailUnits(joined, maxUnits) : joined;
}

/** The last `n` sentences, optionally capped to a speech-unit budget. */
export function lastSentences(text: string, n: number, maxUnits = Infinity): string {
  const sentences = splitSentences(text.trim());
  if (sentences.length === 0) return "";
  return tailWithinUnits(sentences.slice(-n), maxUnits);
}

/** The unanswered turn, capped to whole recent sentences within the budget. */
export function capTurn(text: string, maxUnits: number = TURN_LIMITS.turnMaxUnits): string {
  const sentences = splitSentences(text.trim());
  if (sentences.length === 0) return "";
  return tailWithinUnits(sentences, maxUnits);
}

/**
 * The interviewer's latest utterance: the last sentence, plus the one before it
 * when the last is terse (a short question usually leans on its setup).
 */
export function latestUtterance(text: string): string {
  const sentences = splitSentences(text.trim());
  if (sentences.length === 0) return "";
  const tail = sentences.slice(-2);
  const last = tail[tail.length - 1];
  if (tail.length === 2 && speechUnits(last) <= TURN_LIMITS.terseLastUnits) {
    return tail.join(" ");
  }
  return last;
}

/**
 * Remove the leading words of `text` that `consumed` (a previously answered
 * interim snapshot) already covers. Word-level longest common prefix on the
 * normalized form, so a Live Captions revision only costs a small partial
 * overlap instead of re-answering the whole thing.
 */
export function stripConsumedPrefix(text: string, consumed: string): string {
  const t = text.trim().split(/\s+/).filter(Boolean);
  const c = consumed.trim().split(/\s+/).filter(Boolean);
  if (t.length === 0 || c.length === 0) return text.trim();
  let k = 0;
  const max = Math.min(t.length, c.length);
  while (k < max && normWord(t[k]) === normWord(c[k]) && normWord(t[k]) !== "") k++;
  return t.slice(k).join(" ");
}

/**
 * How long to wait, after the last caption change, before treating the pause as
 * the end of the interviewer's turn. Returns null when there's nothing worth
 * answering yet (empty, or just filler) — don't arm a timer at all.
 *
 *   "...handle conflict on a team?"   -> sooner  (a finished question)
 *   "...tell me about a time you led." -> base
 *   "...so what I'd like to understand" -> longer (no terminal punctuation: they
 *                                           are almost certainly still talking)
 */
export function endOfTurnDelayMs(pending: string, baseMs: number): number | null {
  const text = pending.trim();
  if (!text) return null;

  const isQuestion = /[?？]["')\]]*$/.test(text);
  if (!isQuestion && speechUnits(text) < TURN_LIMITS.minTurnUnits) return null;

  if (isQuestion) return Math.round(baseMs * PAUSE_AFTER_QUESTION);
  if (/[.!。！…]["')\]]*$/.test(text)) return Math.round(baseMs * PAUSE_AFTER_STATEMENT);
  return Math.round(baseMs * PAUSE_UNFINISHED);
}
