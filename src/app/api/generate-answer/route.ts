import { handleRouteError, jsonOk, parseBody } from "@/lib/api";
import { generateAnswerRequestSchema } from "@/lib/schemas";
import { generateAnswer } from "@/lib/llm-tasks";
import { loadAllStories, loadCandidateStructured, loadJobStructured } from "@/lib/repo";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, generateAnswerRequestSchema);
  if (error) return error;

  try {
    const [{ candidate, rawResumeText }, job, stories] = await Promise.all([
      loadCandidateStructured(data.candidateProfileId),
      loadJobStructured(data.jobProfileId),
      loadAllStories(),
    ]);

    const result = await generateAnswer({
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
    });

    return jsonOk(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
