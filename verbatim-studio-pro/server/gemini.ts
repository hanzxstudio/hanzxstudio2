import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import fs from 'node:fs/promises';
import type { AutoClipCandidate } from '../src/types/tools.ts';
import type {
  ChapterItem,
  TranscriptSegment,
  TranscriptionAnalysis,
  TranscriptionOptions,
} from '../src/types/transcription.ts';
import { splitSegmentsIntoSubtitleCues } from '../src/utils/subtitleTemplates.ts';

let client: GoogleGenAI | null = null;
let betaClient: GoogleGenAI | null = null;
let clientApiKey: string | null = null;

/** Drop cached Gemini clients so a changed GEMINI_API_KEY takes effect without restart. */
export function resetGeminiClients(): void {
  client = null;
  betaClient = null;
  clientApiKey = null;
}

function readGeminiApiKey(): string {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.length < 20) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your API key in Settings > Secrets.',
    );
  }
  return apiKey;
}

export function hasGeminiApiKey(): boolean {
  try {
    readGeminiApiKey();
    return true;
  } catch {
    return false;
  }
}

// Circuit breakers so rate-limited/exhausted models don't slow down every subsequent chunk
let transcribeCooldownUntil = 0;
const modelCooldownUntil = new Map<string, number>();
let globalThrottleUntil = 0;

// Global semaphore + gentle pacing so parallel jobs/tools never overwhelm Gemini API RPM limits under heavy load
const MAX_CONCURRENT_GEMINI = 3;
const MIN_PACING_MS = 220;
let activeGeminiCalls = 0;
let lastLaunchAt = 0;
const geminiWaitQueue: Array<() => void> = [];

async function withGeminiSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeGeminiCalls >= MAX_CONCURRENT_GEMINI) {
    await new Promise<void>((resolve) => geminiWaitQueue.push(resolve));
  }
  activeGeminiCalls += 1;
  try {
    const waitGap = MIN_PACING_MS - (Date.now() - lastLaunchAt);
    if (waitGap > 0) {
      await new Promise((r) => setTimeout(r, waitGap));
    }
    lastLaunchAt = Date.now();
    return await fn();
  } finally {
    activeGeminiCalls = Math.max(0, activeGeminiCalls - 1);
    const next = geminiWaitQueue.shift();
    if (next) next();
  }
}

const FAST_MODEL_POOL = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = readGeminiApiKey();
  if (!client || clientApiKey !== apiKey) {
    clientApiKey = apiKey;
    client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return client;
}

function getBetaGeminiClient(): GoogleGenAI {
  const apiKey = readGeminiApiKey();
  if (!betaClient || clientApiKey !== apiKey) {
    clientApiKey = apiKey;
    betaClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return betaClient;
}

export function isHardDailyQuotaError(msg: string): boolean {
  return /PerDay|RequestsPerDay|per day|retry in \d+\s*h/i.test(msg);
}

export function isAuthOrBillingError(msg: string): boolean {
  return /API_KEY_INVALID|PERMISSION_DENIED|"code":\s*403/i.test(msg);
}

function parseRetryAfterMs(msg: string): number | null {
  const secMatch =
    msg.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i) ||
    msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (secMatch) {
    const secs = Number.parseFloat(secMatch[1]);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(65_000, Math.max(2_000, Math.ceil(secs * 1000) + 1_200));
    }
  }
  return null;
}

export function formatApiError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let statusStr = '';
  let codeNum = 0;
  if (message.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(message) as {
        error?: { message?: string; code?: number; status?: string };
      };
      if (parsed.error?.message) message = parsed.error.message;
      if (parsed.error?.status) statusStr = parsed.error.status;
      if (parsed.error?.code) codeNum = parsed.error.code;
    } catch {
      // Keep original
    }
  }
  if (/free tier is not available/i.test(message)) {
    return 'Gemini free tier is not available for this API key\u2019s Google project. The key itself is valid, but Google refuses free-tier use — set up billing at aistudio.google.com/billing, or use a new key from another Google account / new AI Studio project that still has free tier.';
  }
  if (
    codeNum === 403 ||
    statusStr === 'PERMISSION_DENIED' ||
    message.includes('API_KEY_INVALID') ||
    message.includes('PERMISSION_DENIED')
  ) {
    return 'Gemini API key is invalid or lacks permission. Please verify GEMINI_API_KEY in Settings > Secrets.';
  }
  if (
    codeNum === 429 ||
    statusStr === 'RESOURCE_EXHAUSTED' ||
    /RESOURCE_EXHAUSTED|quota|rate[- ]limit|429/i.test(message)
  ) {
    if (isHardDailyQuotaError(message)) {
      return 'Daily Gemini free-tier quota reached for this API key. Try again after the daily reset, or switch to a billing-enabled API key in Settings > Secrets.';
    }
    return 'Gemini API per-minute rate limit is currently busy. Please wait 30–60 seconds and try again (or add a billing-enabled key in Settings > Secrets for faster multi-hour runs).';
  }
  if (
    codeNum === 503 ||
    statusStr === 'UNAVAILABLE' ||
    /503|UNAVAILABLE|high demand/i.test(message)
  ) {
    return 'The AI transcription service is temporarily busy (503). Please try again in a few seconds.';
  }
  return message;
}

