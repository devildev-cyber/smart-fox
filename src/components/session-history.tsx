"use client";

import { ChevronLeft, ChevronRight, Code2, History, MessageSquareText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FeedItem {
  id: string;
  kind: "answer" | "code";
  title: string;
  at: number;
  /** Small tag shown next to the title (e.g. the coding mode). */
  tag?: string;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * ◀ position ▶ stepper for flipping through earlier answers, plus a button that
 * opens the full list. Used on both the Answer and Code views so earlier answers
 * are always one tap (or Alt+←/→) away.
 */
export function PrevNav({
  label,
  canOlder,
  canNewer,
  onOlder,
  onNewer,
  onOpenHistory,
  historyCount,
  className,
}: {
  label: string;
  canOlder: boolean;
  canNewer: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onOpenHistory: () => void;
  historyCount: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onOlder}
        disabled={!canOlder}
        title="Earlier answer (Alt+←)"
        aria-label="Earlier answer"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="min-w-[3.25rem] text-center text-[11px] tabular-nums text-muted-foreground">
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onNewer}
        disabled={!canNewer}
        title="Later answer (Alt+→)"
        aria-label="Later answer"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-[11px] text-muted-foreground"
        onClick={onOpenHistory}
        title="All earlier answers"
        aria-label="All earlier answers"
      >
        <History className="h-3.5 w-3.5" />
        {historyCount > 0 ? historyCount : null}
      </Button>
    </div>
  );
}

/** One list of everything answered this session (spoken answers + coding), newest first. */
export function HistoryPanel({
  items,
  activeId,
  onOpen,
  onClose,
  onClearAnswers,
}: {
  items: FeedItem[];
  activeId: string | null;
  onOpen: (item: FeedItem) => void;
  onClose: () => void;
  onClearAnswers: () => void;
}) {
  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      aria-label="Earlier answers this session"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Earlier this session</h2>
        <div className="ml-auto flex items-center gap-1">
          {items.some((i) => i.kind === "answer") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={onClearAnswers}
            >
              Clear answers
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="Close list"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-3 text-center text-sm text-muted-foreground">
          Nothing yet. Answers and coding solutions show up here as you go.
        </p>
      ) : (
        <ul className="max-h-[22rem] space-y-1 overflow-y-auto scrollbar-thin">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                  activeId === item.id ? "border-primary/50 bg-primary/5" : "border-transparent"
                )}
              >
                {item.kind === "code" ? (
                  <Code2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 leading-snug">{item.title}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {timeLabel(item.at)}
                    {item.tag ? ` · ${item.tag}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
