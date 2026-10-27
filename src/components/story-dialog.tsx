"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Sparkles, Wand2 } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { STORY_CATEGORY_LABELS } from "@/lib/constants";
import { toCategorySlug } from "@/lib/schemas";
import type { StoryDto } from "@/lib/types";

interface StoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  story: StoryDto | null;
  onSaved: (story: StoryDto) => void;
}

const emptyForm = {
  title: "",
  category: "tell_me_about_yourself",
  shortVersion: "",
  starVersion: "",
  technicalVersion: "",
  keywords: "",
  evidence: "",
};

// Evidence is one entry per line (not comma-separated) so a detail the candidate
// told us — which may itself contain commas — is never split or loses its
// "told by you:" marker.
function splitEvidence(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface SharpenQuestion {
  id: string;
  question: string;
}

export function StoryDialog({ open, onOpenChange, story, onSaved }: StoryDialogProps) {
  const [form, setForm] = React.useState(emptyForm);
  const [saving, setSaving] = React.useState(false);
  // "Sharpen": interview the candidate for the real details behind this story.
  const [questions, setQuestions] = React.useState<SharpenQuestion[]>([]);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [asking, setAsking] = React.useState(false);
  const [merging, setMerging] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setQuestions([]);
    setAnswers({});
    if (story) {
      setForm({
        title: story.title,
        category: story.category || "tell_me_about_yourself",
        shortVersion: story.shortVersion,
        starVersion: story.starVersion,
        technicalVersion: story.technicalVersion,
        keywords: story.keywords.join(", "),
        evidence: story.evidence.join("\n"),
      });
    } else {
      setForm(emptyForm);
    }
  }, [open, story]);

  const currentStory = () => ({
    title: form.title.trim(),
    category: toCategorySlug(form.category) || "general",
    shortVersion: form.shortVersion,
    starVersion: form.starVersion,
    technicalVersion: form.technicalVersion,
    keywords: form.keywords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    evidence: splitEvidence(form.evidence),
  });

  const askQuestions = async () => {
    setAsking(true);
    try {
      const res = await apiFetch<{ questions: SharpenQuestion[] }>("/api/stories/sharpen", {
        method: "POST",
        body: JSON.stringify({ action: "questions", story: currentStory() }),
      });
      setQuestions(res.questions);
      setAnswers({});
      if (res.questions.length === 0) toast("No questions came back. Try again.");
    } catch (err) {
      toast.error("Could not get questions", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setAsking(false);
    }
  };

  const mergeAnswers = async () => {
    setMerging(true);
    try {
      const merged = await apiFetch<{
        title: string;
        shortVersion: string;
        starVersion: string;
        technicalVersion: string;
        keywords: string[];
        evidence: string[];
      }>("/api/stories/sharpen", {
        method: "POST",
        body: JSON.stringify({
          action: "merge",
          story: currentStory(),
          answers: questions.map((q) => ({
            question: q.question,
            answer: answers[q.id] ?? "",
          })),
        }),
      });
      setForm((f) => ({
        ...f,
        title: merged.title || f.title,
        shortVersion: merged.shortVersion,
        starVersion: merged.starVersion,
        technicalVersion: merged.technicalVersion,
        keywords: merged.keywords.join(", "),
        evidence: merged.evidence.join("\n"),
      }));
      setQuestions([]);
      setAnswers({});
      toast.success("Merged. Read it over, then Save.", {
        description: "Nothing is saved until you press Save.",
      });
    } catch (err) {
      toast.error("Could not merge your answers", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setMerging(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSaving(true);

    const payload = {
      title: form.title.trim(),
      category: toCategorySlug(form.category) || "tell_me_about_yourself",
      shortVersion: form.shortVersion,
      starVersion: form.starVersion,
      technicalVersion: form.technicalVersion,
      keywords: form.keywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      evidence: splitEvidence(form.evidence),
    };

    try {
      const saved = story
        ? await apiFetch<StoryDto>(`/api/stories/${story.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await apiFetch<StoryDto>("/api/stories", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      onSaved(saved);
      toast.success(story ? "Story updated" : "Story created");
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not save story", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{story ? "Edit story" : "New story"}</DialogTitle>
          <DialogDescription>
            Keep facts truthful. Use comma-separated keywords and evidence.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="story-title">Title</Label>
              <Input
                id="story-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Cut p99 latency"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="story-category">Category</Label>
              <Input
                id="story-category"
                list="story-category-suggestions"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. signature_project"
              />
              <datalist id="story-category-suggestions">
                {Object.entries(STORY_CATEGORY_LABELS).map(([slug, label]) => (
                  <option key={slug} value={slug}>
                    {label}
                  </option>
                ))}
              </datalist>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="story-short">Short version</Label>
            <Textarea
              id="story-short"
              value={form.shortVersion}
              onChange={(e) => setForm({ ...form, shortVersion: e.target.value })}
              placeholder="1-2 spoken sentences"
              className="min-h-[70px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="story-star">STAR version</Label>
            <Textarea
              id="story-star"
              value={form.starVersion}
              onChange={(e) => setForm({ ...form, starVersion: e.target.value })}
              placeholder="Situation, Task, Action, Result"
              className="min-h-[90px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="story-tech">Technical version</Label>
            <Textarea
              id="story-tech"
              value={form.technicalVersion}
              onChange={(e) => setForm({ ...form, technicalVersion: e.target.value })}
              placeholder="Architecture, tools, tradeoffs"
              className="min-h-[90px]"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="story-keywords">Keywords</Label>
              <Input
                id="story-keywords"
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                placeholder="comma, separated"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="story-evidence">Evidence (one per line)</Label>
              <Textarea
                id="story-evidence"
                value={form.evidence}
                onChange={(e) => setForm({ ...form, evidence: e.target.value })}
                placeholder="one fact per line"
                className="min-h-[40px]"
              />
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-dashed p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Sharpen with real details</p>
                <p className="text-xs text-muted-foreground">
                  Answer a few questions in a line each. Only what you say is added, nothing
                  is invented. Skip any you don&apos;t remember.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void askQuestions()}
                disabled={asking || !form.title.trim()}
              >
                {asking ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                {questions.length ? "New questions" : "Ask me"}
              </Button>
            </div>
            {questions.length > 0 && (
              <div className="space-y-3">
                {questions.map((q) => (
                  <div key={q.id} className="space-y-1">
                    <Label htmlFor={`sharpen-${q.id}`} className="text-sm font-normal">
                      {q.question}
                    </Label>
                    <Textarea
                      id={`sharpen-${q.id}`}
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                      placeholder="A line or two. Skip if you don't remember."
                      className="min-h-[48px]"
                    />
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void mergeAnswers()}
                  disabled={merging || !Object.values(answers).some((a) => a.trim())}
                >
                  {merging ? <Spinner /> : <Wand2 className="h-4 w-4" />}
                  Merge into story
                </Button>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />} {story ? "Save changes" : "Create story"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
