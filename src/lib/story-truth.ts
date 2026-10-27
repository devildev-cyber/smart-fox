/**
 * Which details in the story bank are REAL (told by the candidate) versus merely
 * derived from the resume. Verified stories are the most trustworthy source for a
 * live answer: they hold the lived specifics (what broke, what was chosen over
 * what, who pushed back) that a resume never contains and that a model would
 * otherwise have to invent.
 *
 * Stored as plain `evidence` entries ("told by you: ...") so no schema change is
 * needed and the user can read and edit them like any other evidence line.
 */

export const TOLD_PREFIX = "told by you:";

/** Build the evidence line for one detail the candidate told us. */
export function toldEntry(detail: string): string {
  return `${TOLD_PREFIX} ${detail.trim()}`;
}

/** True if this evidence line records something the candidate told us. */
export function isToldEntry(entry: string): boolean {
  return entry.trim().toLowerCase().startsWith(TOLD_PREFIX);
}

/** True if any evidence line on the story is a candidate-told detail. */
export function isToldByCandidate(evidence: readonly string[] | undefined): boolean {
  return (evidence ?? []).some(isToldEntry);
}

/** The told details, without the marker prefix. */
export function toldDetails(evidence: readonly string[] | undefined): string[] {
  return (evidence ?? [])
    .filter(isToldEntry)
    .map((e) => e.trim().slice(TOLD_PREFIX.length).trim())
    .filter(Boolean);
}
