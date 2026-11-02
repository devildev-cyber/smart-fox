import { callJson, isProModel, LlmError, streamText } from "./llm";
import { ContinuationFilter } from "./coding-stream";
import { liveCodingModel } from "./model-utils";
import { getRuntimeConfig } from "./runtime-config";
import {
  ANSWER_MODE_INSTRUCTIONS,
  buildAnswerSystemPrompt,
  buildCodingSystemPrompt,
  CODING_CONTINUE_PROMPT,
  CODING_TALK_PROMPT,
  CANDIDATE_EXTRACT_PROMPT,
  JOB_EXTRACT_PROMPT,
  languageBlock,
  POSITIONING_BRIEF_PROMPT,
  questionDepthBlock,
  REVIEW_PROMPT,
  REWRITE_PROMPT,
  STORY_CATEGORY_PLAN_PROMPT,
  STORY_GEN_PROMPT,
  STORY_IMPROVE_PROMPT,
  STORY_SHARPEN_MERGE_PROMPT,
  STORY_SHARPEN_QUESTIONS_PROMPT,
} from "./prompts";
import {
  candidateStructuredSchema,
  generatedStoriesSchema,
  jobStructuredSchema,
  positioningBriefSchema,
  postInterviewReviewSchema,
  sharpenQuestionsSchema,
  storyCategoryPlanSchema,
  UNIVERSAL_STORY_CATEGORIES,
  type AnswerLanguage,
  type AnswerMode,
  type CandidateStructured,
  type JobStructured,
  type PositioningBrief,
  type SharpenStory,
} from "./schemas";
import { isToldByCandidate, toldDetails } from "./story-truth";
import {
  buildAnswerContext,
  selectContext,
  type PriorTurn,
  type StoryLike,
} from "./context";
import { STORY_CATEGORY_LABELS } from "./constants";

export async function extractCandidateProfile(rawResumeText: string) {
  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: CANDIDATE_EXTRACT_PROMPT,
    user: `RESUME:\n${rawResumeText}`,
    schema: candidateStructuredSchema,
    temperature: 0.2,
  });
}

export async function extractJobProfile(rawJobDescription: string) {
  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: JOB_EXTRACT_PROMPT,
    user: `JOB DESCRIPTION:\n${rawJobDescription}`,
    schema: jobStructuredSchema,
    temperature: 0.2,
  });
}

/**
 * Build the one-time strategic positioning brief for a (candidate, job) pair.
 * Uses the strong analysis model; cached in the DB and injected into every live
 * answer for that pair.
 */
export async function generatePositioningBrief(params: {
  candidate: CandidateStructured;
  rawResumeText: string;
  job: JobStructured;
  /** Story bank; entries the candidate told real detail for become ground truth. */
  stories?: StoryLike[];
}): Promise<PositioningBrief> {
  const jobSummary = {
    company: params.job.company,
    role: params.job.role_title,
    seniority: params.job.seniority,
    domain: params.job.domain,
    must_have_skills: params.job.must_have_skills,
    preferred_skills: params.job.preferred_skills,
    responsibilities: params.job.responsibilities,
    likely_interview_focus: params.job.likely_interview_focus,
    likely_questions: params.job.likely_questions,
  };

  // Only stories the candidate verified: these are real, lived detail and the
  // brief must reuse them verbatim instead of inventing around them.
  const verified = (params.stories ?? []).filter((s) => isToldByCandidate(s.evidence));
  const verifiedBlock = verified.length
    ? `VERIFIED STORIES (told by the candidate — ground truth, reuse their exact details):\n${verified
        .slice(0, 10)
        .map(
          (s) =>
            `- ${s.title} [${s.category}]\n  ${[s.shortVersion, s.starVersion].filter(Boolean).join("\n  ")}\n  told: ${toldDetails(s.evidence).join("; ")}`
        )
        .join("\n")}`
    : "";

  const user = [
    `TARGET JOB:\n${JSON.stringify(jobSummary, null, 2)}`,
    `STRUCTURED CANDIDATE PROFILE:\n${JSON.stringify(params.candidate, null, 2)}`,
    `RAW RESUME (for evidence):\n${params.rawResumeText.slice(0, 6000)}`,
    verifiedBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: POSITIONING_BRIEF_PROMPT,
    user,
    schema: positioningBriefSchema,
    temperature: 0.4,
    timeoutMs: 60_000,
  });
}

