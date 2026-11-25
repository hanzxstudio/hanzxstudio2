import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  SourceKind,
  TranscriptSegment,
  TranscriptionJob,
  TranscriptionOptions,
  YouTubeInfo,
} from '../src/types/transcription.ts';
import {
  analyzeFullTranscript,
  formatApiError,
  polishCaptionSegments,
  transcribeAudioChunk,
  transcribeYouTubeWindow,
} from './ai.ts';
import {
  formatTimecode,
  isAuthOrBillingError,
  isHardDailyQuotaError,
} from './gemini.ts';
import {
  type AudioChunk,
  extractAndChunkAudio,
  extractSingleAudioSlice,
  probeMedia,
  safeRemoveDir,
  streamSegmentAudio,
} from './media.ts';
import { fetchYouTubeCaptions, fetchYouTubeInfo } from './youtube.ts';

interface InternalJobState {
  job: TranscriptionJob;
  cancelled: boolean;
  emitter: EventEmitter;
  sourceFilePath?: string;
  workDir: string;
}

const WORK_ROOT = path.join(os.tmpdir(), 'verbatim-studio');
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RETAINED_FINISHED_JOBS = 40;
const jobs = new Map<string, InternalJobState>();

function isJobFinished(status: TranscriptionJob['status']): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

function cleanupExpiredJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  const finished: Array<[string, InternalJobState]> = [];

  for (const [id, state] of jobs.entries()) {
    if (!isJobFinished(state.job.status)) continue;
    if (state.job.updatedAt < cutoff) {
      jobs.delete(id);
      state.emitter.removeAllListeners();
      void safeRemoveDir(state.workDir);
      if (state.sourceFilePath && state.sourceFilePath.startsWith(WORK_ROOT)) {
        void fs.rm(state.sourceFilePath, { force: true }).catch(() => {});
      }
    } else {
      finished.push([id, state]);
    }
  }

  if (finished.length > MAX_RETAINED_FINISHED_JOBS) {
    finished.sort((a, b) => a[1].job.updatedAt - b[1].job.updatedAt);
    const excess = finished.length - MAX_RETAINED_FINISHED_JOBS;
    for (let i = 0; i < excess; i++) {
      const [id, state] = finished[i];
      jobs.delete(id);
      state.emitter.removeAllListeners();
      void safeRemoveDir(state.workDir);
      if (state.sourceFilePath && state.sourceFilePath.startsWith(WORK_ROOT)) {
        void fs.rm(state.sourceFilePath, { force: true }).catch(() => {});
      }
    }
  }
}

setInterval(() => {
  cleanupExpiredJobs();
}, 15 * 60 * 1000).unref();

export function getJob(jobId: string): TranscriptionJob | undefined {
  return jobs.get(jobId)?.job;
}

export function getJobMediaFile(jobId: string): { filePath: string; mimeType?: string } | undefined {
  const state = jobs.get(jobId);
  if (!state?.sourceFilePath) return undefined;
  return { filePath: state.sourceFilePath, mimeType: state.job.mimeType };
}

export function subscribeToJob(
  jobId: string,
  listener: (job: TranscriptionJob) => void,
): () => void {
  const state = jobs.get(jobId);
  if (!state) return () => {};
  state.emitter.on('update', listener);
  return () => {
    state.emitter.off('update', listener);
  };
}

export function cancelJob(jobId: string): boolean {
  const state = jobs.get(jobId);
  if (!state) return false;
  state.cancelled = true;
  if (state.job.status !== 'completed' && state.job.status !== 'error') {
    updateJob(state, {
      status: 'cancelled',
      stageLabel: 'Transcription cancelled by user.',
    });
  }
  return true;
}

function updateJob(state: InternalJobState, patch: Partial<TranscriptionJob>): void {
  state.job = {
    ...state.job,
    ...patch,
    updatedAt: Date.now(),
  };
  state.emitter.emit('update', state.job);
}

function appendSegments(state: InternalJobState, newSegments: TranscriptSegment[]): void {
  if (newSegments.length === 0) return;
  const merged = [...state.job.segments, ...newSegments].sort((a, b) => a.startSec - b.startSec);
  updateJob(state, { segments: merged });
}

/**
 * Transcribes a single chunk with automatic retry and 50/50 sub-split fallback so a transient
 * failure on one chunk never aborts a multi-hour transcription job.
 */
