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

// Normalized key for dedup: lowercase, punctuation/whitespace collapsed.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Windows Live Captions exposes a rolling window that it repeatedly rewrites and
// replays. Crucially, it keeps re-punctuating the SAME sentence as it grows
// ("...how do you?" -> "...the balance?" -> "...shipping features quickly?"), so
// committing on punctuation duplicates the question at every length.
//
// The reliable signal is position: the LAST sentence in the window is still
// being revised, so we treat it as the live tail (interim). Every earlier
// sentence is stable — a new sentence has started after it — so we commit each
// exactly once, keyed by its normalized form.
class CaptionReconciler {
  #committedNorm = new Set<string>();
  #pending = "";
  // Raw non-last sentences from the previous snapshot. We only commit a sentence
  // once it has stayed identical across two snapshots, so Live Captions can fix
  // a word in a just-finished sentence before we lock it in.
  #prevSettled = new Set<string>();

  reset() {
    this.#committedNorm = new Set();
    this.#pending = "";
    this.#prevSettled = new Set();
  }

  push(snapshot: string): { finals: string[]; interim: string } {
    const sentences = splitSentences(snapshot);
    const finals: string[] = [];
    if (sentences.length === 0) {
      this.#pending = "";
      this.#prevSettled = new Set();
      return { finals, interim: "" };
    }

    const lastIdx = sentences.length - 1;
    const settled = sentences.slice(0, lastIdx);

    for (const sentence of settled) {
      const key = normalize(sentence);
      if (!key || this.#committedNorm.has(key)) continue;
      // Require the exact text to have survived the previous snapshot too. A
      // sentence that just became non-last this tick waits one more snapshot in
      // case Live Captions revises a word in it.
      if (!this.#prevSettled.has(sentence)) continue;
      this.#committedNorm.add(key);
      finals.push(sentence);
    }

    this.#prevSettled = new Set(settled);

    // The trailing sentence is the live tail. Hide it if it's just a replay of a
    // sentence we already committed (the window can scroll back to it).
    const tail = sentences[lastIdx];
    this.#pending = this.#committedNorm.has(normalize(tail)) ? "" : tail;
    return { finals, interim: this.#pending };
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
