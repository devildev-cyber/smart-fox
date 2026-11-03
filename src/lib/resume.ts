/**
 * Resume builder: schemas and PURE logic (no network, no DB), so it can be unit
 * tested and shared by the server pipeline and the client view.
 *
 * Why this lives in code and not only in the prompt: the prompt tells the model
 * to keep employers/titles/dates exact, to compute experience without rounding
 * up, to avoid copying the JD, and to hit length/skill ranges. Models are bad at
 * date arithmetic and at obeying "exactly as supplied", so we (1) compute the
 * facts ourselves and hand them over, (2) overwrite the immutable fields after
 * generation, and (3) lint the rest so problems are visible or repaired.
 */
import { z } from "zod";
import { bannedPhrasesIn } from "./answer-style";

/* ------------------------------ Loose coercion ------------------------------ */

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

const str = z.any().transform(toStr);

function toStrArray(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
  return arr
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return toStr(o.name ?? o.title ?? o.text ?? o.value ?? o.note ?? "");
      }
      return toStr(x);
    })
    .filter(Boolean);
}

const strArray = z.any().transform(toStrArray);

function toObjArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    : [];
}

/* ------------------------------- Facts schema ------------------------------- */

const contactSchema = z
  .any()
  .transform((v) => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return {
      email: toStr(o.email),
      phone: toStr(o.phone),
      location: toStr(o.location),
      linkedin: toStr(o.linkedin),
    };
  });

const factExperienceSchema = z.any().transform((v) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    company: toStr(o.company),
    title: toStr(o.title),
    location: toStr(o.location),
    start_date: toStr(o.start_date),
    end_date: toStr(o.end_date),
  };
});

const educationSchema = z.any().transform((v) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    institution: toStr(o.institution),
    degree: toStr(o.degree),
    field_of_study: toStr(o.field_of_study),
    location: toStr(o.location),
    start_date: toStr(o.start_date),
    end_date: toStr(o.end_date),
  };
});

const arrayOf = <T extends z.ZodTypeAny>(item: T) =>
  z.any().transform((v) => toObjArray(v)).pipe(z.array(item));

/** The fixed facts the resume must carry over untouched. Extracted, then user-verified. */
export const resumeFactsSchema = z.object({
  name: str.default(""),
  contact: contactSchema.default({}),
  experience: arrayOf(factExperienceSchema).default([]),
  education: arrayOf(educationSchema).default([]),
  certifications: strArray.default([]),
  languages: strArray.default([]),
  career_breaks: strArray.default([]),
});
export type ResumeFacts = z.infer<typeof resumeFactsSchema>;
export type FactExperience = ResumeFacts["experience"][number];
export type FactEducation = ResumeFacts["education"][number];

export function emptyFacts(): ResumeFacts {
  return resumeFactsSchema.parse({});
}

/* ------------------------------ Resume schema ------------------------------ */

const skillGroupSchema = z.any().transform((v) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { category: toStr(o.category), items: toStrArray(o.items) };
});

const resumeExperienceSchema = z.any().transform((v) => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    company: toStr(o.company),
    title: toStr(o.title),
    location: toStr(o.location),
    start_date: toStr(o.start_date),
    end_date: toStr(o.end_date),
    bullets: toStrArray(o.bullets),
  };
});

export const generatedResumeSchema = z.object({
  name: str.default(""),
  contact: contactSchema.default({}),
  resume_title: str.default(""),
  summary: str.default(""),
  skills: arrayOf(skillGroupSchema).default([]),
  experience: arrayOf(resumeExperienceSchema).default([]),
  education: arrayOf(educationSchema).default([]),
  certifications: strArray.default([]),
  languages: strArray.default([]),
  career_breaks: strArray.default([]),
  keyword_notes: strArray.default([]),
  verification_notes: strArray.default([]),
});
export type GeneratedResume = z.infer<typeof generatedResumeSchema>;
export type ResumeExperience = GeneratedResume["experience"][number];

/* ------------------------------ API requests ------------------------------ */

export const resumeFactsRequestSchema = z.object({
  candidateProfileId: z.string().min(1, "Pick a candidate profile first"),
});

