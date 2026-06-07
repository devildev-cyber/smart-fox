import { prisma } from "@/lib/db";
import { handleRouteError, jsonError, jsonOk } from "@/lib/api";
import { generateReview } from "@/lib/llm-tasks";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const session = await prisma.interviewSession.findUnique({
      where: { id },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    if (!session) return jsonError("Session not found.", 404);

    const review = await generateReview({
      sessionTitle: session.title,
      transcript: session.transcript,
      turns: session.turns.map((t) => ({
        detectedQuestion: t.detectedQuestion,
        questionType: t.questionType,
        generatedAnswer: t.generatedAnswer,
        confidence: t.confidence,
        riskNote: t.riskNote,
      })),
    });

    return jsonOk(review);
  } catch (err) {
    return handleRouteError(err);
  }
}
