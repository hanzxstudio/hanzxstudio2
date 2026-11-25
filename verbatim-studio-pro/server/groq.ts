/**
 * Groq FREE provider for Verbatim Studio.
 *
 * Why this exists: Google restricted the Gemini free tier on many accounts /
 * projects ("The Gemini API free tier is not available for this project", HTTP
 * 403), so transcription and clip-finding need a no-card free alternative.
 *
 * Groq free tier (no credit card):
 *  - Whisper large-v3-turbo transcription, ~8 hours of audio/day free
 *    (28,800 audio-sec/day, 20 req/min, 25 MB max file per request).
 *  - Llama chat models for clip picks, summaries, chapters and caption polish.
 *
 * Key: GROQ_API_KEY in .env.local (starts with gsk_). Get one free at
 * https://console.groq.com -> API Keys -> Create API Key.
 * The server uses Groq automatically when GROQ_API_KEY is set, unless
 * TRANSCRIPTION_PROVIDER=gemini is set explicitly.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TranscriptSegment, TranscriptionOptions } from '../src/types/transcription.ts';
import type { ClipPick } from './gemini.ts';
import {
  SCRIPT_MODE_PROMPTS,
  resolveScriptMode,
  segmentNeedsScriptFix,
  type ScriptTargetMode,
} from './gemini.ts';

const execFileAsync = promisify(execFile);

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
const WHISPER_MODEL = 'whisper-large-v3-turbo';
// Chat models verified live against this account on 2026-11-17 via
// GET /openai/v1/models. Groq removed the Llama 3.x chat models, so the
// old llama-3.3-70b-versatile / llama-3.1-8b-instant names now 404.
// gpt-oss-120b is the strongest; 20b is the fast fallback; qwen is third.
const CHAT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'] as const;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq free-tier per-file limit

export function isGroqConfigured(): boolean {
  const key = (process.env.GROQ_API_KEY || '').trim();
  return key.length >= 20 && key.startsWith('gsk_');
}

function readGroqApiKey(): string {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key || !key.startsWith('gsk_')) {
    throw new Error(
      'Groq: GROQ_API_KEY is not configured. Get a free key at console.groq.com -> API Keys, then paste it in the app (Auto Clips > Groq Key) or into .env.local.',
    );
  }
  return key;
}

export function formatGroqError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|invalid_api_key|Incorrect API key/i.test(msg)) {
    return 'Groq: API key is invalid. Check GROQ_API_KEY — free keys start with gsk_ (console.groq.com -> API Keys).';
  }
  if (/429|rate_limit_exceeded|Rate limit/i.test(msg)) {
    return 'Groq: free-tier rate limit reached (20 requests/min). Wait 30–60 seconds and try again — long videos retry chunk by chunk.';
  }
  if (/413|too large|file.*25 ?MB/i.test(msg)) {
    return 'Groq: audio file is larger than the 25 MB free-tier limit. The tool chunks audio automatically — try a shorter file or split it first.';
  }
  if (/model.*not found|model_not_found|404/i.test(msg)) {
    return 'Groq: the requested model is not available on this account right now. Try again in a few minutes.';
  }
  return /^Groq[: ]/.test(msg) ? msg : `Groq: ${msg}`;
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

interface GroqChatOptions {
  jsonMode?: boolean;
}

async function groqChat(
  prompt: string,
  options: GroqChatOptions = {},
): Promise<string> {
  const apiKey = readGroqApiKey();
  let lastErr: unknown = null;

  for (const model of CHAT_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model,
          messages: [
            {
              role: 'system',
              content: options.jsonMode
                ? 'You are a precise JSON API. Return ONLY valid JSON, no markdown fences, no commentary.'
                : 'You are a careful, precise assistant. Follow the instructions exactly.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
        };
        if (options.jsonMode) {
          body.response_format = { type: 'json_object' };
        }

        const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Groq chat failed (${res.status}): ${text.slice(0, 300)}`);
          if ((res.status === 400 || res.status === 404) && /model/i.test(text)) {
            throw Object.assign(err, { code: 'MODEL_NOT_FOUND' });
          }
          throw err;
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) throw new Error('Groq: empty reply from chat model.');
        return content;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isModelErr =
          (err as { code?: string }).code === 'MODEL_NOT_FOUND' || /model.*not found/i.test(msg);
        if (isModelErr) break; // try next model
        const isRateLimit = /429|rate_limit/i.test(msg);
        if (isRateLimit && attempt === 1) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Groq: chat request failed.');
}

/** JSON-mode chat: returns parsed JSON matching the given Gemini-style schema. */
export async function groqJson(
  prompt: string,
  responseSchema: Record<string, unknown>,
): Promise<unknown> {
  const withSchema = `${prompt}\n\nReturn ONLY valid JSON matching this JSON Schema:\n${JSON.stringify(responseSchema)}`;
  const raw = await groqChat(withSchema, { jsonMode: true });
  try {
    return JSON.parse(stripJsonFences(raw));
  } catch {
    throw new Error('Groq: could not parse JSON reply from chat model.');
  }
}