async function waitForGlobalThrottle(): Promise<void> {
  const now = Date.now();
  if (globalThrottleUntil > now) {
    const waitMs = Math.min(45_000, globalThrottleUntil - now);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForGlobalThrottle();
    try {
      return await withGeminiSlot(fn);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (isHardDailyQuotaError(msg) || isAuthOrBillingError(msg)) {
        throw err;
      }
      const isRateLimit = /429|RESOURCE_EXHAUSTED|rate[- ]limit|quota/i.test(msg);
      const isRetryable =
        isRateLimit ||
        /500|502|503|504|UNAVAILABLE|high demand|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      const parsedDelay = isRateLimit ? parseRetryAfterMs(msg) : null;
      const baseMs =
        parsedDelay ??
        (isRateLimit
          ? Math.min(35_000, 6_000 * attempt)
          : 1_200 * Math.pow(2, attempt - 1));
      const delayMs = baseMs + Math.floor(Math.random() * 1_000);
      if (isRateLimit) {
        globalThrottleUntil = Math.max(globalThrottleUntil, Date.now() + Math.min(delayMs, 20_000));
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

async function generateFast(
  ai: GoogleGenAI,
  params: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>,
) {
  let lastErr: unknown;

  for (let pass = 0; pass < 2; pass++) {
    const now = Date.now();
    // Try healthy models first, then any model on shortest cooldown
    const orderedModels = [...FAST_MODEL_POOL].sort((a, b) => {
      const ca = modelCooldownUntil.get(a) ?? 0;
      const cb = modelCooldownUntil.get(b) ?? 0;
      const aReady = ca <= now ? 0 : ca;
      const bReady = cb <= now ? 0 : cb;
      return aReady - bReady;
    });

    for (const model of orderedModels) {
      const cooldown = modelCooldownUntil.get(model) ?? 0;
      if (cooldown > Date.now() && pass === 0) {
        continue;
      }
      if (cooldown > Date.now()) {
        const waitMs = Math.min(45_000, cooldown - Date.now());
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }

      try {
        return await withRetry(
          () =>
            ai.models.generateContent({
              ...params,
              model,
              config: {
                ...params.config,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              },
            }),
          3,
        );
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (isAuthOrBillingError(msg)) {
          throw err;
        }
        const isQuotaOrBusy =
          /429|RESOURCE_EXHAUSTED|quota|rate[- ]limit|503|UNAVAILABLE|high demand/i.test(msg);
        if (isQuotaOrBusy) {
          const parsedMs = parseRetryAfterMs(msg);
          const cdMs = isHardDailyQuotaError(msg)
            ? 15 * 60 * 1000
            : (parsedMs ?? 30 * 1000);
          modelCooldownUntil.set(model, Date.now() + cdMs);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

export function parseTimestampToSeconds(raw: string): number {
  const cleaned = raw.trim().replace(/[\[\]()]/g, '');
  const parts = cleaned.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2) {
    return Math.round(parts[0] * 60 + parts[1]);
  }
  return Math.round(parts[0] || 0);
}

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export type ScriptTargetMode = 'urdu-pure' | 'roman-urdu' | 'urdu-english' | 'english';
export type RepurposeFormat = 'study-notes' | 'blog-article' | 'youtube-pack' | 'social-thread';

export function resolveScriptMode(options: TranscriptionOptions): ScriptTargetMode | 'auto' {
  const lang = options.language;
  if (lang === 'Urdu (Pure Nastaliq Script)' || lang === 'Urdu (اردو)') return 'urdu-pure';
  if (lang === 'Roman Urdu (Latin Script)' || lang === 'Roman Urdu / Hinglish') return 'roman-urdu';
  if (lang === 'Urdu + English (Bilingual)') return 'urdu-english';
  if (options.translateToEnglish || lang === 'English') return 'english';
  return 'auto';
}

export function sanitizeSpeakerLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  let cleaned = raw.replace(/[\[\]*:]/g, '').replace(/[,\-.\s]+$/g, '').trim();
  if (!cleaned || cleaned.length > 36) return undefined;
  // Reject accidental numeric timestamps / float noise like "329.83", "Speaker 329.83", "Speaker 23.366", "12:04"
  if (/^\d+(?:[.:]\d+)*$/.test(cleaned)) return undefined;
  if (/^speaker\s+\d+\.\d+/i.test(cleaned)) return undefined;
  if (/^speaker\s+\d{3,}/i.test(cleaned)) return undefined;
  if (/^\d{1,2}$/.test(cleaned)) cleaned = `Speaker ${cleaned}`;
  return cleaned;
}

function scriptInstructionForMode(mode: ScriptTargetMode): string {
  switch (mode) {
    case 'urdu-pure':
      return [
        'STRICT SCRIPT RULE (PURE URDU ONLY): Write EVERY SINGLE WORD 100% strictly in standard Urdu Arabic script (اردو رسم الخط).',
        'STRICTLY FORBIDDEN: ZERO Devanagari/Hindi script (हिन्दी / अ आ इ), ZERO Roman Urdu (e.g., NEVER write "aap", "hai", "ka", "mein"), and ZERO Latin/English A-Z words anywhere.',
        'Even if the speaker says English loanwords or technical terms (like social media, addiction, depression, mobile, point, statement), transliterate them cleanly into Urdu script (سوشل میڈیا، ایڈکشن، ڈپریشن، موبائل، پوائنٹ، سٹیٹمنٹ) or natural Urdu.',
      ].join(' ');
    case 'roman-urdu':
      return [
        'STRICT SCRIPT RULE (ROMAN URDU ONLY): Write EVERY SINGLE WORD 100% strictly in Roman Urdu using Latin A-Z letters (e.g., "Assalam-o-Alaikum, aaj ka topic bohat important hai").',
        'STRICTLY FORBIDDEN: ZERO Urdu/Arabic Unicode script (ا ب پ...) and ZERO Devanagari/Hindi script (अ आ इ...). Transliterate all Urdu/Arabic phrases into readable Roman Urdu.',
      ].join(' ');
    case 'urdu-english':
      return [
        'STRICT SCRIPT RULE (URDU + SPOKEN ENGLISH WORDS ONLY): Write all spoken Urdu/Hindi words and sentences 100% strictly in standard Urdu Arabic script (اردو رسم الخط)—NEVER in Devanagari/Hindi (अ आ इ) and NEVER in Roman Urdu (aap, hai, mein, karna).',
        'ONLY keep genuine English words or phrases actually spoken by the speaker inline in standard English.',
        'NEVER output Devanagari/Hindi script anywhere. NEVER write duplicate bilingual echoes like "بریفلی (briefly)" or translate Urdu sentences into English.',
      ].join(' ');
    case 'english':
      return 'Write all dialogue strictly in clear, natural standard English (no Devanagari or non-English scripts).';
  }
}

function buildLanguageDirective(options: TranscriptionOptions): string {
  const mode = resolveScriptMode(options);
  let langLine: string;

  if (mode === 'urdu-pure' || mode === 'roman-urdu' || mode === 'urdu-english') {
    langLine = scriptInstructionForMode(mode);
  } else if (options.language === 'auto') {
    langLine =
      'Transcribe in the exact spoken language(s) verbatim. IMPORTANT: When Urdu is spoken, write all Urdu words strictly in Urdu Arabic script (اردو)—never output Devanagari Hindi or Roman Urdu unless Hindi was explicitly chosen—keeping only genuinely spoken English words in English.';
  } else {
    langLine = `The primary spoken language is ${options.language}. Transcribe strictly and accurately in ${options.language} without drifting into unrelated scripts.`;
  }

  const translateLine = options.translateToEnglish
    ? 'Translate all spoken dialogue clearly into natural English while keeping speaker turns and timestamps intact.'
    : 'Preserve the original spoken wording faithfully.';

  const speakerLine = options.identifySpeakers
    ? 'Identify different speakers consistently as clean labels (e.g., Speaker 1, Speaker 2—never put timestamps or decimal numbers in speaker labels).'
    : 'Do not include speaker labels.';

  return `${langLine} ${translateLine} ${speakerLine}`;
}

const ARABIC_URDU_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const DEVANAGARI_INDIC_RE = /[\u0900-\u0D7F]/;
const LATIN_WORD_RE = /[A-Za-z]{2,}/;
const PAREN_ECHO_RE = /[\u0600-\u06FF]+\s*\([A-Za-z][A-Za-z\s'-]{1,35}\)/;
const ROMAN_URDU_CLUES_RE =
  /\b(hai|hain|nahi|nhi|aap|mein|ham|hum|tum|woh|yeh|kaise|kya|kyun|kyunki|lekin|aur|kuch|bohat|bahut|bhi|rha|raha|rahi|karna|karke|krna|wala|wali|wale|samajh|dekhein|baat|gunah|allah|taala)\b/i;

export function segmentNeedsScriptFix(seg: TranscriptSegment, mode: ScriptTargetMode): boolean {
  const txt = seg.text.trim();
  if (!txt) return false;
  if (DEVANAGARI_INDIC_RE.test(txt)) {
    // Devanagari Hindi / Indic script NEVER belongs in Urdu Pure, Roman Urdu, Urdu+English, or English
    return true;
  }
  if (mode === 'urdu-pure') {
    return LATIN_WORD_RE.test(txt);
  }
  if (mode === 'roman-urdu') {
    return ARABIC_URDU_RE.test(txt);
  }
  if (mode === 'urdu-english') {
    if (ROMAN_URDU_CLUES_RE.test(txt)) return true;
    if (PAREN_ECHO_RE.test(txt)) return true;
    if (!ARABIC_URDU_RE.test(txt) && txt.length > 75) return true;
    return false;
  }
  return false;
}

/** Shared script-conversion prompts (also used by the Groq provider). */
export const SCRIPT_MODE_PROMPTS: Record<ScriptTargetMode, string> = {
  'urdu-pure':
    'Convert EVERY segment strictly into 100% Pure Urdu Arabic script (اردو رسم الخط). Transliterate any Hindi/Devanagari or English/Roman words phonetically into Urdu script (e.g., "सामने रखें" -> "سامنے رکھیں", "social media" -> "سوشل میڈیا"). Output ZERO Devanagari and ZERO Latin/English letters.',
  'roman-urdu':
    'Convert EVERY segment strictly into natural Roman Urdu using Latin A-Z script only (e.g., "Assalam-o-Alaikum, aaj ka topic bohat aham hai"). Convert any Urdu Arabic or Hindi Devanagari words into Roman Urdu. Output ZERO Arabic/Urdu or Devanagari characters.',
  'urdu-english':
    'Convert ALL Hindi/Devanagari script (e.g. आपके लिए, सामने रखें) and ANY Roman Urdu words strictly into standard Urdu Arabic script (اردو). Keep ONLY genuinely spoken English technical/loan words in clean English. Remove any doubled echoes like "بریفلی (briefly)". Output ZERO Devanagari/Hindi characters.',
  english:
    'Translate EVERY segment accurately into clear, natural English with ZERO Devanagari or other non-English scripts.',
};

/**
 * A JSON generator: prompt + Gemini-style response schema -> parsed JSON.
 * Lets the same transcript logic run on Gemini (default) or Groq (injected).
 */
export type JsonGenerator = (
  prompt: string,
  responseSchema: Record<string, unknown>,
) => Promise<unknown>;

export type TextGenerator = (prompt: string) => Promise<string>;

export interface ClipPick {
  title: string;
  hookSummary: string;
  reason: string;
  category: string;
  startSec: number;
  endSec: number;
}

export type ClipPickFetcher = (prompt: string) => Promise<ClipPick[]>;

export async function geminiJsonGenerator(
  prompt: string,
  responseSchema: Record<string, unknown>,
): Promise<unknown> {
  const ai = getGeminiClient();
  const res = await generateFast(ai, {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema as never,
    },
  });
  return JSON.parse((res.text ?? '{}').trim());
}

async function rewriteSegmentsBatch(
  segments: TranscriptSegment[],
  targetMode: ScriptTargetMode,
  jsonGen: JsonGenerator = geminiJsonGenerator,
): Promise<TranscriptSegment[]> {
  if (segments.length === 0) return segments;

  const payload = segments.map((s) => ({
    id: s.id,
    text: s.text,
  }));

  try {
    const parsed = (await jsonGen(
      [
        SCRIPT_MODE_PROMPTS[targetMode],
        'Preserve the exact array order and every "id" unchanged. Do not add timestamps inside "text".',
        JSON.stringify(payload),
      ].join('\n\n'),
      {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            text: { type: Type.STRING },
          },
          required: ['id', 'text'],
        },
      },
    )) as Array<{ id?: string; text?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return segments;

    const byId = new Map<string, string>();
    parsed.forEach((item, idx) => {
      const val = typeof item?.text === 'string' ? item.text.trim() : '';
      if (val) {
        byId.set(item.id || segments[idx]?.id || '', val);
      }
    });

    return segments.map((seg, idx) => ({
      ...seg,
      text: byId.get(seg.id) || parsed[idx]?.text?.trim() || seg.text,
    }));
  } catch {
    return segments;
  }
}

async function enforceScriptPurity(
  segments: TranscriptSegment[],
  options: TranscriptionOptions,
): Promise<TranscriptSegment[]> {
  const mode = resolveScriptMode(options);
  if (mode === 'auto' || segments.length === 0) {
    return segments;
  }

  let working = [...segments];
  // Up to 2 passes in clean batches of 25 so large Devanagari chunks are guaranteed fixed
  for (let pass = 0; pass < 2; pass++) {
    const offendingIndices: number[] = [];
    for (let i = 0; i < working.length; i++) {
      if (segmentNeedsScriptFix(working[i], mode)) {
        offendingIndices.push(i);
      }
    }
    if (offendingIndices.length === 0) break;

    for (let start = 0; start < offendingIndices.length; start += 25) {
      const sliceIndices = offendingIndices.slice(start, start + 25);
      const toFix = sliceIndices.map((idx) => working[idx]);
      const fixed = await rewriteSegmentsBatch(toFix, mode);
      sliceIndices.forEach((origIdx, k) => {
        if (fixed[k]?.text?.trim()) {
          working[origIdx] = {
            ...working[origIdx],
            text: fixed[k].text.trim(),
          };
        }
      });
    }
  }
  return working;
}

function splitTextSentences(text: string): string[] {
  const matches = text.match(/[^.!?؟۔।。]+(?:[.!?؟۔।。]+["'”’)\]]*)?/g);
  if (!matches) return [text.trim()].filter(Boolean);
  return matches.map((s) => s.trim()).filter(Boolean);
}

/**
 * Splits any segment containing leaked inline [MM:SS] markers OR excessive length (>420 chars / >45s)
 * into clean, proportionally timestamped segments along sentence boundaries.
 */
function enforceSegmentGranularity(
  segments: TranscriptSegment[],
  chunkOffsetSec: number,
  chunkDurationSec: number,
): TranscriptSegment[] {
  const afterInlineSplit: TranscriptSegment[] = [];

  for (const seg of segments) {
    const clean = seg.text.trim();
    if (!clean) continue;

    // Detect leaked inline [MM:SS] or [HH:MM:SS] tags inside text
    const markerRe = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(?:([A-Za-z0-9 _.-]{1,28}):\s*)?/g;
    const matches = Array.from(clean.matchAll(markerRe));

    if (matches.length === 0) {
      afterInlineSplit.push(seg);
      continue;
    }

    let lastEnd = 0;
    let currentStart = seg.startSec;
    let currentSpeaker = seg.speaker;
    const parts: Array<{ startSec: number; speaker?: string; text: string }> = [];

    for (const m of matches) {
      const idx = m.index ?? 0;
      const before = clean.slice(lastEnd, idx).trim();
      if (before) {
        parts.push({ startSec: currentStart, speaker: currentSpeaker, text: before });
      }
      const parsedSec = parseTimestampToSeconds(m[1]);
      // Treat as relative to chunkOffsetSec if within chunk bounds, else absolute if >= seg.startSec
      if (parsedSec <= Math.ceil(chunkDurationSec) + 5 && chunkOffsetSec >= parsedSec) {
        currentStart = Math.round(chunkOffsetSec + parsedSec);
      } else if (parsedSec >= seg.startSec && parsedSec <= chunkOffsetSec + chunkDurationSec + 10) {
        currentStart = Math.round(parsedSec);
      } else {
        currentStart = Math.max(currentStart + 5, Math.round(seg.startSec + parsedSec));
      }
      if (m[2]) currentSpeaker = m[2].trim();
      lastEnd = idx + m[0].length;
    }
    const tail = clean.slice(lastEnd).trim();
    if (tail) {
      parts.push({ startSec: currentStart, speaker: currentSpeaker, text: tail });
    }

    for (let i = 0; i < parts.length; i++) {
      const nextStart =
        i < parts.length - 1 ? Math.max(parts[i].startSec + 1, parts[i + 1].startSec) : seg.endSec;
      afterInlineSplit.push({
        id: `${seg.id}_in${i}`,
        startSec: parts[i].startSec,
        endSec: Math.max(parts[i].startSec + 1, nextStart),
        speaker: parts[i].speaker,
        text: parts[i].text,
      });
    }
  }

  // Subdivide any remaining mega-segment (>420 chars or >45s span with multiple sentences)
  const finalSegs: TranscriptSegment[] = [];
  for (const seg of afterInlineSplit) {
    const spanSec = Math.max(2, seg.endSec - seg.startSec);
    if (seg.text.length <= 420 && (spanSec <= 48 || seg.text.length <= 200)) {
      finalSegs.push(seg);
      continue;
    }

    const sentences = splitTextSentences(seg.text);
    const groups: string[] = [];
    let buf = '';
    const targetLen = 280;

    for (const s of sentences) {
      if (buf && (buf + ' ' + s).length > targetLen) {
        groups.push(buf.trim());
        buf = s;
      } else {
        buf = buf ? `${buf} ${s}` : s;
      }
    }
    if (buf.trim()) groups.push(buf.trim());

    // If a single run-on sentence lacked punctuation, split gently by word count (~55 words)
    if (groups.length === 1 && groups[0].length > 440) {
      const words = groups[0].split(/\s+/);
      groups.length = 0;
      for (let w = 0; w < words.length; w += 50) {
        groups.push(words.slice(w, w + 50).join(' '));
      }
    }

    if (groups.length <= 1) {
      finalSegs.push(seg);
      continue;
    }

    const totalChars = groups.reduce((acc, g) => acc + g.length, 0) || 1;
    let cursorSec = seg.startSec;

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const text = groups[gIdx];
      const frac = text.length / totalChars;
      const gStart = Math.round(cursorSec);
      cursorSec += spanSec * frac;
      const gEnd =
        gIdx === groups.length - 1
          ? Math.max(gStart + 1, seg.endSec)
          : Math.max(gStart + 1, Math.round(cursorSec));
      finalSegs.push({
        id: `${seg.id}_sub${gIdx}`,
        startSec: gStart,
        endSec: gEnd,
        speaker: seg.speaker,
        text,
      });
    }
  }

  for (let i = 0; i < finalSegs.length; i++) {
    if (i < finalSegs.length - 1) {
      finalSegs[i].endSec = Math.max(finalSegs[i].startSec + 1, finalSegs[i + 1].startSec);
    } else {
      finalSegs[i].endSec = Math.max(finalSegs[i].startSec + 2, finalSegs[i].endSec);
    }
  }

  return normalizeAndSpreadChunkTimestamps(finalSegs, chunkOffsetSec, chunkDurationSec);
}

/**
 * Prevents repeated chunk-boundary timestamps (e.g., 8+ lines all stuck at [04:00], [08:00], [32:00])
 * by detecting absolute vs relative timestamps first and smoothly redistributing any stacked runs
 * proportionally across the available time span.
 */
export function normalizeAndSpreadChunkTimestamps(
  segments: TranscriptSegment[],
  offsetSec: number,
  chunkDurationSec: number,
): TranscriptSegment[] {
  if (segments.length === 0) return [];
  const dur = Math.max(4, Math.round(chunkDurationSec));
  const chunkEnd = Math.round(offsetSec + dur);
  const safeCap = Math.max(offsetSec + 1, chunkEnd - 2);

  const out: TranscriptSegment[] = segments.map((s) => ({
    ...s,
    speaker: sanitizeSpeakerLabel(s.speaker),
    startSec: Math.max(offsetSec, Math.min(safeCap, Math.round(s.startSec))),
  }));

  // Ensure monotonic non-decreasing timestamps following spoken order
  for (let i = 1; i < out.length; i++) {
    if (out[i].startSec < out[i - 1].startSec) {
      out[i].startSec = out[i - 1].startSec;
    }
  }

  // Spread any run of 2+ consecutive segments sharing the exact same startSec (or clustered within 1s at chunk end)
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    const isEndCluster = out[i].startSec >= chunkEnd - 15;
    while (
      j < out.length &&
      (out[j].startSec === out[i].startSec || (isEndCluster && out[j].startSec >= chunkEnd - 15))
    ) {
      j += 1;
    }
    const runLen = j - i;
    if (runLen >= 2) {
      const prevStart = i > 0 ? out[i - 1].startSec : offsetSec;
      const maxAllowedEnd = j < out.length ? Math.max(prevStart + 1, out[j].startSec - 1) : safeCap;
      const winStart = isEndCluster
        ? Math.max(offsetSec, Math.min(maxAllowedEnd - Math.min(runLen, maxAllowedEnd - offsetSec), prevStart + 4))
        : out[i].startSec;
      const winEnd =
        j < out.length
          ? maxAllowedEnd
          : safeCap;
      const span = Math.max(1, winEnd - winStart);
      const runChars =
        out.slice(i, j).reduce((acc, s) => acc + Math.max(8, s.text.length), 0) || 1;

      let cursor = winStart;
      for (let k = i; k < j; k++) {
        out[k].startSec = Math.max(prevStart, Math.min(maxAllowedEnd, Math.round(cursor)));
        cursor += (Math.max(8, out[k].text.length) / runChars) * span;
      }
    }
    i = j;
  }

  for (let k = 0; k < out.length; k++) {
    if (k < out.length - 1) {
      out[k].endSec = Math.max(out[k].startSec + 1, out[k + 1].startSec);
    } else {
      out[k].endSec = Math.max(out[k].startSec + 2, chunkEnd);
    }
  }

  return out;
}

function parseTimestampedLines(
  rawText: string,
  offsetSec: number,
  chunkDurationSec: number,
  identifySpeakers: boolean,
): TranscriptSegment[] {
  // Split inline bracketed timestamps onto separate lines first so `[00:13] ... [00:57] ...` never stays merged
  const normalizedRaw = rawText
    .replace(/\*\*(\[\d{1,3}:\d{2}(?::\d{2})?\])\*\*/g, '$1')
    .replace(/([^\n])\s+(?=\[\d{1,3}:\d{2}(?::\d{2})?\])/g, '$1\n');

  const lines = normalizedRaw
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  const lineRegex =
    /^\*{0,2}\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?\*{0,2}\s*(?:-\s*)?(?:\*{0,2}([A-Za-z][A-Za-z0-9 ._-]{0,30}):\*{0,2}\s+)?(.+)$/;
  const rawItems: Array<{ rawSec: number; speaker?: string; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(lineRegex);
    if (match) {
      const rawSec = parseTimestampToSeconds(match[1]);
      const speaker = identifySpeakers ? sanitizeSpeakerLabel(match[2]) : undefined;
      const text = match[3].trim();
      if (text && text !== 'NO_SPEECH') {
        rawItems.push({ rawSec, speaker, text });
      }
    } else if (rawItems.length > 0 && !/^NO_SPEECH$/i.test(lines[i])) {
      const prev = rawItems[rawItems.length - 1];
      prev.text = `${prev.text} ${lines[i]}`.trim();
    }
  }

  if (rawItems.length === 0) return [];

  const maxRel = Math.max(4, Math.ceil(chunkDurationSec));
  const absCount = rawItems.filter(
    (item) => offsetSec >= 60 && item.rawSec >= offsetSec - 5 && item.rawSec <= offsetSec + maxRel + 25,
  ).length;
  const treatsAsAbsolute = absCount >= Math.max(1, Math.ceil(rawItems.length * 0.4));

  const parsed: TranscriptSegment[] = rawItems.map((item, idx) => {
    const rel = treatsAsAbsolute
      ? Math.max(0, item.rawSec - offsetSec)
      : item.rawSec >= offsetSec - 5 && offsetSec >= 60
        ? Math.max(0, item.rawSec - offsetSec)
        : Math.max(0, item.rawSec);
    const boundedRel = Math.min(rel, Math.max(1, maxRel - 2));
    const startSec = Math.round(offsetSec + boundedRel);
    return {
      id: `seg_${offsetSec}_${idx}`,
      startSec,
      endSec: startSec + 5,
      speaker: item.speaker,
      text: item.text,
    };
  });

  return enforceSegmentGranularity(parsed, offsetSec, chunkDurationSec);
}

function splitPlainTextIntoSegments(
  rawText: string,
  offsetSec: number,
  chunkDurationSec: number,
): TranscriptSegment[] {
  const cleaned = rawText.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === 'NO_SPEECH') return [];

  const sentences = cleaned.match(/[^.!?؟۔]+[.!?؟۔]?/g) || [cleaned];
  const groups: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((buffer + ' ' + s).trim().length > 260 && buffer) {
      groups.push(buffer.trim());
      buffer = s;
    } else {
      buffer = (buffer + ' ' + s).trim();
    }
  }
  if (buffer) groups.push(buffer.trim());

  const totalChars = groups.reduce((acc, g) => acc + g.length, 0) || 1;
  let elapsed = 0;

  return groups.map((text, idx) => {
    const fraction = text.length / totalChars;
    const dur = Math.max(2, chunkDurationSec * fraction);
    const startSec = Math.round(offsetSec + elapsed);
    elapsed += dur;
    const endSec = Math.round(offsetSec + Math.min(chunkDurationSec, elapsed));
    return {
      id: `seg_${offsetSec}_${idx}`,
      startSec,
      endSec: Math.max(startSec + 1, endSec),
      text,
    };
  });
}

async function transcribeChunkFastLines(params: {
  audioPart: Record<string, unknown>;
  offsetSec: number;
  chunkDurationSec: number;
  chunkIndex: number;
  totalChunks: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  const ai = getGeminiClient();
  const maxRelSec = Math.max(1, Math.round(params.chunkDurationSec));
  const targetWindow =
    params.options.timestampInterval === '60s'
      ? '45-60 seconds'
      : params.options.timestampInterval === '30s'
        ? '20-30 seconds'
        : '15-25 seconds';

  const structuredPrompt = [
    `Audio segment ${params.chunkIndex + 1}/${params.totalChunks} (duration ${maxRelSec}s).`,
    'Transcribe ALL spoken dialogue verbatim from start to end. Do NOT summarize or omit words.',
    buildLanguageDirective(params.options),
    `Split the transcript into MANY fine-grained timestamped segments (one new segment every ${targetWindow} or at every speaker turn/sentence pause, never merging multiple minutes together).`,
    `Each item must have relative "startSec" (number from 0 to ${Math.max(1, maxRelSec - 2)}, where 0 is the start of THIS ${maxRelSec}s clip—NOT total video seconds), optional clean "speaker" (or empty if single speaker), and clean "text" without embedded timestamps.`,
    'If the audio has no speech at all, return an empty array [].',
  ].join('\n');

  try {
    const jsonRes = await generateFast(ai, {
      contents: {
        parts: [params.audioPart, { text: structuredPrompt }],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              startSec: { type: Type.NUMBER },
              speaker: { type: Type.STRING },
              text: { type: Type.STRING },
            },
            required: ['startSec', 'text'],
          },
        },
      },
    });

    const parsedArr = JSON.parse((jsonRes.text ?? '[]').trim()) as Array<{
      startSec?: number;
      speaker?: string;
      text?: string;
    }>;

    if (Array.isArray(parsedArr)) {
      const validItems = parsedArr.filter(
        (item) => typeof item?.text === 'string' && item.text.trim() && item.text.trim() !== 'NO_SPEECH',
      );
      if (validItems.length === 0) return [];

      // Detect if Gemini accidentally returned absolute video seconds instead of relative 0..maxRelSec
      const absHits = validItems.filter((item) => {
        const val = Number(item.startSec) || 0;
        return params.offsetSec >= 60 && val >= params.offsetSec - 5 && val <= params.offsetSec + maxRelSec + 25;
      }).length;
      const mostlyAbsolute = absHits >= Math.max(1, Math.ceil(validItems.length * 0.4));

      const cleaned: TranscriptSegment[] = validItems.map((item, idx) => {
        const rawNum = Math.round(Number(item.startSec) || 0);
        const relRaw =
          mostlyAbsolute || (params.offsetSec >= 60 && rawNum >= params.offsetSec - 5)
            ? Math.max(0, rawNum - params.offsetSec)
            : Math.max(0, rawNum);
        const rel = Math.min(Math.max(1, maxRelSec - 2), relRaw);
        const absStart = Math.round(params.offsetSec + rel);
        return {
          id: `seg_${params.offsetSec}_${idx}`,
          startSec: absStart,
          endSec: absStart + 15,
          speaker: params.options.identifySpeakers
            ? sanitizeSpeakerLabel(item.speaker)
            : undefined,
          text: item.text!.trim(),
        };
      });

      const granular = enforceSegmentGranularity(
        cleaned,
        params.offsetSec,
        params.chunkDurationSec,
      );
      return await enforceScriptPurity(granular, params.options);
    }
  } catch {
    // Fallback to text prompt mode below if structured schema returns invalid JSON
  }

  const intervalHint =
    params.options.timestampInterval === '60s'
      ? 'every 45-60 seconds or at topic shifts'
      : params.options.timestampInterval === '30s'
        ? 'every 25-30 seconds or at speaker turns'
        : 'at every natural speaker turn or every 15-25 seconds';

  const prompt = [
    `Audio segment ${params.chunkIndex + 1}/${params.totalChunks} (duration ${maxRelSec}s).`,
    'Transcribe ALL spoken words verbatim without summarizing or skipping anything.',
    buildLanguageDirective(params.options),
    `Format EVERY segment on its OWN NEW LINE as: [MM:SS] ${params.options.identifySpeakers ? 'Speaker 1: ' : ''}Spoken text`,
    `Output a NEW [MM:SS] line ${intervalHint} (from [00:00] up to [${formatTimecode(maxRelSec)}]). NEVER combine more than 30 seconds into a single line.`,
    'If the audio contains only silence or non-speech noise, reply strictly with NO_SPEECH.',
  ].join('\n');

  const res = await generateFast(ai, {
    contents: {
      parts: [params.audioPart, { text: prompt }],
    },
  });

  const rawText = (res.text ?? '').trim();
  if (!rawText || rawText === 'NO_SPEECH') return [];

  const parsed = parseTimestampedLines(
    rawText,
    params.offsetSec,
    params.chunkDurationSec,
    params.options.identifySpeakers,
  );
  if (parsed.length > 0) {
    return await enforceScriptPurity(parsed, params.options);
  }
  return await enforceScriptPurity(
    enforceSegmentGranularity(
      splitPlainTextIntoSegments(rawText, params.offsetSec, params.chunkDurationSec),
      params.offsetSec,
      params.chunkDurationSec,
    ),
    params.options,
  );
}

export async function transcribeAudioChunk(params: {
  filePath: string;
  mimeType: string;
  offsetSec: number;
  chunkDurationSec: number;
  chunkIndex: number;
  totalChunks: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  const ai = getGeminiClient();
  const betaAi = getBetaGeminiClient();
  const stat = await fs.stat(params.filePath);
  let audioPart: Record<string, unknown>;
  let uploadedFileName: string | undefined;

  if (stat.size <= 16 * 1024 * 1024) {
    const bytes = await fs.readFile(params.filePath);
    audioPart = {
      inlineData: {
        mimeType: params.mimeType,
        data: bytes.toString('base64'),
      },
    };
  } else {
    const uploaded = await ai.files.upload({
      file: params.filePath,
      config: { mimeType: params.mimeType },
    });
    uploadedFileName = uploaded.name;
    audioPart = {
      fileData: {
        fileUri: uploaded.uri,
        mimeType: uploaded.mimeType || params.mimeType,
      },
    };
  }

  try {
    // For multi-chunk long-form files or if gemini-3.5-transcribe is in cooldown, use fast parallel path directly
    const shouldTryDedicatedAsr = params.totalChunks === 1 && Date.now() >= transcribeCooldownUntil;

    if (!shouldTryDedicatedAsr) {
      return await transcribeChunkFastLines({
        audioPart,
        offsetSec: params.offsetSec,
        chunkDurationSec: params.chunkDurationSec,
        chunkIndex: params.chunkIndex,
        totalChunks: params.totalChunks,
        options: params.options,
      });
    }

    const intervalHint =
      params.options.timestampInterval === '60s'
        ? 'roughly every 60 seconds or at topic shifts'
        : params.options.timestampInterval === '30s'
          ? 'roughly every 30 seconds or at speaker turns'
          : 'at every natural speaker turn or every 15-25 seconds';

    const transcribePrompt = [
      `This is audio segment ${params.chunkIndex + 1} of ${params.totalChunks} (duration ${Math.round(params.chunkDurationSec)} seconds).`,
      'Transcribe ALL spoken words completely and verbatim. Do NOT summarize, omit, or skip anything.',
      buildLanguageDirective(params.options),
      `Output one segment per line using this exact format: [MM:SS] ${params.options.identifySpeakers ? 'Speaker 1: ' : ''}Spoken text here`,
      `Place [MM:SS] timestamps relative to the start of this clip (starting near [00:00]) ${intervalHint}.`,
      'If there is only silence or non-speech music in this segment, return an empty string.',
    ].join('\n');

    let rawText = '';
    try {
      const verbatimRes = await betaAi.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: {
          parts: [audioPart, { text: transcribePrompt }],
        },
      });
      rawText = (verbatimRes.text ?? '').trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|NOT_FOUND|not supported|429|RESOURCE_EXHAUSTED|Quota|503|UNAVAILABLE/i.test(msg)) {
        transcribeCooldownUntil = Date.now() + 65 * 1000;
        return await transcribeChunkFastLines({
          audioPart,
          offsetSec: params.offsetSec,
          chunkDurationSec: params.chunkDurationSec,
          chunkIndex: params.chunkIndex,
          totalChunks: params.totalChunks,
          options: params.options,
        });
      }
      throw err;
    }

    if (!rawText) return [];

    const parsedDirect = parseTimestampedLines(
      rawText,
      params.offsetSec,
      params.chunkDurationSec,
      params.options.identifySpeakers,
    );
    if (parsedDirect.length >= 1) {
      return await enforceScriptPurity(
        enforceSegmentGranularity(parsedDirect, params.offsetSec, params.chunkDurationSec),
        params.options,
      );
    }

    return await enforceScriptPurity(
      enforceSegmentGranularity(
        splitPlainTextIntoSegments(rawText, params.offsetSec, params.chunkDurationSec),
        params.offsetSec,
        params.chunkDurationSec,
      ),
      params.options,
    );
  } finally {
    if (uploadedFileName) {
      ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
}

export async function transcribeYouTubeWindow(params: {
  youtubeUrl: string;
  startSec: number;
  endSec: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  const ai = getGeminiClient();
  const duration = Math.max(10, params.endSec - params.startSec);

  const prompt = [
    `Transcribe ALL spoken dialogue in this video strictly between ${formatTimecode(params.startSec)} and ${formatTimecode(params.endSec)} completely and verbatim.`,
    'Do not summarize, paraphrase, or skip any spoken sentence.',
    buildLanguageDirective(params.options),
    `Format EVERY line strictly as: [MM:SS] ${params.options.identifySpeakers ? 'Speaker 1: ' : ''}Spoken sentence here`,
    `Use [MM:SS] timestamps relative to the start of this clip (from [00:00] up to [${formatTimecode(duration)}]), or absolute video [MM:SS] / [HH:MM:SS].`,
    'If there is no speech in this time window, reply strictly with NO_SPEECH.',
  ].join('\n');

  const response = await generateFast(ai, {
    contents: {
      parts: [
        {
          fileData: {
            fileUri: params.youtubeUrl,
            mimeType: 'video/*',
          },
          videoMetadata: {
            startOffset: `${params.startSec}s`,
            endOffset: `${params.endSec}s`,
            fps: 0.5,
          },
        },
        { text: prompt },
      ],
    },
  });

  const rawText = (response.text ?? '').trim();
  if (!rawText || rawText === 'NO_SPEECH') {
    return [];
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const lineRegex = /^\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?\s*(?:-\s*)?(?:([A-Za-z][A-Za-z0-9 ._-]{0,30}):\s+)?(.+)$/;
  const rawParsed: Array<{ rawSec: number; speaker?: string; text: string }> = [];

  for (const line of lines) {
    const m = line.match(lineRegex);
    if (m) {
      let rawSec = parseTimestampToSeconds(m[1]);
      const parts = m[1].split(':').map((p) => Number.parseInt(p, 10));
      if (parts.length === 3 && parts[2] === 0 && rawSec > params.endSec) {
        const asMinSec = parts[0] * 60 + parts[1];
        if (asMinSec <= params.endSec) {
          rawSec = asMinSec;
        }
      }
      const speaker = params.options.identifySpeakers ? sanitizeSpeakerLabel(m[2]) : undefined;
      const text = m[3].trim();
      if (text && text !== 'NO_SPEECH') {
        rawParsed.push({ rawSec, speaker, text });
      }
    }
  }

  if (rawParsed.length === 0) {
    return splitPlainTextIntoSegments(rawText, params.startSec, duration);
  }

  const minRaw = Math.min(...rawParsed.map((r) => r.rawSec));
  const maxRaw = Math.max(...rawParsed.map((r) => r.rawSec));
  const looksAbsolute = params.startSec >= 60 && minRaw >= params.startSec - 15 && maxRaw <= params.endSec + 15;

  const segments: TranscriptSegment[] = rawParsed.map((item, idx) => {
    const absStart = looksAbsolute ? item.rawSec : params.startSec + item.rawSec;
    const clampedStart = Math.max(params.startSec, Math.min(params.endSec, Math.round(absStart)));
    return {
      id: `yt_${params.startSec}_${idx}`,
      startSec: clampedStart,
      endSec: clampedStart + 5,
      speaker: item.speaker,
      text: item.text,
    };
  });

  for (let i = 0; i < segments.length; i++) {
    if (i < segments.length - 1) {
      segments[i].endSec = Math.max(segments[i].startSec + 1, segments[i + 1].startSec);
    } else {
      segments[i].endSec = Math.max(segments[i].startSec + 2, Math.min(params.endSec, segments[i].startSec + 6));
    }
  }

  return await enforceScriptPurity(
    enforceSegmentGranularity(segments, params.startSec, duration),
    params.options,
  );
}

export async function polishCaptionSegments(
  segments: TranscriptSegment[],
  options: TranscriptionOptions,
  jsonGen: JsonGenerator = geminiJsonGenerator,
): Promise<TranscriptSegment[]> {
  if (segments.length === 0) return [];
  const batchSize = 80;
  const result: TranscriptSegment[] = [];

  for (let i = 0; i < segments.length; i += batchSize) {
    const slice = segments.slice(i, i + batchSize);
    const inputPayload = slice.map((s) => ({
      id: s.id,
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
    }));

    try {
      const polished = (await jsonGen(
        [
          'Clean up punctuation, capitalization, and broken subtitle line splits for these transcript segments while preserving exact timestamps and every spoken word.',
          buildLanguageDirective(options),
          JSON.stringify(inputPayload),
        ].join('\n\n'),
        {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              startSec: { type: Type.NUMBER },
              endSec: { type: Type.NUMBER },
              speaker: { type: Type.STRING },
              text: { type: Type.STRING },
            },
            required: ['id', 'startSec', 'text'],
          },
        },
      )) as TranscriptSegment[];
      if (Array.isArray(polished) && polished.length > 0) {
        result.push(
          ...polished.map((p, idx) => ({
            id: p.id || slice[idx]?.id || `cap_${i + idx}`,
            startSec: Math.round(p.startSec ?? slice[idx]?.startSec ?? 0),
            endSec: Math.round(p.endSec ?? slice[idx]?.endSec ?? (p.startSec || 0) + 4),
            speaker: options.identifySpeakers ? sanitizeSpeakerLabel(p.speaker) : undefined,
            text: (p.text || slice[idx]?.text || '').trim(),
          })),
        );
        continue;
      }
    } catch {
      // Fallback to unpolished slice
    }

    result.push(...slice);
  }

  return await enforceScriptPurity(result, options);
}

export async function analyzeFullTranscript(
  segments: TranscriptSegment[],
  title: string,
  requestedLanguage?: string,
  jsonGen: JsonGenerator = geminiJsonGenerator,
): Promise<TranscriptionAnalysis> {
  if (segments.length === 0) {
    return {
      summary: 'No spoken content was detected in this media.',
      keyPoints: [],
      actionItems: [],
      chapters: [],
    };
  }

  const fullLines = segments.map(
    (s) => `[${formatTimecode(s.startSec)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text}`,
  );

  const joined = fullLines.join('\n');
  let condensedNotes = joined;
  const extractedChapters: ChapterItem[] = [];

  if (joined.length > 26000) {
    const blocks: string[] = [];
    let current = '';
    for (const line of fullLines) {
      if (current.length + line.length + 1 > 18000 && current) {
        blocks.push(current);
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) blocks.push(current);

    // Process map blocks gently in batches of 2 so RPM limits remain calm on multi-hour transcripts
    for (let i = 0; i < blocks.length; i += 2) {
      const batch = blocks.slice(i, i + 2);
      const results = await Promise.all(
        batch.map((block) =>
          jsonGen(
            [
              `Extract major chapters (with exact startSec in seconds) and key takeaways from this portion of "${title}".`,
              block,
            ].join('\n\n'),
            {
              type: Type.OBJECT,
              properties: {
                sectionSummary: { type: Type.STRING },
                chapters: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      startSec: { type: Type.NUMBER },
                      summary: { type: Type.STRING },
                    },
                    required: ['title', 'startSec', 'summary'],
                  },
                },
              },
              required: ['sectionSummary', 'chapters'],
            },
          ),
        ),
      );
      const blockSummaries: string[] = [];
      for (const partRes of results) {
        const parsedPart = partRes as {
          sectionSummary?: string;
          chapters?: ChapterItem[];
        };
        if (parsedPart.sectionSummary) blockSummaries.push(parsedPart.sectionSummary);
        if (Array.isArray(parsedPart.chapters)) extractedChapters.push(...parsedPart.chapters);
      }
      if (blockSummaries.length > 0) {
        condensedNotes =
          i === 0 ? blockSummaries.join('\n\n') : `${condensedNotes}\n\n${blockSummaries.join('\n\n')}`;
      }
    }
  }

  const langHintNote =
    requestedLanguage && requestedLanguage !== 'auto'
      ? `Note: The transcript language mode is "${requestedLanguage}". Report "detectedLanguage" accurately (e.g., "Urdu", "Urdu + English", "Roman Urdu", etc.—do NOT mark an Urdu transcript as "English").`
      : 'Detect the primary spoken language(s) accurately (e.g., "Urdu", "Urdu + English", "English").';

  const finalParsed = (await jsonGen(
    [
      `Create a concise executive summary, 4-8 key points, any concrete action items, detected language, and ${extractedChapters.length > 0 ? 'refine/confirm' : 'generate'} timestamped chapters for "${title}".`,
      langHintNote,
      condensedNotes,
    ].join('\n\n'),
    {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        detectedLanguage: { type: Type.STRING },
        keyPoints: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        actionItems: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        chapters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              startSec: { type: Type.NUMBER },
              summary: { type: Type.STRING },
            },
            required: ['title', 'startSec', 'summary'],
          },
        },
      },
      required: ['summary', 'keyPoints', 'actionItems', 'chapters'],
    },
  )) as Partial<TranscriptionAnalysis>;
  const chapters =
    extractedChapters.length > 0
      ? extractedChapters
      : Array.isArray(finalParsed.chapters)
        ? finalParsed.chapters
        : [];

  return {
    summary: finalParsed.summary || 'Summary unavailable.',
    detectedLanguage: finalParsed.detectedLanguage,
    keyPoints: Array.isArray(finalParsed.keyPoints) ? finalParsed.keyPoints : [],
    actionItems: Array.isArray(finalParsed.actionItems) ? finalParsed.actionItems : [],
    chapters: chapters.sort((a, b) => a.startSec - b.startSec),
  };
}

