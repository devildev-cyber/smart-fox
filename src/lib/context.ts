import type { CandidateStructured, JobStructured } from "./schemas";

export interface StoryLike {
  id: string;
  title: string;
  category: string;
  shortVersion: string;
  starVersion: string;
  technicalVersion: string;
  keywords: string[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "have",
  "has",
  "are",
  "was",
  "were",
  "will",
  "what",
  "when",
  "where",
  "which",
  "how",
  "why",
  "who",
  "can",
  "could",
  "would",
  "should",
  "about",
  "into",
  "over",
  "tell",
  "talk",
  "give",
  "any",
  "all",
  "some",
  "our",
  "their",
  "they",
  "them",
  "experience",
  "work",
  "team",
  "role",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function overlapScore(query: Set<string>, text: string): number {
  if (query.size === 0) return 0;
  const tokens = tokenize(text);
  let score = 0;
  for (const token of tokens) {
    if (query.has(token)) score += 1;
  }
  return score;
}

function rankByOverlap<T>(
  items: T[],
  query: Set<string>,
  getText: (item: T) => string,
  limit: number
): T[] {
  if (items.length === 0) return [];
  const scored = items.map((item, index) => ({
    item,
    index,
    score: overlapScore(query, getText(item)),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index; // stable, preserve original order on ties
  });
  return scored.slice(0, limit).map((s) => s.item);
}

export interface SelectedContext {
  resumeFacts: string[];
  jdRequirements: string[];
  stories: StoryLike[];
}

/**
 * Deterministically select the most relevant resume facts, JD requirements,
 * and story bank entries for a given detected question. Uses simple keyword
 * overlap scoring so the same inputs always produce the same context.
 */
export function selectContext(params: {
  question: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  stories?: StoryLike[];
  maxResumeFacts?: number;
  maxJdRequirements?: number;
  maxStories?: number;
}): SelectedContext {
  const {
    question,
    candidate,
    job,
    stories = [],
    maxResumeFacts = 8,
    maxJdRequirements = 5,
    maxStories = 3,
  } = params;

  // Build the query vocabulary from the question plus the JD match keywords,
  // since those describe what the interviewer is likely probing for.
  const queryTokens = new Set<string>(tokenize(question));
  for (const kw of job?.resume_match_keywords ?? []) {
    for (const t of tokenize(kw)) queryTokens.add(t);
  }

  const resumePool: string[] = [];
  if (candidate) {
    resumePool.push(
      ...candidate.strong_evidence,
      ...candidate.projects,
      ...candidate.metrics,
      ...candidate.leadership,
      ...candidate.core_stack.map((s) => `Core stack: ${s}`),
      ...candidate.secondary_stack.map((s) => `Also used: ${s}`),
      ...candidate.domains.map((d) => `Domain: ${d}`),
      ...candidate.best_story_angles
    );
  }

  const jdPool: string[] = [];
  if (job) {
    jdPool.push(
      ...job.must_have_skills.map((s) => `Must-have: ${s}`),
      ...job.responsibilities,
      ...job.preferred_skills.map((s) => `Preferred: ${s}`),
      ...job.likely_interview_focus.map((f) => `Focus: ${f}`)
    );
  }

  const dedupedResume = Array.from(new Set(resumePool.filter(Boolean)));
  const dedupedJd = Array.from(new Set(jdPool.filter(Boolean)));

  return {
    resumeFacts: rankByOverlap(dedupedResume, queryTokens, (t) => t, maxResumeFacts),
    jdRequirements: rankByOverlap(dedupedJd, queryTokens, (t) => t, maxJdRequirements),
    stories: rankByOverlap(
      stories,
      queryTokens,
      (s) => `${s.title} ${s.category} ${s.keywords.join(" ")} ${s.shortVersion}`,
      maxStories
    ),
  };
}

/**
 * Render the selected context plus structured profile summaries into a compact
 * user-message payload for the answer model. Avoids sending the full raw resume
 * when a structured profile is available.
 */
export function buildAnswerContext(params: {
  detectedQuestion: string;
  questionType?: string;
  recentTranscript: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  selected: SelectedContext;
  rawResumeFallback?: string;
}): string {
  const { detectedQuestion, questionType, recentTranscript, candidate, job, selected } =
    params;

  const parts: string[] = [];

  if (detectedQuestion.trim()) {
    parts.push(`DETECTED QUESTION:\n${detectedQuestion}`);
    if (questionType) parts.push(`QUESTION TYPE: ${questionType}`);
  } else {
    parts.push(
      "TASK: Read the recent transcript below and answer the interviewer's latest question."
    );
  }

  if (candidate) {
    parts.push(
      [
        "CANDIDATE PROFILE:",
        `- Name: ${candidate.name || "(unknown)"}`,
        `- Seniority: ${candidate.seniority || "(unknown)"}`,
        `- Core stack: ${candidate.core_stack.join(", ") || "(none listed)"}`,
        `- Domains: ${candidate.domains.join(", ") || "(none listed)"}`,
        `- Companies: ${candidate.companies.join(", ") || "(none listed)"}`,
        `- Weak/missing evidence (avoid overclaiming): ${
          candidate.weak_or_missing_evidence.join(", ") || "(none listed)"
        }`,
      ].join("\n")
    );
  } else if (params.rawResumeFallback) {
    parts.push(`RAW RESUME (no structured profile available):\n${params.rawResumeFallback.slice(0, 4000)}`);
  } else {
    parts.push("CANDIDATE PROFILE: (none provided — answer in safe, general language)");
  }

  if (selected.resumeFacts.length) {
    parts.push(`TOP RELEVANT RESUME FACTS:\n- ${selected.resumeFacts.join("\n- ")}`);
  }

  if (job) {
    parts.push(
      [
        "JOB PROFILE:",
        `- Company: ${job.company || "(unknown)"}`,
        `- Role: ${job.role_title || "(unknown)"}`,
        `- Domain: ${job.domain || "(unknown)"}`,
      ].join("\n")
    );
  }

  if (selected.jdRequirements.length) {
    parts.push(`TOP RELEVANT JD REQUIREMENTS:\n- ${selected.jdRequirements.join("\n- ")}`);
  }

  if (selected.stories.length) {
    const storyText = selected.stories
      .map(
        (s) =>
          `[${s.category}] ${s.title}\n  short: ${s.shortVersion}\n  star: ${s.starVersion}`
      )
      .join("\n");
    parts.push(`RELEVANT APPROVED STORIES:\n${storyText}`);
  }

  if (recentTranscript.trim()) {
    parts.push(`RECENT TRANSCRIPT (context only):\n${recentTranscript.slice(-2000)}`);
  }

  return parts.join("\n\n");
}