// Loose enough to sound like a person talking, tight enough to stay on the facts.
const ANSWER_TEMPERATURE = 0.6;

/**
 * Generate a live interview answer as streamed Markdown deltas (answer body
 * followed by a trailing ---META--- JSON block). Used for the live session.
 */
export async function streamGenerateAnswer(params: {
  detectedQuestion: string;
  questionType?: string;
  recentTranscript: string;
  focusHint?: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  stories?: StoryLike[];
  positioning?: PositioningBrief | null;
  answerMode: AnswerMode;
  answerLanguage?: AnswerLanguage;
  boldKeywords: boolean;
  /** The brief answer already shown for this question; "deep" extends it. */
  expandOn?: string;
  /** When true, the model fills gaps with plausible, consistent specifics; off = strict grounding. */
  allowInventedDetails?: boolean;
  rawResumeFallback?: string;
  priorTurns?: PriorTurn[];
  codingContext?: string;
}) {
  const oneShot = !params.detectedQuestion.trim();

  // Use the most specific signal we have to retrieve relevant resume facts and
  // stories: an explicit question, else the latest-utterance focus hint, else
  // the whole transcript.
  const retrievalQuery =
    params.detectedQuestion.trim() ||
    (params.focusHint ?? "").trim() ||
    params.recentTranscript;

  const selected = selectContext({
    question: retrievalQuery,
    candidate: params.candidate,
    job: params.job,
    stories: params.stories,
  });

  const context = buildAnswerContext({
    detectedQuestion: params.detectedQuestion,
    questionType: params.questionType,
    recentTranscript: params.recentTranscript,
    focusHint: params.focusHint,
    candidate: params.candidate,
    job: params.job,
    selected,
    positioning: params.positioning,
    rawResumeFallback: params.rawResumeFallback,
    priorTurns: params.priorTurns,
    codingContext: params.codingContext,
  });

  const modeInstruction =
    ANSWER_MODE_INSTRUCTIONS[params.answerMode] ?? ANSWER_MODE_INSTRUCTIONS.brief;

  const expandInstruction =
    params.answerMode === "deep" && params.expandOn?.trim()
      ? `\n\nEXPANDING: the candidate was just shown this BRIEF answer to the same question:\n"""\n${params.expandOn.trim()}\n"""\nWrite the DEEP version of that SAME answer: same story, same facts, same opening point, with the next layer added. It replaces the brief one, so don't mention a brief version and don't switch to a different example.`
      : "";

  const oneShotInstruction = oneShot
    ? "\n\nNO EXPLICIT QUESTION WAS PROVIDED. YOU decide what's being asked: identify the interviewer's most recent question or prompt (it's at the end of the transcript; a focus hint may point at it). If they packed several asks into that latest turn, answer each. Ignore the candidate's own speech, greetings, and filler. If the latest turn is not actually something to answer yet (acknowledgement, small talk, the candidate speaking, or an unfinished fragment), output exactly NO_ANSWER and nothing else."
    : "";

  const language = languageBlock(params.answerLanguage);
  const languageInstruction = language ? `\n\n${language}` : "";

  const depth = questionDepthBlock(params.questionType);
  const depthInstruction = depth ? `\n\n${depth}` : "";

  const system = `${buildAnswerSystemPrompt(
    params.boldKeywords,
    params.allowInventedDetails ?? true
  )}${depthInstruction}\n\nMODE:\n${modeInstruction}${expandInstruction}${oneShotInstruction}${languageInstruction}`;

  // Live answers use the user-selectable "live answer" model (fastModel) so the
  // teleprompter streams quickly; heavy analysis stays on the strong model.
  return streamText({
    model: (await getRuntimeConfig()).fastModel,
    system,
    user: context,
    temperature: ANSWER_TEMPERATURE,
  });
}

