import OpenAI from "openai";
import { z } from "zod";
import { getRuntimeConfig } from "./runtime-config";

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

// Cache the client per API key so changing the key in Settings rebuilds it.
let cached: { key: string; client: OpenAI } | null = null;

/**
 * Build (or reuse) an OpenAI client from the active runtime config. The key may
 * come from the Settings UI (DB) or the environment.
 */
export async function getClient(): Promise<OpenAI> {
  const { openaiApiKey } = await getRuntimeConfig();
  if (!openaiApiKey) {
    throw new LlmError(
      "OpenAI API key is not configured. Add it on the Settings page (or set OPENAI_API_KEY).",
      503
    );
  }
  if (!cached || cached.key !== openaiApiKey) {
    cached = {
      key: openaiApiKey,
      client: new OpenAI({
        apiKey: openaiApiKey,
        timeout: DEFAULT_TIMEOUT_MS,
        maxRetries: 0, // we manage retries ourselves
      }),
    };
  }
  return cached.client;
}

/**
 * Attempt to extract a JSON object from a model response that may contain
 * code fences or stray prose, then repair common issues before parsing.
 */
function extractJson(raw: string): unknown {
  const text = raw.trim();

  // Strip markdown code fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  const tryParse = (input: string): unknown | undefined => {
    try {
      return JSON.parse(input);
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;

  // Fall back to the first {...} or [...] block in the string.
  const firstBrace = candidate.indexOf("{");
  const firstBracket = candidate.indexOf("[");
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  if (start !== -1) {
    const openChar = candidate[start];
    const closeChar = openChar === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(closeChar);
    if (end > start) {
      const slice = candidate.slice(start, end + 1);
      const parsed = tryParse(slice);
      if (parsed !== undefined) return parsed;

      // Light repair: remove trailing commas.
      const repaired = slice.replace(/,\s*([}\]])/g, "$1");
      const reparsed = tryParse(repaired);
      if (reparsed !== undefined) return reparsed;
    }
  }

  throw new LlmError("The model returned a response that was not valid JSON.", 502);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface JsonCallOptions<S extends z.ZodTypeAny> {
  model: string;
  system: string;
  user: string;
  schema: S;
  temperature?: number;
  /** Override the request timeout. Heavy extraction tasks need more than 30s. */
  timeoutMs?: number;
  /** Override the output token cap (e.g. for large structured results). */
  maxOutputTokens?: number;
}

/**
 * Reasoning models (o-series and the gpt-5 family) don't accept a custom
 * `temperature` on the Responses API — passing one returns a 400. The
 * non-reasoning chat variant (gpt-5-chat-*) still does.
 */
function isReasoningModel(model: string): boolean {
  const l = model.toLowerCase();
  if (/^o\d/.test(l)) return true;
  if (/^gpt-5/.test(l) && !l.includes("chat")) return true;
  return false;
}

type ReasoningEffortValue = NonNullable<
  OpenAI.Responses.ResponseCreateParams["reasoning"]
>["effort"];

/**
 * Fastest acceptable reasoning effort. The gpt-5 family supports "minimal"
 * (barely any reasoning tokens — ideal for extraction + short spoken answers);
 * the o-series only goes as low as "low". Cast because some SDK versions don't
 * yet list "minimal" even though the API accepts it for gpt-5.
 */
function reasoningEffort(model: string): ReasoningEffortValue {
  return (/^gpt-5/.test(model.toLowerCase()) ? "minimal" : "low") as ReasoningEffortValue;
}

/**
 * Call the OpenAI Responses API and parse + validate a JSON result.
 * Retries once on transient failures, with JSON-repair fallback.
 */
