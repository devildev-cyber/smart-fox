import type {
  AnswerLanguage,
  AnswerMode,
  Confidence,
  InterviewStage,
  QuestionType,
} from "./schemas";

// Labels for the universal, role-agnostic categories. Role-specific categories
// (chosen per candidate at generation time) won't be in this map — use
// storyCategoryLabel() to render any slug with a sensible humanized fallback.
export const STORY_CATEGORY_LABELS: Record<string, string> = {
  tell_me_about_yourself: "Tell me about yourself",
  signature_project: "Signature project",
  biggest_impact: "Biggest impact",
  leadership_or_ownership: "Leadership / ownership",
  teamwork_and_collaboration: "Teamwork & collaboration",
  handling_conflict: "Handling conflict",
  overcoming_failure: "Overcoming failure",
  adapting_to_change: "Adapting to change",
  driving_improvement: "Driving improvement",
  why_this_role: "Why this role",
};

/** Human label for any category slug — mapped when known, else humanized. */
export function storyCategoryLabel(slug: string): string {
  if (STORY_CATEGORY_LABELS[slug]) return STORY_CATEGORY_LABELS[slug];
  const words = slug.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

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
  brief: "Brief",
  deep: "Deep",
};

export const INTERVIEW_STAGE_LABELS: Record<InterviewStage, string> = {
  general: "General / mixed",
  recruiter_hr: "Recruiter / HR screen",
  behavioral: "Behavioral",
  technical: "Technical / system design",
  culture_fit: "Culture / values (final)",
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
  autoAnswer: boolean;
  boldKeywords: boolean;
  /**
   * When on (default), the model fills thin spots with realistic, consistent
   * specifics so answers sound like a real practitioner, and keeps them
   * consistent for the rest of the interview. Off = strict grounding: only use
   * details actually present in the profile, stories, and JD.
   */
  allowInventedDetails: boolean;
  /**
   * Live coding: on (default) swaps a Pro model for its base model, which is
   * much faster and cheaper. Off = use your Strong model exactly as picked, Pro
   * included (most accurate, but it can take minutes and costs far more).
   */
  codingBaseModel: boolean;
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
  /**
   * Stealth: exclude the desktop overlay from screen capture / screen share
   * (and hide it from the taskbar). On by default. Desktop app only.
   */
  stealth: boolean;
  /** On-screen size of the generated answer text. */
  answerFontSize: AnswerFontSize;
  /** Language the generated answer is written in. "zh" adds per-character pinyin. */
  answerLanguage: AnswerLanguage;
}

export type AnswerFontSize = "sm" | "base" | "lg" | "xl";

export const ANSWER_FONT_SIZE_LABELS: Record<AnswerFontSize, string> = {
  sm: "Small",
  base: "Medium",
  lg: "Large",
  xl: "Extra large",
};

export const DEFAULT_SETTINGS: AppSettings = {
  autoAnswer: false,
  boldKeywords: false,
  allowInventedDetails: true,
  codingBaseModel: true,
  transcriptWindowSeconds: 90,
  sttSegmentSeconds: 4,
  sttLanguage: "en",
  // Silence (in seconds) before we treat the interviewer's turn as finished.
  // Lower = snappier live trigger; a superseding run aborts a slightly-early one.
  endOfTurnSeconds: 1.2,
  stealth: true,
  answerFontSize: "base",
  answerLanguage: "en",
};

export const ANSWER_LANGUAGES: { value: AnswerLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese (with pinyin)" },
];

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
