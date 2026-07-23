// Pure helpers for the live-coding copilot: parse the section-tagged stream the
// coding endpoint emits into fixed UI zones. Kept dependency-free so it can be
// unit-tested in isolation and safely called on every streamed chunk.

// Mirrors the transport error marker in `lib/api.ts` (streamTextResponse). Kept
// as a local literal so this module stays free of app/schema/zod imports.
const ERROR_DELIM = "---ERROR---";

export type CodingMode =
  | "new"
  | "fix"
  | "optimize"
  | "explain"
  | "test"
  | "answer";

export const CODING_MODES: readonly CodingMode[] = [
  "new",
  "fix",
  "optimize",
  "explain",
  "test",
  "answer",
];

// Short, human labels for the mode badge in the UI.
export const CODING_MODE_LABELS: Record<CodingMode, string> = {
  new: "Solution",
  fix: "Bug fix",
  optimize: "Optimize",
  explain: "Explain",
  test: "Dry run",
  answer: "Answer",
};

export interface CodingSolution {
  mode: CodingMode | null;
  /** 1–2 spoken lines the candidate says out loud. */
  say: string;
  /** The solution / minimal fix (may be empty for answer/explain modes). */
  code: string;
  /** Language tag from the @@CODE@@ marker (e.g. "python"). */
  language: string;
  /** One-line time/space complexity. */
  complexity: string;
  /** Ordered approach / edge cases / exact fix, as markdown bullets. */
  plan: string;
  /** Optional one-line follow-up / pitfall. */
  note: string;
  /** A mid-stream error surfaced by the streaming transport, if any. */
  error: string | null;
}

// Section markers the coding prompt emits, each on its own line. The inline
// value after MODE/CODE is the mode string / language respectively.
const SECTIONS = ["MODE", "SAY", "CODE", "COMPLEXITY", "PLAN", "NOTE"] as const;
type SectionKey = (typeof SECTIONS)[number];

const MARKER_RE = /^@@([A-Z]+)@@[ \t]*(.*)$/;

function emptySolution(): CodingSolution {
  return {
    mode: null,
    say: "",
    code: "",
    language: "",
    complexity: "",
    plan: "",
    note: "",
    error: null,
  };
}

function asMode(raw: string): CodingMode | null {
  const v = raw.trim().toLowerCase();
  return (CODING_MODES as readonly string[]).includes(v)
    ? (v as CodingMode)
    : null;
}

/**
 * Hide a partially-streamed trailing marker (e.g. "@@COMP") so it doesn't flash
 * in the UI while the next section header is still arriving.
 */
function stripPartialMarker(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1];
  // A complete marker line is handled by the parser; only strip an incomplete
  // one that could still resolve into a marker.
  if (/^@@[A-Z]*$/.test(last) && !/^@@[A-Z]+@@/.test(last)) {
    return lines.slice(0, -1);
  }
  return lines;
}

/**
 * Parse a (possibly partial) coding stream into fixed zones. Safe to call on
 * every chunk while streaming — unknown markers are ignored, and content before
 * the first marker is treated as the SAY body so early tokens still render.
 */
export function parseCodingStream(full: string): CodingSolution {
  const result = emptySolution();

  let text = full;
  const errIdx = text.indexOf(ERROR_DELIM);
  if (errIdx !== -1) {
    result.error =
      text.slice(errIdx + ERROR_DELIM.length).trim() || "Streaming failed.";
    text = text.slice(0, errIdx);
  }

  const lines = stripPartialMarker(text.split("\n"));

  const bodies: Record<SectionKey, string[]> = {
    MODE: [],
    SAY: [],
    CODE: [],
    COMPLEXITY: [],
    PLAN: [],
    NOTE: [],
  };

  // Content before any marker is almost always the model easing into the SAY
  // line before the header lands; keep it visible under SAY.
  let current: SectionKey | null = "SAY";

  for (const line of lines) {
    const m = line.match(MARKER_RE);
    if (m && (SECTIONS as readonly string[]).includes(m[1])) {
      const key = m[1] as SectionKey;
      const inline = m[2] ?? "";
      if (key === "MODE") {
        result.mode = asMode(inline);
        current = null; // MODE has no multi-line body
      } else if (key === "CODE") {
        result.language = inline.trim().toLowerCase();
        current = "CODE";
      } else {
        current = key;
      }
      continue;
    }
    if (current) bodies[current].push(line);
  }

  result.say = bodies.SAY.join("\n").trim();
  result.code = trimBlankEdges(bodies.CODE.join("\n"));
  result.complexity = bodies.COMPLEXITY.join("\n").trim();
  result.plan = bodies.PLAN.join("\n").trim();
  result.note = bodies.NOTE.join("\n").trim();

  return result;
}

/** Trim leading/trailing blank lines but preserve interior indentation. */
function trimBlankEdges(s: string): string {
  return s.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/** True once the stream has produced something worth showing. */
export function hasCodingContent(s: CodingSolution): boolean {
  return Boolean(
    s.say || s.code || s.complexity || s.plan || s.note || s.mode
  );
}
