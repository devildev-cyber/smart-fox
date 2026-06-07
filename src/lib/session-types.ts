import type {
  DetectQuestionResponse,
  GenerateAnswerResponse,
} from "./schemas";

export type DetectResult = DetectQuestionResponse;
export type AnswerResult = GenerateAnswerResponse;

export type {
  ConfigStatus,
  ProfilesResponse,
  CandidateProfileDto,
  JobProfileDto,
} from "./types";
