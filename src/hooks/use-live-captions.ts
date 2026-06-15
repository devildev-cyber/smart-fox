import * as React from "react";
import { getElectronAPI } from "@/lib/electron";

interface UseLiveCaptionsOptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
}

type LiveCaptionState = "idle" | "recording";

// CJK ideographs (main block + extension A + compatibility). Chinese/Japanese
// text has no spaces, so we tokenize it per character for alignment.
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function isCjkChar(ch: string): boolean {
  return Boolean(ch) && CJK.test(ch);
}

// Split into sentences on both ASCII and full-width CJK terminators, keeping a
// trailing unpunctuated fragment as its own (in-progress) sentence.
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?。！？…]+[.!?。！？…]+|\S[^.!?。！？…]*$/gu);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [];
}

// Tokenize for alignment + reconstruction: each CJK character is its own token
// (no spaces between them), while non-CJK text is split into whitespace-
// separated words. Whitespace is dropped here; rebuild text with joinTokens.
function tokenize(text: string): string[] {
  return text.match(/[\u3400-\u9fff\uf900-\ufaff]|[^\s\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
}

// Rejoin tokens, inserting a space only between two non-CJK tokens so Chinese
// stays contiguous ("你好") while English keeps its spacing ("how are you").
function joinTokens(tokens: string[]): string {
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
// characters survive (the old [a-z0-9]-only form normalized them all to "").
function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function sentenceKey(s: string): string {
  return tokenize(s).map(normWord).filter(Boolean).join(" ");
}

// Windows Live Captions exposes a single rolling window that it continuously
// rewrites: it appends new words at the end, REVISES the last few words as it
// hears more ("...how do you" -> "...how do you balance shipping"), and scrolls
// old text off the front. Splitting each snapshot into sentences and de-duping
// by text breaks the moment a word inside a "finished" sentence is revised — the
// old and new spellings both get committed, which is the duplication users see.
//
// Instead we treat the stream as append-with-revision and reconcile by word
// overlap:
//   1. Keep a bounded tail of already-committed words.
//   2. For each snapshot, strip the prefix that overlaps that committed tail —
//      what's left is the current "live" region, recomputed fresh every tick so
//      revisions simply replace the old guess (never duplicate it).
//   3. Commit a sentence only once a LATER sentence has begun (so it can't still
//      be revised), guarded by a normalized-text set as a final dedup backstop.
// Tokens Live Captions may still revise — kept in the live region, never
// committed until more arrives after them.
const LIVE_MARGIN = 8;
// Once the live region grows past this with no sentence break, commit its
// stable prefix anyway. This is what makes Chinese work: Live Captions often
// emits Chinese with no sentence punctuation, so the sentence-based commit
// would otherwise never fire.
const LIVE_MAX = 24;
const TAIL_MAX = 80;

class CaptionReconciler {
  // Bounded list of committed tokens, kept only to align the next snapshot.
  #committedTail: string[] = [];
  // Normalized text of every fragment already emitted — a hard dedup backstop.
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
    const trimmed = text.trim();
    if (!trimmed) return;
    this.#committedTail.push(...tokenize(trimmed));
    if (this.#committedTail.length > TAIL_MAX) {
      this.#committedTail = this.#committedTail.slice(-TAIL_MAX);
    }
    const key = sentenceKey(trimmed);
    if (key && !this.#seen.has(key)) {
      this.#seen.add(key);
      finals.push(trimmed);
    }
  }

  // Strip the part of the snapshot that overlaps the committed tail and return
  // the remaining (live) tokens.
  #alignLive(snapTokens: string[]): string[] {
    const tail = this.#committedTail;
    if (tail.length === 0) return snapTokens;

    const tailNorm = tail.map(normWord);
    const snapNorm = snapTokens.map(normWord);

    // Largest overlap where the END of the committed tail equals the START of
    // the snapshot (handles the window scrolling off the front).
    const maxO = Math.min(tail.length, snapTokens.length);
    for (let o = maxO; o >= 1; o--) {
      let ok = true;
      for (let i = 0; i < o; i++) {
        if (tailNorm[tail.length - o + i] !== snapNorm[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return snapTokens.slice(o);
    }

    // No prefix overlap: the snapshot scrolled past everything we have, or its
    // start was revised. Treat the whole snapshot as the live region — we must
    // NOT guess an anchor from a single (often common) token, or we'd drop the
    // start of new speech. Duplicate *finals* are still blocked by #seen.
    return snapTokens;
  }
}

export function useLiveCaptions({
  onTranscript,
  onError,
}: UseLiveCaptionsOptions) {
  const [state, setState] = React.useState<LiveCaptionState>("idle");

  const onTranscriptRef = React.useRef(onTranscript);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reconciler = React.useRef(new CaptionReconciler());
  const unsubText = React.useRef<(() => void) | null>(null);
  const unsubError = React.useRef<(() => void) | null>(null);

  const stop = React.useCallback(() => {
    getElectronAPI()?.liveCaptions.stop();
    unsubText.current?.();
    unsubText.current = null;
    unsubError.current?.();
    unsubError.current = null;
    reconciler.current.reset();
    setState("idle");
  }, []);

  const start = React.useCallback(() => {
    const api = getElectronAPI();
    if (!api) {
      onErrorRef.current?.("Live Captions is only available in the desktop app.");
      return;
    }
    if (api.platform !== "win32") {
      onErrorRef.current?.("Live Captions capture is Windows-only.");
      return;
    }

    reconciler.current.reset();
    unsubText.current = api.liveCaptions.onText((text) => {
      const { finals, interim } = reconciler.current.push(text);
      for (const sentence of finals) onTranscriptRef.current(sentence, true);
      onTranscriptRef.current(interim, false);
    });
    unsubError.current = api.liveCaptions.onError((message) =>
      onErrorRef.current?.(message)
    );
    api.liveCaptions.start();
    setState("recording");
  }, []);

  React.useEffect(() => () => stop(), [stop]);

  return { state, start, stop, isRecording: state === "recording" };
}
