import { prisma } from "@/lib/db";
import { handleRouteError, jsonError, jsonOk, parseBody } from "@/lib/api";
import { generateStoriesRequestSchema, candidateStructuredSchema } from "@/lib/schemas";
import { generateStories } from "@/lib/llm-tasks";
import { serializeStory } from "@/lib/repo";
import { safeJsonParse } from "@/lib/utils";
import { STORY_CATEGORIES } from "@/lib/schemas";
import { assertAccess } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { data, error } = await parseBody(request, generateStoriesRequestSchema);
  if (error) return error;

  try {
    await assertAccess(request);
    const candidateRow = await prisma.candidateProfile.findUnique({
      where: { id: data.candidateProfileId },
    });
    if (!candidateRow) return jsonError("Candidate profile not found.", 404);

    const parsed = candidateStructuredSchema.safeParse(
      safeJsonParse(candidateRow.structuredProfileJson, {})
    );
    if (!parsed.success) {
      return jsonError("Candidate profile is not analyzed yet. Analyze the resume first.", 422);
    }

    // Only generate stories for categories that don't already exist.
    const missing = STORY_CATEGORIES.filter(
      (c) => !data.existingCategories.includes(c)
    );
    if (missing.length === 0) {
      return jsonOk({ created: [] });
    }

    const { stories } = await generateStories({
      candidate: parsed.data,
      rawResumeText: candidateRow.rawResumeText,
      categories: missing,
    });

    const created = [];
    for (const s of stories) {
      const row = await prisma.story.create({
        data: {
          title: s.title,
          category: s.category,
          shortVersion: s.short_version,
          starVersion: s.star_version,
          technicalVersion: s.technical_version,
          keywordsJson: JSON.stringify(s.keywords),
          evidenceJson: JSON.stringify(s.evidence),
        },
      });
      created.push(serializeStory(row));
    }

    return jsonOk({ created });
  } catch (err) {
    return handleRouteError(err);
  }
}
