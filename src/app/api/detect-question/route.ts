import { handleRouteError, jsonOk, parseBody } from "@/lib/api";
import { detectQuestionRequestSchema } from "@/lib/schemas";
import { detectQuestion } from "@/lib/llm-tasks";
import { assertAccess } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, detectQuestionRequestSchema);
  if (error) return error;

  try {
    await assertAccess(request);
    const result = await detectQuestion({
      recentTranscript: data.recentTranscript,
      previousQuestion: data.previousQuestion,
      candidateName: data.candidateName,
    });
    return jsonOk(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
