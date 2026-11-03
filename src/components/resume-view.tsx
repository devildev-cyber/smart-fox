"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { resumeToMarkdown, resumeToText, type GeneratedResume, type ResumeIssue, type ResumeStats } from "@/lib/resume";

export interface ResumeResult {
  resume: GeneratedResume;
  issues: ResumeIssue[];
  stats: ResumeStats;
  corrections: string[];
  timeline: { label: string; safePhrase: string; ambiguous: boolean };
  repaired: boolean;
}

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not copy");
  }
}

export function ResumeView({ result }: { result: ResumeResult }) {
  const { resume, issues, stats, corrections, timeline } = result;
  const notes = resume.verification_notes;
  const [confirmed, setConfirmed] = React.useState<boolean[]>(() => notes.map(() => false));
  React.useEffect(() => setConfirmed(notes.map(() => false)), [result]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = confirmed.filter((c) => !c).length;
  const fileBase = (resume.name || "resume").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  return (
    <div className="space-y-4">
      {notes.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-warning">
              <AlertTriangle className="h-4 w-4" /> Confirm before you use this resume
            </CardTitle>
            <CardDescription>
              These details were written for you, not taken from your record. Only keep what is
              true for you, and change or remove the rest. {open} of {notes.length} still to check.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {notes.map((n, i) => (
              <label key={i} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmed[i] ?? false}
                  onChange={(e) =>
                    setConfirmed((prev) => prev.map((c, j) => (j === i ? e.target.checked : c)))
                  }
                />
                <span className={confirmed[i] ? "text-muted-foreground line-through" : ""}>{n}</span>
              </label>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Checks</CardTitle>
          <CardDescription>
            {timeline.ambiguous
              ? "Dates are partly year-only, so no total experience was claimed."
              : `Experience from your dates: ${timeline.label}, overlaps removed.`}
            {result.repaired && " One automatic fix pass was applied."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Badge variant="outline">{stats.skillsCount} skills</Badge>
            <Badge variant="outline">{stats.skillCategories} categories</Badge>
            <Badge variant="outline">{stats.totalBullets} bullets</Badge>
            <Badge variant="outline">
              {stats.numericBullets} with numbers ({stats.numericPct}%)
            </Badge>
            <Badge variant="outline">{stats.summaryWords}-word summary</Badge>
          </div>
          {corrections.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {corrections.map((c, i) => (
                <li key={i} className="flex gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {c}
                </li>
              ))}
            </ul>
          )}
          {issues.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5" /> No issues found.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {issues.map((it, i) => (
                <li
                  key={i}
                  className={it.severity === "fix" ? "text-warning" : "text-muted-foreground"}
                >
                  • {it.message}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={() => void copy(resumeToText(resume), "Resume text")}>
          <Copy className="h-4 w-4" /> Copy text
        </Button>
        <Button size="sm" variant="outline" onClick={() => void copy(resumeToMarkdown(resume), "Markdown")}>
          <Copy className="h-4 w-4" /> Copy Markdown
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(`${fileBase}.md`, "text/markdown", resumeToMarkdown(resume))}>
          <Download className="h-4 w-4" /> .md
        </Button>
        <Button size="sm" variant="outline" onClick={() => download(`${fileBase}.json`, "application/json", JSON.stringify(resume, null, 2))}>
          <Download className="h-4 w-4" /> .json
        </Button>
        {open > 0 && notes.length > 0 && (
          <span className="self-center text-xs text-warning">{open} item(s) unconfirmed</span>
        )}
      </div>

      <Card>
        <CardContent className="space-y-4 p-5 text-sm leading-relaxed">
          <header>
            <h2 className="text-xl font-semibold">{resume.name}</h2>
            {resume.resume_title && <p className="font-medium">{resume.resume_title}</p>}
            <p className="text-xs text-muted-foreground">
              {[resume.contact.email, resume.contact.phone, resume.contact.location, resume.contact.linkedin]
                .filter(Boolean)
                .join(" | ")}
            </p>
          </header>

          {resume.summary && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h3>
              <p>{resume.summary}</p>
            </section>
          )}

          {resume.skills.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skills</h3>
              <ul className="space-y-0.5">
                {resume.skills.map((g, i) => (
                  <li key={i}>
                    <span className="font-medium">{g.category}:</span> {g.items.join(", ")}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Experience</h3>
            {resume.experience.map((r, i) => (
              <div key={i}>
                <p className="font-medium">
                  {r.title} — {r.company}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[r.location, [r.start_date, r.end_date].filter(Boolean).join(" – ")].filter(Boolean).join(" | ")}
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {r.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          {resume.education.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Education</h3>
              <ul className="space-y-0.5">
                {resume.education.map((e, i) => (
                  <li key={i}>
                    {[[e.degree, e.field_of_study].filter(Boolean).join(", "), e.institution, e.location, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                      .filter(Boolean)
                      .join(" — ")}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {resume.certifications.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Certifications</h3>
              <ul className="list-disc pl-5">
                {resume.certifications.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          )}

          {resume.keyword_notes.length > 0 && (
            <section className="border-t border-border pt-3">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Keyword coverage (not part of the resume)
              </h3>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {resume.keyword_notes.map((k, i) => (
                  <li key={i}>{k}</li>
                ))}
              </ul>
            </section>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
