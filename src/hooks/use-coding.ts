"use client";

import * as React from "react";
import { streamFetch } from "@/lib/client";
import { getElectronAPI, type CodingSource } from "@/lib/electron";
import {
  parseCodingStream,
  hasCodingContent,
  type CodingSolution,
} from "@/lib/coding";

export type CodingModeChoice =
  | "auto"
  | "new"
  | "fix"
  | "optimize"
  | "explain"
  | "test"
  | "answer";

// A captured or pasted problem image. `preview` is always a data URL we can
// render; it's also what we send to the model.
export interface CaptureItem {
  id: string;
  dataUrl: string;
}

const MAX_IMAGES = 8;

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * State + actions for the live-coding copilot: pick a screen once, capture one
 * or more screenshots (or paste/upload), then stream a structured solution.
 * Works in the Electron overlay (native capture) and degrades to paste/upload +
 * getDisplayMedia in a plain browser.
 */
export function useCoding(opts: {
  candidateId?: string;
  getTranscript?: () => string;
}) {
  const { candidateId, getTranscript } = opts;

  const electron = React.useMemo(() => getElectronAPI(), []);
  const canNativeCapture = Boolean(electron?.coding);

  const [sources, setSources] = React.useState<CodingSource[]>([]);
  const [sourceId, setSourceId] = React.useState<string>("");
  const [loadingSources, setLoadingSources] = React.useState(false);

  const [images, setImages] = React.useState<CaptureItem[]>([]);
  const [pastedText, setPastedText] = React.useState("");
  const [language, setLanguage] = React.useState<string>("auto");
  const [mode, setMode] = React.useState<CodingModeChoice>("auto");

  const [solution, setSolution] = React.useState<CodingSolution | null>(null);
  const [solving, setSolving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Prior context so a follow-up ("now optimize", "fix the failing test")
  // builds on the last solution instead of starting over.
  const lastRef = React.useRef<CodingSolution | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const chosenSource = sources.find((s) => s.id === sourceId) ?? null;

  const refreshSources = React.useCallback(async () => {
    if (!electron?.coding) return [];
    setLoadingSources(true);
    try {
      const list = await electron.coding.listSources();
      setSources(list);
      // Default to the primary screen if nothing chosen yet.
      setSourceId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        const screen = list.find((s) => s.id.startsWith("screen"));
        return screen?.id ?? list[0]?.id ?? "";
      });
      return list;
    } finally {
      setLoadingSources(false);
    }
  }, [electron]);

  const addImage = React.useCallback((dataUrl: string) => {
    if (!dataUrl) return;
    setImages((prev) =>
      prev.length >= MAX_IMAGES ? prev : [...prev, { id: uid(), dataUrl }]
    );
  }, []);

  const removeImage = React.useCallback((id: string) => {
    setImages((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Native screenshot of the chosen source (Electron only).
  const capture = React.useCallback(async () => {
    if (!electron?.coding) return;
    let id = sourceId;
    if (!id) {
      const list = await refreshSources();
      id = list.find((s) => s.id.startsWith("screen"))?.id ?? list[0]?.id ?? "";
    }
    if (!id) return;
    const dataUrl = await electron.coding.capture(id);
    if (dataUrl) addImage(dataUrl);
  }, [electron, sourceId, refreshSources, addImage]);

  // Browser fallback: grab a single frame via getDisplayMedia.
  const captureViaDisplayMedia = React.useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen capture isn't available in this browser.");
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    try {
      const track = stream.getVideoTracks()[0];
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      // Let a frame render before grabbing it.
      await new Promise((r) => setTimeout(r, 250));
      const canvas = document.createElement("canvas");
      const settings = track.getSettings();
      canvas.width = settings.width ?? video.videoWidth ?? 1280;
      canvas.height = settings.height ?? video.videoHeight ?? 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not grab the frame.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      addImage(canvas.toDataURL("image/png"));
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }, [addImage]);

  const clearImages = React.useCallback(() => setImages([]), []);

  // Reset everything for a brand-new problem (keeps the chosen source + prefs).
  const newProblem = React.useCallback(() => {
    abortRef.current?.abort();
    setImages([]);
    setPastedText("");
    setSolution(null);
    setError(null);
    lastRef.current = null;
  }, []);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const solve = React.useCallback(
    async (overrideMode?: CodingModeChoice) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const transcript = getTranscript?.() ?? "";
      const prior = lastRef.current;

      const payload = {
        images: images.map((c) => c.dataUrl),
        pastedText,
        transcript,
        language,
        mode: overrideMode ?? mode,
        candidateProfileId: candidateId || undefined,
        // Feed the previous turn back so follow-ups build on it.
        priorProblem: prior
          ? [prior.say, prior.plan].filter(Boolean).join("\n")
          : "",
        currentCode: prior?.code ?? "",
      };

      if (
        payload.images.length === 0 &&
        !payload.pastedText.trim() &&
        !payload.transcript.trim()
      ) {
        setError("Capture a screenshot, paste the problem, or record some transcript first.");
        return;
      }

      setSolving(true);
      setError(null);
      setSolution({
        mode: null,
        say: "",
        code: "",
        language: language === "auto" ? "" : language,
        complexity: "",
        plan: "",
        note: "",
        error: null,
      });

      try {
        const full = await streamFetch(
          "/api/coding/solve",
          {
            method: "POST",
            body: JSON.stringify(payload),
            signal: controller.signal,
          },
          (acc) => {
            const parsed = parseCodingStream(acc);
            if (hasCodingContent(parsed)) setSolution(parsed);
          }
        );
        const parsed = parseCodingStream(full);
        setSolution(parsed);
        if (parsed.error) {
          setError(parsed.error);
        } else {
          lastRef.current = parsed;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to solve.");
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setSolving(false);
        }
      }
    },
    [images, pastedText, language, mode, candidateId, getTranscript]
  );

  React.useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return {
    canNativeCapture,
    sources,
    sourceId,
    setSourceId,
    chosenSource,
    loadingSources,
    refreshSources,
    images,
    addImage,
    removeImage,
    clearImages,
    pastedText,
    setPastedText,
    language,
    setLanguage,
    mode,
    setMode,
    capture,
    captureViaDisplayMedia,
    solution,
    solving,
    error,
    solve,
    stop,
    newProblem,
    maxImages: MAX_IMAGES,
  };
}
