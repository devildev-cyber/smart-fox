"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  ListOrdered,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichAnswer } from "@/components/rich-answer";
import { getElectronAPI } from "@/lib/electron";
import { CODING_LANGUAGE_LABELS } from "@/lib/prompts";
import {
  CODING_MODE_LABELS,
  VERBAL_MODES,
  fullCode,
  hasCodingContent,
  type CodingMode,
  type CodingStep,
} from "@/lib/coding";
import type { CodingModeChoice, useCoding } from "@/hooks/use-coding";
import { cn } from "@/lib/utils";

type CodingState = ReturnType<typeof useCoding>;

const MODE_CHIPS: Array<{ value: CodingModeChoice; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "new", label: "Solve" },
  { value: "fix", label: "Fix" },
  { value: "optimize", label: "Optimize" },
  { value: "explain", label: "Explain" },
  { value: "test", label: "Dry run" },
  { value: "answer", label: "Verbal" },
];

// One-tap follow-ups after a solution. `ask` is what the model is told; `mode`
// forces the shape of the reply.
const FOLLOW_UPS: Array<{ label: string; mode: CodingModeChoice; ask: string }> = [
  {
    label: "Optimize",
    mode: "optimize",
    ask: "Can we do better? Optimize it and say why the new version is faster.",
  },
  {
    label: "Complexity",
    mode: "explain",
    ask: "Explain the time and space complexity of the current solution.",
  },
  {
    label: "Dry run",
    mode: "test",
    ask: "Walk through the examples and one edge case with the current code.",
  },
  {
    label: "Edge cases",
    mode: "explain",
    ask: "What edge cases should I handle or mention, and does the code handle them?",
  },
];

