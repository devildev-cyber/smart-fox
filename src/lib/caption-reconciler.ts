/**
 * Turns the rolling, self-revising text stream from Windows Live Captions into
 * a clean sequence of committed "final" fragments plus one "interim" fragment.
 *
 * Live Captions exposes a single rolling window it continuously rewrites: it
 * appends new words at the end, REVISES the last few words as it hears more
 * ("...how do you" -> "...how do you balance shipping"), and scrolls old text
 * off the front. Naively splitting each snapshot into sentences and de-duping by
 * text breaks the moment a word inside a "finished" sentence is revised — the
 * old and new spellings both get committed, which is the duplication users see.
 *
 * This module is pure (no React / DOM) so it can be unit-tested directly.
 */

// CJK ideographs (main block + extension A + compatibility). Chinese/Japanese
// text has no spaces, so we tokenize it per character for alignment.
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

export function isCjkChar(ch: string): boolean {
  return Boolean(ch) && CJK.test(ch);
}

// A sentence ends at an ASCII terminator only when it is followed by whitespace
// or the end of the text, so dots INSIDE a name ("Node.js", "ASP.NET", "v2.0",
// "3.5") never split it. Full-width CJK terminators need no trailing space.
// ([\s\S] instead of the `s` flag keeps this valid for older compile targets.)
const SENTENCE_RE = /[\s\S]+?(?:[.!?]+(?=\s|$)|[。！？…]+|$)/gu;

// A piece ending in one of these is not a real sentence end ("e.g. Redis" /
// "Dr. Smith" / a list marker like "1.") — glue it to what follows.
const NOT_A_SENTENCE_END = /(?:^|\s)(?:e\.g|i\.e|vs|mr|mrs|ms|dr|sr|jr|inc|ltd)\.$|^\d{1,2}[.)]$/i;

