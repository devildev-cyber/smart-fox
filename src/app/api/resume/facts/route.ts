import { handleRouteError, jsonError, jsonOk, parseBody } from "@/lib/api";
import { assertAccess } from "@/lib/access";
import { factsGroundingWarnings, resumeFactsRequestSchema } from "@/lib/resume";
import { extractResumeFacts } from "@/lib/resume-task";
import { loadCandidateStructured } from "@/lib/repo";
import { getRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Read employers, titles, dates, education and contact out of the saved resume. */
export async function POST(request: Request) {
  try {
    await assertAccess(request);
  } catch (err) {
    return handleRouteError(err);
  }

  const { data, error } = await parseBody(request, resumeFactsRequestSchema);
  if (error) return error;

  try {

    const cfg = await getRuntimeConfig();
    if (!cfg.openaiApiKey) {
      return jsonError("OpenAI API key is not configured. Add it on the Settings page.", 503);
    }

    const { rawResumeText } = await loadCandidateStructured(data.candidateProfileId);
    if (!rawResumeText.trim()) {
      return jsonError("This candidate profile has no resume text. Add it on Setup first.", 422);
    }

    const facts = await extractResumeFacts(rawResumeText);
    return jsonOk({ facts, warnings: factsGroundingWarnings(facts, rawResumeText) });
  } catch (err) {
    return handleRouteError(err);
  }
}
