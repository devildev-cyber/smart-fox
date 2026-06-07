import * as React from "react";
import { getElectronAPI } from "@/lib/electron";

interface UseLiveCaptionsOptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
}

type LiveCaptionState = "idle" | "recording";

// Live Captions emits a rolling window of text that grows and then scrolls.
// Extract only the newly-added tail by overlapping the previous string.
function captionDelta(prev: string, next: string): string {
  if (!prev) return next;
  if (next.startsWith(prev)) return next.slice(prev.length);
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k -= 1) {
    if (prev.slice(prev.length - k) === next.slice(0, k)) {
      return next.slice(k);
    }
  }
  return ` ${next}`;
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

  const prevRef = React.useRef("");
  const unsubText = React.useRef<(() => void) | null>(null);
  const unsubError = React.useRef<(() => void) | null>(null);

  const stop = React.useCallback(() => {
    getElectronAPI()?.liveCaptions.stop();
    unsubText.current?.();
    unsubText.current = null;
    unsubError.current?.();
    unsubError.current = null;
    prevRef.current = "";
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

    prevRef.current = "";
    unsubText.current = api.liveCaptions.onText((text) => {
      const delta = captionDelta(prevRef.current, text).trim();
      prevRef.current = text;
      if (delta) onTranscriptRef.current(delta, true);
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
