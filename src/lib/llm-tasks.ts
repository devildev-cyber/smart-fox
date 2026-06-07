import { callJson } from "./llm";
import { getRuntimeConfig } from "./runtime-config";
import {
  ANSWER_MODE_INSTRUCTIONS,
  buildAnswerSystemPrompt,
  CANDIDATE_EXTRACT_PROMPT,
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
  generateAnswerResponseSchema,
  generatedStoriesSchema,
  jobStructuredSchema,
  postInterviewReviewSchema,
  type AnswerMode,
  type CandidateStructured,
  type JobStructured,
} from "./schemas";
import { buildAnswerContext, selectContext, type StoryLike } from "./context";
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

export async function generateAnswer(params: {
  detectedQuestion: string;
  questionType?: string;
  recentTranscript: string;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  stories?: StoryLike[];
  answerMode: AnswerMode;
  maxSentences: number;
  boldKeywords: boolean;
  rawResumeFallback?: string;
}) {
  // One-shot mode: no explicit question, so use the transcript both to select
  // context and to let the model infer the question.
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
  });

  const modeInstruction =
    ANSWER_MODE_INSTRUCTIONS[params.answerMode] ?? ANSWER_MODE_INSTRUCTIONS.default;

  const oneShotInstruction = oneShot
    ? "\n\nNO EXPLICIT QUESTION WAS PROVIDED. From the recent transcript, identify the single latest real question the interviewer is asking the candidate right now. Ignore the candidate's own speech, greetings, and filler. Put that question in 'detected_question' and answer it. If there is no clear question yet, set 'detected_question' to \"\" and give a brief, safe holding answer."
    : "";

  const system = `${buildAnswerSystemPrompt(params.maxSentences, params.boldKeywords)}\n\nMODE:\n${modeInstruction}${oneShotInstruction}`;

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system,
    user: context,
    schema: generateAnswerResponseSchema,
    temperature: params.answerMode === "human" ? 0.8 : 0.6,
  });
}

export async function rewriteAnswer(params: {
  detectedQuestion: string;
  answer: string;
  answerMode: AnswerMode;
  candidate?: CandidateStructured | null;
  job?: JobStructured | null;
  maxSentences: number;
  boldKeywords: boolean;
}) {
  const modeInstruction =
    ANSWER_MODE_INSTRUCTIONS[params.answerMode] ?? ANSWER_MODE_INSTRUCTIONS.default;

  const constraints: string[] = [];
  if (params.maxSentences > 0) {
    constraints.push(`Never exceed ${params.maxSentences} sentences.`);
  }
  constraints.push(
    params.boldKeywords
      ? "You may wrap 1-3 key terms in **double asterisks**."
      : "Do not use markdown. Plain spoken text only."
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

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: `${REWRITE_PROMPT}\n\nCONSTRAINTS:\n- ${constraints.join("\n- ")}`,
    user: userParts.join("\n\n"),
    schema: generateAnswerResponseSchema,
    temperature: params.answerMode === "human" ? 0.85 : 0.5,
  });
}

export async function generateStories(params: {
  candidate: CandidateStructured;
  rawResumeText: string;
  categories: string[];
}) {
  const categoryLines = params.categories
    .map((c) => `- ${c} (${STORY_CATEGORY_LABELS[c as keyof typeof STORY_CATEGORY_LABELS] ?? c})`)
    .join("\n");

  const user = [
    `STRUCTURED CANDIDATE PROFILE:\n${JSON.stringify(params.candidate, null, 2)}`,
    `RAW RESUME (for evidence only):\n${params.rawResumeText.slice(0, 6000)}`,
    `GENERATE ONE STORY FOR EACH OF THESE CATEGORIES:\n${categoryLines}`,
  ].join("\n\n");

  return callJson({
    model: (await getRuntimeConfig()).strongModel,
    system: STORY_GEN_PROMPT,
    user,
    schema: generatedStoriesSchema,
    temperature: 0.5,
  });
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