async function transcribeChunkResilient(params: {
  chunk: AudioChunk;
  totalChunks: number;
  options: TranscriptionOptions;
  workDir: string;
  isCancelled: () => boolean;
}): Promise<TranscriptSegment[]> {
  const { chunk, totalChunks, options, workDir, isCancelled } = params;
  try {
    return await transcribeAudioChunk({
      filePath: chunk.filePath,
      mimeType: chunk.mimeType,
      offsetSec: chunk.offsetSec,
      chunkDurationSec: chunk.durationSec,
      chunkIndex: chunk.index,
      totalChunks,
      options,
    });
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (isCancelled() || isAuthOrBillingError(firstMsg) || isHardDailyQuotaError(firstMsg)) {
      throw firstErr;
    }

    // Brief backoff and retry once (gemini.ts already handles 429 cooldowns & model failover)
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await transcribeAudioChunk({
        filePath: chunk.filePath,
        mimeType: chunk.mimeType,
        offsetSec: chunk.offsetSec,
        chunkDurationSec: chunk.durationSec,
        chunkIndex: chunk.index,
        totalChunks,
        options,
      });
    } catch (secondErr) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      if (isCancelled() || isAuthOrBillingError(secondMsg) || isHardDailyQuotaError(secondMsg)) {
        throw secondErr;
      }
      // Sub-split into 2 half-duration chunks if chunk is >= 80s
      if (chunk.durationSec >= 80) {
        const halfDur = Math.floor(chunk.durationSec / 2);
        const partA = path.join(workDir, `retry_${chunk.index}_a.mp3`);
        const partB = path.join(workDir, `retry_${chunk.index}_b.mp3`);
        const collected: TranscriptSegment[] = [];
        try {
          await extractSingleAudioSlice(chunk.filePath, partA, 0, halfDur);
          const segA = await transcribeAudioChunk({
            filePath: partA,
            mimeType: 'audio/mp3',
            offsetSec: chunk.offsetSec,
            chunkDurationSec: halfDur,
            chunkIndex: chunk.index,
            totalChunks,
            options,
          }).catch(() => [] as TranscriptSegment[]);
          collected.push(...segA);

          const remDur = Math.max(10, chunk.durationSec - halfDur);
          await extractSingleAudioSlice(chunk.filePath, partB, halfDur, remDur);
          const segB = await transcribeAudioChunk({
            filePath: partB,
            mimeType: 'audio/mp3',
            offsetSec: chunk.offsetSec + halfDur,
            chunkDurationSec: remDur,
            chunkIndex: chunk.index,
            totalChunks,
            options,
          }).catch(() => [] as TranscriptSegment[]);
          collected.push(...segB);

          if (collected.length > 0) return collected;
        } finally {
          await fs.rm(partA, { force: true }).catch(() => {});
          await fs.rm(partB, { force: true }).catch(() => {});
        }
      }

      // If entire job is single-chunk, surface error; for multi-hour jobs, leave a gap marker & continue
      if (totalChunks <= 1) {
        throw secondErr;
      }
      return [
        {
          id: `gap_${chunk.index}`,
          startSec: chunk.offsetSec,
          endSec: chunk.offsetSec + chunk.durationSec,
          text: `[Segment ${formatTimecode(chunk.offsetSec)}–${formatTimecode(chunk.offsetSec + chunk.durationSec)} skipped due to audio/API interruption]`,
        },
      ];
    }
  }
}