function modeBadgeVariant(mode: CodingMode | null) {
  if (mode === "fix") return "warning" as const;
  if (mode === "answer" || mode === "explain") return "secondary" as const;
  return "default" as const;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * The coding copilot, embedded in the live session. Built for a narrow always-on
 * window: one column, the thing to SAY first, then the code one step at a time
 * as a cue card (what to say while typing it + the chunk to type), with
 * one-tap follow-ups underneath.
 */
export function CodingView({
  c,
  active,
}: {
  c: CodingState;
  /** Whether this view is the one on screen (gates the arrow-key step shortcuts). */
  active: boolean;
}) {
  const {
    canNativeCapture,
    sources,
    sourceId,
    setSourceId,
    refreshSources,
    images,
    addImage,
    removeImage,
    pastedText,
    setPastedText,
    ask,
    setAsk,
    language,
    setLanguage,
    mode,
    setMode,
    capture,
    captureViaDisplayMedia,
    captureAndSolve,
    solving,
    error,
    solve,
    stop,
    newProblem,
    viewingHistory,
    displayedSolution: sol,
    selectTurn,
  } = c;

  const [showPaste, setShowPaste] = React.useState(false);
  const [followUp, setFollowUp] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (canNativeCapture) void refreshSources();
  }, [canNativeCapture, refreshSources]);

  const guard = React.useCallback(
    async (fn: () => Promise<unknown>, what: string) => {
      try {
        await fn();
      } catch (err) {
        toast.error(`${what} failed`, {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    []
  );

  const handleCapture = () =>
    void guard(
      async () => (canNativeCapture ? await capture() : await captureViaDisplayMedia()),
      "Capture"
    );
  const handleCaptureAndSolve = () => void guard(() => captureAndSolve(), "Capture");

  const handlePaste = React.useCallback(
    async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((i) => i.type.startsWith("image/"));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          try {
            await addImage(await fileToDataUrl(file));
          } catch {
            toast.error("Could not read the pasted image.");
          }
        }
        e.preventDefault();
      }
    },
    [addImage]
  );

  const handleFiles = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (file.type.startsWith("image/")) await addImage(await fileToDataUrl(file));
    }
  };

  const canSolve = images.length > 0 || pastedText.trim().length > 0 || ask.trim().length > 0;
  const showResult = Boolean(sol && hasCodingContent(sol));

  return (
    <div className="space-y-3" onPaste={handlePaste}>
      {/* ---------- Input: capture + steer ---------- */}
      <div className="space-y-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          {solving ? (
            <Button size="sm" variant="destructive" className="flex-1" onClick={stop}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : (
            <>
              <Button size="sm" className="flex-1" onClick={handleCaptureAndSolve}>
                <Camera className="h-4 w-4" /> Capture &amp; solve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void solve()}
                disabled={!canSolve}
                title="Solve with what's already captured (Ctrl/Cmd+Enter)"
              >
                <Sparkles className="h-4 w-4" /> Solve
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={handleCapture}
            disabled={solving}
            title="Add a capture without solving (for a problem that scrolls)"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={newProblem}
            title="Start a new problem"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {images.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-thin">
            {images.map((img, i) => (
              <div key={img.id} className="relative shrink-0 overflow-hidden rounded border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.dataUrl}
                  alt={`Capture ${i + 1}`}
                  className="h-11 w-16 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute right-0 top-0 rounded-bl bg-background/85 p-0.5"
                  aria-label={`Remove capture ${i + 1}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Mode chips */}
        <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-thin" role="group" aria-label="Mode">
          {MODE_CHIPS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setMode(o.value)}
              aria-pressed={mode === o.value}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                mode === o.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>

        <Input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !solving && canSolve) {
              e.preventDefault();
              void solve();
            }
          }}
          placeholder="What they asked (auto-filled from the call)"
          className="h-8 text-xs"
          aria-label="What the interviewer asked"
        />

        <div className="flex items-center gap-1.5">
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="h-7 w-[104px] text-xs" aria-label="Language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CODING_LANGUAGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canNativeCapture && sources.length > 1 && (
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs" aria-label="Screen to capture">
                <SelectValue placeholder="Screen" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.id.startsWith("screen") ? "Screen · " : "Window · "}
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs text-muted-foreground"
            onClick={() => fileInputRef.current?.click()}
          >
            Image
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setShowPaste((v) => !v)}
            aria-expanded={showPaste}
          >
            <Clipboard className="h-3.5 w-3.5" /> Text
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>
        {showPaste && (
          <Textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            placeholder="Paste the problem statement or your code here…"
            className="min-h-[72px] text-xs"
          />
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          {canNativeCapture
            ? "Ctrl/Cmd+Shift+2 captures. The window stays hidden from the capture."
            : "Paste a screenshot (Ctrl/Cmd+V), add an image, or capture a screen."}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {viewingHistory && (
        <button
          type="button"
          onClick={() => selectTurn(null)}
          className="flex w-full items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Viewing an earlier coding answer — back to latest
        </button>
      )}

      {/* ---------- Output ---------- */}
      {!showResult && !solving && !error && (
        <p className="px-2 py-4 text-center text-sm text-muted-foreground">
          Hit <strong>Capture &amp; solve</strong> when the interviewer shares a problem. You get
          what to say first, then the code one step at a time.
        </p>
      )}

      {(showResult || solving) && (
        <Result
          c={c}
          active={active}
          followUp={followUp}
          setFollowUp={setFollowUp}
        />
      )}
    </div>
  );
}

function Result({
  c,
  active,
  followUp,
  setFollowUp,
}: {
  c: CodingState;
  active: boolean;
  followUp: string;
  setFollowUp: (v: string) => void;
}) {
  const { displayedSolution: sol, solving, solve, activeTurnId, viewingHistory } = c;

  const steps: CodingStep[] = sol?.steps ?? [];
  const [stepIdx, setStepIdx] = React.useState(0);
  const [showAll, setShowAll] = React.useState(false);
  const [copiedAll, setCopiedAll] = React.useState(false);

  // Start at step 1 for a new solve or when flipping to another answer.
  const wasSolving = React.useRef(false);
  React.useEffect(() => {
    if (solving && !wasSolving.current) setStepIdx(0);
    wasSolving.current = solving;
  }, [solving]);
  React.useEffect(() => setStepIdx(0), [activeTurnId]);

  const idx = steps.length ? Math.min(stepIdx, steps.length - 1) : 0;
  const goStep = React.useCallback(
    (delta: number) =>
      setStepIdx((cur) => Math.max(0, Math.min(steps.length - 1, cur + delta))),
    [steps.length]
  );

  // Plain ←/→ steps through the cue cards (only when you're not typing).
  React.useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isEditable(e.target)) return;
      if (e.key === "ArrowRight") goStep(1);
      else if (e.key === "ArrowLeft") goStep(-1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, goStep]);

  const copyAll = async () => {
    if (!sol) return;
    if (await copyText(fullCode(sol))) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1400);
    } else {
      toast.error("Couldn't copy to clipboard.");
    }
  };

  const verbal = sol?.mode ? VERBAL_MODES.includes(sol.mode) : false;
  const isFix = sol?.mode === "fix";
  const waitingForCode = solving && !verbal && steps.length === 0 && Boolean(sol?.say);

  const sendFollowUp = (text: string, forcedMode: CodingModeChoice = "auto") => {
    const t = text.trim();
    if (!t || solving) return;
    void solve({ mode: forcedMode, ask: t, followUp: true });
    setFollowUp("");
  };

  return (
    <div className="space-y-3">
      {/* What was read: a misread screenshot should be obvious at a glance */}
      {sol?.problem && (
        <p
          className="line-clamp-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground"
          title={sol.problem}
        >
          <span className="font-semibold uppercase tracking-wide">Read as </span>
          <span className="text-foreground">{sol.problem}</span>
        </p>
      )}

      {/* SAY FIRST */}
      {(solving || sol?.say) && (
        <section className="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Say first
            </h3>
            {sol?.mode && (
              <Badge variant={modeBadgeVariant(sol.mode)} className="px-2 py-0 text-[10px]">
                {CODING_MODE_LABELS[sol.mode]}
              </Badge>
            )}
          </div>
          {sol?.say ? (
            <div className="text-[15px] leading-relaxed">
              <RichAnswer text={sol.say} />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" /> Reading the problem…
            </div>
          )}
        </section>
      )}

      {/* STEPS as cue cards */}
      {steps.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {isFix ? "Edit" : "Step"} {idx + 1} of {steps.length}
              {solving ? "+" : ""}
              {sol?.language ? ` · ${sol.language}` : ""}
            </h3>
            <div className="ml-auto flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowAll((v) => !v)}
                title={showAll ? "One step at a time" : "Show every step"}
                aria-pressed={showAll}
              >
                <ListOrdered className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={copyAll}
                title="Copy all code"
              >
                {copiedAll ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {showAll ? (
            <ol className="space-y-2">
              {steps.map((step, i) => (
                <li key={i} className="list-none">
                  <StepCard index={i + 1} step={step} />
                </li>
              ))}
            </ol>
          ) : (
            <>
              <StepCard index={idx + 1} step={steps[idx]} large />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => goStep(-1)}
                  disabled={idx === 0}
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => goStep(1)}
                  disabled={idx >= steps.length - 1}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {waitingForCode && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Writing the code — start with the line above.
        </div>
      )}

      {/* Verbal answers (explain / dry run / answer) and edge cases */}
      {sol?.points && (
        <section className="space-y-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {steps.length ? "Watch for" : "Say"}
          </h3>
          <div className="text-sm leading-relaxed text-muted-foreground">
            <RichAnswer text={sol.points} />
          </div>
        </section>
      )}

      {sol?.complexity && (
        <p className="rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs">{sol.complexity}</p>
      )}

      {sol?.note && (
        <div className="flex items-start gap-2 rounded-md border-l-2 border-primary/50 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{sol.note}</span>
        </div>
      )}

      {/* Follow-ups: the interviewer's next move is usually one of these */}
      {!solving && sol && hasCodingContent(sol) && !viewingHistory && (
        <section className="space-y-2 border-t pt-3">
          <div className="flex gap-1 overflow-x-auto pb-0.5 scrollbar-thin">
            {FOLLOW_UPS.map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => sendFollowUp(f.ask, f.mode)}
                className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Input
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendFollowUp(followUp);
                }
              }}
              placeholder="Follow-up, e.g. “what if the input is huge?”"
              className="h-8 text-xs"
              aria-label="Follow-up question"
            />
            <Button
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => sendFollowUp(followUp)}
              disabled={!followUp.trim()}
              aria-label="Send follow-up"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function StepCard({
  index,
  step,
  large = false,
}: {
  index: number;
  step: CodingStep;
  large?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (await copyText(step.code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border">
      {/* What to SAY while typing this chunk */}
      {step.narrate && (
        <div className="flex items-start gap-2 bg-primary/5 px-3 py-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
            {index}
          </span>
          <div
            className={cn(
              "flex items-start gap-1.5 leading-relaxed text-foreground",
              large ? "text-[15px]" : "text-sm"
            )}
          >
            <Volume2 className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{step.narrate}</span>
          </div>
        </div>
      )}
      {/* What to TYPE */}
      {step.code && (
        <div className="relative">
          <pre className="max-h-64 overflow-auto bg-muted px-3 py-2 text-[12.5px] leading-relaxed scrollbar-thin">
            <code className="whitespace-pre font-mono">{step.code}</code>
          </pre>
          <button
            type="button"
            onClick={copy}
            className="absolute right-1.5 top-1.5 rounded bg-background/80 p-1"
            aria-label="Copy this step"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Exposed so the shell can hook the Electron capture shortcut once. */
export function useCodingCaptureHotkey(onCapture: () => void) {
  const ref = React.useRef(onCapture);
  ref.current = onCapture;
  React.useEffect(() => {
    const api = getElectronAPI();
    if (!api?.coding) return;
    return api.coding.onCapture(() => ref.current());
  }, []);
}
