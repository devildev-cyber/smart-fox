import { z } from "zod";

/* ----------------------------- Shared enums ----------------------------- */

export const questionTypeSchema = z.enum([
  "hr",
  "behavioral",
  "technical",
  "system_design",
  "salary",
  "logistics",
  "other",
]);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const confidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const answerModeSchema = z.enum([
  "default",
  "shorter",
  "more_senior",
  "star",
  "technical",
  "human",
  "safer",
  "follow_up",
]);
export type AnswerMode = z.infer<typeof answerModeSchema>;

export const storyCategorySchema = z.enum([
  "tell_me_about_yourself",
  "backend_experience",
  "frontend_experience",
  "cloud_experience",
  "production_bug",
  "architecture_decision",
  "performance_optimization",
  "security",
  "mentoring",
  "stakeholder_collaboration",
  "conflict",
  "mistake",
  "learning_new_tech",
  "legacy_refactor",
  "distributed_team",
  "integration_project",
]);
export type StoryCategory = z.infer<typeof storyCategorySchema>;

export const STORY_CATEGORIES: StoryCategory[] = storyCategorySchema.options;

/* --------------------------- Structured profiles --------------------------- */

export const candidateStructuredSchema = z.object({
  name: z.string().default(""),
  seniority: z.string().default(""),
  target_titles: z.array(z.string()).default([]),
  core_stack: z.array(z.string()).default([]),
  secondary_stack: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  companies: z.array(z.string()).default([]),
  projects: z.array(z.string()).default([]),
  metrics: z.array(z.string()).default([]),
  leadership: z.array(z.string()).default([]),
  strong_evidence: z.array(z.string()).default([]),
  weak_or_missing_evidence: z.array(z.string()).default([]),
  best_story_angles: z.array(z.string()).default([]),
});
export type CandidateStructured = z.infer<typeof candidateStructuredSchema>;

export const jobStructuredSchema = z.object({
  company: z.string().default(""),
  role_title: z.string().default(""),
  seniority: z.string().default(""),
  must_have_skills: z.array(z.string()).default([]),
  preferred_skills: z.array(z.string()).default([]),
  domain: z.string().default(""),
  responsibilities: z.array(z.string()).default([]),
  likely_interview_focus: z.array(z.string()).default([]),
  likely_questions: z.array(z.string()).default([]),
  resume_match_keywords: z.array(z.string()).default([]),
});
export type JobStructured = z.infer<typeof jobStructuredSchema>;

/* ----------------------------- LLM responses ----------------------------- */

export const detectQuestionResponseSchema = z.object({
  has_question: z.boolean(),
  question: z.string().nullable(),
  question_type: questionTypeSchema,
  confidence: confidenceSchema,
  reason: z.string(),
});
export type DetectQuestionResponse = z.infer<typeof detectQuestionResponseSchema>;

export const generateAnswerResponseSchema = z.object({
  detected_question: z.string(),
  answer: z.string(),
  keywords: z.array(z.string()).default([]),
  confidence: confidenceSchema,
  risk_note: z.string().default(""),
  possible_follow_up: z.string().default(""),
});
export type GenerateAnswerResponse = z.infer<typeof generateAnswerResponseSchema>;

// Trailing ---META--- block parsed from a streamed answer. Confidence is lenient
// (the model occasionally omits it) and defaults to "medium".
export const answerMetaSchema = z.object({
  detected_question: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  confidence: confidenceSchema.catch("medium").default("medium"),
  risk_note: z.string().default(""),
  possible_follow_up: z.string().default(""),
});
export type AnswerMeta = z.infer<typeof answerMetaSchema>;

export const generatedStorySchema = z.object({
  title: z.string(),
  category: storyCategorySchema,
  short_version: z.string(),
  star_version: z.string(),
  technical_version: z.string(),
  keywords: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});
export type GeneratedStory = z.infer<typeof generatedStorySchema>;

export const generatedStoriesSchema = z.object({
  stories: z.array(generatedStorySchema).default([]),
});

export const postInterviewReviewSchema = z.object({
  questions_asked: z.array(z.string()).default([]),
  strongest_answers: z.array(z.string()).default([]),
  weak_answers: z.array(z.string()).default([]),
  missing_prep_areas: z.array(z.string()).default([]),
  follow_up_email: z.string().default(""),
});
export type PostInterviewReview = z.infer<typeof postInterviewReviewSchema>;

/* ----------------------------- API requests ----------------------------- */

export const analyzeResumeRequestSchema = z.object({
  rawResumeText: z.string().min(1, "Resume text is required"),
});

export const analyzeJobRequestSchema = z.object({
  rawJobDescription: z.string().min(1, "Job description is required"),
});

export const detectQuestionRequestSchema = z.object({
  recentTranscript: z.string().min(1, "Transcript is required"),
  previousQuestion: z.string().optional(),
  candidateName: z.string().optional(),
});

export const priorTurnSchema = z.object({
  question: z.string().default(""),
  answerGist: z.string().default(""),
});
export type PriorTurnInput = z.infer<typeof priorTurnSchema>;

export const generateAnswerRequestSchema = z
  .object({
    candidateProfileId: z.string().optional(),
    jobProfileId: z.string().optional(),
    recentTranscript: z.string().default(""),
    // Optional: if empty, the model infers the latest question from the
    // transcript and answers it in a single call (faster).
    detectedQuestion: z.string().default(""),
    questionType: questionTypeSchema.optional(),
    answerMode: answerModeSchema.default("default"),
    maxSentences: z.number().int().min(1).max(8).default(4),
    boldKeywords: z.boolean().default(false),
    // Prior answered turns this session, so the model can reference instead of repeat.
    priorTurns: z.array(priorTurnSchema).default([]),
  })
  .refine((d) => d.detectedQuestion.trim() || d.recentTranscript.trim(), {
    message: "Provide a detected question or some recent transcript.",
  });

export const rewriteAnswerRequestSchema = z.object({
  detectedQuestion: z.string().min(1),
  answer: z.string().min(1, "An existing answer is required"),
  answerMode: answerModeSchema,
  candidateProfileId: z.string().optional(),
  jobProfileId: z.string().optional(),
  maxSentences: z.number().int().min(1).max(8).default(4),
  boldKeywords: z.boolean().default(false),
});

export const generateStoriesRequestSchema = z.object({
  candidateProfileId: z.string().min(1, "A candidate profile is required"),
  existingCategories: z.array(z.string()).default([]),
});

export const improveStoryRequestSchema = z.object({
  storyId: z.string().min(1),
});

/* ----------------------------- DB write schemas ----------------------------- */

export const storyInputSchema = z.object({
  title: z.string().min(1, "Title is required"),
  category: storyCategorySchema,
  shortVersion: z.string().default(""),
  starVersion: z.string().default(""),
  technicalVersion: z.string().default(""),
  keywords: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});
export type StoryInput = z.infer<typeof storyInputSchema>;

export const sessionInputSchema = z.object({
  title: z.string().min(1, "Title is required"),
  candidateProfileId: z.string().optional().nullable(),
  jobProfileId: z.string().optional().nullable(),
});

export const turnInputSchema = z.object({
  sessionId: z.string().min(1),
  rawTranscript: z.string().default(""),
  detectedQuestion: z.string().default(""),
  questionType: z.string().default("other"),
  generatedAnswer: z.string().default(""),
  answerMode: z.string().default("default"),
  keywords: z.array(z.string()).default([]),
  confidence: z.string().default("medium"),
  riskNote: z.string().default(""),
  possibleFollowUp: z.string().default(""),
});

export const reviewRequestSchema = z.object({
  sessionId: z.string().min(1),
});