export async function createFileTranscriptionJob(params: {
  jobId: string;
  title: string;
  sourceKind: SourceKind;
  filePath: string;
  fileSizeBytes: number;
  mimeType: string;
  options: TranscriptionOptions;
}): Promise<TranscriptionJob> {
  cleanupExpiredJobs();
  const workDir = path.join(WORK_ROOT, params.jobId);
  await fs.mkdir(workDir, { recursive: true });

  const initialJob: TranscriptionJob = {
    id: params.jobId,
    title: params.title,
    sourceKind: params.sourceKind,
    status: 'inspecting',
    stageLabel: 'Inspecting media duration and audio stream...',
    progressPercent: 4,
    totalChunks: 0,
    completedChunks: 0,
    durationSeconds: 0,
    fileSizeBytes: params.fileSizeBytes,
    mimeType: params.mimeType,
    mediaUrl: `/api/jobs/${params.jobId}/media`,
    options: params.options,
    segments: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const state: InternalJobState = {
    job: initialJob,
    cancelled: false,
    emitter: new EventEmitter(),
    sourceFilePath: params.filePath,
    workDir,
  };
  jobs.set(params.jobId, state);

  void processLocalMediaJob(state, params.filePath).catch((err) => {
    if (!state.cancelled) {
      updateJob(state, {
        status: 'error',
        error: formatApiError(err),
        stageLabel: 'Transcription failed.',
      });
    }
  });

  return initialJob;
}

async function processLocalMediaJob(state: InternalJobState, inputFilePath: string): Promise<void> {
  const chunksDir = path.join(state.workDir, 'chunks');
  try {
    const probe = await probeMedia(inputFilePath);
    if (!probe.hasAudio) {
      throw new Error('No audio track found in the uploaded file.');
    }

    const totalDurationSec = probe.durationSeconds > 0 ? probe.durationSeconds : 0;
    // Adaptive chunk sizing: 4 min normally, 5 min for 2+ hour videos (keeps 6–10hr jobs snappy)
    const CHUNK_SEC = totalDurationSec > 7200 ? 300 : 240;
    const CONCURRENCY = 3;

    updateJob(state, {
      status: 'extracting',
      durationSeconds: Math.round(totalDurationSec),
      stageLabel:
        totalDurationSec > 600
          ? `Long-form media (${formatTimecode(totalDurationSec)}). Starting single-pass streaming pipeline...`
          : 'Preparing audio track...',
      progressPercent: 10,
    });

    if (totalDurationSec > CHUNK_SEC + 30) {
      const estimatedTotal = Math.max(1, Math.ceil(totalDurationSec / CHUNK_SEC));
      await fs.mkdir(chunksDir, { recursive: true });

      updateJob(state, {
        status: 'transcribing',
        durationSeconds: Math.round(totalDurationSec),
        totalChunks: estimatedTotal,
        completedChunks: 0,
        strategyUsed: 'Single-Pass Streaming + Adaptive Parallel AI',
        stageLabel: `Streaming & transcribing ~${estimatedTotal} segments in parallel...`,
        progressPercent: 14,
      });

      const queue: AudioChunk[] = [];
      let producerDone = false;
      let producerErr: unknown = null;
      let waiters: Array<() => void> = [];

      const wakeWorkers = () => {
        const list = waiters;
        waiters = [];
        for (const w of list) w();
      };

      const popChunk = async (): Promise<AudioChunk | null> => {
        while (queue.length === 0) {
          if (state.cancelled || producerErr) return null;
          if (producerDone) return null;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        return queue.shift() || null;
      };

      const producerPromise = streamSegmentAudio({
        inputPath: inputFilePath,
        outputDir: chunksDir,
        chunkDurationSec: CHUNK_SEC,
        totalDurationSec,
        isCancelled: () => state.cancelled,
        onChunkReady: (chunk) => {
          queue.push(chunk);
          wakeWorkers();
        },
      })
        .then((actualTotal) => {
          producerDone = true;
          if (actualTotal > 0) {
            updateJob(state, { totalChunks: actualTotal });
          }
          wakeWorkers();
        })
        .catch((err) => {
          producerErr = err;
          producerDone = true;
          wakeWorkers();
        });

      let completed = 0;
      const worker = async () => {
        while (!state.cancelled) {
          const chunk = await popChunk();
          if (!chunk) break;
          try {
            const segs = await transcribeChunkResilient({
              chunk,
              totalChunks: state.job.totalChunks || estimatedTotal,
              options: state.job.options,
              workDir: chunksDir,
              isCancelled: () => state.cancelled,
            });
            if (state.cancelled) break;

            appendSegments(state, segs);
            completed += 1;
            const denom = Math.max(completed, state.job.totalChunks || estimatedTotal);
            const pct =
              15 + Math.round((completed / denom) * (state.job.options.autoAnalyze ? 74 : 83));
            updateJob(state, {
              completedChunks: completed,
              progressPercent: Math.min(90, pct),
              stageLabel: `Transcribed ${completed} of ${denom} segments...`,
            });
          } finally {
            await fs.rm(chunk.filePath, { force: true }).catch(() => {});
          }
        }
      };

      await Promise.all([
        producerPromise,
        ...Array.from({ length: Math.min(CONCURRENCY, estimatedTotal) }, () => worker()),
      ]);

      if (producerErr && state.job.segments.length === 0) {
        throw producerErr;
      }
      if (state.cancelled) return;
    } else {
      const { chunks, totalDurationSec: extractedDur } = await extractAndChunkAudio(
        inputFilePath,
        chunksDir,
        CHUNK_SEC,
        probe,
      );
      if (state.cancelled) return;

      updateJob(state, {
        status: 'transcribing',
        durationSeconds: Math.round(extractedDur),
        totalChunks: chunks.length,
        completedChunks: 0,
        stageLabel:
          chunks.length > 1
            ? `Transcribing ${chunks.length} segments in parallel...`
            : 'Transcribing audio...',
        progressPercent: 18,
      });

      let completed = 0;
      let nextCursor = 0;
      const worker = async () => {
        while (!state.cancelled) {
          const myPos = nextCursor++;
          if (myPos >= chunks.length) break;
          const chunk = chunks[myPos];
          const segs = await transcribeChunkResilient({
            chunk,
            totalChunks: chunks.length,
            options: state.job.options,
            workDir: chunksDir,
            isCancelled: () => state.cancelled,
          });
          if (state.cancelled) break;
          appendSegments(state, segs);
          completed += 1;
          const pct =
            18 + Math.round((completed / chunks.length) * (state.job.options.autoAnalyze ? 70 : 80));
          updateJob(state, {
            completedChunks: completed,
            progressPercent: pct,
            stageLabel: `Transcribed ${completed} of ${chunks.length} segments...`,
          });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
      );
      if (state.cancelled) return;
    }

    if (state.job.options.autoAnalyze && state.job.segments.length > 0 && !state.cancelled) {
      updateJob(state, {
        status: 'analyzing',
        stageLabel: 'Generating chapters & summary...',
        progressPercent: 92,
      });
      try {
        const analysis = await analyzeFullTranscript(
          state.job.segments,
          state.job.title,
          state.job.options.language,
        );
        if (state.cancelled) return;
        updateJob(state, { analysis });
      } catch {
        // Keep completed transcript even if optional summary step hits rate limits
      }
    }

    if (!state.cancelled) {
      updateJob(state, {
        status: 'completed',
        stageLabel: 'Transcription complete.',
        progressPercent: 100,
      });
    }
  } finally {
    await safeRemoveDir(chunksDir);
  }
}

export async function createYouTubeTranscriptionJob(params: {
  jobId: string;
  url: string;
  options: TranscriptionOptions;
  prefetchedInfo?: YouTubeInfo;
}): Promise<TranscriptionJob> {
  cleanupExpiredJobs();
  const workDir = path.join(WORK_ROOT, params.jobId);
  await fs.mkdir(workDir, { recursive: true });

  const info = params.prefetchedInfo || (await fetchYouTubeInfo(params.url));

  const initialJob: TranscriptionJob = {
    id: params.jobId,
    title: info.title,
    sourceKind: 'youtube',
    status: 'transcribing',
    stageLabel: 'Transcribing YouTube video...',
    progressPercent: 10,
    totalChunks: 0,
    completedChunks: 0,
    durationSeconds: info.durationSeconds,
    youtubeInfo: info,
    options: params.options,
    segments: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const state: InternalJobState = {
    job: initialJob,
    cancelled: false,
    emitter: new EventEmitter(),
    workDir,
  };
  jobs.set(params.jobId, state);

  void processYouTubeJob(state, info).catch((err) => {
    if (!state.cancelled) {
      updateJob(state, {
        status: 'error',
        error: formatApiError(err),
        stageLabel: 'YouTube transcription failed.',
      });
    }
  });

  return initialJob;
}

async function processYouTubeJob(state: InternalJobState, info: YouTubeInfo): Promise<void> {
  const windowSize = 300; // 5-minute sliding windows for long-form YouTube videos
  let nativeWorked = false;
  let primaryError: unknown = null;

  try {
    const maxWindows =
      info.durationSeconds > 0
        ? Math.ceil(info.durationSeconds / windowSize)
        : 240; // Supports 20+ hours seamlessly
    const CONCURRENCY = 3;
    let nextWindowIdx = 0;
    let stopScheduling = false;
    let completed = 0;
    let fatalErr: unknown = null;

    updateJob(state, {
      status: 'transcribing',
      totalChunks: info.durationSeconds > 0 ? maxWindows : 0,
      strategyUsed: 'Adaptive Parallel Video Window Pool',
      stageLabel:
        info.durationSeconds > 0
          ? `Transcribing ${formatTimecode(info.durationSeconds)} video across ${maxWindows} segments...`
          : 'Transcribing YouTube video in parallel segments...',
      progressPercent: 14,
    });

    const ytWorker = async () => {
      while (!state.cancelled && !stopScheduling) {
        const idx = nextWindowIdx++;
        if (idx >= maxWindows) break;
        const startSec = idx * windowSize;
        if (info.durationSeconds > 0 && startSec >= info.durationSeconds) break;
        const endSec =
          info.durationSeconds > 0
            ? Math.min(info.durationSeconds, startSec + windowSize)
            : startSec + windowSize;

        try {
          const segs = await transcribeYouTubeWindow({
            youtubeUrl: info.url,
            startSec,
            endSec,
            options: state.job.options,
          });
          if (state.cancelled) break;

          if (segs.length === 0) {
            // If duration was unknown and we hit an empty window after earlier content, stop
            if (info.durationSeconds <= 0 && idx > 0 && state.job.segments.length > 0) {
              stopScheduling = true;
            }
            continue;
          }

          appendSegments(state, segs);
          completed += 1;
          const lastSegEnd = segs[segs.length - 1]?.endSec || endSec;
          const denom = info.durationSeconds > 0 ? maxWindows : Math.max(completed + 1, 1);
          const pct = 15 + Math.round((completed / denom) * (state.job.options.autoAnalyze ? 73 : 82));

          updateJob(state, {
            completedChunks: completed,
            totalChunks: info.durationSeconds > 0 ? maxWindows : completed,
            durationSeconds: Math.max(state.job.durationSeconds, lastSegEnd),
            progressPercent: Math.min(89, pct),
            stageLabel:
              info.durationSeconds > 0
                ? `Transcribed ${completed} of ${maxWindows} segments (${formatTimecode(lastSegEnd)})...`
                : `Transcribed up to ${formatTimecode(lastSegEnd)}...`,
          });
        } catch (err) {
          if (idx === 0 && state.job.segments.length === 0) {
            fatalErr = err;
            stopScheduling = true;
            break;
          }
          // If past known/unknown end of video, stop scheduling; otherwise tolerate single-window hiccup
          if (info.durationSeconds <= 0) {
            stopScheduling = true;
            break;
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, maxWindows) }, () => ytWorker()),
    );

    if (fatalErr && state.job.segments.length === 0) {
      throw fatalErr;
    }

    if (state.job.segments.length > 0) {
      nativeWorked = true;
    }
  } catch (err) {
    primaryError = err;
    nativeWorked = false;
  }

  if (state.cancelled) return;

  // Fallback: YouTube Captions / Timedtext Extraction + AI Punctuation
  if (!nativeWorked) {
    updateJob(state, {
      status: 'transcribing',
      strategyUsed: 'YouTube Captions + AI Punctuation',
      stageLabel: 'Extracting YouTube timed captions...',
      progressPercent: 50,
    });

    let rawCaptions: TranscriptSegment[] = [];
    try {
      rawCaptions = await fetchYouTubeCaptions(info.videoId);
    } catch (capErr) {
      throw new Error(primaryError ? formatApiError(primaryError) : formatApiError(capErr));
    }

    if (rawCaptions.length === 0) {
      throw new Error(
        primaryError
          ? formatApiError(primaryError)
          : 'Unable to transcribe this YouTube video. Verify the link is public.',
      );
    }

    if (state.cancelled) return;
    const polished = await polishCaptionSegments(rawCaptions, state.job.options);
    const lastEnd = polished[polished.length - 1]?.endSec || info.durationSeconds;
    updateJob(state, {
      segments: polished,
      durationSeconds: info.durationSeconds || lastEnd,
      totalChunks: 1,
      completedChunks: 1,
      progressPercent: state.job.options.autoAnalyze ? 88 : 98,
    });
  }

  if (state.job.options.autoAnalyze && state.job.segments.length > 0 && !state.cancelled) {
    updateJob(state, {
      status: 'analyzing',
      stageLabel: 'Generating chapters & summary...',
      progressPercent: 92,
    });
    try {
      const analysis = await analyzeFullTranscript(
        state.job.segments,
        state.job.title,
        state.job.options.language,
      );
      if (state.cancelled) return;
      updateJob(state, { analysis });
    } catch {
      // Keep completed transcript even if optional summary step hits rate limits
    }
  }

  if (!state.cancelled) {
    updateJob(state, {
      status: 'completed',
      stageLabel: 'Transcription complete.',
      progressPercent: 100,
    });
  }
}

export async function runOnDemandAnalysis(jobId: string, customSegments?: TranscriptSegment[]) {
  const state = jobs.get(jobId);
  const segs = customSegments || state?.job.segments || [];
  const title = state?.job.title || 'Transcript';
  const analysis = await analyzeFullTranscript(segs, title, state?.job.options.language);
  if (state) {
    updateJob(state, { analysis });
  }
  return analysis;
}