/**
 * Solve (or fix / optimize / explain) a live coding problem from screenshot(s)
 * plus the interviewer's words. Streams the section-tagged coding block the
 * client parses into fixed zones.
 *
 * Two stages, one stream:
 *  1. A fast vision model streams MODE / PROBLEM / SAY within seconds, so the
 *     candidate can start talking while
 *  2. the strong model (as configured, Pro included; optionally its faster
 *     base model) writes the steps. A ContinuationFilter keeps stage 2 from
 *     repeating what stage 1 already delivered.
 * If stage 1 fails before saying anything, we fall back to a single full run.
 */
export async function* streamCodingSolution(params: {
  images?: string[];
  pastedText?: string;
  transcript?: string;
  language?: string;
  mode?: string;
  priorProblem?: string;
  currentCode?: string;
  candidate?: CandidateStructured | null;
  sessionContext?: string;
  useBaseModel?: boolean;
}): AsyncGenerator<string> {
  const userParts: string[] = [];

  const mode = (params.mode ?? "auto").trim();
  if (mode && mode !== "auto") {
    userParts.push(
      `MODE (the interviewer / candidate forced this — honor it): ${mode}`
    );
  }

  if (params.transcript?.trim()) {
    userParts.push(
      `WHAT THE INTERVIEWER JUST SAID (use for intent; may be messy live captions):\n${params.transcript.trim()}`
    );
  }
  if (params.pastedText?.trim()) {
    userParts.push(`PROBLEM (pasted by the candidate):\n${params.pastedText.trim()}`);
  }
  if (params.priorProblem?.trim()) {
    userParts.push(`EARLIER IN THIS CODING SESSION (context):\n${params.priorProblem.trim()}`);
  }
  if (params.currentCode?.trim()) {
    userParts.push(`CANDIDATE'S CURRENT CODE (build on / fix this):\n${params.currentCode.trim()}`);
  }
  if (params.candidate) {
    const c = params.candidate;
    const about = [
      c.name ? `Name: ${c.name}` : "",
      c.seniority ? `Seniority: ${c.seniority}` : "",
      c.core_stack.length ? `Core stack: ${c.core_stack.slice(0, 12).join(", ")}` : "",
      c.domains.length ? `Domains: ${c.domains.slice(0, 6).join(", ")}` : "",
    ].filter(Boolean);
    if (about.length) userParts.push(`ABOUT THE CANDIDATE:\n${about.join("\n")}`);
  }
  if (params.sessionContext?.trim()) {
    userParts.push(
      `SO FAR IN THIS INTERVIEW (what the candidate already told the interviewer — canon, stay consistent):\n${params.sessionContext.trim()}`
    );
  }

  const hasImages = Boolean(params.images && params.images.length);
  if (hasImages) {
    userParts.push(
      `The attached screenshot${
        (params.images as string[]).length > 1 ? "s show" : " shows"
      } the problem and possibly the candidate's editor. Read it carefully and solve THAT problem.`
    );
  }

  if (!userParts.length) {
    userParts.push("Solve the coding problem shown in the attached screenshot(s).");
  }

  const user = userParts.join("\n\n");
  const cfg = await getRuntimeConfig();
  const system = buildCodingSystemPrompt(params.language);

  // ---- Stage 1: fast talk track -------------------------------------------
  // Only worth it when there is real input to read (a screenshot or pasted
  // problem); a bare verbal question is quick enough in one stage.
  let spoken = "";
  // A follow-up has no screenshot but carries the earlier problem; the fast model
  // handles that as text only, which is cheap.
  const hasProblem =
    hasImages ||
    Boolean(params.pastedText?.trim()) ||
    Boolean(params.priorProblem?.trim());
  if (hasProblem && cfg.fastModel) {
    try {
      for await (const delta of streamText({
        model: cfg.fastModel,
        system: CODING_TALK_PROMPT,
        user,
        images: params.images,
        imageDetail: "high",
        reasoningTier: "fast",
        maxOutputTokens: 2000,
        temperature: 0.3,
      })) {
        spoken += delta;
        yield delta;
      }
    } catch {
      // Nothing said yet: fall through to a single full run. Something said:
      // keep it and let stage 2 finish the job.
      if (!spoken.trim()) spoken = "";
    }
    if (spoken && !spoken.endsWith("\n")) yield "\n";
  }

  // ---- Stage 2 (or the only stage): the strong model ----------------------
  const strongModel = cfg.strongModel;
  // Your Strong model exactly as picked (Pro included) unless asked for speed.
  const liveModel = params.useBaseModel ? liveCodingModel(strongModel) : strongModel;
  const continuing = Boolean(spoken.trim());
  const stageSystem = continuing ? `${system}\n\n${CODING_CONTINUE_PROMPT}` : system;
  const stageUser = continuing
    ? `${user}\n\nALREADY SAID TO THE INTERVIEWER (stay consistent with this; do not repeat it):\n${spoken.trim()}`
    : user;

  const run = (model: string) =>
    streamText({
      model,
      system: stageSystem,
      user: stageUser,
      images: params.images,
      imageDetail: "high",
      // Correctness over raw speed: think a notch harder than the live-answer tier.
      reasoningTier: "balanced",
      // Reasoning tokens are billed against this cap, and a hard problem can burn
      // thousands of them before a single character of code is written. A tight
      // cap leaves nothing for the script and the stream ends empty or cut
      // mid-step. Pro models always think at "high", so they need the most room.
      maxOutputTokens: isProModel(model) ? 32000 : 16000,
      temperature: 0.2,
    });

  const filter = continuing ? new ContinuationFilter() : null;
  let emitted = false;
  const forward = (text: string) => {
    if (text) emitted = true;
    return text;
  };

  try {
    for await (const delta of run(liveModel)) {
      const out = filter ? filter.push(delta) : delta;
      if (out) yield forward(out);
    }
  } catch (err) {
    // The de-pro'd model name may not exist (e.g. a dated pro snapshot). If
    // nothing came out of stage 2 yet, retry once with the configured model.
    const notFound = err instanceof LlmError && err.status === 404;
    if (emitted || !notFound || liveModel === strongModel) throw err;
    for await (const delta of run(strongModel)) {
      const out = filter ? filter.push(delta) : delta;
      if (out) yield forward(out);
    }
  }
  if (filter) {
    const rest = filter.flush();
    if (rest) yield rest;
  }
}

