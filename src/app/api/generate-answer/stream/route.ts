import { jsonError, parseBody, streamTextResponse } from "@/lib/api";
import { generateAnswerRequestSchema } from "@/lib/schemas";
import { streamGenerateAnswer } from "@/lib/llm-tasks";
import { loadAllStories, loadCandidateStructured, loadJobStructured } from "@/lib/repo";
import { getRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, generateAnswerRequestSchema);
  if (error) return error;

  const cfg = await getRuntimeConfig();
  if (!cfg.openaiApiKey) {
    return jsonError(
      "OpenAI API key is not configured. Add it on the Settings page.",
      503
    );
  }

  const [{ candidate, rawResumeText }, job, stories] = await Promise.all([
    loadCandidateStructured(data.candidateProfileId),
    loadJobStructured(data.jobProfileId),
    loadAllStories(),
  ]);

  const generator = await streamGenerateAnswer({
    detectedQuestion: data.detectedQuestion,
    questionType: data.questionType,
    recentTranscript: data.recentTranscript,
    candidate,
    job,
    stories,
    answerMode: data.answerMode,
    maxSentences: data.maxSentences,
    boldKeywords: data.boldKeywords,
    rawResumeFallback: candidate ? undefined : rawResumeText || undefined,
    priorTurns: data.priorTurns,
  });

  return streamTextResponse(generator);
}