export const resumeGenerateRequestSchema = z.object({
  candidateProfileId: z.string().min(1, "Pick a candidate profile first"),
  jobProfileId: z.string().min(1, "Pick a job profile first"),
  facts: resumeFactsSchema,
  // Real projects, results, preferences. Used ahead of anything the model invents.
  notes: z.string().max(8000).default(""),
});

/* ------------------------------ Experience math ------------------------------ */

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

interface ParsedDate {
  /** Months since year 0 (year * 12 + month0). */
  idx: number;
  /** False for year-only dates, where the month is unknown. */
  precise: boolean;
}

export function parseMonthIndex(raw: string, today: Date): ParsedDate | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^(present|current|currently|now|today|ongoing|to date)\b/.test(s)) {
    return { idx: today.getFullYear() * 12 + today.getMonth(), precise: true };
  }
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/);
  if (named) {
    return { idx: Number(named[2]) * 12 + MONTH_NAMES.indexOf(named[1]), precise: true };
  }
  const mY = s.match(/\b(\d{1,2})[\/.\-](\d{4})\b/);
  if (mY && Number(mY[1]) >= 1 && Number(mY[1]) <= 12) {
    return { idx: Number(mY[2]) * 12 + Number(mY[1]) - 1, precise: true };
  }
  const yM = s.match(/\b(\d{4})[\/.\-](\d{1,2})\b/);
  if (yM && Number(yM[2]) >= 1 && Number(yM[2]) <= 12) {
    return { idx: Number(yM[1]) * 12 + Number(yM[2]) - 1, precise: true };
  }
  const y = s.match(/^\D*(\d{4})\D*$/);
  if (y) return { idx: Number(y[1]) * 12, precise: false };
  return null;
}

export interface RoleTenure {
  months: number | null;
  internship: boolean;
}

export interface ExperienceTimeline {
  /** Non-overlapping professional months (internships excluded), or null if dates are ambiguous. */
  professionalMonths: number | null;
  /** Internship / trainee months that don't overlap professional time. */
  internshipMonths: number | null;
  perRole: RoleTenure[];
  /** e.g. "10 years 4 months" */
  label: string;
  /** What the summary may claim without rounding up, e.g. "over 10 years". */
  safePhrase: string;
  ambiguous: boolean;
}

const INTERNSHIP_RE = /\b(intern|internship|trainee|apprentice)\b/i;

function unionMonths(spans: Array<[number, number]>): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (curEnd < 0) {
      curStart = s;
      curEnd = e;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}

/**
 * Non-overlapping tenure from the supplied dates. Deliberately conservative: a
 * role counts the months BETWEEN its start and end month (Jan 2020 to Dec 2020 is
 * 11), so a claim like "over 10 years" is never inflated. Any missing, unparseable
 * or year-only date makes the total ambiguous, and then no precise total is given.
 */
export function computeTimeline(
  experience: Array<Pick<FactExperience, "title" | "start_date" | "end_date">>,
  today: Date = new Date()
): ExperienceTimeline {
  let ambiguous = experience.length === 0;
  const all: Array<[number, number]> = [];
  const prof: Array<[number, number]> = [];
  const perRole: RoleTenure[] = [];

  for (const role of experience) {
    const s = parseMonthIndex(role.start_date, today);
    const e = parseMonthIndex(role.end_date, today);
    const internship = INTERNSHIP_RE.test(role.title);
    if (!s || !e || !s.precise || !e.precise || e.idx < s.idx) {
      ambiguous = true;
      perRole.push({ months: null, internship });
      continue;
    }
    const months = e.idx - s.idx;
    perRole.push({ months, internship });
    all.push([s.idx, e.idx]);
    if (!internship) prof.push([s.idx, e.idx]);
  }

  if (ambiguous) {
    return {
      professionalMonths: null,
      internshipMonths: null,
      perRole,
      label: "",
      safePhrase: "",
      ambiguous: true,
    };
  }

  const professionalMonths = unionMonths(prof);
  const internshipMonths = Math.max(0, unionMonths(all) - professionalMonths);
  const years = Math.floor(professionalMonths / 12);
  const rem = professionalMonths % 12;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const label =
    years > 0
      ? rem > 0
        ? `${plural(years, "year")} ${plural(rem, "month")}`
        : plural(years, "year")
      : plural(rem, "month");
  const safePhrase =
    years >= 1 ? `over ${plural(years, "year")}` : professionalMonths > 0 ? plural(rem, "month") : "";

  return { professionalMonths, internshipMonths, perRole, label, safePhrase, ambiguous: false };
}