/** Cut an existing answer down to the brief version, streamed as text + ---META---. */
export async function streamRewriteAnswer(params: {
  detectedQuestion: string;
  answer: string;
  answerLanguage?: AnswerLanguage;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  boldKeywords: boolean;
}) {
  const constraints: string[] = [];
  constraints.push(
    params.boldKeywords
      ? "Emphasis: bold 1 to 3 key terms with double asterisks."
      : "Emphasis: plain text only — no bold or markdown emphasis."
  );

  const userParts = [
    `QUESTION:\n${params.detectedQuestion}`,
    `EXISTING ANSWER:\n${params.answer}`,
  ];
  if (params.candidate) {
    userParts.push(
      `CANDIDATE WEAK/MISSING EVIDENCE (never claim these): ${
        params.candidate.weak_or_missing_evidence.join(", ") || "(none)"
      }`
    );
  }

  const language = languageBlock(params.answerLanguage);
  const languageInstruction = language ? `\n\n${language}` : "";

  return streamText({
    // Same selectable "live answer" model as generation.
    model: (await getRuntimeConfig()).fastModel,
    system: `${REWRITE_PROMPT}${languageInstruction}\n\nCONSTRAINTS:\n- ${constraints.join(
      "\n- "
    )}`,
    user: userParts.join("\n\n"),
    temperature: ANSWER_TEMPERATURE,
  });
}

// Generating all ~16 categories in one JSON call produces a huge response that
// regularly truncates or times out (especially on the 30s default), so the whole
// batch fails. Generate in small chunks instead: each call is fast and reliable,
// runs in parallel, and a single chunk failing doesn't lose the rest.
const STORY_BATCH_SIZE = 4;

