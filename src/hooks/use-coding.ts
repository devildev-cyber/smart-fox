"use client";

import * as React from "react";
import { streamFetch } from "@/lib/client";
import { getElectronAPI, type CodingSource } from "@/lib/electron";
import {
  parseCodingStream,
  hasCodingContent,
  codingTurnTitle,
  fullCode,
  type CodingSolution,
} from "@/lib/coding";
import { lastSentences } from "@/lib/transcript-turn";
import { shrinkImage } from "@/lib/image-shrink";

export interface SolveOptions {
  /** Force a mode for this run (a follow-up chip). */
  mode?: CodingModeChoice;
  /** Use this ask instead of the editable field (a follow-up chip / box). */
  ask?: string;
  /** Use exactly these images (a capture taken this very tick). */
  images?: string[];
  /**
   * A follow-up on the problem already on screen ("optimize it"): don't send the
   * screenshots again. The problem line and the working code carry the context.
   */
  followUp?: boolean;
}

export type CodingModeChoice =
  | "auto"
  | "new"
  | "fix"
  | "optimize"
  | "explain"
  | "test"
  | "answer";

// A captured or pasted problem image, rendered and sent as a data URL.
export interface CaptureItem {
  id: string;
  dataUrl: string;
}

// A completed solve, kept so the candidate can flip back to earlier answers.
export interface CodingTurn {
  id: string;
  at: number;
  title: string;
  solution: CodingSolution;
  images: string[];
  ask: string;
}

const MAX_IMAGES = 8;
const MAX_HISTORY = 20;

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySolution(language: string): CodingSolution {
  return {
    mode: null,
    problem: "",
    say: "",
    steps: [],
    language: language === "auto" ? "" : language,
    complexity: "",
    points: "",
    note: "",
    error: null,
  };
}

/**
 * State + actions for the live-coding copilot. Inputs are explicit and visible
 * (captures + an editable "what they asked" field) so the same problem yields
 * the same answer, and every solve is kept in history so nothing is lost.
 */
