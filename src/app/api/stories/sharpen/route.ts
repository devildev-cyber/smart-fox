import { handleRouteError, jsonError, jsonOk, parseBody } from "@/lib/api";
import { sharpenStoryRequestSchema } from "@/lib/schemas";
import { generateSharpenQuestions, mergeSharpenAnswers } from "@/lib/llm-tasks";
import { loadCandidateStructured } from "@/lib/repo";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { assertAccess } from "@/lib/access";

export const runtime = "nodejs";

/**
 * "Sharpen" a story with real details from the candidate.
 *  - action "questions": returns a few sharp, story-specific questions.
 *  - action "merge":     folds the candidate's answers into the story and
 *                        returns the proposed rewrite. Nothing is saved here;
 *                        the dialog shows it for review and saves on confirm.
 */
export async function POST(request: Request) {
  const { data, error } = await parseBody(request, sharpenStoryRequestSchema);
  if (error) return error;

  try {
    await assertAccess(request);

    const cfg = await getRuntimeConfig();
    if (!cfg.openaiApiKey) {
      return jsonError("OpenAI API key is not configured. Add it on the Settings page.", 503);
    }

    if (data.action === "questions") {
      const { candidate } = await loadCandidateStructured(data.candidateProfileId);
      const questions = await generateSharpenQuestions({ story: data.story, candidate });
      return jsonOk({ questions });
    }

    const merged = await mergeSharpenAnswers({ story: data.story, answers: data.answers });
    if (!merged) {
      return jsonError("Answer at least one question first.", 422);
    }
    return jsonOk({
      title: merged.title || data.story.title,
      shortVersion: merged.short_version,
      starVersion: merged.star_version,
      technicalVersion: merged.technical_version,
      keywords: merged.keywords,
      evidence: merged.evidence,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
