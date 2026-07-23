"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  X,
  Camera,
  MonitorUp,
  Sparkles,
  Square,
  Trash2,
  Plus,
  Copy,
  Check,
  RefreshCw,
  Clipboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { CODING_MODE_LABELS, hasCodingContent, type CodingMode } from "@/lib/coding";
import { useCoding, type CodingModeChoice } from "@/hooks/use-coding";

const MODE_OPTIONS: Array<{ value: CodingModeChoice; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "new", label: "Solve" },
  { value: "fix", label: "Fix bug" },
  { value: "optimize", label: "Optimize" },
  { value: "explain", label: "Explain" },
  { value: "test", label: "Dry run" },
  { value: "answer", label: "Verbal" },
];

function modeBadgeVariant(mode: CodingMode | null) {
  if (mode === "fix") return "warning" as const;
  if (mode === "answer" || mode === "explain") return "secondary" as const;
  return "default" as const;
}

/** Read image files from a clipboard/drop into data URLs. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

export function CodingPanel({
  onClose,
  candidateId,
  getTranscript,
}: {
  onClose: () => void;
  candidateId?: string;
  getTranscript?: () => string;
}) {
  const c = useCoding({ candidateId, getTranscript });
  const {
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
  } = c;

  const [showPaste, setShowPaste] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Load capture sources once when the native picker is available.
  React.useEffect(() => {
    if (canNativeCapture) void refreshSources();
  }, [canNativeCapture, refreshSources]);

  // Global "capture" hotkey from the Electron shell.
  React.useEffect(() => {
    const api = getElectronAPI();
    if (!api?.coding) return;
    return api.coding.onCapture(() => void capture());
  }, [capture]);

  // Local shortcuts: Esc to close, Cmd/Ctrl+Enter to solve.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void solve();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, solve]);

  const handleCapture = React.useCallback(async () => {
    try {
      if (canNativeCapture) await capture();
      else await captureViaDisplayMedia();
    } catch (err) {
      toast.error("Capture failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [canNativeCapture, capture, captureViaDisplayMedia]);

  // Paste an image (screenshot) or text problem straight into the panel.
  const handlePaste = React.useCallback(
    async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((i) => i.type.startsWith("image/"));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          try {
            addImage(await fileToDataUrl(file));
          } catch {
            toast.error("Could not read the pasted image.");
          }
        }
        return;
      }
      const text = e.clipboardData?.getData("text");
      if (text && !showPaste) {
        setShowPaste(true);
        setPastedText((prev) => (prev ? `${prev}\n${text}` : text));
      }
    },
    [addImage, setPastedText, showPaste]
  );

  const handleFiles = React.useCallback(
    async (files: FileList | null) => {
      for (const file of Array.from(files ?? [])) {
        if (file.type.startsWith("image/")) addImage(await fileToDataUrl(file));
      }
    },
    [addImage]
  );

  const copyCode = React.useCallback(async () => {
    if (!solution?.code) return;
    try {
      await navigator.clipboard.writeText(solution.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  }, [solution?.code]);

  const showResult = solution && hasCodingContent(solution);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/97 backdrop-blur-sm"
      onPaste={handlePaste}
    >
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <MonitorUp className="h-4 w-4 text-primary" />
          Coding copilot
        </span>

        {canNativeCapture && (
          <Select value={sourceId} onValueChange={setSourceId} disabled={loadingSources}>
            <SelectTrigger className="h-8 w-[190px]">
              <SelectValue placeholder={loadingSources ? "Loading…" : "Pick screen"} />
            </SelectTrigger>
            <SelectContent>
              {sources.length === 0 && (
                <SelectItem value="none" disabled>
                  No sources found
                </SelectItem>
              )}
              {sources.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.id.startsWith("screen") ? "🖥 " : "🪟 "}
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onClose} title="Close (Esc)">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body: left context strip + main answer */}
      <div className="flex min-h-0 flex-1">
        {/* Left: captures + controls */}
        <div className="flex w-[230px] shrink-0 flex-col gap-3 overflow-y-auto border-r p-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={handleCapture} className="flex-1">
              <Camera className="h-4 w-4" /> Capture
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              title="Add an image file"
            >
              <Plus className="h-4 w-4" />
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

          <p className="text-[11px] leading-tight text-muted-foreground">
            {canNativeCapture
              ? "Capture the shared screen (⌘/Ctrl+Shift+2). Add several for scrolled or multiple problems. The copilot stays hidden from the capture."
              : "Paste a screenshot (⌘/Ctrl+V), add an image, or capture the screen."}
          </p>

          {/* Captured thumbnails */}
          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {images.map((img, i) => (
                <div key={img.id} className="group relative overflow-hidden rounded border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.dataUrl} alt={`Capture ${i + 1}`} className="h-16 w-full object-cover" />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute right-0.5 top-0.5 rounded bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Remove"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Language</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="h-8">
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
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Mode</label>
            <Select value={mode} onValueChange={(v) => setMode(v as CodingModeChoice)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="justify-start px-2 text-muted-foreground"
            onClick={() => setShowPaste((v) => !v)}
          >
            <Clipboard className="h-4 w-4" /> Paste problem text
          </Button>
          {showPaste && (
            <Textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder="Paste the problem statement or your code here…"
              className="min-h-[90px] text-xs"
            />
          )}
        </div>

        {/* Main: the answer, in fixed zones */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex-1 space-y-4 p-4">
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {!showResult && !solving && !error && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <MonitorUp className="h-8 w-8 opacity-40" />
                <p className="max-w-xs">
                  Capture or paste the coding problem, then press{" "}
                  <kbd className="rounded border px-1 text-xs">⌘/Ctrl+Enter</kbd> to get a
                  solution you can read and type.
                </p>
              </div>
            )}

            {/* SAY */}
            {(solving || solution?.say) && (
              <Zone
                label="Say"
                badge={
                  solution?.mode ? (
                    <Badge variant={modeBadgeVariant(solution.mode)}>
                      {CODING_MODE_LABELS[solution.mode]}
                    </Badge>
                  ) : null
                }
              >
                {solution?.say ? (
                  <div className="text-[15px] leading-relaxed text-foreground">
                    <RichAnswer text={solution.say} />
                  </div>
                ) : (
                  <ThinkingLine />
                )}
              </Zone>
            )}

            {/* CODE */}
            {solution?.code ? (
              <Zone
                label={`Code${solution.language ? ` · ${solution.language}` : ""}`}
                action={
                  <Button variant="ghost" size="sm" onClick={copyCode} className="h-7 px-2">
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" /> Copy
                      </>
                    )}
                  </Button>
                }
              >
                <pre className="max-h-[45vh] overflow-auto rounded-md bg-muted p-3 text-[13px] leading-relaxed">
                  <code className="whitespace-pre font-mono">{solution.code}</code>
                </pre>
              </Zone>
            ) : null}

            {/* COMPLEXITY */}
            {solution?.complexity ? (
              <Zone label="Complexity">
                <p className="font-mono text-sm text-foreground">{solution.complexity}</p>
              </Zone>
            ) : null}

            {/* PLAN / WALKTHROUGH */}
            {solution?.plan ? (
              <Zone label={solution.mode === "fix" ? "The fix" : "Walkthrough"}>
                <div className="text-sm text-muted-foreground">
                  <RichAnswer text={solution.plan} />
                </div>
              </Zone>
            ) : null}

            {/* NOTE */}
            {solution?.note ? (
              <div className="rounded-md border-l-2 border-primary/50 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {solution.note}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {images.length > 0
            ? `${images.length} capture${images.length > 1 ? "s" : ""}`
            : "No captures yet"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={newProblem} title="Start a new problem">
            <RefreshCw className="h-4 w-4" /> New
          </Button>
          {solving ? (
            <Button variant="destructive" size="sm" onClick={stop}>
              <Square className="h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={() => void solve()}>
              <Sparkles className="h-4 w-4" /> Solve
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Zone({
  label,
  badge,
  action,
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        {badge}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ThinkingLine() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="h-4 w-4" /> Reading the problem…
    </div>
  );
}