/* ----------------------------- Facts vs source text ----------------------------- */

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9+#./@ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracted facts that don't appear in the resume text. A model can misread or
 * invent a title/date; those are the fields that must never be wrong, so each one
 * is checked against the source and surfaced for the user to fix.
 */
export function factsGroundingWarnings(facts: ResumeFacts, rawResumeText: string): string[] {
  const hay = norm(rawResumeText);
  const warnings: string[] = [];
  const check = (label: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    if (/^(present|current|now|today)$/i.test(v)) return;
    if (!hay.includes(norm(v))) warnings.push(`${label} “${v}” was not found in the resume text.`);
  };
  facts.experience.forEach((r, i) => {
    const tag = `Role ${i + 1}`;
    check(`${tag} company`, r.company);
    check(`${tag} title`, r.title);
    check(`${tag} start date`, r.start_date);
    check(`${tag} end date`, r.end_date);
    check(`${tag} location`, r.location);
  });
  facts.education.forEach((e, i) => {
    check(`Education ${i + 1} institution`, e.institution);
    check(`Education ${i + 1} degree`, e.degree);
  });
  facts.certifications.forEach((c, i) => check(`Certification ${i + 1}`, c));
  check("Email", facts.contact.email);
  check("Phone", facts.contact.phone);
  return warnings;
}

/* -------------------------- Enforce the immutable data -------------------------- */

const key = (s: string) => norm(s).replace(/\s+/g, "");

function dedupeSkillGroups(groups: GeneratedResume["skills"]): GeneratedResume["skills"] {
  const seen = new Set<string>();
  const out: GeneratedResume["skills"] = [];
  for (const g of groups) {
    const items: string[] = [];
    for (const item of g.items) {
      const k = item.toLowerCase().replace(/\s+/g, " ").trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      items.push(item.trim());
    }
    if (g.category && items.length) out.push({ category: g.category, items });
  }
  return out;
}

/**
 * Overwrite everything the prompt says must be preserved exactly with the
 * verified facts, whatever the model returned. Returns what had to be corrected
 * so the UI can say so instead of silently changing things.
 */
export function enforceFacts(
  resume: GeneratedResume,
  facts: ResumeFacts
): { resume: GeneratedResume; corrections: string[] } {
  const corrections: string[] = [];
  const out: GeneratedResume = { ...resume };

  if (facts.name && out.name !== facts.name) {
    if (out.name) corrections.push(`Name restored to “${facts.name}”.`);
    out.name = facts.name;
  }

  const contact = { ...facts.contact };
  for (const k of ["email", "phone", "location", "linkedin"] as const) {
    if (!facts.contact[k] && resume.contact[k]) {
      corrections.push(`Removed invented contact ${k}.`);
    }
  }
  out.contact = contact;

  // Experience: facts decide the list, order, and every non-bullet field.
  const pool = [...resume.experience];
  const takeMatch = (f: FactExperience, index: number): ResumeExperience | undefined => {
    let at = pool.findIndex((p) => key(p.company) === key(f.company) && key(p.title) === key(f.title));
    if (at < 0) at = pool.findIndex((p) => key(p.company) === key(f.company));
    if (at < 0 && resume.experience[index] && pool.includes(resume.experience[index])) {
      at = pool.indexOf(resume.experience[index]);
    }
    return at >= 0 ? pool.splice(at, 1)[0] : undefined;
  };

  out.experience = facts.experience.map((f, i) => {
    const match = takeMatch(f, i);
    if (!match) {
      corrections.push(`The model omitted “${f.title} at ${f.company}”; it was added back with no bullets.`);
      return { ...f, bullets: [] };
    }
    const changed: string[] = [];
    if (match.title !== f.title) changed.push("title");
    if (match.company !== f.company) changed.push("company");
    if (match.location !== f.location) changed.push("location");
    if (match.start_date !== f.start_date || match.end_date !== f.end_date) changed.push("dates");
    if (changed.length) {
      corrections.push(`Restored ${changed.join(", ")} for “${f.title} at ${f.company}”.`);
    }
    return {
      company: f.company,
      title: f.title,
      location: f.location,
      start_date: f.start_date,
      end_date: f.end_date,
      bullets: match.bullets.map((b) => b.trim()).filter(Boolean),
    };
  });
  if (pool.length) {
    corrections.push(`Dropped ${pool.length} role(s) that are not in your career facts.`);
  }

  const sameEdu =
    JSON.stringify(resume.education) === JSON.stringify(facts.education);
  if (!sameEdu) corrections.push("Education restored to your career facts.");
  out.education = facts.education.map((e) => ({ ...e }));

  if (JSON.stringify(resume.certifications) !== JSON.stringify(facts.certifications)) {
    corrections.push("Certifications restored to your career facts.");
  }
  out.certifications = [...facts.certifications];
  out.languages = [...facts.languages];
  out.career_breaks = [...facts.career_breaks];

  out.skills = dedupeSkillGroups(resume.skills);
  return { resume: out, corrections };
}

