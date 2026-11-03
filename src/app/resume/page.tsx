"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, FileText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  const [showFacts, setShowFacts] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [result, setResult] = React.useState<ResumeResult | null>(null);

  const [working, setWorking] = React.useState<"" | "reading" | "writing">("");
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

  // Remember each candidate's career facts and notes, and each pair's resume.
  React.useEffect(() => {
    if (!candidateId) return;
    const stored = load<unknown>(`facts.${candidateId}`);
    const parsed = stored ? resumeFactsSchema.safeParse(stored) : null;
    setFacts(parsed?.success ? parsed.data : null);
    setShowFacts(false);
    setNotes(load<string>(`notes.${candidateId}`) ?? "");
  }, [candidateId]);

  React.useEffect(() => {
    if (!candidateId || !jobId) return setResult(null);
    setResult(load<ResumeResult>(`result.${candidateId}.${jobId}`));
  }, [candidateId, jobId]);

  React.useEffect(() => {
    if (working !== "writing") return;
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [working]);

  const updateFacts = (next: ResumeFacts) => {
    setFacts(next);
    if (candidateId) save(`facts.${candidateId}`, next);
  };

  // One button: read the jobs/dates/education from the saved resume the first
  // time, then write the resume for the chosen job.
  const generate = async () => {
    if (!candidateId || !jobId) return;
    try {
      let useFacts = facts;
      if (!useFacts || useFacts.experience.length === 0) {
        setWorking("reading");
        const out = await apiFetch<{ facts: ResumeFacts }>("/api/resume/facts", {
          method: "POST",
          body: JSON.stringify({ candidateProfileId: candidateId }),
        });
        useFacts = out.facts;
        updateFacts(useFacts);
        if (useFacts.experience.length === 0) {
          setShowFacts(true);
          toast.error("No jobs found in the resume", {
            description: "Add your jobs under Career facts, then generate again.",
          });
          return;
        }
      }
      setWorking("writing");
      const out = await apiFetch<ResumeResult>("/api/resume/generate", {
        method: "POST",
        body: JSON.stringify({ candidateProfileId: candidateId, jobProfileId: jobId, facts: useFacts, notes }),
      });
      setResult(out);
      save(`result.${candidateId}.${jobId}`, out);
    } catch (err) {
      toast.error("Could not generate the resume", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FileText className="h-5 w-5" /> Resume
        </h1>
        <p className="text-sm text-muted-foreground">
          Pick the candidate and the job, then generate. Your employers, titles, dates and education
          stay exactly as they are in your saved resume.
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

          <div className="space-y-1.5">
            <Label>Anything you want included (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                if (candidateId) save(`notes.${candidateId}`, e.target.value);
              }}
              placeholder="Projects, tools, results, or the kind of work you want the resume to lean on."
              className="min-h-[80px]"
              maxLength={8000}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => void generate()} disabled={!jobId || working !== ""}>
              {working ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {result ? "Generate again" : "Generate resume"}
            </Button>
            {working === "reading" && (
              <span className="text-xs text-muted-foreground">Reading your resume…</span>
            )}
            {working === "writing" && (
              <span className="text-xs text-muted-foreground">
                Writing… {elapsed}s. This can take a few minutes on a Pro model.
              </span>
            )}
          </div>

          {result && <ResumeView result={result} />}

          <div>
            <button
              type="button"
              onClick={() => setShowFacts((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showFacts}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showFacts ? "rotate-180" : ""}`} />
              Career facts (jobs, dates, education)
            </button>
            {showFacts && (
              <div className="mt-3">
                {facts ? (
                  <ResumeFactsEditor facts={facts} onChange={updateFacts} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    They are read from your saved resume the first time you generate.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
