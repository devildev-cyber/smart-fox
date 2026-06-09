import * as React from "react";
import { getElectronAPI } from "@/lib/electron";

interface UseLiveCaptionsOptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
}

type LiveCaptionState = "idle" | "recording";

// Split text into sentences, keeping a trailing unpunctuated fragment as its own
// (in-progress) sentence.
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [];
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Match key for a word: lowercase, strip punctuation. Lets us align snapshots
// even as Live Captions re-punctuates or re-cases the same words.
function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sentenceKey(s: string): string {
  return words(s).map(normWord).filter(Boolean).join(" ");
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
class CaptionReconciler {
  // Bounded list of committed words, kept only to align the next snapshot.
  #committedTail: string[] = [];
  // Normalized text of every sentence already emitted — a hard dedup backstop.
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

    const live = this.#alignLive(words(snap));
    const sentences = splitSentences(live);
    const finals: string[] = [];
    let interim = live;

    if (sentences.length > 1) {
      // Everything before the last sentence is stable: a newer sentence has
      // started after it, so Live Captions won't revise it anymore.
      for (const sentence of sentences.slice(0, -1)) {
        this.#committedTail.push(...words(sentence));
        const key = sentenceKey(sentence);
        if (key && !this.#seen.has(key)) {
          this.#seen.add(key);
          finals.push(sentence);
        }
      }
      if (this.#committedTail.length > 80) {
        this.#committedTail = this.#committedTail.slice(-80);
      }
      interim = sentences[sentences.length - 1];
    }

    this.#live = interim;
    return { finals, interim };
  }

  // Strip the part of the snapshot that overlaps the committed tail and return
  // the remaining (live) words as text.
  #alignLive(snapWords: string[]): string {
    const tail = this.#committedTail;
    if (tail.length === 0) return snapWords.join(" ");

    const tailNorm = tail.map(normWord);
    const snapNorm = snapWords.map(normWord);

    // Largest overlap where the END of the committed tail equals the START of
    // the snapshot (handles the window scrolling off the front).
    const maxO = Math.min(tail.length, snapWords.length);
    for (let o = maxO; o >= 1; o--) {
      let ok = true;
      for (let i = 0; i < o; i++) {
        if (tailNorm[tail.length - o + i] !== snapNorm[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return snapWords.slice(o).join(" ");
    }

    // No prefix overlap: the snapshot scrolled past everything we have, or its
    // start was revised. Treat the whole snapshot as the live region — we must
    // NOT try to guess an anchor from a single (often common) word, or we'd drop
    // the start of new speech. Duplicate *finals* are still blocked by #seen.
    return snapWords.join(" ");
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
