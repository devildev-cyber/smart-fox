import { handleRouteError, jsonOk, parseBody } from "@/lib/api";
import { rewriteAnswerRequestSchema } from "@/lib/schemas";
import { rewriteAnswer } from "@/lib/llm-tasks";
import { loadCandidateStructured, loadJobStructured } from "@/lib/repo";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, rewriteAnswerRequestSchema);
  if (error) return error;

  try {
    const [{ candidate }, job] = await Promise.all([
      loadCandidateStructured(data.candidateProfileId),
      loadJobStructured(data.jobProfileId),
    ]);

    const result = await rewriteAnswer({
      detectedQuestion: data.detectedQuestion,
      answer: data.answer,
      answerMode: data.answerMode,
      candidate,
      job,
      maxSentences: data.maxSentences,
      boldKeywords: data.boldKeywords,
    });

    return jsonOk(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
