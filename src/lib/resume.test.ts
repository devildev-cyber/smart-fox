import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bulletRange,
  computeTimeline,
  enforceFacts,
  factsGroundingWarnings,
  findJdOverlaps,
  generatedResumeSchema,
  hasNumericAchievement,
  lintResume,
  parseMonthIndex,
  resumeFactsSchema,
  resumeToMarkdown,
  techVocabulary,
} from "./resume";

const TODAY = new Date(2026, 10, 3); // Nov 2026

const role = (title: string, start: string, end: string, company = "Acme") => ({
  company,
  title,
  location: "Austin, TX",
  start_date: start,
  end_date: end,
});

test("dates: month names, numeric months, Present, and year-only", () => {
  assert.equal(parseMonthIndex("Jan 2020", TODAY)?.idx, 2020 * 12);
  assert.equal(parseMonthIndex("March 2019", TODAY)?.idx, 2019 * 12 + 2);
  assert.equal(parseMonthIndex("03/2019", TODAY)?.idx, 2019 * 12 + 2);
  assert.equal(parseMonthIndex("2019-03", TODAY)?.idx, 2019 * 12 + 2);
  assert.equal(parseMonthIndex("Present", TODAY)?.idx, 2026 * 12 + 10);
  assert.equal(parseMonthIndex("2019", TODAY)?.precise, false);
  assert.equal(parseMonthIndex("sometime", TODAY), null);
});

test("timeline: overlaps are not double counted and nothing is rounded up", () => {
  const t = computeTimeline(
    [
      role("Senior Engineer", "Jan 2022", "Present"), // 58 months to Nov 2026
      role("Engineer", "Jan 2018", "Jan 2022"), // 48, contiguous
      role("Contractor", "Jun 2021", "Dec 2021"), // fully inside the others
    ],
    TODAY
  );
  assert.equal(t.ambiguous, false);
  assert.equal(t.professionalMonths, 106);
  assert.equal(t.label, "8 years 10 months");
  assert.equal(t.safePhrase, "over 8 years");
});

test("timeline: 10 years 11 months never becomes 11+ years", () => {
  const t = computeTimeline([role("Engineer", "Jan 2015", "Dec 2025")], TODAY);
  assert.equal(t.professionalMonths, 10 * 12 + 11);
  assert.equal(t.safePhrase, "over 10 years");
});

test("timeline: year-only or missing dates give no precise total; interns are separate", () => {
  const amb = computeTimeline([role("Engineer", "2018", "2021")], TODAY);
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.professionalMonths, null);
  assert.equal(amb.safePhrase, "");

  const t = computeTimeline(
    [role("Engineer", "Jan 2022", "Jan 2024"), role("Software Intern", "Jun 2021", "Aug 2021")],
    TODAY
  );
  assert.equal(t.professionalMonths, 24);
  assert.equal(t.internshipMonths, 2);
});

const facts = resumeFactsSchema.parse({
  name: "Dana Reyes",
  contact: { email: "dana@example.com", phone: "", location: "Austin, TX", linkedin: "" },
  experience: [
    role("Senior Software Engineer", "Jan 2022", "Present", "Northwind"),
    role("Software Engineer", "Jan 2018", "Dec 2021", "Contoso"),
  ],
  education: [{ institution: "UT Austin", degree: "B.S.", field_of_study: "Computer Science" }],
  certifications: ["AWS Certified Developer"],
});

test("enforceFacts: restores relabelled titles, order, contact and education", () => {
  const model = generatedResumeSchema.parse({
    name: "Dana R.",
    contact: { email: "dana@example.com", phone: "555-0100", location: "Austin, TX" },
    resume_title: "Senior Backend Engineer",
    skills: [
      { category: "Languages", items: ["Go", "go", "Python"] },
      { category: "Cloud", items: ["AWS", "Python"] },
    ],
    experience: [
      { company: "Contoso", title: "Staff Engineer", location: "Austin, TX", start_date: "2018", end_date: "2021", bullets: ["Built X"] },
      { company: "Northwind", title: "Principal Engineer", location: "Remote", start_date: "Jan 2022", end_date: "Present", bullets: ["Built Y", " "] },
      { company: "Invented Corp", title: "CTO", bullets: ["Ran everything"] },
    ],
    education: [{ institution: "MIT", degree: "PhD" }],
    certifications: ["CISSP"],
  });
  const { resume, corrections } = enforceFacts(model, facts);

  assert.deepEqual(resume.experience.map((r) => `${r.company}|${r.title}`), [
    "Northwind|Senior Software Engineer",
    "Contoso|Software Engineer",
  ]);
  assert.equal(resume.experience[0].location, "Austin, TX");
  assert.equal(resume.experience[1].start_date, "Jan 2018");
  assert.deepEqual(resume.experience[0].bullets, ["Built Y"]);
  assert.equal(resume.name, "Dana Reyes");
  assert.equal(resume.contact.phone, ""); // invented phone removed
  assert.deepEqual(resume.education.map((e) => e.institution), ["UT Austin"]);
  assert.deepEqual(resume.certifications, ["AWS Certified Developer"]);
  assert.deepEqual(resume.skills.map((g) => g.items), [["Go", "Python"], ["AWS"]]);
  assert.ok(corrections.some((c) => /Dropped 1 role/.test(c)));
});

