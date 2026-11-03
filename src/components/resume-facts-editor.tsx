"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FactEducation, FactExperience, ResumeFacts } from "@/lib/resume";

function Field({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}

function lines(value: string): string[] {
  return value.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * The facts a resume must carry over exactly. They are extracted from the saved
 * resume, but the person reading this decides what is true, so everything is
 * editable here before anything is generated.
 */
export function ResumeFactsEditor({
  facts,
  onChange,
}: {
  facts: ResumeFacts;
  onChange: (next: ResumeFacts) => void;
}) {
  const set = (patch: Partial<ResumeFacts>) => onChange({ ...facts, ...patch });

  const setRole = (i: number, patch: Partial<FactExperience>) =>
    set({ experience: facts.experience.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const moveRole = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= facts.experience.length) return;
    const next = [...facts.experience];
    [next[i], next[j]] = [next[j], next[i]];
    set({ experience: next });
  };
  const setEdu = (i: number, patch: Partial<FactEducation>) =>
    set({ education: facts.education.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name" value={facts.name} onChange={(v) => set({ name: v })} />
        <Field
          label="Email"
          value={facts.contact.email}
          onChange={(v) => set({ contact: { ...facts.contact, email: v } })}
        />
        <Field
          label="Phone"
          value={facts.contact.phone}
          onChange={(v) => set({ contact: { ...facts.contact, phone: v } })}
        />
        <Field
          label="Location"
          value={facts.contact.location}
          onChange={(v) => set({ contact: { ...facts.contact, location: v } })}
        />
        <Field
          label="LinkedIn"
          value={facts.contact.linkedin}
          onChange={(v) => set({ contact: { ...facts.contact, linkedin: v } })}
          className="sm:col-span-2"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Jobs (most recent first)</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set({
                experience: [
                  ...facts.experience,
                  { company: "", title: "", location: "", start_date: "", end_date: "" },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" /> Add job
          </Button>
        </div>
        {facts.experience.length === 0 && (
          <p className="text-xs text-muted-foreground">No jobs yet.</p>
        )}
        {facts.experience.map((r, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Company" value={r.company} onChange={(v) => setRole(i, { company: v })} />
              <Field label="Official title" value={r.title} onChange={(v) => setRole(i, { title: v })} />
              <Field label="Location" value={r.location} onChange={(v) => setRole(i, { location: v })} />
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Start"
                  value={r.start_date}
                  onChange={(v) => setRole(i, { start_date: v })}
                  placeholder="Jan 2020"
                />
                <Field
                  label="End"
                  value={r.end_date}
                  onChange={(v) => setRole(i, { end_date: v })}
                  placeholder="Present"
                />
              </div>
            </div>
            <div className="flex justify-end gap-1">
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => moveRole(i, -1)} disabled={i === 0} aria-label="Move job up">
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => moveRole(i, 1)} disabled={i === facts.experience.length - 1} aria-label="Move job down">
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => set({ experience: facts.experience.filter((_, j) => j !== i) })}
                aria-label="Remove job"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Education</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              set({
                education: [
                  ...facts.education,
                  { institution: "", degree: "", field_of_study: "", location: "", start_date: "", end_date: "" },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {facts.education.map((e, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Institution" value={e.institution} onChange={(v) => setEdu(i, { institution: v })} />
              <Field label="Degree" value={e.degree} onChange={(v) => setEdu(i, { degree: v })} />
              <Field label="Field of study" value={e.field_of_study} onChange={(v) => setEdu(i, { field_of_study: v })} />
              <Field label="Location" value={e.location} onChange={(v) => setEdu(i, { location: v })} />
              <Field label="Start" value={e.start_date} onChange={(v) => setEdu(i, { start_date: v })} />
              <Field label="End" value={e.end_date} onChange={(v) => setEdu(i, { end_date: v })} />
            </div>
            <div className="flex justify-end">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => set({ education: facts.education.filter((_, j) => j !== i) })}
                aria-label="Remove education"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["certifications", "Certifications (one per line)"],
            ["languages", "Languages (one per line)"],
            ["career_breaks", "Career breaks (one per line)"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <Textarea
              defaultValue={facts[k].join("\n")}
              key={`${k}-${JSON.stringify(facts[k])}`}
              onBlur={(e) => set({ [k]: lines(e.target.value) } as Partial<ResumeFacts>)}
              className="min-h-[72px] text-sm"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
