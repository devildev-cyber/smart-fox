import { prisma } from "./db";

export const DEFAULT_STRONG_MODEL = "gpt-4.1";
export const DEFAULT_FAST_MODEL = "gpt-4.1-mini";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const FALLBACK_TRANSCRIPTION_MODEL = "whisper-1";

export interface RuntimeConfig {
  openaiApiKey: string;
  /** Where the key came from, for display only. */
  openaiKeySource: "settings" | "env" | "none";
  strongModel: string;
  fastModel: string;
  transcriptionModel: string;
}

const SINGLETON_ID = "singleton";

async function readAppConfig() {
  try {
    return await prisma.appConfig.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    return null;
  }
}

/**
 * Resolve the active configuration. Values saved in the Settings UI (DB) take
 * precedence over environment variables, which act as defaults/fallbacks.
 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const row = await readAppConfig();

  const dbKey = row?.openaiApiKey?.trim();
  const envKey = process.env.OPENAI_API_KEY?.trim();
  const openaiApiKey = dbKey || envKey || "";
  const openaiKeySource: RuntimeConfig["openaiKeySource"] = dbKey
    ? "settings"
    : envKey
      ? "env"
      : "none";

  return {
    openaiApiKey,
    openaiKeySource,
    strongModel:
      row?.strongModel?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      DEFAULT_STRONG_MODEL,
    fastModel:
      row?.fastModel?.trim() ||
      process.env.OPENAI_FAST_MODEL?.trim() ||
      DEFAULT_FAST_MODEL,
    transcriptionModel:
      row?.transcriptionModel?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
  };
}

export async function saveAppConfig(patch: {
  openaiApiKey?: string | null;
  strongModel?: string | null;
  fastModel?: string | null;
  transcriptionModel?: string | null;
}) {
  const data = {
    ...(patch.openaiApiKey !== undefined
      ? { openaiApiKey: normalize(patch.openaiApiKey) }
      : {}),
    ...(patch.strongModel !== undefined
      ? { strongModel: normalize(patch.strongModel) }
      : {}),
    ...(patch.fastModel !== undefined
      ? { fastModel: normalize(patch.fastModel) }
      : {}),
    ...(patch.transcriptionModel !== undefined
      ? { transcriptionModel: normalize(patch.transcriptionModel) }
      : {}),
  };

  return prisma.appConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
}

function normalize(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Mask a secret for display: keeps the prefix and last 4 chars. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}
