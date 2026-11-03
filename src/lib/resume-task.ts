/**
 * Server-side resume pipeline: extract facts -> generate -> enforce the
 * immutable data -> lint -> (once) repair what the lint can fix -> re-lint.
 */
import { callJson, isProModel } from "./llm";
import { getRuntimeConfig } from "./runtime-config";
import {
  RESUME_APP_INPUT_NOTE,
  RESUME_BUILD_PROMPT,
  RESUME_FACTS_PROMPT,
  RESUME_REPAIR_PROMPT,
} from "./resume-prompts";
import {
  computeTimeline,
  enforceFacts,
  generatedResumeSchema,
  lintResume,
  resumeFactsSchema,
  resumeStats,
  techVocabulary,
  type ExperienceTimeline,
  type GeneratedResume,
  type ResumeFacts,
  type ResumeIssue,
  type ResumeStats,
} from "./resume";
import type { CandidateStructured, JobStructured } from "./schemas";

const MAX_RESUME_CHARS = 20_000;
const MAX_JD_CHARS = 14_000;

export async function extractResumeFacts(rawResumeText: string): Promise<ResumeFacts> {
  const model = (await getRuntimeConfig()).strongModel;
  return callJson({
    model,
    system: RESUME_FACTS_PROMPT,
    user: `RESUME:\n${rawResumeText.slice(0, MAX_RESUME_CHARS)}`,
    schema: resumeFactsSchema,
    temperature: 0.1,
    timeoutMs: isProModel(model) ? 300_000 : 150_000,
  });
}

export interface ResumeBuildResult {
  resume: GeneratedResume;
  /** What was still wrong after the repair pass (and, if no repair ran, before). */
  issues: ResumeIssue[];
  stats: ResumeStats;
  /** Immutable fields the model got wrong and the code restored. */
  corrections: string[];
  timeline: Pick<ExperienceTimeline, "label" | "safePhrase" | "ambiguous">;
  repaired: boolean;
}

function evidenceBlock(candidate: CandidateStructured | null): string {
  if (!candidate) return "";
  const pick = {
    seniority: candidate.seniority,
    core_stack: candidate.core_stack,
    secondary_stack: candidate.secondary_stack,
    domains: candidate.domains,
    projects: candidate.projects,
    metrics: candidate.metrics,
    leadership: candidate.leadership,
    strong_evidence: candidate.strong_evidence,
    weak_or_missing_evidence: candidate.weak_or_missing_evidence,
  };
  return `STRUCTURED PROFILE (from the candidate's resume):\n${JSON.stringify(pick, null, 2)}`;
}

function jobSummaryBlock(job: JobStructured | null): string {
  if (!job) return "";
  return `STRUCTURED JD SUMMARY:\n${JSON.stringify(
    {
      company: job.company,
      role_title: job.role_title,
      seniority: job.seniority,
      domain: job.domain,
      must_have_skills: job.must_have_skills,
      preferred_skills: job.preferred_skills,
      responsibilities: job.responsibilities,
    },
    null,
    2
  )}`;
}

function timelineBlock(t: ExperienceTimeline): string {
  if (t.ambiguous || t.professionalMonths === null) {
    return "Not available: the supplied dates are partly missing or year-only, so do NOT state a precise number of years. Use a natural, non-inflated phrasing.";
  }
  const parts = [
    `Non-overlapping professional experience: ${t.label} (${t.professionalMonths} months).`,
    t.safePhrase
      ? `Safe wording for the summary: "with ${t.safePhrase} of professional experience". Never round up.`
      : "Under one year of professional experience: do not claim years.",
  ];
  if (t.internshipMonths) {
    parts.push(`Internship/trainee time counted separately: ${t.internshipMonths} months.`);
  }
  return parts.join("\n");
}

export async function buildResume(params: {
  facts: ResumeFacts;
  candidate: CandidateStructured | null;
  rawResumeText: string;
  job: JobStructured | null;
  rawJobDescription: string;
  notes: string;
  today?: Date;
}): Promise<ResumeBuildResult> {
  const today = params.today ?? new Date();
  const timeline = computeTimeline(params.facts.experience, today);
  const model = (await getRuntimeConfig()).strongModel;
  const jd = params.rawJobDescription.slice(0, MAX_JD_CHARS);

  const user = [
    `TODAY (reference date): ${today.toISOString().slice(0, 10)}`,
    `COMPUTED EXPERIENCE:\n${timelineBlock(timeline)}`,
    `IMMUTABLE CAREER DATA (verified by the candidate; copy exactly):\n${JSON.stringify(params.facts, null, 2)}`,
    `CANDIDATE EVIDENCE:\n${[
      evidenceBlock(params.candidate),
      params.rawResumeText.trim()
        ? `EXISTING RESUME TEXT (supplied evidence):\n${params.rawResumeText.slice(0, MAX_RESUME_CHARS)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n") || "(none beyond the career data)"}`,
    `ADDITIONAL EVIDENCE FROM THE CANDIDATE (real projects, results, preferences):\n${params.notes.trim() || "(none)"}`,
    `TARGET JOB:\n<job_description>\n${jd}\n</job_description>\n\n${jobSummaryBlock(params.job)}`,
    "Return the resume as a JSON object only.",
  ].join("\n\n");

  const call = <T>(system: string, userMsg: string, schema: typeof generatedResumeSchema) =>
    callJson({
      model,
      system,
      user: userMsg,
      schema,
      temperature: 0.5,
      maxOutputTokens: 32_000,
      timeoutMs: isProModel(model) ? 600_000 : 420_000,
    }) as Promise<T>;

  const first = await call<GeneratedResume>(
    `${RESUME_BUILD_PROMPT}\n\n${RESUME_APP_INPUT_NOTE}`,
    user,
    generatedResumeSchema
  );

  const tech = techVocabulary([
    ...(params.job?.must_have_skills ?? []),
    ...(params.job?.preferred_skills ?? []),
    ...(params.job?.resume_match_keywords ?? []),
    ...first.skills.flatMap((g) => g.items),
  ]);
  const lint = (r: GeneratedResume) =>
    lintResume(r, { jdText: jd, tech, timeline });

  let { resume, corrections } = enforceFacts(first, params.facts);
  let issues = lint(resume);
  let repaired = false;

  const fixable = issues.filter((i) => i.severity === "fix");
  if (fixable.length) {
    try {
      const repairUser = [
        `PROBLEMS TO FIX:\n${fixable.map((i) => `- ${i.message}`).join("\n")}`,
        `JOB DESCRIPTION (reference only; do not copy its wording):\n<job_description>\n${jd}\n</job_description>`,
        `RESUME JSON:\n${JSON.stringify(resume, null, 2)}`,
        "Return the full corrected resume as a JSON object only.",
      ].join("\n\n");
      const second = await call<GeneratedResume>(RESUME_REPAIR_PROMPT, repairUser, generatedResumeSchema);
      const enforced = enforceFacts(second, params.facts);
      const reIssues = lint(enforced.resume);
      const before = fixable.length;
      const after = reIssues.filter((i) => i.severity === "fix").length;
      // Only keep the repair if it actually helped.
      if (after < before) {
        resume = enforced.resume;
        corrections = [...corrections, ...enforced.corrections];
        issues = reIssues;
        repaired = true;
      }
    } catch {
      // The first draft is still good; the remaining issues are shown to the user.
    }
  }

  return {
    resume,
    issues,
    stats: resumeStats(resume, timeline),
    corrections,
    timeline: {
      label: timeline.label,
      safePhrase: timeline.safePhrase,
      ambiguous: timeline.ambiguous,
    },
    repaired,
  };
}