/* ----------------------------------- Lint ----------------------------------- */

export type ResumeIssueCode =
  | "summary_start"
  | "summary_length"
  | "skills_count"
  | "skills_categories"
  | "jd_overlap"
  | "bullets_count"
  | "metric_ratio"
  | "metrics_unverified"
  | "first_person"
  | "filler"
  | "tech_stack_line"
  | "duplicate_bullet"
  | "empty_role";

export interface ResumeIssue {
  code: ResumeIssueCode;
  /** "fix" issues are sent back to the model once; "warn" issues are only shown. */
  severity: "fix" | "warn";
  message: string;
}

const STOP = new Set(
  "a an the and or of to in on for with by at from as is are was were be been being it its this that these those into over under per via than then so if we you they their our your i".split(" ")
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Technology / skill vocabulary: runs of these are exempt from the JD-copy check. */
export function techVocabulary(terms: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of terms) for (const w of words(t)) if (!STOP.has(w)) set.add(w);
  return set;
}

/**
 * Lines that reuse five or more consecutive words from the JD, ignoring runs that
 * are mostly technology names (those are required for ATS and not "copying").
 */
export function findJdOverlaps(
  lines: Array<{ where: string; text: string }>,
  jdText: string,
  tech: Set<string>
): Array<{ where: string; phrase: string }> {
  const jd = words(jdText);
  if (jd.length < 5) return [];
  const grams = new Set<string>();
  for (let i = 0; i + 5 <= jd.length; i++) grams.add(jd.slice(i, i + 5).join(" "));

  const hits: Array<{ where: string; phrase: string }> = [];
  for (const line of lines) {
    const w = words(line.text);
    for (let i = 0; i + 5 <= w.length; i++) {
      const gram = w.slice(i, i + 5);
      if (!grams.has(gram.join(" "))) continue;
      const techCount = gram.filter((x) => tech.has(x)).length;
      const contentCount = gram.filter((x) => !STOP.has(x)).length;
      if (techCount >= 3 || contentCount < 3) continue;
      hits.push({ where: line.where, phrase: gram.join(" ") });
      break;
    }
  }
  return hits;
}

const NUMERIC_RE =
  /\d[\d,.]*\s?(?:%|(?:x|ms|s|sec|seconds|min|minutes|hours?|days?|weeks?|months?|k|m|million|billion|gb|tb|mb|rps|qps|req|requests|users|customers|engineers|developers|teams?|services|endpoints|pipelines|tables|repos|tests|incidents|deploys|releases|tickets|alerts|dashboards)\b)|\$\s?\d/i;

export function hasNumericAchievement(bullet: string): boolean {
  return NUMERIC_RE.test(bullet);
}

export interface BulletRange {
  min: number;
  max: number;
}

/**
 * Soft bullet range for a role by tenure and rank among substantial roles. Wider
 * than the prompt's "about" ranges, so only clear misses are reported.
 */
