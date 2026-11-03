"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileText, ScanText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ResumeFactsEditor } from "@/components/resume-facts-editor";
import { ResumeView, type ResumeResult } from "@/components/resume-view";
import { apiFetch } from "@/lib/client";
import { resumeFactsSchema, type ResumeFacts } from "@/lib/resume";
import type { CandidateProfileDto, JobProfileDto, ProfilesResponse } from "@/lib/types";

const K = "interview-coach.resume.";

function load<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(K + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(K + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: the page still works, it just won't remember
  }
}

export default function ResumePage() {
  const [candidates, setCandidates] = React.useState<CandidateProfileDto[]>([]);
  const [jobs, setJobs] = React.useState<JobProfileDto[]>([]);
  const [candidateId, setCandidateId] = React.useState("");
  const [jobId, setJobId] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const [facts, setFacts] = React.useState<ResumeFacts | null>(null);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [notes, setNotes] = React.useState("");
  const [result, setResult] = React.useState<ResumeResult | null>(null);

  const [extracting, setExtracting] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    void (async () => {
      try {
        const profiles = await apiFetch<ProfilesResponse>("/api/profiles");
        setCandidates(profiles.candidates);
        setJobs(profiles.jobs);
        setCandidateId(profiles.candidates[0]?.id ?? "");
        setJobId(profiles.jobs[0]?.id ?? "");
      } catch (err) {
        toast.error("Could not load profiles", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Remember each candidate's verified facts and notes, and each pair's result.
  React.useEffect(() => {
    if (!candidateId) return;
    const stored = load<unknown>(`facts.${candidateId}`);
    const parsed = stored ? resumeFactsSchema.safeParse(stored) : null;
    setFacts(parsed?.success ? parsed.data : null);
    setWarnings([]);
    setNotes(load<string>(`notes.${candidateId}`) ?? "");
  }, [candidateId]);

  React.useEffect(() => {
    if (!candidateId || !jobId) return setResult(null);
    setResult(load<ResumeResult>(`result.${candidateId}.${jobId}`));
  }, [candidateId, jobId]);

  React.useEffect(() => {
    if (!generating) return;
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [generating]);

  const updateFacts = (next: ResumeFacts) => {
    setFacts(next);
    if (candidateId) save(`facts.${candidateId}`, next);
  };

  const extract = async () => {
    if (!candidateId) return;
    setExtracting(true);
    try {
      const out = await apiFetch<{ facts: ResumeFacts; warnings: string[] }>("/api/resume/facts", {
        method: "POST",
        body: JSON.stringify({ candidateProfileId: candidateId }),
      });
      updateFacts(out.facts);
      setWarnings(out.warnings);
      toast.success("Read your resume", {
        description: "Check every job, title and date below before generating.",
      });
    } catch (err) {
      toast.error("Could not read the resume", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setExtracting(false);
    }
  };

  const generate = async () => {
    if (!candidateId || !jobId || !facts) return;
    setGenerating(true);
    try {
      const out = await apiFetch<ResumeResult>("/api/resume/generate", {
        method: "POST",
        body: JSON.stringify({ candidateProfileId: candidateId, jobProfileId: jobId, facts, notes }),
      });
      setResult(out);
      save(`result.${candidateId}.${jobId}`, out);
      toast.success("Resume ready", {
        description:
          out.resume.verification_notes.length > 0
            ? "Review the items to confirm at the top."
            : undefined,
      });
    } catch (err) {
      toast.error("Could not generate the resume", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setGenerating(false);
    }
  };

  const ready = Boolean(facts && facts.experience.length > 0 && jobId);

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FileText className="h-5 w-5" /> Resume
        </h1>
        <p className="text-sm text-muted-foreground">
          Build a resume for one job. Your employers, titles, dates and education are kept exactly as
          you confirm them. The rest is written for the role.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : candidates.length === 0 || jobs.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground">
            Add a candidate profile and a job description on the Setup page first.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Candidate</Label>
              <Select value={candidateId} onValueChange={setCandidateId}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || "Candidate"}
                      {c.targetTitle ? ` — ${c.targetTitle}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Target job</Label>
              <Select value={jobId} onValueChange={setJobId}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map((j) => (
                    <SelectItem key={j.id} value={j.id}>
                      {j.roleTitle || "Role"} @ {j.company || "company"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">1. Career facts</CardTitle>
              <CardDescription>
                Read from your saved resume. These are copied into the new resume word for word, so
                fix anything that is wrong or missing here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button size="sm" variant={facts ? "outline" : "default"} onClick={() => void extract()} disabled={extracting}>
                {extracting ? <Spinner /> : <ScanText className="h-4 w-4" />}
                {facts ? "Read the resume again" : "Read my resume"}
              </Button>
              {warnings.length > 0 && (
                <ul className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                  {warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              )}
              {facts && <ResumeFactsEditor facts={facts} onChange={updateFacts} />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">2. Real projects and results (optional)</CardTitle>
              <CardDescription>
                Anything true you want used: projects, tools, numbers, the kind of work you did. These
                are used before anything the writer makes up.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  if (candidateId) save(`notes.${candidateId}`, e.target.value);
                }}
                placeholder="e.g. At Acme I moved nightly billing from cron to a queue-based job runner; the run went from about 4 hours to 50 minutes."
                className="min-h-[110px]"
                maxLength={8000}
              />
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={() => void generate()} disabled={!ready || generating}>
              {generating ? <Spinner /> : <Sparkles className="h-4 w-4" />} Generate resume
            </Button>
            {generating && (
              <span className="text-xs text-muted-foreground">
                Working… {elapsed}s. This can take a few minutes on a Pro model.
              </span>
            )}
            {!ready && !generating && (
              <span className="text-xs text-muted-foreground">
                {facts ? "Add at least one job to the career facts." : "Read your resume first."}
              </span>
            )}
          </div>

          {result && <ResumeView result={result} />}
        </>
      )}
    </div>
  );
}