export async function callJson<S extends z.ZodTypeAny>({
  model,
  system,
  user,
  schema,
  temperature = 0.5,
  timeoutMs,
  maxOutputTokens,
}: JsonCallOptions<S>): Promise<z.output<S>> {
  const openai = await getClient();

  // The Responses API requires the literal word "json" in the input messages
  // when using a json_object text format. Guarantee it for every call.
  const jsonInput = /json/i.test(user)
    ? user
    : `${user}\n\nReturn the result as a JSON object only.`;

  const reasoning = isReasoningModel(model);

  const run = async (): Promise<z.output<S>> => {
    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      instructions: system,
      input: jsonInput,
      text: { format: { type: "json_object" } },
    };
    if (reasoning) {
      // Reasoning models reject `temperature`; keep effort as low as the family
      // allows so latency stays usable.
      params.reasoning = { effort: reasoningEffort(model) };
      // CRITICAL: reasoning tokens are billed against the output budget. Without
      // a generous cap the model can spend the whole budget "thinking" and
      // return an empty/truncated body — which looks like "GPT-5 doesn't work"
      // for resume/JD/story extraction. Give it ample room for reasoning + JSON.
      params.max_output_tokens = maxOutputTokens ?? 16000;
    } else {
      params.temperature = temperature;
      if (maxOutputTokens) params.max_output_tokens = maxOutputTokens;
    }

    // Reasoning models are slower; give them more headroom than the client
    // default. Callers can override for heavy structured tasks.
    const timeout = timeoutMs ?? (reasoning ? 90_000 : DEFAULT_TIMEOUT_MS);
    const requestOptions = { timeout };

    let response;
    try {
      response = await openai.responses.create(params, requestOptions);
    } catch (err) {
      // Defensive fallback for any model that unexpectedly rejects temperature.
      if (
        err instanceof OpenAI.APIError &&
        err.status === 400 &&
        /temperature/i.test(err.message) &&
        params.temperature !== undefined
      ) {
        delete params.temperature;
        response = await openai.responses.create(params, requestOptions);
      } else {
        throw err;
      }
    }

    const raw = response.output_text;
    if (!raw || !raw.trim()) {
      // Reasoning models that hit the output cap stop with status "incomplete"
      // and no message text. Surface a clearer, retryable error.
      const incomplete =
        response.status === "incomplete"
          ? ` (stopped early: ${response.incomplete_details?.reason ?? "incomplete"})`
          : "";
      throw new LlmError(`The model returned an empty response${incomplete}.`, 502);
    }

    const json = extractJson(raw);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new LlmError(
        `The model response did not match the expected format: ${parsed.error.issues
          .map((i) => i.path.join(".") + " " + i.message)
          .join("; ")}`,
        502
      );
    }
    return parsed.data;
  };

  try {
    return await run();
  } catch (err) {
    if (shouldRetry(err)) {
      await delay(600);
      try {
        return await run();
      } catch (retryErr) {
        throw normalizeError(retryErr);
      }
    }
    throw normalizeError(err);
  }
}

interface StreamTextOptions {
  model: string;
  system: string;
  user: string;
  temperature?: number;
}

/**
 * Stream a free-text (Markdown) response from the Responses API as an async
 * iterable of text deltas. Used for live interview answers so the candidate sees
 * words appear immediately. Errors are normalized to LlmError.
 */
export async function* streamText({
  model,
  system,
  user,
  temperature = 0.6,
}: StreamTextOptions): AsyncGenerator<string> {
  const openai = await getClient();
  const reasoning = isReasoningModel(model);

  const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
    model,
    instructions: system,
    input: user,
    stream: true,
  };
  if (reasoning) {
    params.reasoning = { effort: reasoningEffort(model) };
    // Leave room for reasoning tokens + the spoken answer so the body isn't
    // starved (reasoning tokens count against the output budget).
    params.max_output_tokens = 4000;
  } else {
    params.temperature = temperature;
  }

  // Reasoning models are slower to first token; give them more headroom.
  const requestOptions = reasoning ? { timeout: 90_000 } : undefined;

  try {
    const stream = await openai.responses.create(params, requestOptions);
    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && event.delta) {
        yield event.delta;
      } else if (event.type === "response.failed") {
        throw new LlmError("The model failed while streaming the answer.", 502);
      }
    }
  } catch (err) {
    if (
      err instanceof OpenAI.APIError &&
      err.status === 400 &&
      /temperature/i.test(err.message) &&
      params.temperature !== undefined
    ) {
      // Retry once without temperature for models that reject it.
      delete params.temperature;
      const stream = await openai.responses.create(params, requestOptions);
      for await (const event of stream) {
        if (event.type === "response.output_text.delta" && event.delta) {
          yield event.delta;
        }
      }
      return;
    }
    throw normalizeError(err);
  }
}

function shouldRetry(err: unknown): boolean {
  if (err instanceof LlmError) {
    // Retry on bad-format / empty / gateway issues, not on auth/config errors.
    return err.status === 502;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    return status === 429 || status >= 500;
  }
  // Network / timeout style errors.
  return true;
}

function normalizeError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 500;
    if (status === 401) {
      return new LlmError("OpenAI rejected the API key. Check OPENAI_API_KEY.", 401);
    }
    if (status === 429) {
      return new LlmError(
        "OpenAI rate limit or quota reached. Please try again shortly.",
        429
      );
    }
    return new LlmError(`OpenAI request failed: ${err.message}`, status);
  }

  if (err instanceof Error) {
    if (err.name === "AbortError" || /timeout/i.test(err.message)) {
      return new LlmError("The model request timed out. Please try again.", 504);
    }
    return new LlmError(err.message, 500);
  }

  return new LlmError("Unknown error while calling the language model.", 500);
}