/**
 * Converts an entire completed transcript between Pure Urdu, Roman Urdu, Urdu+English,
 * or full English while preserving exact timestamps and speakers.
 */
export async function transformTranscriptScript(
  segments: TranscriptSegment[],
  targetMode: ScriptTargetMode,
  jsonGen: JsonGenerator = geminiJsonGenerator,
): Promise<TranscriptSegment[]> {
  if (segments.length === 0) return [];

  const batchSize = 35;
  const batches: TranscriptSegment[][] = [];
  for (let i = 0; i < segments.length; i += batchSize) {
    batches.push(segments.slice(i, i + batchSize));
  }

  const results: TranscriptSegment[][] = new Array(batches.length);
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= batches.length) break;
      results[idx] = await rewriteSegmentsBatch(batches[idx], targetMode, jsonGen);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, batches.length) }, () => worker()),
  );

  return results.flat();
}

/**
 * Generates ready-to-publish study notes, blog articles, YouTube chapters/description,
 * or social threads from any transcript.
 */
export async function repurposeTranscript(params: {
  segments: TranscriptSegment[];
  title: string;
  format: RepurposeFormat;
  outputLanguage?: 'match' | 'urdu' | 'english' | 'roman-urdu';
  textGen?: TextGenerator;
}): Promise<{ format: RepurposeFormat; content: string }> {
  if (params.segments.length === 0) {
    return { format: params.format, content: 'Transcript is empty.' };
  }

  const transcriptLines = params.segments
    .map((s) => `[${formatTimecode(s.startSec)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text}`)
    .join('\n')
    .slice(0, 65000);

  const langHint =
    params.outputLanguage === 'urdu'
      ? 'Write the ENTIRE generated output strictly in clear Urdu script (اردو).'
      : params.outputLanguage === 'roman-urdu'
        ? 'Write the ENTIRE generated output in clean Roman Urdu.'
        : params.outputLanguage === 'english'
          ? 'Write the ENTIRE generated output in clear, crisp English.'
          : 'Match the primary language of the transcript naturally.';

  const formatPrompts: Record<RepurposeFormat, string> = {
    'study-notes':
      'Create comprehensive, well-structured Study & Lecture Notes with: Core Thesis, Structured Topic Headings with bullet takeaways, Key Definitions/Quotes with [MM:SS] references, and 5 Self-Check Review Questions with concise answers.',
    'blog-article':
      'Transform this transcript into a polished, publication-ready Article / Newsletter Post with a compelling headline, engaging introduction, structured H2 sections, key pull-quotes, and an actionable conclusion.',
    'youtube-pack':
      'Generate a complete YouTube Publishing Pack: 3 high-CTR Video Title ideas, a 2-paragraph SEO Description, complete Copy-Paste Chapter Timestamps (starting with 00:00), and 12 relevant comma-separated tags.',
    'social-thread':
      'Create a punchy 6-to-8 post Social Media Thread (numbered 1/N .. N/N) summarizing the strongest insights cleanly plus a crisp 45-second Short/Reel spoken hook script.',
  };

  const prompt = [
    `Media Title: "${params.title}"`,
    formatPrompts[params.format],
    langHint,
    'Format cleanly in readable plain text / Markdown headings without filler meta-commentary.',
    '--- TRANSCRIPT ---',
    transcriptLines,
  ].join('\n\n');

  const text = params.textGen
    ? await params.textGen(prompt)
    : (await generateFast(getGeminiClient(), { contents: prompt })).text ?? '';

  return {
    format: params.format,
    content: text.trim() || 'Could not generate content from this transcript.',
  };
}

