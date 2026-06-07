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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/client";
import { STORY_CATEGORY_LABELS } from "@/lib/constants";
import { STORY_CATEGORIES, type StoryCategory } from "@/lib/schemas";
import type { StoryDto } from "@/lib/types";

interface StoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  story: StoryDto | null;
  onSaved: (story: StoryDto) => void;
}

const emptyForm = {
  title: "",
  category: "tell_me_about_yourself" as StoryCategory,
  shortVersion: "",
  starVersion: "",
  technicalVersion: "",
  keywords: "",
  evidence: "",
};

export function StoryDialog({ open, onOpenChange, story, onSaved }: StoryDialogProps) {
  const [form, setForm] = React.useState(emptyForm);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (story) {
      setForm({
        title: story.title,
        category: (story.category as StoryCategory) ?? "tell_me_about_yourself",
        shortVersion: story.shortVersion,
        starVersion: story.starVersion,
        technicalVersion: story.technicalVersion,
        keywords: story.keywords.join(", "),
        evidence: story.evidence.join(", "),
      });
    } else {
      setForm(emptyForm);
    }
  }, [open, story]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSaving(true);

    const payload = {
      title: form.title.trim(),
      category: form.category,
      shortVersion: form.shortVersion,
      starVersion: form.starVersion,
      technicalVersion: form.technicalVersion,
      keywords: form.keywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      evidence: form.evidence
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
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
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as StoryCategory })}
              >
                <SelectTrigger id="story-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STORY_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {STORY_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Label htmlFor="story-evidence">Evidence</Label>
              <Input
                id="story-evidence"
                value={form.evidence}
                onChange={(e) => setForm({ ...form, evidence: e.target.value })}
                placeholder="comma, separated"
              />
            </div>
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
