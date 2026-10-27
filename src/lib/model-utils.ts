/**
 * Tiny, dependency-free model helpers shared by the server code and tests.
 */

/**
 * "Pro" reasoning models (gpt-5-pro, gpt-5.5-pro, o1-pro, o3-pro, …) run extended
 * reasoning: they only accept reasoning.effort "high" and can take minutes to
 * respond.
 */
export function isProModel(model: string): boolean {
  return model.toLowerCase().includes("-pro");
}

/**
 * The model to use for LIVE coding. A pro model thinks for minutes before the
 * first token, which in a live interview means sitting in silence. Use the base
 * model of the same family instead ("gpt-5.5-pro" -> "gpt-5.5"). Non-pro models
 * are returned unchanged.
 */
export function liveCodingModel(model: string): string {
  return isProModel(model) ? model.replace(/-pro\b/i, "") : model;
}