export async function groqText(prompt: string): Promise<string> {
  return groqChat(prompt);
}

/** Clip-pick fetcher with the same contract as Gemini's, for findBestVideoClips. */
export async function fetchClipPicksGroq(prompt: string): Promise<ClipPick[]> {
  const schema = {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            hookSummary: { type: 'string' },
            reason: { type: 'string' },
            category: { type: 'string' },
            startSec: { type: 'number' },
            endSec: { type: 'number' },
          },
          required: ['title', 'hookSummary', 'reason', 'category', 'startSec', 'endSec'],
        },
      },
    },
    required: ['clips'],
  };
  try {
    const parsed = (await groqJson(prompt, schema)) as { clips?: ClipPick[] };
    return Array.isArray(parsed.clips) ? parsed.clips : [];
  } catch {
    return [];
  }
}

function groqLanguageFor(options: TranscriptionOptions): string | undefined {
  const lang = (options.language || 'auto').toLowerCase();
  if (lang === 'auto') return undefined;
  if (lang.includes('arabic')) return 'ar';
  if (lang.includes('hindi')) return 'hi';
  if (lang.includes('english') && !lang.includes('urdu')) return 'en';
  if (lang.includes('urdu')) return 'ur';
  return undefined;
}

const GROQ_AUDIO_EXTS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.mpeg', '.mpga', '.ogg', '.flac']);

async function ensureGroqCompatibleAudio(
  filePath: string,
  workDir: string,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fsp.stat(filePath);
  if (GROQ_AUDIO_EXTS.has(ext) && stat.size <= MAX_AUDIO_BYTES) {
    return { filePath, cleanup: async () => {} };
  }
  // Re-encode to a small 16kHz mono MP3 (same recipe as the chunker) so the
  // 25 MB free-tier limit is never hit, even for lossless/video sources.
  await fsp.mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, `groq_${Date.now()}.mp3`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-threads',
    '0',
    '-i',
    filePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '32k',
    outPath,
  ]);
  return {
    filePath: outPath,
    cleanup: async () => {
      await fsp.rm(outPath, { force: true }).catch(() => {});
    },
  };
}

interface GroqVerboseSegment {
  start?: number;
  end?: number;
  text?: string;
  no_speech_prob?: number;
}

/**
 * Transcribes one audio chunk with Groq Whisper (verbose_json gives real
 * word/segment timestamps — no LLM timestamp guessing like Gemini).
 */