// Split into sentences on both ASCII and full-width CJK terminators, keeping a
// trailing unpunctuated fragment as its own (in-progress) sentence.
export function splitSentences(text: string): string[] {
  const pieces = (text.match(SENTENCE_RE) ?? []).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev && NOT_A_SENTENCE_END.test(prev)) {
      out[out.length - 1] = `${prev} ${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

// Tokenize for alignment + reconstruction: each CJK character is its own token
// (no spaces between them), while non-CJK text is split into whitespace-
// separated words. Whitespace is dropped here; rebuild text with joinTokens.
export function tokenize(text: string): string[] {
  return text.match(/[\u3400-\u9fff\uf900-\ufaff]|[^\s\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
}

// Rejoin tokens, inserting a space only between two non-CJK tokens so Chinese
// stays contiguous ("你好") while English keeps its spacing ("how are you").
export function joinTokens(tokens: string[]): string {
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i === 0) {
      out = t;
      continue;
    }
    const glue = isCjkChar(tokens[i - 1].slice(-1)) || isCjkChar(t[0]) ? "" : " ";
    out += glue + t;
  }
  return out;
}

// Match key for a token: lowercase, strip punctuation. Unicode-aware so CJK
// characters survive (an [a-z0-9]-only form would normalize them all to "").
export function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function sentenceKey(s: string): string {
  return tokenize(s).map(normWord).filter(Boolean).join(" ");
}

/**
 * Strip the leading tokens of `textTokens` that are already covered by the END
 * of the committed tail, comparing on the normalized form so revisions to
 * spacing/punctuation don't defeat it. Returns the remaining (new) tokens.
 *
 * This is the core reconciliation primitive: the most recently committed words
 * reappear at the START of the next snapshot (the window scrolled), so the
 * largest suffix-of-tail that equals a prefix-of-text is the already-seen part.
 * When nothing overlaps we return the whole input rather than guessing an
 * anchor from a single common token — dropping the start of genuinely new
 * speech is worse than a rare duplicate (which later dedup still catches).
 */
export function stripLeadingOverlap(
  tailNorm: readonly string[],
  textTokens: string[]
): string[] {
  if (tailNorm.length === 0 || textTokens.length === 0) return textTokens;
  const textNorm = textTokens.map(normWord);
  const maxOverlap = Math.min(tailNorm.length, textTokens.length);
  for (let o = maxOverlap; o >= 1; o--) {
    let ok = true;
    for (let i = 0; i < o; i++) {
      if (tailNorm[tailNorm.length - o + i] !== textNorm[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return textTokens.slice(o);
  }
  return textTokens;
}

// Tokens Live Captions may still revise — kept in the live region, never
// committed until more arrives after them.
const LIVE_MARGIN = 8;
// Once the live region grows past this with no sentence break, commit its
// stable prefix anyway. This is what makes Chinese work: Live Captions often
// emits Chinese with no sentence punctuation, so the sentence-based commit
// would otherwise never fire.
const LIVE_MAX = 24;
const TAIL_MAX = 80;
// How many recent fragments the exact-match dedup backstop remembers. The
// caption window only ever holds a few sentences, so anything older can't be a
// re-emission — and remembering forever would silently swallow a question the
// interviewer legitimately repeats later ("Can you elaborate on that?").
const SEEN_MAX = 16;
// Tokens of the committed tail used to re-find our place when the window was
// revised/scrolled so the snapshot no longer STARTS with the tail. Longer for
// CJK (one token per character) so a common character run can't false-match.
const ANCHOR_LATIN = 4;
const ANCHOR_CJK = 6;

/**
 * Align a snapshot against the committed tail and return only the NEW tokens.
 * First the cheap, exact case (the snapshot starts with the tail's end). If
 * that finds nothing — Live Captions revised a word inside text we'd already
 * committed, so the prefix no longer matches — fall back to locating the tail's
 * last few tokens anywhere in the snapshot and keeping what follows. Taking the
 * LEFTMOST hit errs toward a rare duplicate (later dedup catches it) rather than
 * swallowing genuinely new speech, which is the worse failure.
 */
export function alignToCommitted(
  tailNorm: readonly string[],
  textTokens: string[]
): string[] {
  const direct = stripLeadingOverlap(tailNorm, textTokens);
  if (direct.length < textTokens.length) return direct;

  const cjk = isCjkChar(tailNorm[tailNorm.length - 1]?.slice(-1) ?? "");
  const anchorLen = cjk ? ANCHOR_CJK : ANCHOR_LATIN;
  if (tailNorm.length < anchorLen || textTokens.length <= anchorLen) return textTokens;

  const anchor = tailNorm.slice(-anchorLen);
  if (anchor.some((w) => w === "")) return textTokens;

  const textNorm = textTokens.map(normWord);
  for (let i = 0; i + anchorLen <= textNorm.length; i++) {
    let ok = true;
    for (let k = 0; k < anchorLen; k++) {
      if (textNorm[i + k] !== anchor[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return textTokens.slice(i + anchorLen);
  }
  return textTokens;
}

export class CaptionReconciler {
  // Bounded list of committed tokens, kept only to align the next snapshot.
  #committedTail: string[] = [];
  // Normalized text of the most recent fragments emitted — a dedup backstop.
  #seen = new Set<string>();
  #live = "";

  reset() {
    this.#committedTail = [];
    this.#seen = new Set();
    this.#live = "";
  }

  push(snapshot: string): { finals: string[]; interim: string } {
    const snap = snapshot.replace(/\s+/g, " ").trim();
    if (!snap) return { finals: [], interim: this.#live };

    const finals: string[] = [];
    let remaining = this.#alignLive(tokenize(snap));

    // 1) Commit completed sentences: everything before the last sentence is
    //    stable because a newer sentence has started after it.
    const sentences = splitSentences(joinTokens(remaining));
    if (sentences.length > 1) {
      for (const sentence of sentences.slice(0, -1)) this.#commit(sentence, finals);
      remaining = tokenize(sentences[sentences.length - 1]);
    }

    // 2) Punctuation-independent fallback: once the still-live region is long,
    //    commit its stable prefix and keep a small revision margin live.
    while (remaining.length > LIVE_MAX) {
      const cut = remaining.length - LIVE_MARGIN;
      this.#commit(joinTokens(remaining.slice(0, cut)), finals);
      remaining = remaining.slice(cut);
    }

    const interim = joinTokens(remaining);
    this.#live = interim;
    return { finals, interim };
  }

  #commit(text: string, finals: string[]) {
    const rawTokens = tokenize(text.trim());
    if (rawTokens.length === 0) return;

    // Drop any leading tokens already covered by the end of the committed tail.
    // This is what kills the rolling-window re-emissions that the exact-key
    // `#seen` backstop can't catch (a one-word revision changes the whole key).
    const tokens = stripLeadingOverlap(
      this.#committedTail.map(normWord),
      rawTokens
    );
    if (tokens.length === 0) return;

    const trimmed = joinTokens(tokens).trim();
    const key = sentenceKey(trimmed);
    if (!key) return;

    // Fuzzy backstop: skip if this fragment is already fully contained in the
    // recent committed window, not just when it's byte-identical.
    if (this.#seen.has(key) || this.#tailContainsKey(key)) return;

    this.#committedTail.push(...tokens);
    if (this.#committedTail.length > TAIL_MAX) {
      this.#committedTail = this.#committedTail.slice(-TAIL_MAX);
    }
    this.#seen.add(key);
    if (this.#seen.size > SEEN_MAX) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    finals.push(trimmed);
  }

  #tailContainsKey(key: string): boolean {
    const tailKey = this.#committedTail.map(normWord).filter(Boolean).join(" ");
    return tailKey.length > 0 && tailKey.includes(key);
  }

  // Strip the part of the snapshot that overlaps the committed tail and return
  // the remaining (live) tokens.
  #alignLive(snapTokens: string[]): string[] {
    return alignToCommitted(this.#committedTail.map(normWord), snapTokens);
  }
}

/**
 * Collapse an immediately-repeated phrase in already-assembled transcript text
 * (a safety net for whatever duplication slips past the reconciler, e.g. from
 * the Live Captions PowerShell bridge concatenating a finalized + live block).
 * Only collapses phrases of length >= 2 so grammatical single-word doublings
 * ("had had", "that that") are preserved; the caption problem is multi-word.
 */
export function collapseRepeatedText(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return text.trim();

  const norm = tokens.map(normWord);
  const out: string[] = [];
  const outNorm: string[] = [];
  const MAX_PHRASE = 12;

  let i = 0;
  while (i < tokens.length) {
    let matched = 0;
    const maxLen = Math.min(MAX_PHRASE, tokens.length - i, out.length);
    for (let len = maxLen; len >= 2; len--) {
      let ok = true;
      for (let k = 0; k < len; k++) {
        const a = outNorm[out.length - len + k];
        const b = norm[i + k];
        if (!b || a !== b) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matched = len;
        break;
      }
    }
    if (matched) {
      i += matched;
    } else {
      out.push(tokens[i]);
      outNorm.push(norm[i]);
      i++;
    }
  }

  return out.join(" ");
}