/**
 * Analyzes a timestamped video/audio transcript to find the strongest self-contained
 * highlight clips (hooks, insights, stories, takeaways), aligns clip boundaries to
 * natural spoken sentences, and builds synced 0-based subtitle cues for each clip.
 */
const HOOK_WORDS =
  /\b(how|why|what|secret|best|worst|mistake|free|never|always|stop|truth|amazing|powerful|important|easy|fast|new|first|last|guaranteed|proven|ultimate|shocking|surprising|incredible)\b|کیوں|کیسے|راز|بہترین|غلطی|مفت|کبھی|سچ|اہم|آسان/gi;

/** Local 0-100 hook score for one transcript line — no AI call needed. */
export function scoreSegmentText(text: string): number {
  const t = (text || '').trim();
  if (!t) return 0;
  const words = t.split(/\s+/).length;
  let score = 45;
  if (/\?/.test(t)) score += 14; // question = hook
  if (/!/.test(t)) score += 6;
  if (/\d+/.test(t)) score += 8; // numbers / stats
  const hookHits = (t.match(HOOK_WORDS) || []).length;
  score += Math.min(16, hookHits * 6);
  if (words >= 8 && words <= 38) score += 8; // ideal self-contained length
  else if (words < 4) score -= 18; // filler fragment
  else if (words > 60) score -= 8;
  if (/^(um|uh|so|well|like|you know|haan|toh|acha|bas)\b/i.test(t)) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Local sliding-window fallback: picks the highest-scoring non-overlapping
 * windows straight from the transcript, no AI call. Used when Gemini returns
 * nothing, or to top up when it returns fewer clips than requested.
 */
export function pickBestWindowsLocally(
  segments: TranscriptSegment[],
  totalDur: number,
  count: number,
  minClipSec: number,
  maxClipSec: number,
  exclude: Array<{ startSec: number; endSec: number }> = [],
): Array<{ startSec: number; endSec: number; score: number }> {
  const sorted = [...segments]
    .filter((s) => s.text && s.text.trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);
  if (sorted.length === 0 || totalDur < minClipSec) return [];
  const targetLen = Math.min(maxClipSec, Math.max(minClipSec, Math.round((minClipSec + maxClipSec) / 2)));
  const step = 5;
  const candidates: Array<{ startSec: number; endSec: number; score: number }> = [];
  for (let start = 0; start + minClipSec <= totalDur; start += step) {
    const end = Math.min(totalDur, start + targetLen);
    const inside = sorted.filter((s) => s.endSec > start && s.startSec < end);
    if (inside.length < 3) continue;
    const avg = inside.reduce((acc, s) => acc + scoreSegmentText(s.text), 0) / inside.length;
    // Prefer windows that start on a strong hook line
    const startBonus = inside.length > 0 ? scoreSegmentText(inside[0].text) * 0.25 : 0;
    candidates.push({ startSec: start, endSec: end, score: Math.round(avg * 0.75 + startBonus) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: Array<{ startSec: number; endSec: number; score: number }> = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    const overlaps = [...picked, ...exclude].some((p) => {
      const overlap = Math.max(0, Math.min(p.endSec, c.endSec) - Math.max(p.startSec, c.startSec));
      return overlap / Math.min(p.endSec - p.startSec, c.endSec - c.startSec) > 0.3;
    });
    if (!overlaps) picked.push(c);
  }
  return picked.sort((a, b) => a.startSec - b.startSec);
}

export async function findBestVideoClips(params: {
  segments: TranscriptSegment[];
  title: string;
  totalDurationSec: number;
  maxClips?: number;
  minClipSec?: number;
  maxClipSec?: number;
  maxWordsPerCue?: number;
  language?: string;
  /** Injected clip-pick fetcher (Groq). Defaults to Gemini. */
  pickFetcher?: ClipPickFetcher;
}): Promise<AutoClipCandidate[]> {
  const sorted = [...params.segments]
    .filter((s) => s.text && s.text.trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec);

  if (sorted.length === 0) {
    throw new Error('No spoken dialogue was detected in this media to create clips from.');
  }

  const totalDur = Math.max(
    params.totalDurationSec || 0,
    sorted[sorted.length - 1]?.endSec || 0,
    10,
  );
  const maxClips = Math.max(1, Math.min(8, Math.round(params.maxClips || 5)));
  const minClipSec = Math.max(12, Math.min(60, Math.round(params.minClipSec || 22)));
  const maxClipSec = Math.max(minClipSec + 8, Math.min(120, Math.round(params.maxClipSec || 65)));
  const maxWordsPerCue = Math.max(3, Math.min(16, Math.round(params.maxWordsPerCue || 7)));

  const buildClipFromWindow = (
    idx: number,
    rawStart: number,
    rawEnd: number,
    meta: { title: string; hookSummary: string; reason: string; category: string },
  ): AutoClipCandidate | null => {
    let startSec = Math.max(0, Math.min(totalDur - 5, rawStart));
    let endSec = Math.max(startSec + 6, Math.min(totalDur, rawEnd));

    // Snap boundaries cleanly to natural segment edges if close (never cut mid-sentence)
    const touching = sorted.filter((s) => s.endSec > startSec + 0.3 && s.startSec < endSec - 0.3);
    if (touching.length > 0) {
      const first = touching[0];
      const last = touching[touching.length - 1];
      if (first.startSec < startSec && startSec - first.startSec <= 6) {
        startSec = Math.max(0, first.startSec);
      }
      if (last.endSec > endSec && last.endSec - endSec <= 6) {
        endSec = Math.min(totalDur, last.endSec);
      }
    }

    const durationSec = Number(Math.max(4, endSec - startSec).toFixed(2));
    const clipSegments: TranscriptSegment[] = sorted
      .filter((s) => s.endSec > startSec + 0.15 && s.startSec < endSec - 0.15)
      .map((s, segPos) => {
        const relStart = Math.max(0, Number((s.startSec - startSec).toFixed(2)));
        const relEnd = Math.min(durationSec, Math.max(relStart + 0.6, Number((s.endSec - startSec).toFixed(2))));
        return {
          ...s,
          id: `clip${idx}_s${segPos}`,
          startSec: relStart,
          endSec: relEnd,
        };
      });

    if (clipSegments.length === 0) return null;

    const cues = splitSegmentsIntoSubtitleCues(clipSegments, maxWordsPerCue);
    if (cues.length === 0) return null;

    // Local hook score for this window (opening line counts double — hooks win clips)
    const clipScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          clipSegments.reduce((acc, s, i) => acc + scoreSegmentText(s.text) * (i === 0 ? 2 : 1), 0) /
            Math.max(1, clipSegments.length + 1),
        ),
      ),
    );

    return {
      id: `clip_${idx + 1}_${Math.round(startSec)}`,
      title: meta.title.trim().slice(0, 80) || `Highlight Clip ${idx + 1}`,
      hookSummary: meta.hookSummary.trim().slice(0, 140) || clipSegments[0].text.slice(0, 100),
      reason: meta.reason.trim().slice(0, 220) || 'Strong self-contained segment with clear delivery.',
      category: meta.category.trim().slice(0, 36) || 'Highlight',
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      durationSec,
      score: clipScore,
      cues,
    };
  };

  // If the entire video already fits cleanly inside one short clip window
  if (totalDur <= maxClipSec + 6) {
    const single = buildClipFromWindow(0, 0, totalDur, {
      title: params.title.replace(/\.[^.]+$/, '').slice(0, 64) || 'Full Highlight Clip',
      hookSummary: sorted[0]?.text.slice(0, 110) || 'Complete video highlight with synced captions.',
      reason: 'Entire short video framed and captioned cleanly as one complete shareable clip.',
      category: 'Full Clip',
    });
    return single ? [single] : [];
  }

  // Condense ultra-long transcripts by HOOK SCORE, not blind sampling:
  // keep the strongest lines (+1 neighbour each side for context) so the best
  // moments are never dropped by an every-Nth-line cut.
  const formattedLines = sorted.map(
    (s) =>
      `[${s.startSec.toFixed(1)}s -> ${s.endSec.toFixed(1)}s]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text.trim()}`,
  );
  let transcriptForPrompt = formattedLines.join('\n');
  if (transcriptForPrompt.length > 56000) {
    const scored = sorted.map((s, i) => ({ i, score: scoreSegmentText(s.text) }));
    scored.sort((a, b) => b.score - a.score);
    const keep = new Set<number>();
    for (const item of scored) {
      if (keep.size >= 420) break;
      keep.add(item.i);
      if (item.i > 0) keep.add(item.i - 1);
      if (item.i < sorted.length - 1) keep.add(item.i + 1);
    }
    transcriptForPrompt = formattedLines.filter((_, i) => keep.has(i)).join('\n');
  }

  const langNote =
    params.language && params.language !== 'auto'
      ? `Write clip titles, hookSummary, and reason primarily matching the video language/script (${params.language}) or crisp English editorial labels if mixed.`
      : 'Write crisp, engaging clip titles and hook summaries matching the main language of the spoken content (keep Urdu in Urdu script if Urdu, Roman Urdu if Roman Urdu, English if English).';

  const promptText = [
    `You are a senior short-form video editor and content strategist.`,
    `Media Title: "${params.title}" (Total Duration: ${Math.round(totalDur)} seconds).`,
    `Analyze the timestamped transcript below and select up to ${maxClips} of the BEST, non-overlapping highlight clips that work standalone as Reels, Shorts, TikToks, or social takeaways.`,
    `STRICT RULES:`,
    `1. Each clip MUST be between ${minClipSec} and ${maxClipSec} seconds long (endSec - startSec).`,
    `2. Pick moments with a strong opening hook, surprising insight, clear story, punchy advice, or memorable explanation — NEVER cut off mid-sentence at the start or end.`,
    `3. Use exact numeric seconds (startSec and endSec) grounded strictly in the [Xs -> Ys] timestamps provided below (0 <= startSec < endSec <= ${totalDur.toFixed(1)}).`,
    `4. Do NOT overlap clips heavily; spread picks across the strongest parts of the video.`,
    `5. ${langNote}`,
    `--- TIMESTAMPED TRANSCRIPT ---`,
    transcriptForPrompt,
  ].join('\n\n');

  let parsedClips: ClipPick[] = [];

  if (params.pickFetcher) {
    try {
      parsedClips = await params.pickFetcher(promptText);
    } catch {
      parsedClips = [];
    }
  } else {
    const res = await generateFast(getGeminiClient(), {
      contents: promptText,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            clips: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  hookSummary: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  category: { type: Type.STRING },
                  startSec: { type: Type.NUMBER },
                  endSec: { type: Type.NUMBER },
                },
                required: ['title', 'hookSummary', 'reason', 'category', 'startSec', 'endSec'],
              },
            },
          },
          required: ['clips'],
        },
      },
    });

    try {
      const raw = JSON.parse((res.text ?? '{}').trim()) as { clips?: ClipPick[] };
      if (Array.isArray(raw.clips)) {
        parsedClips = raw.clips;
      }
    } catch {
      parsedClips = [];
    }
  }

  const accepted: AutoClipCandidate[] = [];
  for (const item of parsedClips) {
    if (!Number.isFinite(item.startSec) || !Number.isFinite(item.endSec)) continue;
    let s = Math.max(0, item.startSec);
    let e = Math.min(totalDur, item.endSec);
    if (e - s < 10) {
      e = Math.min(totalDur, s + minClipSec);
    }
    if (e - s > maxClipSec + 10) {
      e = s + maxClipSec;
    }

    const overlapsExisting = accepted.some((prev) => {
      const overlap = Math.max(0, Math.min(prev.endSec, e) - Math.max(prev.startSec, s));
      const minLen = Math.min(prev.endSec - prev.startSec, e - s) || 1;
      return overlap / minLen > 0.45;
    });
    if (overlapsExisting) continue;

    const built = buildClipFromWindow(accepted.length, s, e, {
      title: item.title || `Clip ${accepted.length + 1}`,
      hookSummary: item.hookSummary || '',
      reason: item.reason || '',
      category: item.category || 'Highlight',
    });
    if (built) {
      accepted.push(built);
    }
    if (accepted.length >= maxClips) break;
  }

  // Fallback / top-up with local hook scoring (no extra AI call): if Gemini
  // returned nothing, or fewer clips than requested, fill the rest with the
  // highest-scoring non-overlapping windows from the transcript itself.
  if (accepted.length < maxClips) {
    const needed = maxClips - accepted.length;
    const localWindows = pickBestWindowsLocally(
      sorted,
      totalDur,
      needed,
      minClipSec,
      maxClipSec,
      accepted.map((c) => ({ startSec: c.startSec, endSec: c.endSec })),
    );
    for (const w of localWindows) {
      const fallbackClip = buildClipFromWindow(accepted.length, w.startSec, w.endSec, {
        title: `Highlight Part ${accepted.length + 1}`,
        hookSummary: 'Highest-scoring spoken moment from the timeline.',
        reason:
          accepted.length === 0
            ? 'AI clip pick was empty, so the strongest local highlight window was used.'
            : 'Top-up highlight picked by local hook scoring.',
        category: 'Highlight',
      });
      if (fallbackClip) accepted.push(fallbackClip);
      if (accepted.length >= maxClips) break;
    }
  }

  return accepted.sort((a, b) => a.startSec - b.startSec);
}