// Max story batches in flight at once — keeps things fast without hammering
// rate limits on lower OpenAI tiers.
const STORY_BATCH_CONCURRENCY = 2;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run async tasks with a concurrency cap, preserving order in the results. */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < tasks.length; i = next++) {
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

export interface PlannedCategory {
  id: string;
  label: string;
  focus?: string;
}

/**
 * Ask the model which story categories fit THIS candidate + role, so the story
 * bank isn't a hardcoded engineering list. Returns a role-tailored mix of
 * universal behavioral + field-specific categories, minus anything already
 * covered. Falls back to the universal set if planning yields nothing.
 */
export async function planStoryCategories(params: {
  candidate: CandidateStructured;
  job?: JobStructured | null;
  existingCategories?: string[];
}): Promise<PlannedCategory[]> {
  const userParts = [
    `STRUCTURED CANDIDATE PROFILE:\n${JSON.stringify(params.candidate, null, 2)}`,
  ];
  if (params.job) {
    const roleSummary = {
      role: params.job.role_title,
      seniority: params.job.seniority,
      domain: params.job.domain,
      must_have_skills: params.job.must_have_skills,
      responsibilities: params.job.responsibilities,
    };
    userParts.push(`TARGET ROLE:\n${JSON.stringify(roleSummary, null, 2)}`);
  }
  if (params.existingCategories?.length) {
    userParts.push(`ALREADY COVERED (do not repeat):\n${params.existingCategories.join(", ")}`);
  }

  const plan = await callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: STORY_CATEGORY_PLAN_PROMPT,
    user: userParts.join("\n\n"),
    schema: storyCategoryPlanSchema,
    temperature: 0.3,
  });

  return plan.categories.map((c) => ({
    id: c.id,
    label: c.label || c.id,
    focus: c.focus,
  }));
}

async function generateStoryBatch(
  model: string,
  candidate: CandidateStructured,
  rawResumeText: string,
  categories: PlannedCategory[]
) {
  const categoryLines = categories
    .map((c) => `- ${c.id} — ${c.label}${c.focus ? `: ${c.focus}` : ""}`)
    .join("\n");

  const user = [
    `STRUCTURED CANDIDATE PROFILE:\n${JSON.stringify(candidate, null, 2)}`,
    `RAW RESUME (for evidence only):\n${rawResumeText.slice(0, 6000)}`,
    `GENERATE ONE STORY FOR EACH OF THESE CATEGORIES:\n${categoryLines}`,
  ].join("\n\n");

  return callJson({
    model,
    system: STORY_GEN_PROMPT,
    user,
    schema: generatedStoriesSchema,
    temperature: 0.5,
    timeoutMs: 60_000,
  });
}

const universalPlanned = (): PlannedCategory[] =>
  UNIVERSAL_STORY_CATEGORIES.map((id) => ({
    id,
    label: STORY_CATEGORY_LABELS[id] ?? id,
  }));

export async function generateStories(params: {
  candidate: CandidateStructured;
  rawResumeText: string;
  job?: JobStructured | null;
  existingCategories?: string[];
  /** Optional explicit categories; if omitted, they're planned for the role. */
  categories?: PlannedCategory[];
}) {
  const model = (await getRuntimeConfig()).strongModel;
  const existing = new Set(
    (params.existingCategories ?? []).map((c) => c.toLowerCase())
  );

  // Resolve which categories to build: explicit > role-tailored plan > universal.
  let planned: PlannedCategory[];
  if (params.categories?.length) {
    planned = params.categories;
  } else {
    let fromPlan: PlannedCategory[] = [];
    try {
      fromPlan = await planStoryCategories({
        candidate: params.candidate,
        job: params.job,
        existingCategories: params.existingCategories,
      });
    } catch {
      // Planning is best-effort; fall back to the universal set below.
    }
    planned = fromPlan.length ? fromPlan : universalPlanned();
  }

  // Never regenerate a category the bank already has.
  planned = planned.filter((c) => c.id && !existing.has(c.id.toLowerCase()));
  if (planned.length === 0) return { stories: [] };

  const batches = chunk(planned, STORY_BATCH_SIZE);

  const results = await runWithConcurrency(
    batches.map(
      (cats) => () =>
        generateStoryBatch(model, params.candidate, params.rawResumeText, cats)
    ),
    STORY_BATCH_CONCURRENCY
  );

  const stories = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value.stories : []
  );

  // Surface an error only if EVERY batch failed (otherwise return what we got).
  if (stories.length === 0) {
    const firstRejected = results.find((r) => r.status === "rejected");
    if (firstRejected && firstRejected.status === "rejected") {
      throw firstRejected.reason;
    }
  }

  return { stories };
}

