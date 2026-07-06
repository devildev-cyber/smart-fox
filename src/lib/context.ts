import type { CandidateStructured, JobStructured, PositioningBrief } from "./schemas";

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
export interface PriorTurn {
  question: string;
  answerGist: string;
}

/** Render the positioning brief into a specific, skimmable block for the model. */
function renderPositioning(brief: PositioningBrief): string {
  const lines: string[] = [
    "POSITIONING — your CANONICAL facts for THIS role. Pull the signature project or prepared answer that fits the question and reuse its exact names, tech, and numbers. Stay this specific; never go generic:",
  ];
  if (brief.headline) lines.push(`Known for: ${brief.headline}`);

  if (brief.signature_projects.length) {
    lines.push("\nSIGNATURE PROJECTS (reuse these exact stories):");
    for (const p of brief.signature_projects.slice(0, 6)) {
      const parts: string[] = [];
      const head = [p.title, p.what].filter(Boolean).join(" — ");
      if (head) parts.push(head);
      if (p.contributions.length) parts.push(`did: ${p.contributions.slice(0, 5).join("; ")}`);
      if (p.tech.length) parts.push(`tech: ${p.tech.slice(0, 12).join(", ")}`);
      if (p.impact.length) parts.push(`impact: ${p.impact.slice(0, 4).join("; ")}`);
      if (parts.length) lines.push(`- ${parts.join(" | ")}`);
    }
  }

  if (brief.why_fit.length) lines.push(`\nWhy a fit: ${brief.why_fit.slice(0, 5).join("; ")}`);

  if (brief.prepared_answers.length) {
    lines.push("\nPREPARED ANSWERS (adapt to the exact wording asked; keep the facts):");
    for (const qa of brief.prepared_answers.slice(0, 8)) {
      if (qa.answer) lines.push(`- ${qa.question ? `${qa.question}: ` : ""}${qa.answer}`);
    }
  }

  if (brief.weak_spots.length) {
    const ws = brief.weak_spots
      .slice(0, 5)
      .map((w) => (w.how_to_handle ? `${w.concern} -> ${w.how_to_handle}` : w.concern))
      .join(" | ");
    lines.push(`\nIf a weak spot comes up: ${ws}`);
  }

  return lines.join("\n");
}

export function buildAnswerContext(params: {
  detectedQuestion: string;
  questionType?: string;
  recentTranscript: string;
  focusHint?: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  selected: SelectedContext;
  positioning?: PositioningBrief | null;
  rawResumeFallback?: string;
  priorTurns?: PriorTurn[];
}): string {
  const { detectedQuestion, questionType, recentTranscript, candidate, job, selected } =
    params;
  const focusHint = (params.focusHint ?? "").trim();
  const transcript = recentTranscript.slice(-2000).trim();
  const hasExplicitQuestion = Boolean(detectedQuestion.trim());

  const parts: string[] = [];

  // The thing to answer ALWAYS comes first. With an explicit question that's the
  // question; otherwise it's the transcript itself, framed so the model answers
  // the LATEST utterance (which is at the end) rather than something stale.
  if (hasExplicitQuestion) {
    parts.push(`QUESTION TO ANSWER:\n${detectedQuestion}`);
    if (questionType) parts.push(`QUESTION TYPE: ${questionType}`);
  } else {
    const task: string[] = [];
    if (focusHint) {
      // The latest turn is handed over explicitly, so we don't rely on "it's at
      // the end of the transcript". Earlier speech (if any) is background only.
      task.push(
        "TASK — answer what the interviewer asks under INTERVIEWER'S LATEST WORDS. If they packed SEVERAL distinct questions or prompts into it, answer EACH (as numbered blocks). A prompt may not end in \"?\". Anything under EARLIER CONTEXT is only there to interpret the ask — do NOT re-answer it. Ignore the candidate's own speech, greetings, and filler."
      );
      task.push(`INTERVIEWER'S LATEST WORDS — this is what to answer:\n${focusHint}`);
      if (transcript) {
        task.push(`EARLIER CONTEXT (background only, already handled):\n${transcript}`);
      }
    } else {
      // No explicit latest-turn hint: fall back to "the ask is at the end".
      task.push(
        "TASK — answer the interviewer's MOST RECENT question or prompt. It's at the END of the transcript; earlier lines are only there to interpret it. If several distinct things were asked, answer each. A prompt may not end in \"?\". Ignore the candidate's own speech, greetings, and filler."
      );
      if (transcript) {
        task.push(`TRANSCRIPT:\n${transcript}`);
      }
    }
    parts.push(task.join("\n\n"));
  }

  // Strategic positioning comes right after the ask so it frames everything
  // below. When present it's the primary source of specifics for the answer.
  if (params.positioning) {
    parts.push(renderPositioning(params.positioning));
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

  const priorTurns = (params.priorTurns ?? []).filter((t) => t.question.trim());
  if (priorTurns.length) {
    const recent = priorTurns.slice(-6);
    const lines = recent
      .map((t) => `- Q: ${t.question.trim()} -> ${t.answerGist.trim()}`)
      .join("\n");
    parts.push(
      `PRIOR ANSWERS THIS SESSION (already covered; do not repeat. If the new question overlaps, reference briefly with "As I mentioned earlier" and add only what is new):\n${lines}`
    );
  }

  // Only re-show the transcript at the bottom when an explicit question was
  // given (in one-shot mode it's already shown prominently up top as the ask).
  if (hasExplicitQuestion && transcript) {
    parts.push(`RECENT TRANSCRIPT (context only):\n${transcript}`);
  }

  return parts.join("\n\n");
}
