import { jsonError, parseBody, streamTextResponse } from "@/lib/api";
import { rewriteAnswerRequestSchema } from "@/lib/schemas";
import { streamRewriteAnswer } from "@/lib/llm-tasks";
import { loadCandidateStructured, loadJobStructured } from "@/lib/repo";
import { getRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, rewriteAnswerRequestSchema);
  if (error) return error;

  const cfg = await getRuntimeConfig();
  if (!cfg.openaiApiKey) {
    return jsonError(
      "OpenAI API key is not configured. Add it on the Settings page.",
      503
    );
  }

  const [{ candidate }, job] = await Promise.all([
    loadCandidateStructured(data.candidateProfileId),
    loadJobStructured(data.jobProfileId),
  ]);

  const generator = await streamRewriteAnswer({
    detectedQuestion: data.detectedQuestion,
    answer: data.answer,
    answerMode: data.answerMode,
    candidate,
    job,
    maxSentences: data.maxSentences,
    boldKeywords: data.boldKeywords,
  });

  return streamTextResponse(generator);
}