export function useCoding(opts: {
  candidateId?: string;
  getTranscript?: () => string;
  /** What the candidate already said in this interview, sent with every solve. */
  getSessionContext?: () => string;
  /** Swap a Pro model for its faster base model. */
  useBaseModel?: boolean;
}) {
  const { candidateId, getTranscript, getSessionContext, useBaseModel } = opts;

  const electron = React.useMemo(() => getElectronAPI(), []);
  const canNativeCapture = Boolean(electron?.coding);

  const [sources, setSources] = React.useState<CodingSource[]>([]);
  const [sourceId, setSourceId] = React.useState<string>("");
  const [loadingSources, setLoadingSources] = React.useState(false);

  const [images, setImages] = React.useState<CaptureItem[]>([]);
  const [pastedText, setPastedText] = React.useState("");
  // The interviewer's instruction/question, editable and visible. Empty by
  // default so answers are predictable; the candidate can pull the latest
  // transcript in with one click.
  const [ask, setAsk] = React.useState("");
  const [language, setLanguage] = React.useState<string>("auto");
  const [mode, setMode] = React.useState<CodingModeChoice>("auto");

  const [solution, setSolution] = React.useState<CodingSolution | null>(null);
  const [solving, setSolving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Session history of completed solves, and which one is on screen (null =
  // the live/most-recent solution).
  const [history, setHistory] = React.useState<CodingTurn[]>([]);
  const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  // What follow-ups ("now optimize it") build on. Kept separately from history
  // because a "fix" turn holds only a few edited lines, not a runnable program:
  // treating those as "the current code" would mislead every later turn.
  const workingCodeRef = React.useRef("");
  const problemRef = React.useRef("");

  const activeTurn =
    activeTurnId != null ? history.find((t) => t.id === activeTurnId) ?? null : null;

  // What's shown: a selected past turn, else the live solution.
  const displayedSolution = activeTurn?.solution ?? solution;
  const displayedImages = activeTurn ? activeTurn.images : images.map((c) => c.dataUrl);
  const viewingHistory = Boolean(activeTurn);

  const refreshSources = React.useCallback(async () => {
    if (!electron?.coding) return [];
    setLoadingSources(true);
    try {
      const list = await electron.coding.listSources();
      setSources(list);
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

  // Adds a capture (shrunk first, so a raw 4K screenshot isn't uploaded twice per
  // solve) and returns the image that was added.
  const addImage = React.useCallback(async (raw: string): Promise<string> => {
    if (!raw) return "";
    const dataUrl = await shrinkImage(raw);
    // Adding an input implies we're working on the live turn again.
    setActiveTurnId(null);
    setImages((prev) =>
      prev.length >= MAX_IMAGES ? prev : [...prev, { id: uid(), dataUrl }]
    );
    return dataUrl;
  }, []);

  const removeImage = React.useCallback((id: string) => {
    setImages((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const capture = React.useCallback(async () => {
    if (!electron?.coding) return null;
    let id = sourceId;
    if (!id) {
      const list = await refreshSources();
      id = list.find((s) => s.id.startsWith("screen"))?.id ?? list[0]?.id ?? "";
    }
    if (!id) return null;
    const raw = await electron.coding.capture(id);
    return raw ? await addImage(raw) : null;
  }, [electron, sourceId, refreshSources, addImage]);

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
      await new Promise((r) => setTimeout(r, 250));
      const canvas = document.createElement("canvas");
      const settings = track.getSettings();
      canvas.width = settings.width ?? video.videoWidth ?? 1280;
      canvas.height = settings.height ?? video.videoHeight ?? 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not grab the frame.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return await addImage(canvas.toDataURL("image/png"));
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }, [addImage]);

  // The last few sentences of live speech: what the interviewer just asked. Kept
  // short on purpose — a long transcript buries the instruction and can mislead
  // the model about what the screenshot is for.
  const recentAsk = React.useCallback(() => {
    const t = getTranscript?.() ?? "";
    return lastSentences(t, 3, 70).trim();
  }, [getTranscript]);

  // Pull the latest interviewer speech into the editable ask field.
  const pullAsk = React.useCallback(() => {
    const t = recentAsk();
    if (t) setAsk(t);
    return t;
  }, [recentAsk]);

  const selectTurn = React.useCallback((id: string | null) => {
    setActiveTurnId(id);
  }, []);

  // Reset the live inputs for a brand-new problem (keeps history + prefs).
  const newProblem = React.useCallback(() => {
    abortRef.current?.abort();
    setImages([]);
    setPastedText("");
    setAsk("");
    setSolution(null);
    setError(null);
    setActiveTurnId(null);
    workingCodeRef.current = "";
    problemRef.current = "";
  }, []);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const solve = React.useCallback(
    async (opts: SolveOptions = {}) => {
      const overrideMode = opts.mode;
      const askText = opts.ask ?? ask;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Follow-ups build on the most recent completed turn.
      const prior = history[0]?.solution ?? null;

      // A follow-up only skips the screenshots when we already know the problem.
      const skipImages = Boolean(opts.followUp && problemRef.current);
      const imageUrls = skipImages ? [] : (opts.images ?? images.map((c) => c.dataUrl));
      const payload = {
        images: imageUrls,
        pastedText,
        transcript: askText,
        language,
        mode: overrideMode ?? mode,
        candidateProfileId: candidateId || undefined,
        priorProblem: [problemRef.current, prior?.say, prior?.points]
          .filter(Boolean)
          .join("\n"),
        currentCode: workingCodeRef.current,
        sessionContext: getSessionContext?.() ?? "",
        useBaseModel: Boolean(useBaseModel),
      };

      if (imageUrls.length === 0 && !pastedText.trim() && !askText.trim() && !skipImages) {
        setError("Capture a screenshot, paste the problem, or add the interviewer's ask first.");
        return;
      }

      setActiveTurnId(null);
      setSolving(true);
      setError(null);
      setSolution(emptySolution(language));

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
        } else if (hasCodingContent(parsed)) {
          if (parsed.problem) problemRef.current = parsed.problem;
          if ((parsed.mode === "new" || parsed.mode === "optimize") && parsed.steps.length) {
            workingCodeRef.current = fullCode(parsed);
          }
          const turn: CodingTurn = {
            id: uid(),
            at: Date.now(),
            title: codingTurnTitle(parsed),
            solution: parsed,
            images: imageUrls,
            ask: askText,
          };
          setHistory((prev) => [turn, ...prev].slice(0, MAX_HISTORY));
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
    [
      images,
      pastedText,
      ask,
      language,
      mode,
      candidateId,
      history,
      getSessionContext,
      useBaseModel,
    ]
  );

  // The one-press flow: grab the screen, fill the ask from what the interviewer
  // just said (unless one was typed), and solve. When a solution already exists
  // the new capture REPLACES the old ones — it is almost always an updated editor
  // or a new problem, and a stale screenshot alongside it confuses the model.
  // (Several captures for one scrolled problem: press Capture repeatedly, then
  // Solve.)
  const captureAndSolve = React.useCallback(async () => {
    const dataUrl = canNativeCapture ? await capture() : await captureViaDisplayMedia();
    if (!dataUrl) return;
    const replace = Boolean(solution) && !solving;
    const nextImages = replace ? [dataUrl] : [...images.map((c) => c.dataUrl), dataUrl];
    if (replace) setImages([{ id: uid(), dataUrl }]);
    const askText = ask.trim() || recentAsk();
    if (askText && askText !== ask) setAsk(askText);
    await solve({ images: nextImages.slice(-MAX_IMAGES), ask: askText });
  }, [
    canNativeCapture,
    capture,
    captureViaDisplayMedia,
    solution,
    solving,
    images,
    ask,
    recentAsk,
    solve,
  ]);

  React.useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return {
    canNativeCapture,
    sources,
    sourceId,
    setSourceId,
    loadingSources,
    refreshSources,
    images,
    addImage,
    removeImage,
    pastedText,
    setPastedText,
    ask,
    setAsk,
    pullAsk,
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
    captureAndSolve,
    recentAsk,
    stop,
    newProblem,
    // History + navigation.
    history,
    activeTurnId,
    selectTurn,
    viewingHistory,
    displayedSolution,
    displayedImages,
    maxImages: MAX_IMAGES,
  };
}
