import type {
  AnswerMode,
  Confidence,
  InterviewStage,
  QuestionType,
  StoryCategory,
} from "./schemas";

export const STORY_CATEGORY_LABELS: Record<StoryCategory, string> = {
  tell_me_about_yourself: "Tell me about yourself",
  backend_experience: "Backend experience",
  frontend_experience: "Frontend experience",
  cloud_experience: "Cloud experience",
  production_bug: "Production bug",
  architecture_decision: "Architecture decision",
  performance_optimization: "Performance optimization",
  security: "Security",
  mentoring: "Mentoring",
  stakeholder_collaboration: "Stakeholder collaboration",
  conflict: "Conflict",
  mistake: "Mistake",
  learning_new_tech: "Learning new tech",
  legacy_refactor: "Legacy refactor",
  distributed_team: "Distributed team",
  integration_project: "Integration project",
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  hr: "HR",
  behavioral: "Behavioral",
  technical: "Technical",
  system_design: "System design",
  salary: "Salary",
  logistics: "Logistics",
  other: "Other",
};

export const ANSWER_MODE_LABELS: Record<AnswerMode, string> = {
  default: "Default",
  shorter: "Shorter",
  more_senior: "More senior",
  star: "STAR",
  technical: "Technical",
  human: "Human",
  safer: "Safer",
  follow_up: "Follow-up",
};

export const INTERVIEW_STAGE_LABELS: Record<InterviewStage, string> = {
  general: "General / mixed",
  recruiter_hr: "Recruiter / HR screen",
  behavioral: "Behavioral",
  technical: "Technical / system design",
  culture_fit: "Culture / values (final)",
};

// Short helper text shown under the session-page stage selector.
export const INTERVIEW_STAGE_HINTS: Record<InterviewStage, string> = {
  general: "Adapts to each question",
  recruiter_hr: "Short, warm, high-level",
  behavioral: "STAR stories, ownership",
  technical: "Deep, precise, tradeoffs",
  culture_fit: "Casual, values, fit",
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export const NAV_ITEMS = [
  { href: "/setup", label: "Setup" },
  { href: "/session", label: "Session" },
  { href: "/stories", label: "Stories" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
] as const;

export interface AppSettings {
  defaultAnswerMode: AnswerMode;
  /** Which interview round to assume at the start of a session. */
  defaultInterviewStage: InterviewStage;
  autoAnswer: boolean;
  boldKeywords: boolean;
  maxSentences: number;
  transcriptWindowSeconds: number;
  /** Length of each OpenAI transcription segment, in seconds. Lower = less lag. */
  sttSegmentSeconds: number;
  /** Transcription language as an ISO-639-1 code, or "auto" to detect. */
  sttLanguage: string;
  /**
   * How long the interviewer must pause (no new captions) before we treat their
   * turn as finished — the moment to surface "ready" / auto-answer. Higher =
   * fewer premature triggers mid-question.
   */
  endOfTurnSeconds: number;
  /** On-screen size of the generated answer text. */
  answerFontSize: AnswerFontSize;
}

export type AnswerFontSize = "sm" | "base" | "lg" | "xl";

export const ANSWER_FONT_SIZE_LABELS: Record<AnswerFontSize, string> = {
  sm: "Small",
  base: "Medium",
  lg: "Large",
  xl: "Extra large",
};

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAnswerMode: "default",
  defaultInterviewStage: "general",
  autoAnswer: false,
  boldKeywords: false,
  maxSentences: 4,
  transcriptWindowSeconds: 90,
  sttSegmentSeconds: 4,
  sttLanguage: "en",
  endOfTurnSeconds: 1.8,
  answerFontSize: "base",
};

export const STT_LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "auto", label: "Auto-detect (slower)" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "hi", label: "Hindi" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
];

export const SETTINGS_STORAGE_KEY = "interview-coach-settings";
