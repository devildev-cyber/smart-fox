import { test } from "node:test";
import assert from "node:assert/strict";
import { selectContext, type StoryLike } from "./context";

const story = (over: Partial<StoryLike> & { id: string; category: string }): StoryLike => ({
  title: "",
  shortVersion: "",
  starVersion: "",
  technicalVersion: "",
  keywords: [],
  ...over,
});

test("category-aware boosting surfaces the intent-matched story on paraphrase", () => {
  const stories: StoryLike[] = [
    story({
      id: "proj",
      category: "signature_project",
      title: "Built Canvas",
      keywords: ["react", "node"],
      shortVersion: "An internal content platform.",
    }),
    story({
      id: "conflict",
      category: "handling_conflict",
      title: "Disagreement over API design",
      keywords: ["stakeholder", "api"],
      shortVersion: "Aligned two teams on an approach.",
    }),
  ];

  // "conflict" shares no literal token with the story's text, but synonym
  // expansion + the handling_conflict category boost should still win.
  const selected = selectContext({
    question: "Tell me about a time you had a conflict with a teammate",
    stories,
  });

  assert.equal(selected.stories[0]?.id, "conflict");
});

test("synonym expansion matches a role-specific category", () => {
  const stories: StoryLike[] = [
    story({ id: "impact", category: "biggest_impact", title: "Cut costs" }),
    story({
      id: "reliability",
      category: "incident_response",
      title: "On-call incident",
      keywords: ["uptime", "postmortem"],
    }),
  ];

  // "outage" expands to the reliability/incident group.
  const selected = selectContext({
    question: "Walk me through a major outage you handled",
    stories,
  });

  assert.equal(selected.stories[0]?.id, "reliability");
});

test("a sentence-final period does not break term matching", () => {
  const candidate = {
    strong_evidence: ["Built Terraform modules for AWS", "Led Kubernetes migration"],
    projects: [],
    metrics: [],
    leadership: [],
    core_stack: [],
    secondary_stack: [],
    domains: [],
    best_story_angles: [],
  } as unknown as Parameters<typeof selectContext>[0]["candidate"];

  // Live Captions punctuates statement-style prompts with a trailing ".".
  for (const question of ["Tell me about Kubernetes.", "Tell me about Kubernetes"]) {
    const { resumeFacts } = selectContext({ question, candidate });
    assert.equal(resumeFacts[0], "Led Kubernetes migration", question);
  }
});

test("dots inside a name are kept so node.js still matches", () => {
  const candidate = {
    strong_evidence: ["Built a REST API in Express", "Shipped a Node.js service on AWS"],
    projects: [],
    metrics: [],
    leadership: [],
    core_stack: [],
    secondary_stack: [],
    domains: [],
    best_story_angles: [],
  } as unknown as Parameters<typeof selectContext>[0]["candidate"];

  const { resumeFacts } = selectContext({ question: "Do you know Node.js?", candidate });
  assert.equal(resumeFacts[0], "Shipped a Node.js service on AWS");
});

test("selectContext is deterministic for identical inputs", () => {
  const stories: StoryLike[] = [
    story({ id: "a", category: "leadership_or_ownership", title: "Led a migration" }),
    story({ id: "b", category: "teamwork_and_collaboration", title: "Cross-team launch" }),
  ];
  const params = { question: "How do you lead a team?", stories };
  assert.deepEqual(
    selectContext(params).stories.map((s) => s.id),
    selectContext(params).stories.map((s) => s.id)
  );
});