export async function improveStory(params: {
  title: string;
  category: string;
  shortVersion: string;
  starVersion: string;
  technicalVersion: string;
  keywords: string[];
  evidence: string[];
}) {
  const user = `EXISTING STORY (improve tone only, keep facts):\n${JSON.stringify(
    {
      title: params.title,
      category: params.category,
      short_version: params.shortVersion,
      star_version: params.starVersion,
      technical_version: params.technicalVersion,
      keywords: params.keywords,
      evidence: params.evidence,
    },
    null,
    2
  )}`;

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: STORY_IMPROVE_PROMPT,
    user,
    schema: generatedStoriesSchema,
    temperature: 0.5,
  });
}

function storyForPrompt(story: SharpenStory) {
  return {
    title: story.title,
    category: story.category,
    short_version: story.shortVersion,
    star_version: story.starVersion,
    technical_version: story.technicalVersion,
    keywords: story.keywords,
    evidence: story.evidence,
  };
}

/** Questions that pull real, lived detail out of the candidate for one story. */
export async function generateSharpenQuestions(params: {
  story: SharpenStory;
  candidate?: CandidateStructured | null;
}) {
  const user = [
    `STORY:\n${JSON.stringify(storyForPrompt(params.story), null, 2)}`,
    params.candidate
      ? `CANDIDATE (for context only):\n${JSON.stringify(
          {
            seniority: params.candidate.seniority,
            core_stack: params.candidate.core_stack,
            companies: params.candidate.companies,
          },
          null,
          2
        )}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: STORY_SHARPEN_QUESTIONS_PROMPT,
    user,
    schema: sharpenQuestionsSchema,
    temperature: 0.6,
    timeoutMs: 60_000,
  });

  // Stable ids even if the model omitted or repeated them.
  return result.questions.slice(0, 6).map((q, i) => ({ id: `q${i + 1}`, question: q.question.trim() }));
}

/** Fold the candidate's own answers into the story; nothing else is added. */
export async function mergeSharpenAnswers(params: {
  story: SharpenStory;
  answers: Array<{ question: string; answer: string }>;
}) {
  const answered = params.answers.filter((a) => a.answer.trim());
  if (answered.length === 0) return null;

  const user = [
    `EXISTING STORY:\n${JSON.stringify(storyForPrompt(params.story), null, 2)}`,
    `THE CANDIDATE'S ANSWERS (the only new facts):\n${answered
      .map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer.trim()}`)
      .join("\n\n")}`,
  ].join("\n\n");

  const { stories } = await callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: STORY_SHARPEN_MERGE_PROMPT,
    user,
    schema: generatedStoriesSchema,
    temperature: 0.4,
    timeoutMs: 90_000,
  });
  return stories[0] ?? null;
}

export async function generateReview(params: {
  sessionTitle: string;
  transcript: string;
  turns: Array<{
    detectedQuestion: string;
    questionType: string;
    generatedAnswer: string;
    confidence: string;
    riskNote: string;
  }>;
}) {
  const turnsText = params.turns
    .map(
      (t, i) =>
        `Q${i + 1} [${t.questionType}] (${t.confidence}${
          t.riskNote ? `, risk: ${t.riskNote}` : ""
        }): ${t.detectedQuestion}\nAnswer: ${t.generatedAnswer}`
    )
    .join("\n\n");

  const user = [
    `SESSION: ${params.sessionTitle}`,
    params.transcript.trim()
      ? `TRANSCRIPT:\n${params.transcript.slice(0, 6000)}`
      : "TRANSCRIPT: (none recorded)",
    turnsText ? `RECORDED TURNS:\n${turnsText}` : "RECORDED TURNS: (none)",
  ].join("\n\n");

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: REVIEW_PROMPT,
    user,
    schema: postInterviewReviewSchema,
    temperature: 0.4,
  });
}
