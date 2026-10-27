/**
 * Builds the "what has already happened in this interview" text that links the
 * spoken-answer side and the coding side. Whatever the candidate said out loud
 * is canon for the code (and its narration), and whatever they solved is canon
 * for the next spoken answer ("why a hash map?"). Pure, so it is unit-tested.
 */

import { fullCode, type CodingSolution } from "./coding";

export interface MemoryAnswer {
  question: string;
  answer: string;
}

export interface MemoryCodingTurn {
  solution: CodingSolution;
}

function squash(text: string, max: number): string {
  const flat = text
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * Earlier spoken answers, for the coding endpoint. `newestFirst` is the session
 * log order; the output reads oldest to newest.
 */
export function answersForCoding(newestFirst: MemoryAnswer[], limit = 5): string {
  return newestFirst
    .filter((a) => a.answer.trim())
    .slice(0, limit)
    .reverse()
    .map((a) => `- Asked: ${squash(a.question, 160)}\n  Said: ${squash(a.answer, 420)}`)
    .join("\n");
}

/**
 * Coding turns, for the spoken-answer endpoint. The latest turn carries its
 * final code so the interviewer can be answered about it.
 */
export function codingForAnswers(newestFirst: MemoryCodingTurn[], limit = 3): string {
  const turns = newestFirst
    .filter((t) => t.solution.problem || t.solution.say || t.solution.steps.length)
    .slice(0, limit);
  return turns
    .map((t, i) => {
      const s = t.solution;
      const lines: string[] = [];
      lines.push(`- Problem: ${squash(s.problem || s.say, 220)}`);
      if (s.say && s.problem) lines.push(`  Said while solving: ${squash(s.say, 360)}`);
      if (s.language) lines.push(`  Language: ${s.language}`);
      if (s.complexity) lines.push(`  Complexity: ${squash(s.complexity, 80)}`);
      if (s.note) lines.push(`  Note: ${squash(s.note, 160)}`);
      if (i === 0 && s.steps.length) {
        const code = fullCode(s);
        lines.push(`  Code:\n${code.length > 1400 ? `${code.slice(0, 1400)}\n…` : code}`);
      }
      return lines.join("\n");
    })
    .reverse()
    .join("\n");
}
