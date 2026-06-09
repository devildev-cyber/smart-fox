import { callJson, streamText } from "./llm";
import { getRuntimeConfig } from "./runtime-config";
import {
  ANSWER_MODE_INSTRUCTIONS,
  buildAnswerSystemPrompt,
  CANDIDATE_EXTRACT_PROMPT,
  INTERVIEW_STAGE_INSTRUCTIONS,
  JOB_EXTRACT_PROMPT,
  QUESTION_DETECTOR_PROMPT,
  REVIEW_PROMPT,
  REWRITE_PROMPT,
  STORY_GEN_PROMPT,
  STORY_IMPROVE_PROMPT,
} from "./prompts";
import {
  candidateStructuredSchema,
  detectQuestionResponseSchema,
  generatedStoriesSchema,
  jobStructuredSchema,
  postInterviewReviewSchema,
  type AnswerMode,
  type CandidateStructured,
  type InterviewStage,
  type JobStructured,
} from "./schemas";
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

export async function detectQuestion(params: {
  recentTranscript: string;
  previousQuestion?: string;
  candidateName?: string;
}) {
  const userParts = [`RECENT TRANSCRIPT:\n${params.recentTranscript}`];
  if (params.previousQuestion) {
    userParts.push(`PREVIOUS QUESTION (already handled, ignore if repeated):\n${params.previousQuestion}`);
  }
  if (params.candidateName) {
    userParts.push(`CANDIDATE NAME (this person is the candidate, not the interviewer): ${params.candidateName}`);
  }

  return callJson({
    model: (await getRuntimeConfig()).fastModel,
    system: QUESTION_DETECTOR_PROMPT,
    user: userParts.join("\n\n"),
    schema: detectQuestionResponseSchema,
    temperature: 0.1,
  });
}

// Per-round sampling temperature. Technical rounds want precision (lower);
// recruiter and culture chats want warmth and variety (higher). The "human"
// mode always nudges things looser on top of the stage baseline.
const STAGE_TEMPERATURE: Record<string, number> = {
  general: 0.6,
  technical: 0.4,
  behavioral: 0.55,
  recruiter_hr: 0.7,
  culture_fit: 0.85,
};

function answerTemperature(stage: InterviewStage | undefined, mode: AnswerMode): number {
  const base = STAGE_TEMPERATURE[stage ?? "general"] ?? 0.6;
  if (mode === "human") return Math.max(base, 0.85);
  return base;
}

function stageBlock(stage: InterviewStage | undefined): string {
  const instruction =
    INTERVIEW_STAGE_INSTRUCTIONS[stage ?? "general"] ??
    INTERVIEW_STAGE_INSTRUCTIONS.general;
  return `INTERVIEW STAGE (sets the depth + tone for this round; takes priority over the generic DEPTH guidance when they differ):\n${instruction}`;
}

/**
 * Generate a live interview answer as streamed Markdown deltas (answer body
 * followed by a trailing ---META--- JSON block). Used for the live session.
 */
export async function streamGenerateAnswer(params: {
  detectedQuestion: string;
  questionType?: string;
  recentTranscript: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  stories?: StoryLike[];
  answerMode: AnswerMode;
  interviewStage?: InterviewStage;
  maxSentences: number;
  boldKeywords: boolean;
  rawResumeFallback?: string;
  priorTurns?: PriorTurn[];
}) {
  const oneShot = !params.detectedQuestion.trim();

  const selected = selectContext({
    question: params.detectedQuestion.trim() || params.recentTranscript,
    candidate: params.candidate,
    job: params.job,
    stories: params.stories,
  });

  const context = buildAnswerContext({
    detectedQuestion: params.detectedQuestion,
    questionType: params.questionType,
    recentTranscript: params.recentTranscript,
    candidate: params.candidate,
    job: params.job,
    selected,
    rawResumeFallback: params.rawResumeFallback,
    priorTurns: params.priorTurns,
  });

  const modeInstruction =
    ANSWER_MODE_INSTRUCTIONS[params.answerMode] ?? ANSWER_MODE_INSTRUCTIONS.default;

  const oneShotInstruction = oneShot
    ? "\n\nNO EXPLICIT QUESTION WAS PROVIDED. Identify every distinct question or prompt the interviewer is asking the candidate to respond to right now (a prompt may not end in '?'). Ignore the candidate's own speech, greetings, and filler. If there is no clear prompt yet, give a brief, safe holding answer."
    : "";

  const system = `${buildAnswerSystemPrompt(params.maxSentences, params.boldKeywords)}\n\n${stageBlock(
    params.interviewStage
  )}\n\nMODE:\n${modeInstruction}${oneShotInstruction}`;

  // Live answers use the user-selectable "live answer" model (fastModel) so the
  // teleprompter streams quickly; heavy analysis stays on the strong model.
  return streamText({
    model: (await getRuntimeConfig()).fastModel,
    system,
    user: context,
    temperature: answerTemperature(params.interviewStage, params.answerMode),
  });
}

/** Rewrite an existing answer into a new mode, streamed as Markdown + ---META---. */
export async function streamRewriteAnswer(params: {
  detectedQuestion: string;
  answer: string;
  answerMode: AnswerMode;
  interviewStage?: InterviewStage;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  maxSentences: number;
  boldKeywords: boolean;
}) {
  const modeInstruction =
    ANSWER_MODE_INSTRUCTIONS[params.answerMode] ?? ANSWER_MODE_INSTRUCTIONS.default;

  const constraints: string[] = [];
  if (params.maxSentences > 0) {
    constraints.push(
      `Keep it to a lead line plus at most ${Math.max(
        2,
        Math.min(params.maxSentences, 5)
      )} short bullets.`
    );
  }
  constraints.push(
    params.boldKeywords
      ? "Emphasis: bold 1 to 3 key terms with double asterisks."
      : "Emphasis: plain text only — no bold or markdown emphasis."
  );

  const userParts = [
    `QUESTION:\n${params.detectedQuestion}`,
    `EXISTING ANSWER:\n${params.answer}`,
    `TARGET MODE:\n${modeInstruction}`,
  ];
  if (params.candidate) {
    userParts.push(
      `CANDIDATE WEAK/MISSING EVIDENCE (never claim these): ${
        params.candidate.weak_or_missing_evidence.join(", ") || "(none)"
      }`
    );
  }

  return streamText({
    // Same selectable "live answer" model as generation.
    model: (await getRuntimeConfig()).fastModel,
    system: `${REWRITE_PROMPT}\n\n${stageBlock(params.interviewStage)}\n\nCONSTRAINTS:\n- ${constraints.join(
      "\n- "
    )}`,
    user: userParts.join("\n\n"),
    temperature: answerTemperature(params.interviewStage, params.answerMode),
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

async function generateStoryBatch(
  model: string,
  candidate: CandidateStructured,
  rawResumeText: string,
  categories: string[]
) {
  const categoryLines = categories
    .map((c) => `- ${c} (${STORY_CATEGORY_LABELS[c as keyof typeof STORY_CATEGORY_LABELS] ?? c})`)
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

export async function generateStories(params: {
  candidate: CandidateStructured;
  rawResumeText: string;
  categories: string[];
}) {
  const model = (await getRuntimeConfig()).strongModel;
  const batches = chunk(params.categories, STORY_BATCH_SIZE);

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
