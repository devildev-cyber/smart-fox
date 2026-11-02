"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Mic,
  Square,
  Eraser,
  Sparkles,
  RefreshCw,
  Save,
  Keyboard,
  AlertTriangle,
  MonitorSpeaker,
  Info,
  ChevronLeft,
  ChevronRight,
  Compass,
  Code2,
  MessageSquareText,
  MoreHorizontal,
  Settings2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichAnswer } from "@/components/rich-answer";
import { ConfidenceBadge } from "@/components/confidence-badge";
import { CodingView, useCodingCaptureHotkey } from "@/components/coding-view";
import { HistoryPanel, PrevNav, type FeedItem } from "@/components/session-history";
import { useCoding, type CodingTurn } from "@/hooks/use-coding";
import { CODING_MODE_LABELS } from "@/lib/coding";
import { answersForCoding, codingForAnswers } from "@/lib/session-memory";
import { cn } from "@/lib/utils";
import { apiFetch, streamFetch } from "@/lib/client";
import { parseAnswerStream, answerGist } from "@/lib/answer-stream";
import { collapseRepeatedText } from "@/lib/caption-reconciler";
import {
  TURN_LIMITS,
  capTurn,
  endOfTurnDelayMs,
  lastSentences,
  latestUtterance,
  stripConsumedPrefix,
} from "@/lib/transcript-turn";
import { getElectronAPI } from "@/lib/electron";
import { useSettings } from "@/hooks/use-settings";
import { useDeepgram } from "@/hooks/use-deepgram";
import { useLiveCaptions } from "@/hooks/use-live-captions";
import {
  useOpenAiTranscription,
  type CaptureSource,
} from "@/hooks/use-openai-transcription";

// Capture sources include OpenAI/Deepgram audio plus the Windows Live Captions
// bridge (desktop app only).
type CaptureChoice = CaptureSource | "livecaption";

import type { AnswerMode } from "@/lib/schemas";
import { ANSWER_MODE_LABELS } from "@/lib/constants";
import type {
  ConfigStatus,
  AnswerResult,
  ProfilesResponse,
  CandidateProfileDto,
  JobProfileDto,
} from "@/lib/session-types";
import type { PositioningBrief, BriefProject, BriefQa, WeakSpot } from "@/lib/types";

// Static class strings so Tailwind keeps them; maps the answer-size setting.
const ANSWER_FONT_SIZE_CLASS = {
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
} as const;

// Cap retained final chunks so the transcript doesn't grow without bound (which
// forced manual clearing). The answer model already uses a time-windowed slice.
const MAX_FINALS = 80;

// Cap the in-session answer log so it doesn't grow without bound.
const MAX_LOG = 40;

interface FinalChunk {
  text: string;
  at: number;
  // Monotonic id so we can mark "answered up to here" even after old chunks are
  // pruned (array indices shift on prune; seq does not).
  seq: number;
}

interface PriorTurnState {
  question: string;
  answerGist: string;
}

interface LogEntry {
  id: string;
  question: string;
  answer: string;
  confidence: string;
  riskNote: string;
  at: number;
}

// Result of a streaming generate/rewrite run.
type StreamOutcome =
  | { kind: "answer"; result: AnswerResult }
  | { kind: "no_answer" }
  | { kind: "superseded" };