test("enforceFacts: a role the model left out is added back empty", () => {
  const model = generatedResumeSchema.parse({
    experience: [{ company: "Northwind", title: "Senior Software Engineer", bullets: ["Built Y"] }],
  });
  const { resume, corrections } = enforceFacts(model, facts);
  assert.equal(resume.experience.length, 2);
  assert.deepEqual(resume.experience[1].bullets, []);
  assert.ok(corrections.some((c) => /omitted/.test(c)));
});

test("facts grounding: values missing from the resume text are flagged", () => {
  const raw = "Dana Reyes\nSenior Software Engineer, Northwind, Jan 2022 - Present\nSoftware Engineer, Contoso, Jan 2018 - Dec 2021\nUT Austin B.S.\nAWS Certified Developer";
  assert.deepEqual(factsGroundingWarnings(facts, raw.replace("Contoso", "Fabrikam")).length > 0, true);
  const warnings = factsGroundingWarnings(facts, raw + "\ndana@example.com\nAustin, TX");
  assert.deepEqual(warnings, []);
});

test("JD overlap: copied runs are flagged, tool lists and original wording are not", () => {
  const jd =
    "You will design and operate event driven data pipelines that process customer data at scale. Experience with Kafka, Spark, Airflow, dbt, Snowflake is required.";
  const tech = techVocabulary(["Kafka", "Spark", "Airflow", "dbt", "Snowflake"]);
  const hits = findJdOverlaps(
    [
      { where: "a", text: "Designed and operated event driven data pipelines that process customer data at scale for billing." },
      { where: "b", text: "Replaced a nightly cron job with a queue-backed runner, so reruns after a bad deploy took minutes." },
      { where: "c", text: "Worked with Kafka, Spark, Airflow, dbt, Snowflake across the data platform." },
    ],
    jd,
    tech
  );
  assert.deepEqual(hits.map((h) => h.where), ["a"]);
});

test("metrics and bullet ranges", () => {
  assert.equal(hasNumericAchievement("Cut p95 latency from 900 ms to 310 ms by adding a read-through cache"), true);
  assert.equal(hasNumericAchievement("Reduced nightly job runtime by 38%"), true);
  assert.equal(hasNumericAchievement("Upgraded the service to Node 18 and rewrote the retry policy"), false);
  assert.deepEqual(bulletRange(6, 0), { min: 2, max: 5 });
  assert.deepEqual(bulletRange(46, 0), { min: 8, max: 13 });
  assert.deepEqual(bulletRange(48, 1), { min: 6, max: 10 });
});

test("lint: summary must start with the title, skill count is checked, six-month role follows the short rule", () => {
  const timeline = computeTimeline(facts.experience, TODAY);
  const resume = generatedResumeSchema.parse({
    resume_title: "Senior Backend Engineer",
    summary: "Backend engineer with experience. ".repeat(12),
    skills: [{ category: "Languages", items: ["Go", "Python"] }],
    experience: [
      { company: "Northwind", title: "Senior Software Engineer", bullets: ["Built a thing."] },
      { company: "Contoso", title: "Software Engineer", bullets: ["Built another thing."] },
    ],
  });
  const codes = lintResume(resume, { jdText: "", tech: new Set(), timeline }).map((i) => i.code);
  assert.ok(codes.includes("summary_start"));
  assert.ok(codes.includes("skills_count"));
  assert.ok(codes.includes("bullets_count"));

  const short = computeTimeline([role("Engineer", "May 2026", "Present"), role("Engineer", "Jan 2018", "Dec 2025")], TODAY);
  assert.deepEqual(short.perRole[0].months, 6);
});

test("markdown export carries the facts and no verification notes", () => {
  const { resume } = enforceFacts(
    generatedResumeSchema.parse({
      resume_title: "Senior Backend Engineer",
      summary: "Senior Backend Engineer with over 7 years of experience.",
      experience: [{ company: "Northwind", title: "x", bullets: ["Built Y"] }],
      verification_notes: ["Confirm the 38% figure"],
    }),
    facts
  );
  const md = resumeToMarkdown(resume);
  assert.match(md, /^# Dana Reyes/);
  assert.match(md, /### Senior Software Engineer — Northwind/);
  assert.match(md, /- Built Y/);
  assert.doesNotMatch(md, /38%/);
});