export async function transcribeAudioChunkGroq(params: {
  filePath: string;
  mimeType: string;
  offsetSec: number;
  chunkDurationSec: number;
  chunkIndex: number;
  totalChunks: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  const apiKey = readGroqApiKey();
  const workDir = path.join(os.tmpdir(), 'verbatim-studio', 'groq-tmp');
  const { filePath, cleanup } = await ensureGroqCompatibleAudio(params.filePath, workDir);

  try {
    const bytes = await fsp.readFile(filePath);
    const lang = groqLanguageFor(params.options);

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Rebuild the form per attempt — fetch consumes the body stream.
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: params.mimeType || 'audio/mp3' }), path.basename(filePath));
        form.append('model', WHISPER_MODEL);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        if (lang) form.append('language', lang);

        const res = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Groq transcription failed (${res.status}): ${text.slice(0, 300)}`);
        }
        const data = (await res.json()) as {
          text?: string;
          segments?: GroqVerboseSegment[];
        };

        const rawSegments = Array.isArray(data.segments) ? data.segments : [];
        const segments: TranscriptSegment[] = rawSegments
          .filter((s) => (s.text || '').trim().length > 0)
          .filter((s) => (s.no_speech_prob ?? 0) <= 0.6)
          .map((s, idx) => {
            const startSec = Math.round((params.offsetSec + (s.start ?? 0)) * 100) / 100;
            const endSec = Math.max(
              startSec + 0.5,
              Math.round((params.offsetSec + (s.end ?? (s.start ?? 0) + 2)) * 100) / 100,
            );
            return {
              id: `seg_${params.offsetSec}_${idx}`,
              startSec,
              endSec,
              text: (s.text || '').trim(),
            };
          });

        segments.sort((a, b) => a.startSec - b.startSec);
        for (let i = 0; i < segments.length; i++) {
          if (i < segments.length - 1) {
            segments[i].endSec = Math.max(segments[i].startSec + 0.5, segments[i + 1].startSec);
          }
        }

        return await enforceGroqScriptPurity(segments, params.options);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|rate_limit/i.test(msg) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 6000 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Groq: transcription failed.');
  } finally {
    await cleanup();
  }
}

/**
 * Groq Whisper outputs Urdu audio in Urdu script. For Roman Urdu / English
 * modes the text is transliterated/translated with the free chat model.
 * Urdu-script modes need no fix — Whisper already writes Urdu script.
 */
async function enforceGroqScriptPurity(
  segments: TranscriptSegment[],
  options: TranscriptionOptions,
): Promise<TranscriptSegment[]> {
  const mode: ScriptTargetMode | 'auto' = resolveScriptMode(options);
  if ((mode !== 'roman-urdu' && mode !== 'english') || segments.length === 0) {
    return segments;
  }

  const working = [...segments];
  for (let pass = 0; pass < 2; pass++) {
    const offending: number[] = [];
    for (let i = 0; i < working.length; i++) {
      if (segmentNeedsScriptFix(working[i], mode)) offending.push(i);
    }
    if (offending.length === 0) break;

    for (let start = 0; start < offending.length; start += 25) {
      const sliceIdx = offending.slice(start, start + 25);
      const toFix = sliceIdx.map((idx) => working[idx]);
      const payload = toFix.map((s) => ({ id: s.id, text: s.text }));
      try {
        const parsed = (await groqJson(
          [
            SCRIPT_MODE_PROMPTS[mode],
            'Preserve the exact array order and every "id" unchanged. Do not add timestamps inside "text".',
            JSON.stringify(payload),
          ].join('\n\n'),
          {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, text: { type: 'string' } },
              required: ['id', 'text'],
            },
          },
        )) as Array<{ id?: string; text?: string }>;
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        const byId = new Map<string, string>();
        parsed.forEach((item, idx) => {
          const val = typeof item?.text === 'string' ? item.text.trim() : '';
          if (val) byId.set(item.id || toFix[idx]?.id || '', val);
        });
        sliceIdx.forEach((origIdx, k) => {
          const fixed = byId.get(working[origIdx].id) || parsed[k]?.text?.trim();
          if (fixed) working[origIdx] = { ...working[origIdx], text: fixed };
        });
      } catch {
        // Keep original text if transliteration fails
      }
    }
  }
  return working;
}

// ---------------------------------------------------------------------------
// YouTube windows via Groq: yt-dlp downloads just the window's audio, then
// Groq Whisper transcribes it. (Groq has no video-URL input like Gemini.)
// ---------------------------------------------------------------------------

const STUDIO_TMP = path.join(os.tmpdir(), 'verbatim-studio');
const YTDLP_BIN = path.join(STUDIO_TMP, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function resolveYtDlp(): string {
  if (fs.existsSync(YTDLP_BIN)) return YTDLP_BIN;
  return 'yt-dlp';
}

export async function transcribeYouTubeWindowGroq(params: {
  youtubeUrl: string;
  startSec: number;
  endSec: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  const workDir = path.join(os.tmpdir(), 'verbatim-studio', 'groq-yt', `${Date.now()}`);
  await fsp.mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, 'window.mp3');
  const ytDlp = resolveYtDlp();

  try {
    await execFileAsync(
      ytDlp,
      [
        '--no-warnings',
        '--no-playlist',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '2',
        '--download-sections',
        `*${Math.floor(params.startSec)}-${Math.floor(params.endSec)}`,
        '--force-keyframes-at-cuts',
        '-o',
        outPath,
        params.youtubeUrl,
      ],
      { timeout: 240_000, maxBuffer: 1024 * 1024 * 16 },
    );

    if (!fs.existsSync(outPath)) {
      throw new Error(
        'Groq: could not download the YouTube audio for this window. Try uploading the video file instead, or use the YouTube captions fallback.',
      );
    }

    return await transcribeAudioChunkGroq({
      filePath: outPath,
      mimeType: 'audio/mp3',
      offsetSec: params.startSec,
      chunkDurationSec: Math.max(10, params.endSec - params.startSec),
      chunkIndex: 0,
      totalChunks: 1,
      options: params.options,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/yt-dlp|ENOENT|not found/i.test(msg) && !fs.existsSync(outPath)) {
      throw new Error(
        'Groq: yt-dlp is needed to download YouTube audio for Groq transcription. Upload the video file directly instead.',
      );
    }
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