export default function SessionPage() {
  const { settings, hydrated } = useSettings();

  const [config, setConfig] = React.useState<ConfigStatus | null>(null);
  const [candidates, setCandidates] = React.useState<CandidateProfileDto[]>([]);
  const [jobs, setJobs] = React.useState<JobProfileDto[]>([]);
  const [candidateId, setCandidateId] = React.useState<string>("");
  const [jobId, setJobId] = React.useState<string>("");

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = React.useState("");

  // Transcript state.
  const [finals, setFinals] = React.useState<FinalChunk[]>([]);
  const [interim, setInterim] = React.useState("");
  const [manualCaption, setManualCaption] = React.useState("");

  // Optional question override + answer.
  const [detectedQuestion, setDetectedQuestion] = React.useState("");
  // Question type is no longer separately classified; the one-shot model infers
  // intent. Kept for the saved turn record.
  const questionType = "other";
  const [answer, setAnswer] = React.useState<AnswerResult | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [lastMode, setLastMode] = React.useState<AnswerMode>("brief");
  const [autoAnswer, setAutoAnswer] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // Readiness signal so you know exactly when to press Generate.
  const [questionReady, setQuestionReady] = React.useState(false);
  const [readyConfidence, setReadyConfidence] = React.useState<string>("medium");
  // In-session log of generated Q/A turns (newest first), collapsible for reference.
  const [log, setLog] = React.useState<LogEntry[]>([]);

  // Strategic positioning brief for the selected (candidate, job) pair. Built
  // once and cached server-side; it's injected into every answer automatically.
  const [positioning, setPositioning] = React.useState<PositioningBrief | null>(null);
  const [briefLoading, setBriefLoading] = React.useState(false);
  const [briefBuilding, setBriefBuilding] = React.useState(false);

  // Refs to avoid stale closures in async/debounced handlers.
  const finalsRef = React.useRef<FinalChunk[]>([]);
  const interimRef = React.useRef("");
  const detectedRef = React.useRef("");
  const lastAnsweredRef = React.useRef("");
  // End-of-turn (pause) detection for the live answer flow.
  const endOfTurnTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEndOfTurnRef = React.useRef<() => void>(() => {});
  // Monotonic sequence for final chunks, and the marker of the last chunk we've
  // already answered (so Generate sends only what's new). prevConsumedSeqRef
  // keeps the value from before the last answer, so a mis-click is recoverable
  // via Regenerate (which reads a wider window and ignores the marker).
  const seqRef = React.useRef(0);
  const consumedSeqRef = React.useRef(0);
  const prevConsumedSeqRef = React.useRef(0);
  // The interim text we last answered. When Live Captions finalizes it into a
  // final chunk afterward, we strip that overlap so it isn't answered twice.
  const consumedInterimRef = React.useRef("");
  // Streaming + session memory.
  const streamAbort = React.useRef<AbortController | null>(null);
  const priorTurnsRef = React.useRef<PriorTurnState[]>([]);
  // Mirror of `answer` so async handlers can restore it (e.g. after NO_ANSWER)
  // without depending on stale closure state.
  const answerRef = React.useRef<AnswerResult | null>(null);
  // Latest copies of the two halves of the session's memory, so each side can
  // read the other without a hook-ordering knot: spoken answers (`log`) feed the
  // coding solve; coding turns feed the next spoken answer.
  const logRef = React.useRef<LogEntry[]>([]);
  const codingHistoryRef = React.useRef<CodingTurn[]>([]);

  React.useEffect(() => {
    answerRef.current = answer;
  }, [answer]);
  React.useEffect(() => {
    finalsRef.current = finals;
  }, [finals]);
  React.useEffect(() => {
    interimRef.current = interim;
  }, [interim]);
  React.useEffect(() => {
    detectedRef.current = detectedQuestion;
  }, [detectedQuestion]);

  // Initialize autoAnswer from settings once hydrated.
  React.useEffect(() => {
    if (hydrated) {
      setAutoAnswer(settings.autoAnswer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // Load config + profiles.
  React.useEffect(() => {
    (async () => {
      try {
        const [cfg, profiles] = await Promise.all([
          apiFetch<ConfigStatus>("/api/config"),
          apiFetch<ProfilesResponse>("/api/profiles"),
        ]);
        setConfig(cfg);
        setCandidates(profiles.candidates);
        setJobs(profiles.jobs);
        setCandidateId(profiles.candidates[0]?.id ?? "");
        setJobId(profiles.jobs[0]?.id ?? "");
      } catch (err) {
        toast.error("Could not load session data", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    })();
  }, []);

  // Load any cached positioning brief whenever the candidate/job pair changes.
  React.useEffect(() => {
    if (!candidateId || !jobId) {
      setPositioning(null);
      return;
    }
    let cancelled = false;
    setBriefLoading(true);
    (async () => {
      try {
        const { brief } = await apiFetch<{ brief: PositioningBrief | null }>(
          `/api/positioning-brief?candidateProfileId=${encodeURIComponent(
            candidateId
          )}&jobProfileId=${encodeURIComponent(jobId)}`
        );
        if (!cancelled) setPositioning(brief);
      } catch {
        if (!cancelled) setPositioning(null);
      } finally {
        if (!cancelled) setBriefLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateId, jobId]);

  const buildBrief = React.useCallback(async () => {
    if (!candidateId || !jobId) {
      toast.error("Pick a candidate and a job profile first.");
      return;
    }
    setBriefBuilding(true);
    try {
      const { brief } = await apiFetch<{ brief: PositioningBrief }>(
        "/api/positioning-brief",
        {
          method: "POST",
          body: JSON.stringify({
            candidateProfileId: candidateId,
            jobProfileId: jobId,
          }),
        }
      );
      setPositioning(brief);
      toast.success("Positioning brief ready", {
        description: "It now shapes every answer for this role.",
      });
    } catch (err) {
      toast.error("Could not build positioning brief", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBriefBuilding(false);
    }
  }, [candidateId, jobId]);

  const windowMs = (settings.transcriptWindowSeconds || 90) * 1000;

  const recentTranscript = React.useCallback(() => {
    const cutoff = Date.now() - windowMs;
    const recentFinals = finalsRef.current
      .filter((f) => f.at >= cutoff)
      .map((f) => f.text);
    // Safety net: collapse any repeated phrases that slipped past the caption
    // reconciler (e.g. from the PowerShell bridge concatenating overlapping
    // caption blocks) before the transcript reaches the model or the screen.
    return collapseRepeatedText(
      [...recentFinals, interimRef.current].join(" ").trim()
    );
  }, [windowMs]);

  // A tighter slice (last few sentences) sent to the answer model for speed.
  const recentForAnswer = React.useCallback(
    () =>
      lastSentences(
        recentTranscript(),
        TURN_LIMITS.recentSentences,
        TURN_LIMITS.recentMaxUnits
      ),
    [recentTranscript]
  );

  const selectedJob = jobs.find((j) => j.id === jobId) ?? null;

  /* ------------------------------ Memory ------------------------------ */

  const pushPriorTurn = React.useCallback((question: string, body: string) => {
    const q = question.trim();
    if (!q) return;
    const turn: PriorTurnState = { question: q, answerGist: answerGist(body, 700) };
    priorTurnsRef.current = [
      ...priorTurnsRef.current.filter((t) => t.question !== q),
      turn,
    ].slice(-8);
  }, []);

  const appendLog = React.useCallback((result: AnswerResult, replaceLatest = false) => {
    setLog((prev) => {
      const question = result.detected_question.trim() || "(question inferred)";
      if (replaceLatest && prev[0] && prev[0].question === question) {
        return [{ ...prev[0], answer: result.answer, confidence: result.confidence, riskNote: result.risk_note }, ...prev.slice(1)];
      }
      const entry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        question: result.detected_question.trim() || "(question inferred)",
        answer: result.answer,
        confidence: result.confidence,
        riskNote: result.risk_note,
        at: Date.now(),
      };
      const next = [entry, ...prev];
      return next.length > MAX_LOG ? next.slice(0, MAX_LOG) : next;
    });
  }, []);

  /* ----------------------------- Delta input ----------------------------- */

  // What to answer next: only the speech that's new since the last answer, plus
  // a couple of sentences of overlap for context. This is the core fix for
  // "question detection is bad / scripts duplicated" — we stop re-feeding the
  // whole rolling window on every Generate.
  const buildDelta = React.useCallback(() => {
    const all = finalsRef.current;
    const fresh = all.filter((f) => f.seq > consumedSeqRef.current);
    let newText = collapseRepeatedText(
      [...fresh.map((f) => f.text), interimRef.current].join(" ").trim()
    );
    if (consumedInterimRef.current) {
      newText = stripConsumedPrefix(newText, consumedInterimRef.current);
    }
    // Bound the turn to whole, most-recent sentences: if nothing was answered
    // for a while, a long backlog must not bury the actual ask at the end.
    newText = capTurn(newText);
    const consumedText = all
      .filter((f) => f.seq <= consumedSeqRef.current)
      .map((f) => f.text)
      .join(" ");
    const context = lastSentences(
      consumedText,
      TURN_LIMITS.contextSentences,
      TURN_LIMITS.contextMaxUnits
    );
    const maxSeq = fresh.length
      ? fresh[fresh.length - 1].seq
      : consumedSeqRef.current;
    return { newText, context, maxSeq };
  }, []);

  /* --------------------------- Generation --------------------------- */

  // Shared streaming driver for both Generate and Rewrite. Seeds an empty
  // answer, streams Markdown deltas into it live, then parses the trailing
  // metadata. Aborts any earlier in-flight stream.
  //
  // Outcome:
  //  - "answer"     -> a real answer was produced
  //  - "no_answer"  -> the model decided there was nothing to answer (NO_ANSWER
  //                    sentinel); the prior answer is left on screen untouched
  //  - "superseded" -> a newer run replaced this one (aborted); stay silent
  const streamAnswer = React.useCallback(
    async (
      url: string,
      payload: Record<string, unknown>,
      knownQuestion: string
    ): Promise<StreamOutcome> => {
      streamAbort.current?.abort();
      const controller = new AbortController();
      streamAbort.current = controller;
      // Snapshot the currently-shown answer so a NO_ANSWER run can restore it
      // instead of blanking the card.
      const previous = answerRef.current;
      setGenerating(true);
      setAnswer((prev) => ({
        detected_question: knownQuestion || prev?.detected_question || "",
        answer: "",
        keywords: [],
        confidence: "medium",
        risk_note: "",
        possible_follow_up: "",
      }));

      try {
        const full = await streamFetch(
          url,
          { method: "POST", body: JSON.stringify(payload), signal: controller.signal },
          (acc) => {
            const { body } = parseAnswerStream(acc);
            // While the model is emitting the NO_ANSWER sentinel, keep the
            // loading shimmer instead of flashing the raw token.
            const shown = looksLikeNoAnswer(body) ? "" : body;
            setAnswer((prev) => (prev ? { ...prev, answer: shown } : prev));
          }
        );

        const { body, meta, error } = parseAnswerStream(full);
        if (error) throw new Error(error);

        if (isNoAnswerBody(body)) {
          // Nothing to answer — put the previous answer back so the screen
          // doesn't blank out on a passing remark.
          setAnswer(previous);
          return { kind: "no_answer" };
        }

        const finalQuestion = knownQuestion || meta?.detected_question || "";
        const riskNote = (meta?.risk_note ?? "").trim();
        const result: AnswerResult = {
          detected_question: finalQuestion,
          answer: body,
          keywords: meta?.keywords ?? [],
          confidence: meta?.confidence ?? "medium",
          risk_note: riskNote,
          possible_follow_up: meta?.possible_follow_up ?? "",
        };
        setAnswer(result);
        return { kind: "answer", result };
      } catch (err) {
        // A superseded stream aborts intentionally — stay silent.
        if (controller.signal.aborted) return { kind: "superseded" };
        throw err;
      } finally {
        if (streamAbort.current === controller) {
          streamAbort.current = null;
          setGenerating(false);
        }
      }
    },
    []
  );

  const generate = React.useCallback(
    async (
      mode: AnswerMode,
      opts: { override?: string; wide?: boolean; auto?: boolean; expandOn?: string } = {}
    ) => {
      const question = (opts.override ?? detectedRef.current).trim();

      // Decide what to send, and whether to advance the "answered up to here"
      // marker. We hand the model two distinct things:
      //   focusHint  -> the interviewer's latest words, i.e. what to ANSWER
      //   transcript -> earlier speech, only as background to interpret it
      let transcript = "";
      let focusHint = "";
      let advanceTo: number | null = null;
      // Interim snapshot at the moment we build the delta, committed on success
      // so the next delta can strip it once it finalizes.
      let interimSnapshot = "";

      if (question) {
        // Explicit typed question: it IS the ask. Send recent speech as context.
        transcript = recentForAnswer();
      } else if (opts.wide) {
        // Regenerate / recovery: re-read a wider window and ignore the marker so
        // a wrong boundary or mis-click can be corrected. Point at the tail.
        transcript = lastSentences(
          recentTranscript(),
          TURN_LIMITS.wideSentences,
          TURN_LIMITS.wideMaxUnits
        );
        focusHint = latestUtterance(transcript);
      } else {
        // Normal flow: the interviewer's latest TURN is everything new since the
        // last answer. Hand that WHOLE turn to the model as the thing to answer
        // (so a long, multi-question turn gets each part answered), with a
        // little earlier speech as background only. This is the core of "send
        // the last part as raw script, get back the question(s) + answer".
        const { newText, context, maxSeq } = buildDelta();
        if (newText) {
          focusHint = newText;
          transcript = context; // earlier background only (may be empty)
          advanceTo = maxSeq;
          interimSnapshot = interimRef.current.trim();
        } else if (opts.auto) {
          // Auto-answer with nothing new to say: do nothing (no re-answering).
          return;
        } else {
          // Manual click with nothing new: best-effort answer of the recent
          // window. Harmless, and the marker is left alone.
          transcript = recentForAnswer();
          focusHint = latestUtterance(transcript);
        }
      }

      if (!question && !transcript && !focusHint) {
        toast.error("Nothing to answer yet", {
          description: "Record/paste some transcript, or type a question.",
        });
        return;
      }
      setLastMode(mode);
      try {
        const outcome = await streamAnswer(
          "/api/generate-answer/stream",
          {
            candidateProfileId: candidateId || undefined,
            jobProfileId: jobId || undefined,
            recentTranscript: transcript,
            detectedQuestion: question,
            focusHint,
            questionType,
            answerMode: mode,
            answerLanguage: settings.answerLanguage,
            boldKeywords: settings.boldKeywords,
            expandOn: opts.expandOn ?? "",
            allowInventedDetails: settings.allowInventedDetails,
            // Going deeper replaces the answer just shown, so don't feed it
            // back as something "already said".
            priorTurns: opts.expandOn
              ? priorTurnsRef.current.filter((t) => t.question !== question)
              : priorTurnsRef.current,
            codingContext: codingForAnswers(codingHistoryRef.current),
          },
          question
        );
        if (outcome.kind === "superseded") return; // a newer generate replaced this
        if (outcome.kind === "no_answer") {
          // The model judged there's nothing to answer. Don't advance the
          // marker (so a real ask in the growing delta still gets picked up),
          // don't log it. Only nudge the user when they asked explicitly.
          if (!opts.auto) {
            toast("Nothing to answer there", {
              description: "The latest speech didn't look like a question yet.",
            });
          }
          setQuestionReady(false);
          return;
        }
        const result = outcome.result;
        // Advance the consumed marker only when we actually answered a fresh
        // delta, so the next Generate won't re-answer this text.
        if (advanceTo !== null) {
          prevConsumedSeqRef.current = consumedSeqRef.current;
          consumedSeqRef.current = advanceTo;
          consumedInterimRef.current = interimSnapshot;
        }
        // NOTE: never write the inferred question back into the override box —
        // doing so makes it "stick" and forces every later answer onto a stale
        // question. The box only ever holds what the user types.
        const answered = result.detected_question.trim() || question;
        lastAnsweredRef.current = answered;
        pushPriorTurn(answered, result.answer);
        appendLog(result, Boolean(opts.expandOn));
        setQuestionReady(false);
      } catch (err) {
        toast.error("Could not generate answer", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [
      candidateId,
      jobId,
      questionType,
      recentForAnswer,
      recentTranscript,
      buildDelta,
      settings,
      streamAnswer,
      pushPriorTurn,
      appendLog,
    ]
  );

  // Brief / Deep toggle. With no answer yet it only picks the length for the
  // next one. With an answer on screen: Deep writes the fuller version of the
  // same answer, Brief cuts the current one down.
  const rewrite = React.useCallback(
    async (mode: AnswerMode) => {
      if (!answer || !answer.answer.trim()) {
        setLastMode(mode);
        return;
      }
      if (mode === lastModeRef.current) return;
      setLastMode(mode);
      const baseQuestion = detectedRef.current.trim() || answer.detected_question;
      if (mode === "deep") {
        await generate("deep", {
          override: baseQuestion || undefined,
          wide: !baseQuestion,
          expandOn: answer.answer,
        });
        return;
      }
      try {
        await streamAnswer(
          "/api/rewrite-answer/stream",
          {
            detectedQuestion: baseQuestion || answer.answer.slice(0, 80),
            answer: answer.answer,
            answerLanguage: settings.answerLanguage,
            candidateProfileId: candidateId || undefined,
            jobProfileId: jobId || undefined,
            boldKeywords: settings.boldKeywords,
          },
          baseQuestion
        );
      } catch (err) {
        toast.error("Could not shorten answer", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [answer, generate, candidateId, jobId, settings, streamAnswer]
  );

  /* --------------------------- Live transcript --------------------------- */

  const handleTranscript = React.useCallback((text: string, isFinal: boolean) => {
    if (isFinal) {
      if (!text.trim()) return;
      setFinals((prev) => {
        const next = [...prev, { text, at: Date.now(), seq: ++seqRef.current }];
        return next.length > MAX_FINALS ? next.slice(-MAX_FINALS) : next;
      });
      setInterim("");
    } else {
      setInterim(text);
    }
  }, []);

  const [captureSource, setCaptureSource] = React.useState<CaptureChoice>("microphone");

  // Live Captions is only available in the Windows desktop build. Resolved
  // after mount to avoid a hydration mismatch.
  const [liveCaptionsAvailable, setLiveCaptionsAvailable] = React.useState(false);
  React.useEffect(() => {
    const api = getElectronAPI();
    setLiveCaptionsAvailable(Boolean(api) && api?.platform === "win32");
  }, []);

  const deepgram = useDeepgram({
    onTranscript: handleTranscript,
    onError: (message) =>
      toast.error("Transcription error", { description: message }),
    language: settings.sttLanguage,
  });

  const openaiStt = useOpenAiTranscription({
    onTranscript: handleTranscript,
    onError: (message) =>
      toast.error("Transcription error", { description: message }),
    segmentMs: Math.max(2, settings.sttSegmentSeconds || 4) * 1000,
    language: settings.sttLanguage,
  });

  const liveCaptions = useLiveCaptions({
    onTranscript: handleTranscript,
    onError: (message) =>
      toast.error("Live Captions error", { description: message }),
  });

  // Engine selection: Live Captions when chosen; Deepgram streams the mic when
  // available; otherwise (and always for shared tab/system audio) OpenAI
  // transcribes short segments.
  const isLiveCaptions = captureSource === "livecaption";
  const useDeepgramEngine =
    !isLiveCaptions &&
    Boolean(config?.deepgramConfigured) &&
    captureSource === "microphone";

  const isRecording =
    deepgram.isRecording || openaiStt.isRecording || liveCaptions.isRecording;
  const isStarting =
    deepgram.state === "connecting" || openaiStt.state === "starting";

  const startRecording = React.useCallback(() => {
    if (isLiveCaptions) {
      liveCaptions.start();
    } else if (useDeepgramEngine) {
      void deepgram.start();
    } else if (config?.openaiConfigured) {
      void openaiStt.start(captureSource as CaptureSource);
    } else {
      toast.error("No transcription available", {
        description: "Add an OpenAI key on Settings to enable live transcription.",
      });
    }
  }, [
    isLiveCaptions,
    useDeepgramEngine,
    config?.openaiConfigured,
    captureSource,
    deepgram,
    openaiStt,
    liveCaptions,
  ]);

  const stopRecording = React.useCallback(() => {
    deepgram.stop();
    openaiStt.stop();
    liveCaptions.stop();
  }, [deepgram, openaiStt, liveCaptions]);

  // End-of-turn detection: any new speech (final or interim) resets a short
  // timer. When the interviewer pauses, the timer fires — that's the moment to
  // answer. No "?" required, and no separate detection call on the hot path.
  // How long the interviewer must pause (no new captions) before we treat it as
  // the end of their turn — the moment to answer. Works for questions and for
  // prompts that don't end in "?" ("Tell me about a time you led a project").
  const endOfTurnMs = Math.round(
    Math.max(0.5, settings.endOfTurnSeconds || 1.8) * 1000
  );

  React.useEffect(() => {
    if (!isRecording) return;
    // They're talking again, so it's not the moment yet.
    setQuestionReady(false);
    if (endOfTurnTimer.current) clearTimeout(endOfTurnTimer.current);
    // The pause is adaptive: sooner after a finished question, longer when the
    // text trails off with no punctuation (they're likely still mid-thought),
    // and never for bare filler ("okay", "right").
    const delay = endOfTurnDelayMs(buildDelta().newText, endOfTurnMs);
    if (delay !== null) {
      endOfTurnTimer.current = setTimeout(
        () => handleEndOfTurnRef.current(),
        delay
      );
    }
    return () => {
      if (endOfTurnTimer.current) clearTimeout(endOfTurnTimer.current);
    };
  }, [finals, interim, isRecording, endOfTurnMs, buildDelta]);

  const addManualCaption = () => {
    const text = manualCaption.trim();
    if (!text) return;
    setFinals((prev) => [...prev, { text, at: Date.now(), seq: ++seqRef.current }]);
    setManualCaption("");
  };

  const clearTranscript = () => {
    setFinals([]);
    setInterim("");
    finalsRef.current = [];
    interimRef.current = "";
    seqRef.current = 0;
    consumedSeqRef.current = 0;
    prevConsumedSeqRef.current = 0;
    consumedInterimRef.current = "";
    lastAnsweredRef.current = "";
    priorTurnsRef.current = [];
    setQuestionReady(false);
    toast.success("Transcript cleared");
  };

  /* ------------------------------ Save turn ------------------------------ */

  const ensureSession = React.useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    const title =
      sessionTitle.trim() ||
      `${selectedJob?.company ?? "Interview"} — ${new Date().toLocaleDateString()}`;
    const session = await apiFetch<{ id: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        title,
        candidateProfileId: candidateId || null,
        jobProfileId: jobId || null,
      }),
    });
    setSessionId(session.id);
    setSessionTitle(title);
    return session.id;
  }, [sessionId, sessionTitle, selectedJob, candidateId, jobId]);

  const saveTurn = React.useCallback(async () => {
    if (!answer) {
      toast.error("Generate an answer before saving the turn.");
      return;
    }
    setSaving(true);
    try {
      const id = await ensureSession();
      await apiFetch(`/api/sessions/${id}/turns`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: id,
          rawTranscript: recentTranscript(),
          detectedQuestion: answer.detected_question || detectedRef.current,
          questionType,
          generatedAnswer: answer.answer,
          answerMode: lastMode,
          keywords: answer.keywords,
          confidence: answer.confidence,
          riskNote: answer.risk_note,
          possibleFollowUp: answer.possible_follow_up,
        }),
      });
      // Persist the running transcript on the session too.
      await apiFetch(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          transcript: finalsRef.current.map((f) => f.text).join("\n"),
        }),
      });
      toast.success("Turn saved", { description: "View it later on the History page." });
    } catch (err) {
      toast.error("Could not save turn", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  }, [answer, ensureSession, recentTranscript, questionType, lastMode]);

  /* --------------------------- Keyboard shortcuts --------------------------- */

  const generateRef = React.useRef(generate);
  const rewriteRef = React.useRef(rewrite);
  generateRef.current = generate;
  rewriteRef.current = rewrite;
  const lastModeRef = React.useRef(lastMode);
  lastModeRef.current = lastMode;
  const generatingRef = React.useRef(generating);
  generatingRef.current = generating;
  const autoAnswerRef = React.useRef(autoAnswer);
  autoAnswerRef.current = autoAnswer;

  /* ------------------------ Coding + earlier answers ------------------------ */

  // The coding copilot lives INSIDE the session: same transcript, same hotkeys,
  // same window. Its state is lifted here so it survives switching tabs.
  const getSessionContext = React.useCallback(() => answersForCoding(logRef.current), []);
  const coding = useCoding({
    candidateId: candidateId || undefined,
    getTranscript: recentTranscript,
    getSessionContext,
    useBaseModel: settings.codingBaseModel,
  });
  logRef.current = log;
  codingHistoryRef.current = coding.history;
  const [tab, setTab] = React.useState<"answer" | "code">("answer");
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const [showSetup, setShowSetup] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const [showMore, setShowMore] = React.useState(false);
  // null = the live (latest) answer; otherwise the id of an earlier one.
  const [viewLogId, setViewLogId] = React.useState<string | null>(null);
  const [answerBadge, setAnswerBadge] = React.useState(false);
  const [codeBadge, setCodeBadge] = React.useState(false);

  // Setup opens by itself until there is a candidate and a job to answer as.
  React.useEffect(() => {
    if (config && (candidates.length === 0 || jobs.length === 0)) setShowSetup(true);
  }, [config, candidates.length, jobs.length]);

  // A new run jumps back to the latest answer.
  React.useEffect(() => {
    if (generating) setViewLogId(null);
  }, [generating]);

  // A dot on the tab you are not looking at when something new lands there.
  const latestAnswerId = log[0]?.id;
  const seenAnswerId = React.useRef(latestAnswerId);
  React.useEffect(() => {
    if (latestAnswerId === seenAnswerId.current) return;
    seenAnswerId.current = latestAnswerId;
    if (latestAnswerId && tabRef.current === "code") setAnswerBadge(true);
  }, [latestAnswerId]);
  const latestCodeId = coding.history[0]?.id;
  const seenCodeId = React.useRef(latestCodeId);
  React.useEffect(() => {
    if (latestCodeId === seenCodeId.current) return;
    seenCodeId.current = latestCodeId;
    if (latestCodeId && tabRef.current === "answer") setCodeBadge(true);
  }, [latestCodeId]);
  React.useEffect(() => {
    if (tab === "answer") setAnswerBadge(false);
    else setCodeBadge(false);
  }, [tab]);

  // Stepping through earlier answers. The newest finished answer IS the live
  // one, so "earlier" from live starts one back (or at the newest while a new
  // answer is still streaming and not yet in the list).
  const answerPos = viewLogId ? log.findIndex((e) => e.id === viewLogId) : -1;
  const answerBase = generating ? 0 : 1;
  const canOlderAnswer =
    answerPos === -1 ? log.length > answerBase : answerPos + 1 < log.length;
  const stepAnswer = (dir: 1 | -1) => {
    if (dir === 1) {
      const next = answerPos === -1 ? answerBase : answerPos + 1;
      if (next < log.length) setViewLogId(log[next].id);
    } else if (answerPos !== -1) {
      const next = answerPos - 1;
      setViewLogId(next < answerBase ? null : log[next].id);
    }
  };

  const codePos = coding.activeTurnId
    ? coding.history.findIndex((t) => t.id === coding.activeTurnId)
    : -1;
  const codeBase = coding.solving ? 0 : 1;
  const canOlderCode =
    codePos === -1 ? coding.history.length > codeBase : codePos + 1 < coding.history.length;
  const stepCode = (dir: 1 | -1) => {
    if (dir === 1) {
      const next = codePos === -1 ? codeBase : codePos + 1;
      if (next < coding.history.length) coding.selectTurn(coding.history[next].id);
    } else if (codePos !== -1) {
      const next = codePos - 1;
      coding.selectTurn(next < codeBase ? null : coding.history[next].id);
    }
  };

  const navRef = React.useRef<(dir: 1 | -1) => void>(() => {});
  navRef.current = (dir) => (tab === "code" ? stepCode(dir) : stepAnswer(dir));

  // One list of everything answered this session, newest first.
  const feed: FeedItem[] = [
    ...log.map((e) => ({
      id: e.id,
      kind: "answer" as const,
      title: e.question,
      at: e.at,
    })),
    ...coding.history.map((t) => ({
      id: t.id,
      kind: "code" as const,
      title: t.title,
      at: t.at,
      tag: t.solution.mode ? CODING_MODE_LABELS[t.solution.mode] : undefined,
    })),
  ].sort((a, b) => b.at - a.at);

  const openFeedItem = (item: FeedItem) => {
    if (item.kind === "answer") {
      const idx = log.findIndex((e) => e.id === item.id);
      setViewLogId(idx < answerBase ? null : item.id);
      setTab("answer");
    } else {
      const idx = coding.history.findIndex((t) => t.id === item.id);
      coding.selectTurn(idx < codeBase ? null : item.id);
      setTab("code");
    }
    setShowHistory(false);
  };

  // The main action follows the tab you are on. From the global hotkey (the
  // call window has focus) on the Code tab, grab the screen and solve.
  const quickSolve = async () => {
    if (coding.solving) return;
    try {
      if (coding.images.length > 0 && !coding.solution) await coding.solve();
      else await coding.captureAndSolve();
    } catch (err) {
      toast.error("Capture failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };
  const primaryRef = React.useRef<(fromGlobal: boolean) => void>(() => {});
  primaryRef.current = (fromGlobal) => {
    if (tabRef.current !== "code") {
      void generateRef.current(lastModeRef.current);
      return;
    }
    const hasInputs =
      coding.images.length > 0 ||
      coding.pastedText.trim().length > 0 ||
      coding.ask.trim().length > 0;
    if (!fromGlobal && hasInputs && !coding.solving) void coding.solve();
    else void quickSolve();
  };

  // Electron capture hotkey: grab the screen and show it on the Code tab.
  useCodingCaptureHotkey(() => {
    setTab("code");
    void coding.capture().catch((err) =>
      toast.error("Capture failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    );
  });

  // Runs when the interviewer pauses (end of turn). In auto mode it generates a
  // one-shot answer (the model infers the question itself); otherwise it just
  // signals that now is a good time to press Generate — no LLM call, no waiting.
  handleEndOfTurnRef.current = () => {
    if (generatingRef.current) return;
    // Only react when there's genuinely new speech since the last answer.
    const { newText } = buildDelta();
    if (!newText) return;
    if (autoAnswerRef.current) {
      void generateRef.current(lastModeRef.current, { auto: true });
    } else {
      setReadyConfidence("");
      setQuestionReady(true);
    }
  };

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Alt+←/→ flips through earlier answers (older / newer).
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        navRef.current(e.key === "ArrowLeft" ? 1 : -1);
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (!e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        primaryRef.current(false);
        return;
      }
      if (e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === "s") {
          e.preventDefault();
          void rewriteRef.current("brief");
        } else if (key === "d") {
          e.preventDefault();
          void rewriteRef.current("deep");
        } else if (key === "r") {
          e.preventDefault();
          void generateRef.current(lastModeRef.current, { wide: true });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Global hotkey from the Electron overlay (works even when the call is focused).
  React.useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    return api.onGenerate(() => primaryRef.current(true));
  }, []);

  // Global hotkey (Ctrl/Cmd+Shift+C) flips between the Answer and Code views.
  React.useEffect(() => {
    const api = getElectronAPI();
    if (!api?.coding) return;
    return api.coding.onToggle(() => setTab((t) => (t === "code" ? "answer" : "code")));
  }, []);

  const openaiMissing = config && !config.openaiConfigured;
  const canRecord = Boolean(config?.transcriptionAvailable || liveCaptionsAvailable);

  const viewedEntry = viewLogId ? (log.find((e) => e.id === viewLogId) ?? null) : null;
  const shown = viewedEntry
    ? {
        question: viewedEntry.question,
        text: viewedEntry.answer,
        confidence: viewedEntry.confidence,
        risk: viewedEntry.riskNote,
      }
    : answer
      ? {
          question: answer.detected_question,
          text: answer.answer,
          confidence: answer.confidence,
          risk: answer.risk_note,
        }
      : null;

  const readyGlow = questionReady && !generating;

  const answerPane = (
    <div className="space-y-3">
      <Card className={readyGlow ? "border-success/60 shadow-[0_0_0_1px_hsl(var(--success))]" : "border-primary/30"}>
        <CardHeader className="flex-row items-center justify-between space-y-0 px-3 py-2">
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
            <span className="whitespace-nowrap">{viewedEntry ? "Earlier" : "Answer"}</span>
            {shown && (
              <ConfidenceBadge
                confidence={shown.confidence}
                className="whitespace-nowrap px-2 py-0 text-[10px]"
              />
            )}
          </CardTitle>
          <PrevNav
            label={viewedEntry ? `${log.length - answerPos} / ${log.length}` : "Latest"}
            canOlder={canOlderAnswer}
            canNewer={viewedEntry !== null}
            onOlder={() => stepAnswer(1)}
            onNewer={() => stepAnswer(-1)}
            onOpenHistory={() => setShowHistory((v) => !v)}
            historyCount={feed.length}
          />
        </CardHeader>
        <CardContent className="space-y-2 px-3 pb-3 pt-0">
          {viewedEntry && (
            <button
              type="button"
              onClick={() => setViewLogId(null)}
              className="flex w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back to the latest answer
            </button>
          )}
          {shown?.question && (
            <div className="rounded-md border-l-2 border-primary/50 bg-secondary/30 px-2.5 py-1">
              <p className="text-sm font-semibold leading-snug">{shown.question}</p>
            </div>
          )}
          <div
            className={`min-h-[96px] rounded-md bg-secondary/40 p-2.5 leading-relaxed ${
              ANSWER_FONT_SIZE_CLASS[settings.answerFontSize] ?? "text-base"
            }`}
          >
            {shown && shown.text ? (
              <RichAnswer text={shown.text} />
            ) : generating ? (
              <GeneratingState />
            ) : (
              <span className="text-sm text-muted-foreground">
                Press Generate (⌘/Ctrl + Enter) when the interviewer finishes asking.
              </span>
            )}
          </div>
          {shown?.risk && (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{shown.risk}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className={cn("flex-1", readyGlow && "animate-pulse-dot")}
            onClick={() => void generate(lastMode)}
            disabled={generating}
          >
            <Sparkles className="h-4 w-4" /> Generate
          </Button>
          <div
            role="group"
            aria-label="Answer length"
            className="flex shrink-0 overflow-hidden rounded-md border border-border"
          >
            {(["brief", "deep"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={lastMode === m}
                disabled={generating || viewedEntry !== null}
                onClick={() => void rewrite(m)}
                className={cn(
                  "px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
                  lastMode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                )}
              >
                {ANSWER_MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <Button
            size="icon"
            variant={showMore ? "secondary" : "ghost"}
            className="h-8 w-8 shrink-0"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            aria-label="More actions"
            title="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
        {showMore && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void generate(lastMode, { wide: true })} disabled={generating}>
              <RefreshCw className="h-4 w-4" /> Regenerate
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void saveTurn()} disabled={saving || !answer}>
              {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save turn
            </Button>
          </div>
        )}
        <Input
          value={detectedQuestion}
          onChange={(e) => setDetectedQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !generating) {
              e.preventDefault();
              void generate(lastMode);
            }
          }}
          placeholder="Or type the exact question and press Enter"
          className="h-8 text-xs"
          aria-label="Answer a specific question"
        />
      </div>

      <TranscriptStrip
        finals={finals}
        interim={interim}
        recording={isRecording}
        onClear={clearTranscript}
      />
    </div>
  );

  const lastEntry = log[0] ?? null;
  const codePane = (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-semibold">
          {coding.viewingHistory ? "Earlier coding answer" : "Coding copilot"}
        </span>
        <PrevNav
          label={coding.viewingHistory ? `${coding.history.length - codePos} / ${coding.history.length}` : "Latest"}
          canOlder={canOlderCode}
          canNewer={coding.viewingHistory}
          onOlder={() => stepCode(1)}
          onNewer={() => stepCode(-1)}
          onOpenHistory={() => setShowHistory((v) => !v)}
          historyCount={feed.length}
        />
      </div>

      {/* The spoken answer stays in reach while you code */}
      {(lastEntry || generating) && (
        <details className="group rounded-lg border bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            <span className="shrink-0 font-medium text-muted-foreground">Last answer</span>
            <span className="line-clamp-1 min-w-0 flex-1">
              {generating ? "Writing a new one…" : lastEntry?.question}
            </span>
          </summary>
          <div className="max-h-52 overflow-y-auto border-t px-3 py-2 text-sm scrollbar-thin">
            {answer?.answer ? <RichAnswer text={answer.answer} /> : lastEntry ? <RichAnswer text={lastEntry.answer} /> : null}
          </div>
        </details>
      )}

      <CodingView c={coding} active={tab === "code"} />

      <div className="lg:hidden">
        <TranscriptStrip
          finals={finals}
          interim={interim}
          recording={isRecording}
          onClear={clearTranscript}
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Top bar: status, record, setup, tabs */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <LiveStatus
            recording={isRecording}
            transcribing={openaiStt.processing}
            generating={generating}
            questionReady={questionReady}
            readyConfidence={readyConfidence}
            coding={coding.solving}
          />
          {canRecord &&
            (isRecording ? (
              <Button size="sm" variant="destructive" className="h-8 shrink-0" onClick={stopRecording}>
                <Square className="h-4 w-4" /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 shrink-0"
                onClick={startRecording}
                disabled={isStarting}
              >
                {isStarting ? <Spinner /> : <Mic className="h-4 w-4" />} Record
              </Button>
            ))}
          <Button
            size="icon"
            variant={showSetup ? "secondary" : "ghost"}
            className="h-8 w-8 shrink-0"
            onClick={() => setShowSetup((v) => !v)}
            aria-expanded={showSetup}
            aria-label="Session setup"
            title="Session setup"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/50 p-1 lg:hidden" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "answer"}
            onClick={() => setTab("answer")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors",
              tab === "answer" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <MessageSquareText className="h-4 w-4" /> Answer
            {answerBadge && <span className="h-2 w-2 rounded-full bg-success" aria-label="New answer" />}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            onClick={() => setTab("code")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors",
              tab === "code" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Code2 className="h-4 w-4" /> Code
            {coding.solving ? (
              <Spinner className="h-3 w-3" />
            ) : (
              codeBadge && <span className="h-2 w-2 rounded-full bg-success" aria-label="New coding answer" />
            )}
          </button>
        </div>
      </div>

      {openaiMissing && (
        <Banner>
          OpenAI API key is not configured. Add it on the <strong>Settings</strong> page to
          enable live answers.
        </Banner>
      )}

      {showSetup && (
        <SetupPanel>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Candidate profile</Label>
              <Select value={candidateId} onValueChange={setCandidateId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.length === 0 && (
                    <SelectItem value="none" disabled>
                      No profiles — add one on Setup
                    </SelectItem>
                  )}
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || "Unnamed"} — {c.targetTitle || "candidate"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Job profile</Label>
              <Select value={jobId} onValueChange={setJobId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.length === 0 && (
                    <SelectItem value="none" disabled>
                      No jobs — add one on Setup
                    </SelectItem>
                  )}
                  {jobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.roleTitle || "Role"} @ {j.company || "company"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="session-title">Session title</Label>
              <Input
                id="session-title"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                placeholder="e.g. Meridian — backend screen"
                className="h-9"
              />
            </div>
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
            <span>
              Auto-answer
              <span className="block text-xs text-muted-foreground">
                Answer on its own when the interviewer pauses
              </span>
            </span>
            <Switch checked={autoAnswer} onCheckedChange={setAutoAnswer} />
          </label>

          {canRecord && (
            <div className="space-y-1.5">
              <Label>Audio source</Label>
              <Select
                value={captureSource}
                onValueChange={(v) => setCaptureSource(v as CaptureChoice)}
                disabled={isRecording || isStarting}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {liveCaptionsAvailable && (
                    <SelectItem value="livecaption">Windows Live Captions</SelectItem>
                  )}
                  {config?.transcriptionAvailable && (
                    <>
                      <SelectItem value="microphone">Microphone</SelectItem>
                      <SelectItem value="display">Meeting tab audio</SelectItem>
                      <SelectItem value="both">Mic + meeting audio</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
              <CaptureHint
                source={captureSource}
                engine={
                  isLiveCaptions ? "Live Captions" : useDeepgramEngine ? "Deepgram" : "OpenAI"
                }
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="manual-caption">Paste captions by hand</Label>
            <Textarea
              id="manual-caption"
              value={manualCaption}
              onChange={(e) => setManualCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  addManualCaption();
                }
              }}
              placeholder="Paste what the interviewer said, then Add (⌘/Ctrl+Enter)…"
              className="min-h-[56px]"
            />
            <Button size="sm" variant="outline" onClick={addManualCaption}>
              Add to transcript
            </Button>
          </div>

          <PositioningBriefCard
            brief={positioning}
            loading={briefLoading}
            building={briefBuilding}
            disabled={!candidateId || !jobId}
            onBuild={() => void buildBrief()}
          />
          <ShortcutHint />
        </SetupPanel>
      )}

      {showHistory && (
        <HistoryPanel
          items={feed}
          activeId={viewLogId ?? coding.activeTurnId}
          onOpen={openFeedItem}
          onClose={() => setShowHistory(false)}
          onClearAnswers={() => {
            setLog([]);
            setViewLogId(null);
          }}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <div
          className={cn(tab === "answer" ? "block" : "hidden", "lg:block")}
          onPointerDownCapture={() => setTab("answer")}
        >
          {answerPane}
        </div>
        <div
          className={cn(tab === "code" ? "block" : "hidden", "lg:block")}
          onPointerDownCapture={() => setTab("code")}
        >
          {codePane}
        </div>
      </div>
    </div>
  );
}

function SetupPanel({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3" aria-label="Session setup">
      {children}
    </section>
  );
}

function TranscriptStrip({
  finals,
  interim,
  recording,
  onClear,
}: {
  finals: FinalChunk[];
  interim: string;
  recording: boolean;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the newest line in view.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finals, interim, expanded]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">Live transcript</span>
        {recording && (
          <span className="flex items-center gap-1 text-destructive">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-destructive" />
            recording
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Less" : "More"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={onClear}
            title="Clear the transcript"
          >
            <Eraser className="h-3 w-3" /> Clear
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className={cn(
          "overflow-y-auto rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs leading-relaxed scrollbar-thin",
          expanded ? "h-44" : "h-16"
        )}
      >
        {finals.length === 0 && !interim ? (
          <span className="text-muted-foreground">Transcript will appear here…</span>
        ) : (
          <>
            {finals.map((f) => (
              <span key={f.seq}>{f.text} </span>
            ))}
            {interim && <span className="text-muted-foreground">{interim}</span>}
          </>
        )}
      </div>
    </div>
  );
}

// The model emits the bare token NO_ANSWER (with no ---META--- block) when the
// latest interviewer turn isn't actually something to answer. Detect it
// defensively, tolerating stray leading markdown emphasis.
const NO_ANSWER_TOKEN = "NO_ANSWER";

function normalizeSentinel(body: string): string {
  return body.trim().replace(/^[*_`>#\s]+/, "").toUpperCase();
}

function isNoAnswerBody(body: string): boolean {
  return normalizeSentinel(body).startsWith(NO_ANSWER_TOKEN);
}

// During streaming, also treat an in-progress prefix of the token (e.g. "NO_")
// as the sentinel, so the raw token never flashes on screen before the run
// finishes. A real answer that merely starts with "No" diverges from the token
// quickly (e.g. "No," vs "NO_ANSWER") and renders normally.
function looksLikeNoAnswer(body: string): boolean {
  const s = normalizeSentinel(body);
  return s.length > 0 && (s.startsWith(NO_ANSWER_TOKEN) || NO_ANSWER_TOKEN.startsWith(s));
}

function PositioningBriefCard({
  brief,
  loading,
  building,
  disabled,
  onBuild,
}: {
  brief: PositioningBrief | null;
  loading: boolean;
  building: boolean;
  disabled: boolean;
  onBuild: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-0.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Compass className="h-4 w-4" /> Positioning brief
            {brief && !building && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                Active
              </span>
            )}
          </CardTitle>
          <CardDescription>
            One-time strategy for this candidate + role. It shapes every answer automatically.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant={brief ? "outline" : "default"}
          onClick={onBuild}
          disabled={disabled || building}
        >
          {building ? <Spinner /> : <Sparkles className="h-4 w-4" />}
          {brief ? "Rebuild" : "Build brief"}
        </Button>
      </CardHeader>
      <CardContent>
        {disabled ? (
          <p className="text-sm text-muted-foreground">
            Pick a candidate and a job profile to build a brief.
          </p>
        ) : building ? (
          <p className="text-sm text-muted-foreground">
            Analyzing resume + JD to build your positioning…
          </p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : brief ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="font-medium">
                {brief.headline || "View positioning"}
              </span>
            </summary>
            <div className="mt-3 space-y-4 border-t border-border pt-3 text-sm">
              {brief.signature_projects.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Signature projects
                  </p>
                  {brief.signature_projects.map((p: BriefProject, i: number) => (
                    <div
                      key={i}
                      className="rounded-md border border-border bg-secondary/20 px-2.5 py-2"
                    >
                      <p className="font-medium">
                        {p.title || "Project"}
                        {p.what ? <span className="font-normal text-muted-foreground"> — {p.what}</span> : null}
                      </p>
                      {p.contributions.length > 0 && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                          {p.contributions.map((c, ci) => (
                            <li key={ci}>{c}</li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                        {p.tech.length > 0 && <span>Tech: {p.tech.join(", ")}</span>}
                        {p.impact.length > 0 && <span>Impact: {p.impact.join("; ")}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <BriefList label="Why you fit" items={brief.why_fit} />
              {brief.prepared_answers.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Prepared answers
                  </p>
                  {brief.prepared_answers.map((qa: BriefQa, i: number) => (
                    <div key={i}>
                      {qa.question && <p className="font-medium">{qa.question}</p>}
                      <p className="text-muted-foreground">{qa.answer}</p>
                    </div>
                  ))}
                </div>
              )}
              {brief.weak_spots.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Weak spots
                  </p>
                  <ul className="space-y-1">
                    {brief.weak_spots.map((w: WeakSpot, i: number) => (
                      <li key={i} className="text-muted-foreground">
                        <span className="font-medium text-foreground">{w.concern}</span>
                        {w.how_to_handle ? ` — ${w.how_to_handle}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">
            No brief yet. Build one so answers stay specific and on-message for this role.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function CaptureHint({
  source,
  engine,
}: {
  source: CaptureChoice;
  engine: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>
        {source === "livecaption" && (
          <>
            Reads <strong>Windows 11 Live Captions</strong> on-device (no API cost, very low
            latency). Enable it once with <strong>Win + Ctrl + L</strong> and set Live Captions
            to caption system audio so it hears the interviewer. Captions are mixed (not split
            by speaker), which is fine for detecting the latest question.
          </>
        )}
        {source === "microphone" && (
          <>
            Captures your <strong>microphone</strong> via <strong>{engine}</strong>. This only
            hears the interviewer if they’re on a loudspeaker — to capture their voice, use
            “Meeting tab audio” or “Mic + meeting audio”.
          </>
        )}
        {source === "display" && (
          <>
            Captures audio from a shared tab/window/screen via <strong>{engine}</strong>. For{" "}
            <strong>Google Meet / Zoom in the browser</strong>, share that tab and tick “Share
            tab audio”. For the <strong>desktop apps</strong>, share your <em>whole screen</em>{" "}
            with system audio, or route audio through a virtual loopback device (BlackHole on
            macOS, VB-Cable on Windows). This captures the interviewer but not your mic.
          </>
        )}
        {source === "both" && (
          <>
            Captures <strong>your mic + the shared meeting audio</strong> mixed together via{" "}
            <strong>{engine}</strong>, so the transcript includes both you and the interviewer.
            When prompted, share the meeting tab (tick “Share tab audio”) or your whole screen
            with system audio. Tip: use headphones to avoid echo.
          </>
        )}
      </p>
    </div>
  );
}

function LiveStatus({
  recording,
  transcribing,
  generating,
  questionReady,
  readyConfidence,
  coding,
}: {
  recording: boolean;
  transcribing: boolean;
  generating: boolean;
  questionReady: boolean;
  readyConfidence: string;
  coding: boolean;
}) {
  let dot = "bg-muted-foreground/50";
  let text = "Idle";
  let tone = "text-muted-foreground";
  let pulse = false;

  if (generating) {
    dot = "bg-primary";
    text = "Writing your answer…";
    tone = "text-foreground";
    pulse = true;
  } else if (coding) {
    dot = "bg-primary";
    text = "Solving the problem…";
    tone = "text-foreground";
    pulse = true;
  } else if (questionReady) {
    dot = "bg-success";
    text = readyConfidence
      ? `Question ready (${readyConfidence}) — ⌘/Ctrl+Enter`
      : "They paused — ⌘/Ctrl+Enter";
    tone = "text-success";
    pulse = true;
  } else if (transcribing) {
    dot = "bg-warning";
    text = "Transcribing…";
    tone = "text-foreground";
    pulse = true;
  } else if (recording) {
    dot = "bg-destructive";
    text = "Listening…";
    tone = "text-foreground";
    pulse = true;
  }

  return (
    <div
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs"
      title={text}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${dot} ${pulse ? "animate-pulse-dot" : ""}`}
      />
      <span className={`truncate ${tone}`}>{text}</span>
    </div>
  );
}

function GeneratingState() {
  return (
    <div className="space-y-2">
      <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-5 w-full animate-pulse rounded bg-muted" />
      <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{children}</p>
    </div>
  );
}

function ShortcutHint() {
  const shortcuts = [
    ["⌘/Ctrl + Enter", "Generate"],
    ["⌘/Ctrl + Shift + S", "Brief"],
    ["⌘/Ctrl + Shift + D", "Deep"],
    ["⌘/Ctrl + Shift + R", "Regenerate"],
    ["Alt + ← / →", "Earlier / later answer"],
    ["⌘/Ctrl + Shift + C", "Answer ⇄ Code"],
    ["⌘/Ctrl + Shift + 2", "Capture screen"],
  ];
  return (
    <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
      <p className="mb-2 flex items-center gap-1.5 font-medium">
        <Keyboard className="h-3.5 w-3.5" /> Shortcuts
      </p>
      <div className="grid grid-cols-2 gap-1">
        {shortcuts.map(([keys, label]) => (
          <div key={keys} className="flex items-center justify-between gap-2">
            <span>{label}</span>
            <kbd className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
