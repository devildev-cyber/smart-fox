import { handleRouteError, jsonError, jsonOk, parseBody } from "@/lib/api";
import { assertAccess } from "@/lib/access";
import { resumeGenerateRequestSchema } from "@/lib/resume";
import { buildResume } from "@/lib/resume-task";
import { loadCandidateStructured, loadJobWithRaw } from "@/lib/repo";
import { getRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";
// Resume generation is a long, high-effort call plus an optional repair pass.
export const maxDuration = 800;

export async function POST(request: Request) {
  try {
    await assertAccess(request);
  } catch (err) {
    return handleRouteError(err);
  }

  const { data, error } = await parseBody(request, resumeGenerateRequestSchema);
  if (error) return error;

  try {

    const cfg = await getRuntimeConfig();
    if (!cfg.openaiApiKey) {
      return jsonError("OpenAI API key is not configured. Add it on the Settings page.", 503);
    }
    if (data.facts.experience.length === 0) {
      return jsonError("Add at least one job to the career facts first.", 422);
    }

    const [{ candidate, rawResumeText }, jobRow] = await Promise.all([
      loadCandidateStructured(data.candidateProfileId),
      loadJobWithRaw(data.jobProfileId),
    ]);
    if (!jobRow || !jobRow.rawJobDescription.trim()) {
      return jsonError("This job profile has no job description. Add it on Setup first.", 422);
    }

    const result = await buildResume({
      facts: data.facts,
      candidate,
      rawResumeText,
      job: jobRow.job,
      rawJobDescription: jobRow.rawJobDescription,
      notes: data.notes,
    });
    return jsonOk(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