export function bulletRange(months: number | null, substantialRank: number): BulletRange {
  if (months === null) return { min: 3, max: 12 };
  if (months < 9) return { min: 2, max: 5 };
  if (months < 18) return { min: 4, max: 8 };
  if (substantialRank === 0) return { min: 8, max: 13 };
  if (substantialRank === 1) return { min: 6, max: 10 };
  return { min: 5, max: 9 };
}

export interface ResumeStats {
  skillsCount: number;
  skillCategories: number;
  summaryWords: number;
  totalBullets: number;
  numericBullets: number;
  numericPct: number;
  roles: Array<{ company: string; title: string; bullets: number; range: BulletRange }>;
}

export function resumeStats(resume: GeneratedResume, timeline: ExperienceTimeline): ResumeStats {
  let rank = 0;
  const roles = resume.experience.map((r, i) => {
    const months = timeline.perRole[i]?.months ?? null;
    const substantial = months !== null && months >= 18;
    const range = bulletRange(months, substantial ? rank : 0);
    if (substantial) rank += 1;
    return { company: r.company, title: r.title, bullets: r.bullets.length, range };
  });
  const allBullets = resume.experience.flatMap((r) => r.bullets);
  const numeric = allBullets.filter(hasNumericAchievement).length;
  return {
    skillsCount: resume.skills.reduce((n, g) => n + g.items.length, 0),
    skillCategories: resume.skills.length,
    summaryWords: resume.summary.split(/\s+/).filter(Boolean).length,
    totalBullets: allBullets.length,
    numericBullets: numeric,
    numericPct: allBullets.length ? Math.round((numeric / allBullets.length) * 100) : 0,
    roles,
  };
}

export function lintResume(
  resume: GeneratedResume,
  ctx: { jdText: string; tech: Set<string>; timeline: ExperienceTimeline }
): ResumeIssue[] {
  const issues: ResumeIssue[] = [];
  const stats = resumeStats(resume, ctx.timeline);
  const title = resume.resume_title.trim();

  if (!title) {
    issues.push({ code: "summary_start", severity: "fix", message: "The resume title is empty." });
  } else if (!resume.summary.trim().startsWith(title)) {
    issues.push({
      code: "summary_start",
      severity: "fix",
      message: `The summary must begin with the exact resume title “${title}”.`,
    });
  }

  if (stats.summaryWords > 140 || stats.summaryWords < 40) {
    issues.push({
      code: "summary_length",
      severity: "warn",
      message: `The summary is ${stats.summaryWords} words (aim for roughly 75 to 125).`,
    });
  }

  if (stats.skillsCount < 45 || stats.skillsCount > 62) {
    issues.push({
      code: "skills_count",
      severity: "fix",
      message: `There are ${stats.skillsCount} distinct skills; aim for 50 to 60 (around 55) if they can be defended, without padding.`,
    });
  }
  if (stats.skillCategories < 6 || stats.skillCategories > 11) {
    issues.push({
      code: "skills_categories",
      severity: "warn",
      message: `There are ${stats.skillCategories} skill categories (aim for roughly 8 to 10).`,
    });
  }

  const lines = [
    { where: "summary", text: resume.summary },
    ...resume.experience.flatMap((r, i) =>
      r.bullets.map((b, j) => ({ where: `${r.company || `role ${i + 1}`}, bullet ${j + 1}`, text: b }))
    ),
  ];
  for (const hit of findJdOverlaps(lines, ctx.jdText, ctx.tech)) {
    issues.push({
      code: "jd_overlap",
      severity: "fix",
      message: `${hit.where} copies five or more words from the job description (“${hit.phrase}”). Rewrite it from the project's artifact, mechanism and consequence.`,
    });
  }

  for (const role of stats.roles) {
    if (role.bullets < role.range.min || role.bullets > role.range.max) {
      issues.push({
        code: "bullets_count",
        severity: "warn",
        message: `${role.title} at ${role.company} has ${role.bullets} bullets (expected about ${role.range.min} to ${role.range.max} for that tenure).`,
      });
    }
    if (role.bullets === 0) {
      issues.push({ code: "empty_role", severity: "warn", message: `${role.title} at ${role.company} has no bullets.` });
    }
  }

  if (stats.totalBullets >= 10 && (stats.numericPct < 15 || stats.numericPct > 45)) {
    issues.push({
      code: "metric_ratio",
      severity: "warn",
      message: `${stats.numericBullets} of ${stats.totalBullets} bullets (${stats.numericPct}%) contain a number; about 30% is the target. A credible resume matters more than hitting the ratio.`,
    });
  }
  if (stats.numericBullets > 0 && resume.verification_notes.length === 0) {
    issues.push({
      code: "metrics_unverified",
      severity: "warn",
      message: "There are numbers in the bullets but no verification notes. Treat every figure as unconfirmed.",
    });
  }

  const everyLine = lines.map((l) => l.text);
  if (everyLine.some((t) => /\b(I|my|me|I'm|I've)\b/.test(t))) {
    issues.push({ code: "first_person", severity: "warn", message: "Some lines use first person." });
  }
  const filler = bannedPhrasesIn(everyLine.join("\n"));
  if (filler.length) {
    issues.push({ code: "filler", severity: "warn", message: `Filler wording: ${filler.map((f) => `“${f}”`).join(", ")}.` });
  }
  if (resume.experience.some((r) => r.bullets.some((b) => /^\s*(tech(nolog(y|ies))?\s*(stack)?|environment)\s*:/i.test(b)))) {
    issues.push({ code: "tech_stack_line", severity: "warn", message: "A bullet is a “Tech Stack:” line, which the brief rules out." });
  }
  const starts = new Map<string, number>();
  for (const b of resume.experience.flatMap((r) => r.bullets)) {
    const k = words(b).slice(0, 6).join(" ");
    if (k) starts.set(k, (starts.get(k) ?? 0) + 1);
  }
  if ([...starts.values()].some((n) => n > 1)) {
    issues.push({ code: "duplicate_bullet", severity: "warn", message: "Two or more bullets open with the same words." });
  }

  return issues;
}

