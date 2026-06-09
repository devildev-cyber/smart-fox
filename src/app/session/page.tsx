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
import { Badge } from "@/components/ui/badge";
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
import { apiFetch, streamFetch } from "@/lib/client";
import { parseAnswerStream, answerGist } from "@/lib/answer-stream";
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

import type { AnswerMode, InterviewStage } from "@/lib/schemas";
import { INTERVIEW_STAGE_LABELS, INTERVIEW_STAGE_HINTS } from "@/lib/constants";
import { interviewStageSchema } from "@/lib/schemas";
import type {
  ConfigStatus,
  AnswerResult,
  ProfilesResponse,
  CandidateProfileDto,
  JobProfileDto,
} from "@/lib/session-types";

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

interface FinalChunk {
  text: string;
  at: number;
}

interface PriorTurnState {
  question: string;
  answerGist: string;
}

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
  const [lastMode, setLastMode] = React.useState<AnswerMode>("default");
  const [interviewStage, setInterviewStage] =
    React.useState<InterviewStage>("general");
  const [autoAnswer, setAutoAnswer] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // Readiness signal so you know exactly when to press Generate.
  const [questionReady, setQuestionReady] = React.useState(false);
  const [readyConfidence, setReadyConfidence] = React.useState<string>("medium");

  // Refs to avoid stale closures in async/debounced handlers.
  const finalsRef = React.useRef<FinalChunk[]>([]);
  const interimRef = React.useRef("");
  const detectedRef = React.useRef("");
  const lastAnsweredRef = React.useRef("");
  // End-of-turn (pause) detection for the live answer flow.
  const endOfTurnTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoAnsweredRef = React.useRef("");
  const handleEndOfTurnRef = React.useRef<() => void>(() => {});
  // Streaming + session memory.
  const streamAbort = React.useRef<AbortController | null>(null);
  const priorTurnsRef = React.useRef<PriorTurnState[]>([]);

  React.useEffect(() => {
    finalsRef.current = finals;
  }, [finals]);
  React.useEffect(() => {
    interimRef.current = interim;
  }, [interim]);
  React.useEffect(() => {
    detectedRef.current = detectedQuestion;
  }, [detectedQuestion]);

  // Initialize autoAnswer + lastMode from settings once hydrated.
  React.useEffect(() => {
    if (hydrated) {
      setAutoAnswer(settings.autoAnswer);
      setLastMode(settings.defaultAnswerMode);
      setInterviewStage(settings.defaultInterviewStage);
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

  const windowMs = (settings.transcriptWindowSeconds || 90) * 1000;

  const recentTranscript = React.useCallback(() => {
    const cutoff = Date.now() - windowMs;
    const recentFinals = finalsRef.current
      .filter((f) => f.at >= cutoff)
      .map((f) => f.text);
    return [...recentFinals, interimRef.current].join(" ").trim();
  }, [windowMs]);

  // A tighter slice (last few sentences) sent to the answer model for speed.
  const recentForAnswer = React.useCallback(
    () => lastSentences(recentTranscript(), 6),
    [recentTranscript]
  );

  const selectedJob = jobs.find((j) => j.id === jobId) ?? null;

  /* ------------------------------ Memory ------------------------------ */

  const pushPriorTurn = React.useCallback((question: string, body: string) => {
    const q = question.trim();
    if (!q) return;
    const turn: PriorTurnState = { question: q, answerGist: answerGist(body) };
    priorTurnsRef.current = [
      ...priorTurnsRef.current.filter((t) => t.question !== q),
      turn,
    ].slice(-8);
  }, []);

  /* --------------------------- Generation --------------------------- */

  // Shared streaming driver for both Generate and Rewrite. Seeds an empty
  // answer, streams Markdown deltas into it live, then parses the trailing
  // metadata. Aborts any earlier in-flight stream. Returns the final answer, or
  // null if this run was superseded by a newer one.
  const streamAnswer = React.useCallback(
    async (
      url: string,
      payload: Record<string, unknown>,
      knownQuestion: string
    ): Promise<AnswerResult | null> => {
      streamAbort.current?.abort();
      const controller = new AbortController();
      streamAbort.current = controller;
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
            setAnswer((prev) => (prev ? { ...prev, answer: body } : prev));
          }
        );

        const { body, meta, error } = parseAnswerStream(full);
        if (error) throw new Error(error);

        const finalQuestion = knownQuestion || meta?.detected_question || "";
        const result: AnswerResult = {
          detected_question: finalQuestion,
          answer: body,
          keywords: meta?.keywords ?? [],
          confidence: meta?.confidence ?? "medium",
          risk_note: meta?.risk_note ?? "",
          possible_follow_up: meta?.possible_follow_up ?? "",
        };
        setAnswer(result);
        return result;
      } catch (err) {
        // A superseded stream aborts intentionally — stay silent.
        if (controller.signal.aborted) return null;
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
    async (mode: AnswerMode, questionOverride?: string) => {
      const question = (questionOverride ?? detectedRef.current).trim();
      const transcript = recentForAnswer();
      // One-shot: with no explicit question, the model infers it from the
      // transcript and answers in a single streaming call.
      if (!question && !transcript) {
        toast.error("Nothing to answer yet", {
          description: "Record/paste some transcript, or type a question.",
        });
        return;
      }
      setLastMode(mode);
      try {
        const result = await streamAnswer(
          "/api/generate-answer/stream",
          {
            candidateProfileId: candidateId || undefined,
            jobProfileId: jobId || undefined,
            recentTranscript: transcript,
            detectedQuestion: question,
            questionType,
            answerMode: mode,
            interviewStage,
            maxSentences: settings.maxSentences,
            boldKeywords: settings.boldKeywords,
            priorTurns: priorTurnsRef.current,
          },
          question
        );
        if (!result) return; // superseded by a newer generate
        // NOTE: never write the inferred question back into the override box —
        // doing so makes it "stick" and forces every later answer onto a stale
        // question. The box only ever holds what the user types.
        const answered = result.detected_question.trim() || question;
        lastAnsweredRef.current = answered;
        pushPriorTurn(answered, result.answer);
        // Mark this transcript as handled so end-of-turn auto-answer won't re-fire it.
        autoAnsweredRef.current = recentForAnswer().replace(/\s+/g, " ").trim();
        setQuestionReady(false);
      } catch (err) {
        toast.error("Could not generate answer", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [candidateId, jobId, questionType, interviewStage, recentForAnswer, settings, streamAnswer, pushPriorTurn]
  );

  const rewrite = React.useCallback(
    async (mode: AnswerMode) => {
      // If there's no answer yet, generating in that mode is the right behavior.
      if (!answer || !answer.answer.trim()) {
        await generate(mode);
        return;
      }
      setLastMode(mode);
      const baseQuestion = detectedRef.current.trim() || answer.detected_question;
      try {
        await streamAnswer(
          "/api/rewrite-answer/stream",
          {
            detectedQuestion: baseQuestion || answer.answer.slice(0, 80),
            answer: answer.answer,
            answerMode: mode,
            interviewStage,
            candidateProfileId: candidateId || undefined,
            jobProfileId: jobId || undefined,
            maxSentences: settings.maxSentences,
            boldKeywords: settings.boldKeywords,
          },
          baseQuestion
        );
      } catch (err) {
        toast.error("Could not rewrite answer", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [answer, generate, candidateId, jobId, interviewStage, settings, streamAnswer]
  );

  /* --------------------------- Live transcript --------------------------- */

  const handleTranscript = React.useCallback((text: string, isFinal: boolean) => {
    if (isFinal) {
      if (!text.trim()) return;
      setFinals((prev) => {
        const next = [...prev, { text, at: Date.now() }];
        return next.length > MAX_FINALS ? next.slice(-MAX_FINALS) : next;
      });
      setInterim("");
    } else {
      setInterim(text);
    }
  }, []);

  // Keep the transcript scrolled to the newest line.
  const transcriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finals, interim]);

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
    endOfTurnTimer.current = setTimeout(
      () => handleEndOfTurnRef.current(),
      endOfTurnMs
    );
    return () => {
      if (endOfTurnTimer.current) clearTimeout(endOfTurnTimer.current);
    };
  }, [finals, interim, isRecording, endOfTurnMs]);

  const addManualCaption = () => {
    const text = manualCaption.trim();
    if (!text) return;
    setFinals((prev) => [...prev, { text, at: Date.now() }]);
    setManualCaption("");
  };

  const clearTranscript = () => {
    setFinals([]);
    setInterim("");
    finalsRef.current = [];
    interimRef.current = "";
    autoAnsweredRef.current = "";
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
          interviewStage,
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
  }, [answer, ensureSession, recentTranscript, questionType, lastMode, interviewStage]);

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

  // Runs when the interviewer pauses (end of turn). In auto mode it generates a
  // one-shot answer (the model infers the question itself); otherwise it just
  // signals that now is a good time to press Generate — no LLM call, no waiting.
  handleEndOfTurnRef.current = () => {
    if (generatingRef.current) return;
    const transcript = recentForAnswer();
    if (!transcript) return;
    if (autoAnswerRef.current) {
      const norm = transcript.replace(/\s+/g, " ").trim();
      if (norm === autoAnsweredRef.current) return;
      autoAnsweredRef.current = norm;
      void generateRef.current(lastModeRef.current);
    } else {
      setReadyConfidence("");
      setQuestionReady(true);
    }
  };

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (!e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        void generateRef.current(settings.defaultAnswerMode);
        return;
      }
      if (e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === "s") {
          e.preventDefault();
          void rewriteRef.current("shorter");
        } else if (key === "t") {
          e.preventDefault();
          void rewriteRef.current("technical");
        } else if (key === "h") {
          e.preventDefault();
          void rewriteRef.current("human");
        } else if (key === "r") {
          e.preventDefault();
          void generateRef.current(lastModeRef.current);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settings.defaultAnswerMode]);

  // Global hotkey from the Electron overlay (works even when the call is focused).
  React.useEffect(() => {
    const api = getElectronAPI();
    if (!api) return;
    return api.onGenerate(() => {
      void generateRef.current(settings.defaultAnswerMode);
    });
  }, [settings.defaultAnswerMode]);

  const openaiMissing = config && !config.openaiConfigured;

  return (
    <div className="space-y-5">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live session</h1>
          <p className="text-sm text-muted-foreground">
            Capture the interviewer and stream a spoken answer in real time.
          </p>
        </div>
        <SessionStatus sessionId={sessionId} recording={isRecording} />
      </div>

      {openaiMissing && (
        <Banner>
          OpenAI API key is not configured. Add <code>OPENAI_API_KEY</code> to your{" "}
          <code>.env</code> to enable live answers.
        </Banner>
      )}

      {/* Context selectors */}
      <Card>
        <CardContent className="grid gap-4 p-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Candidate profile</Label>
            <Select value={candidateId} onValueChange={setCandidateId}>
              <SelectTrigger>
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
              <SelectTrigger>
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
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left panel */}
        <div className="space-y-5">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-base">
                Live transcript
                {isRecording && (
                  <span className="flex items-center gap-1 text-xs font-normal text-destructive">
                    <span className="h-2 w-2 animate-pulse-dot rounded-full bg-destructive" />
                    recording
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                {(config?.transcriptionAvailable || liveCaptionsAvailable) && (
                  <>
                    <Select
                      value={captureSource}
                      onValueChange={(v) => setCaptureSource(v as CaptureChoice)}
                      disabled={isRecording || isStarting}
                    >
                      <SelectTrigger className="h-8 w-[170px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {liveCaptionsAvailable && (
                          <SelectItem value="livecaption">
                            Windows Live Captions
                          </SelectItem>
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
                    {isRecording ? (
                      <Button size="sm" variant="destructive" onClick={stopRecording}>
                        <Square className="h-4 w-4" /> Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={startRecording}
                        disabled={isStarting}
                      >
                        {isStarting ? (
                          <Spinner />
                        ) : captureSource === "display" ? (
                          <MonitorSpeaker className="h-4 w-4" />
                        ) : (
                          <Mic className="h-4 w-4" />
                        )}
                        Record
                      </Button>
                    )}
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={clearTranscript}>
                  <Eraser className="h-4 w-4" /> Clear
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!config?.transcriptionAvailable && !liveCaptionsAvailable ? (
                <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  Live audio is off (no OpenAI or Deepgram key). Use the caption box below
                  to paste what the interviewer says.
                </p>
              ) : (
                <CaptureHint
                  source={captureSource}
                  engine={
                    isLiveCaptions
                      ? "Live Captions"
                      : useDeepgramEngine
                        ? "Deepgram"
                        : "OpenAI"
                  }
                />
              )}
              <div
                ref={transcriptScrollRef}
                className="h-44 overflow-y-auto rounded-md border border-border bg-background/50 p-3 text-sm leading-relaxed scrollbar-thin"
              >
                {finals.length === 0 && !interim ? (
                  <span className="text-muted-foreground">
                    Transcript will appear here…
                  </span>
                ) : (
                  <>
                    {finals.map((f, i) => (
                      <span key={i}>{f.text} </span>
                    ))}
                    {interim && <span className="text-muted-foreground">{interim}</span>}
                  </>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-caption">Manual caption paste</Label>
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
                  placeholder="Paste interviewer captions, then Add (or ⌘/Ctrl+Enter)…"
                  className="min-h-[60px]"
                />
                <Button size="sm" variant="outline" onClick={addManualCaption}>
                  Add to transcript
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="text-base">Ask a specific question (optional)</CardTitle>
              <CardDescription>
                Leave blank to let Generate answer whatever the interviewer just
                asked. Type here to answer one exact question instead.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={detectedQuestion}
                onChange={(e) => setDetectedQuestion(e.target.value)}
                placeholder="e.g. Walk me through a system you designed for scale…"
                className="min-h-[70px] text-base"
              />
            </CardContent>
          </Card>
        </div>

        {/* Right panel */}
        <div className="space-y-5">
          <LiveStatus
            recording={isRecording}
            transcribing={openaiStt.processing}
            generating={generating}
            questionReady={questionReady}
            readyConfidence={readyConfidence}
          />

          <Card
            className={
              questionReady && !generating
                ? "border-success/60 shadow-[0_0_0_1px_hsl(var(--success))]"
                : "border-primary/30"
            }
          >
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Your answer</CardTitle>
              {answer && <ConfidenceBadge confidence={answer.confidence} />}
            </CardHeader>
            <CardContent className="space-y-4">
              {answer?.detected_question && (
                <p className="text-xs text-muted-foreground">
                  Answering:{" "}
                  <span className="text-foreground">{answer.detected_question}</span>
                </p>
              )}
              <div
                className={`min-h-[120px] rounded-md bg-secondary/40 p-3 leading-relaxed ${
                  ANSWER_FONT_SIZE_CLASS[settings.answerFontSize] ?? "text-base"
                }`}
              >
                {answer && answer.answer ? (
                  <RichAnswer text={answer.answer} />
                ) : generating ? (
                  <GeneratingState />
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Generate an answer with ⌘/Ctrl + Enter, or the buttons below.
                  </span>
                )}
              </div>

              {answer && (
                <div className="space-y-3 text-sm">
                  {answer.keywords.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Keywords to say
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {answer.keywords.map((k, i) => (
                          <Badge key={i} variant="secondary" className="font-normal">
                            {k}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {answer.risk_note && (
                    <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{answer.risk_note}</span>
                    </div>
                  )}
                  {answer.possible_follow_up && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Possible follow-up
                      </p>
                      <p className="text-muted-foreground">{answer.possible_follow_up}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-sm">Controls</CardTitle>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                Auto-answer
                <Switch checked={autoAnswer} onCheckedChange={setAutoAnswer} />
              </label>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Interview stage</Label>
                <Select
                  value={interviewStage}
                  onValueChange={(v) => setInterviewStage(v as InterviewStage)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {interviewStageSchema.options.map((s) => (
                      <SelectItem key={s} value={s}>
                        {INTERVIEW_STAGE_LABELS[s]} — {INTERVIEW_STAGE_HINTS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void generate(settings.defaultAnswerMode)}
                  disabled={generating}
                  className={questionReady && !generating ? "animate-pulse-dot" : ""}
                >
                  <Sparkles className="h-4 w-4" /> Generate
                </Button>
                <Button variant="outline" onClick={() => void rewrite("shorter")} disabled={generating}>
                  Shorter
                </Button>
                <Button variant="outline" onClick={() => void rewrite("more_senior")} disabled={generating}>
                  More senior
                </Button>
                <Button variant="outline" onClick={() => void rewrite("star")} disabled={generating}>
                  STAR
                </Button>
                <Button variant="outline" onClick={() => void rewrite("technical")} disabled={generating}>
                  Technical
                </Button>
                <Button variant="outline" onClick={() => void rewrite("human")} disabled={generating}>
                  Human
                </Button>
                <Button variant="outline" onClick={() => void rewrite("safer")} disabled={generating}>
                  Safer
                </Button>
                <Button variant="outline" onClick={() => void generate("follow_up")} disabled={generating}>
                  Predict follow-up
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => void generate(lastMode)}
                  disabled={generating}
                >
                  <RefreshCw className="h-4 w-4" /> Regenerate
                </Button>
                <Button variant="secondary" onClick={() => void saveTurn()} disabled={saving || !answer}>
                  {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save turn
                </Button>
              </div>
            </CardContent>
          </Card>

          <ShortcutHint />
        </div>
      </div>
    </div>
  );
}

function SessionStatus({
  sessionId,
  recording,
}: {
  sessionId: string | null;
  recording: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          recording ? "animate-pulse-dot bg-destructive" : sessionId ? "bg-success" : "bg-muted-foreground/50"
        }`}
      />
      <span className="text-muted-foreground">
        {recording ? "Recording" : sessionId ? "Session active" : "Not started"}
      </span>
    </div>
  );
}

/** Return the last `n` sentences from a transcript, for a tighter prompt. */
function lastSentences(text: string, n: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const sentences = trimmed.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
  if (!sentences || sentences.length <= n) return trimmed;
  return sentences.slice(-n).join(" ").trim();
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
}: {
  recording: boolean;
  transcribing: boolean;
  generating: boolean;
  questionReady: boolean;
  readyConfidence: string;
}) {
  let dot = "bg-muted-foreground/50";
  let text = "Idle — record audio or paste a caption";
  let tone = "text-muted-foreground";
  let pulse = false;

  if (generating) {
    dot = "bg-primary";
    text = "Generating answer…";
    tone = "text-foreground";
    pulse = true;
  } else if (questionReady) {
    dot = "bg-success";
    text = readyConfidence
      ? `Question ready (${readyConfidence}) — press ⌘/Ctrl + Enter`
      : "They paused — press ⌘/Ctrl + Enter to answer";
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
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <span
        className={`h-2.5 w-2.5 rounded-full ${dot} ${pulse ? "animate-pulse-dot" : ""}`}
      />
      <span className={tone}>{text}</span>
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
    ["⌘/Ctrl + Shift + S", "Shorter"],
    ["⌘/Ctrl + Shift + T", "Technical"],
    ["⌘/Ctrl + Shift + H", "Human"],
    ["⌘/Ctrl + Shift + R", "Regenerate"],
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
