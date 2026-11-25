/**
 * AI provider routing for Verbatim Studio.
 *
 * Single decision point: Groq (free, no card) is used whenever a Groq key is
 * configured, unless TRANSCRIPTION_PROVIDER=gemini is set explicitly.
 * All call sites (jobs.ts, tools.ts, server.ts) import from this module and
 * never touch gemini.ts / groq.ts directly, so switching providers is one
 * line here instead of a hunt through the codebase.
 */
import type {
  TranscriptionAnalysis,
  TranscriptSegment,
  TranscriptionOptions,
} from '../src/types/transcription.ts';
import type { AutoClipCandidate } from '../src/types/tools.ts';
import type { RepurposeFormat, ScriptTargetMode } from './gemini.ts';

export type { RepurposeFormat } from './gemini.ts';
import * as gemini from './gemini.ts';
import * as groq from './groq.ts';

export type ProviderName = 'groq' | 'gemini';

export function activeProvider(): ProviderName {
  const override = (process.env.TRANSCRIPTION_PROVIDER || '').trim().toLowerCase();
  if (override === 'gemini') return 'gemini';
  if (override === 'groq') return 'groq';
  return groq.isGroqConfigured() ? 'groq' : 'gemini';
}

export function providerStatus(): {
  provider: ProviderName;
  groqConfigured: boolean;
  geminiConfigured: boolean;
} {
  return {
    provider: activeProvider(),
    groqConfigured: groq.isGroqConfigured(),
    geminiConfigured: gemini.hasGeminiApiKey(),
  };
}

export function formatApiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^Groq[: ]/.test(msg)) return groq.formatGroqError(err);
  return gemini.formatApiError(err);
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
  if (activeProvider() === 'groq') return groq.transcribeAudioChunkGroq(params);
  return gemini.transcribeAudioChunk(params);
}

export async function transcribeYouTubeWindow(params: {
  youtubeUrl: string;
  startSec: number;
  endSec: number;
  options: TranscriptionOptions;
}): Promise<TranscriptSegment[]> {
  if (activeProvider() === 'groq') return groq.transcribeYouTubeWindowGroq(params);
  return gemini.transcribeYouTubeWindow(params);
}

export async function polishCaptionSegments(
  segments: TranscriptSegment[],
  options: TranscriptionOptions,
): Promise<TranscriptSegment[]> {
  if (activeProvider() === 'groq') return gemini.polishCaptionSegments(segments, options, groq.groqJson);
  return gemini.polishCaptionSegments(segments, options);
}

export async function analyzeFullTranscript(
  segments: TranscriptSegment[],
  title: string,
  requestedLanguage?: string,
): Promise<TranscriptionAnalysis> {
  if (activeProvider() === 'groq') {
    return gemini.analyzeFullTranscript(segments, title, requestedLanguage, groq.groqJson);
  }
  return gemini.analyzeFullTranscript(segments, title, requestedLanguage);
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
}): Promise<AutoClipCandidate[]> {
  if (activeProvider() === 'groq') {
    return gemini.findBestVideoClips({ ...params, pickFetcher: groq.fetchClipPicksGroq });
  }
  return gemini.findBestVideoClips(params);
}

export async function transformTranscriptScript(
  segments: TranscriptSegment[],
  targetMode: ScriptTargetMode,
): Promise<TranscriptSegment[]> {
  if (activeProvider() === 'groq') {
    return gemini.transformTranscriptScript(segments, targetMode, groq.groqJson);
  }
  return gemini.transformTranscriptScript(segments, targetMode);
}

export async function repurposeTranscript(params: {
  segments: TranscriptSegment[];
  title: string;
  format: RepurposeFormat;
  outputLanguage?: 'match' | 'urdu' | 'english' | 'roman-urdu';
}): Promise<{ format: RepurposeFormat; content: string }> {
  if (activeProvider() === 'groq') {
    return gemini.repurposeTranscript({ ...params, textGen: groq.groqText });
  }
  return gemini.repurposeTranscript(params);
}
