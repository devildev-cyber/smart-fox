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

function isComplete(s: string): boolean {
  return /[.!?]["')\]]*$/.test(s.trim());
}

// Windows Live Captions exposes a rolling window that it repeatedly rewrites and
// replays (the same greeting/question reappears many times as it re-recognizes).
// A naive prefix-delta therefore re-emits the whole buffer over and over. Instead
// we reconcile at the sentence level: each finished sentence is committed exactly
// once (keyed by its normalized form), and the trailing in-progress sentence is
// tracked separately so it can grow/revise without being duplicated.
class CaptionReconciler {
  #committedNorm = new Set<string>();
  #pending = "";

  reset() {
    this.#committedNorm = new Set();
    this.#pending = "";
  }

  push(snapshot: string): { finals: string[]; interim: string } {
    const sentences = splitSentences(snapshot);
    const finals: string[] = [];
    if (sentences.length === 0) return { finals, interim: this.#pending };

    for (const sentence of sentences) {
      const key = normalize(sentence);
      if (!key || this.#committedNorm.has(key)) continue;

      if (isComplete(sentence)) {
        const pendingKey = normalize(this.#pending);
        this.#committedNorm.add(key);
        finals.push(sentence);
        // If this is the finished form of the in-progress tail, retire the tail.
        if (
          pendingKey &&
          (key.startsWith(pendingKey) || pendingKey.startsWith(key))
        ) {
          this.#pending = "";
        }
      } else {
        // Trailing partial sentence (the live tail). The newest snapshot is the
        // most accurate recognition — the window only grows or corrects at the
        // end, it never scrolls there — so always take the latest. This lets
        // mid-sentence word changes (e.g. "ref act or" -> "refactor") settle
        // before the sentence is committed.
        this.#pending = sentence;
      }
    }

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