/* ---------------------------------- Export ---------------------------------- */

function dateRange(start: string, end: string): string {
  return [start, end].filter(Boolean).join(" – ");
}

export function resumeToMarkdown(resume: GeneratedResume): string {
  const c = resume.contact;
  const contact = [c.email, c.phone, c.location, c.linkedin].filter(Boolean).join(" | ");
  const out: string[] = [];
  out.push(`# ${resume.name}`);
  if (resume.resume_title) out.push(`**${resume.resume_title}**`);
  if (contact) out.push(contact);
  if (resume.summary) out.push(`## Summary\n${resume.summary}`);
  if (resume.skills.length) {
    out.push(`## Skills\n${resume.skills.map((g) => `- **${g.category}:** ${g.items.join(", ")}`).join("\n")}`);
  }
  if (resume.experience.length) {
    out.push(
      `## Experience\n${resume.experience
        .map((r) =>
          [
            `### ${r.title} — ${r.company}`,
            [r.location, dateRange(r.start_date, r.end_date)].filter(Boolean).join(" | "),
            r.bullets.map((b) => `- ${b}`).join("\n"),
          ]
            .filter(Boolean)
            .join("\n")
        )
        .join("\n\n")}`
    );
  }
  if (resume.education.length) {
    out.push(
      `## Education\n${resume.education
        .map((e) =>
          [
            [e.degree, e.field_of_study].filter(Boolean).join(", "),
            e.institution,
            e.location,
            dateRange(e.start_date, e.end_date),
          ]
            .filter(Boolean)
            .join(" — ")
        )
        .map((l) => `- ${l}`)
        .join("\n")}`
    );
  }
  if (resume.certifications.length) {
    out.push(`## Certifications\n${resume.certifications.map((x) => `- ${x}`).join("\n")}`);
  }
  if (resume.languages.length) out.push(`## Languages\n${resume.languages.join(", ")}`);
  return out.join("\n\n") + "\n";
}

/** Plain text for pasting into a form: the Markdown without its markup. */
export function resumeToText(resume: GeneratedResume): string {
  return resumeToMarkdown(resume)
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^- /gm, "• ");
}
