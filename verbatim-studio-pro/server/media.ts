import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MediaProbeResult {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width?: number;
  height?: number;
  formatName?: string;
}

export interface AudioChunk {
  index: number;
  filePath: string;
  offsetSec: number;
  durationSec: number;
  mimeType: string;
}

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  let stdout = '';
  try {
    const res = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    stdout = res.stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        'FFmpeg / FFprobe is not installed or not found in system PATH. Please install FFmpeg and restart your terminal.',
      );
    }
    throw err;
  }

  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      duration?: string;
      width?: number;
      height?: number;
    }>;
  };

  const streams = data.streams || [];
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const hasVideo = Boolean(videoStream);

  let durationSeconds = Number.parseFloat(data.format?.duration || '0');
  if (!durationSeconds || Number.isNaN(durationSeconds)) {
    const streamDurations = streams
      .map((s) => Number.parseFloat(s.duration || '0'))
      .filter((n) => !Number.isNaN(n) && n > 0);
    durationSeconds = streamDurations.length > 0 ? Math.max(...streamDurations) : 0;
  }

  return {
    durationSeconds,
    hasAudio,
    hasVideo,
    width: videoStream?.width,
    height: videoStream?.height,
    formatName: data.format?.format_name,
  };
}

function guessAudioMimeFromExt(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp3':
      return 'audio/mp3';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
    case '.aac':
      return 'audio/aac';
    case '.ogg':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.webm':
      return 'audio/webm';
    default:
      return null;
  }
}

/**
 * Extracts audio from any video or audio file into fast 16kHz mono 32kbps MP3 segments.
 * Short audio-only files (< 12MB and <= chunkDurationSec) bypass re-encoding for instant startup.
 */
export async function extractAndChunkAudio(
  inputPath: string,
  outputDir: string,
  chunkDurationSec = 420,
  existingProbe?: MediaProbeResult,
): Promise<{ chunks: AudioChunk[]; totalDurationSec: number }> {
  await fs.mkdir(outputDir, { recursive: true });
  const probe = existingProbe || (await probeMedia(inputPath));

  if (!probe.hasAudio) {
    throw new Error('This media file does not contain an audio stream to transcribe.');
  }

  const stat = await fs.stat(inputPath);
  const directMime = !probe.hasVideo ? guessAudioMimeFromExt(inputPath) : null;

  if (
    directMime &&
    probe.durationSeconds > 0 &&
    probe.durationSeconds <= chunkDurationSec &&
    stat.size <= 12 * 1024 * 1024
  ) {
    return {
      chunks: [
        {
          index: 0,
          filePath: inputPath,
          offsetSec: 0,
          durationSec: probe.durationSeconds,
          mimeType: directMime,
        },
      ],
      totalDurationSec: probe.durationSeconds,
    };
  }

  const pattern = path.join(outputDir, 'chunk_%04d.mp3');

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-threads',
      '0',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-compression_level',
      '0',
      '-f',
      'segment',
      '-segment_time',
      String(chunkDurationSec),
      '-reset_timestamps',
      '1',
      pattern,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );

  const files = (await fs.readdir(outputDir))
    .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
    .sort();

  if (files.length === 0) {
    throw new Error('Audio extraction produced no playable chunks.');
  }

  const chunks: AudioChunk[] = [];
  let runningOffset = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(outputDir, files[i]);
    let segDuration = chunkDurationSec;
    if (i === files.length - 1) {
      if (probe.durationSeconds > runningOffset) {
        segDuration = probe.durationSeconds - runningOffset;
      } else {
        try {
          const lastProbe = await probeMedia(filePath);
          if (lastProbe.durationSeconds > 0) segDuration = lastProbe.durationSeconds;
        } catch {
          // Keep nominal duration
        }
      }
    }
    chunks.push({
      index: i,
      filePath,
      offsetSec: runningOffset,
      durationSec: segDuration,
      mimeType: 'audio/mp3',
    });
    runningOffset += segDuration;
  }

  const totalDurationSec = probe.durationSeconds > 0 ? probe.durationSeconds : runningOffset;
  return { chunks, totalDurationSec };
}

/**
 * Single-pass streaming FFmpeg segmenter: reads multi-hour video/audio files once sequentially
 * and yields each finalized chunk as soon as FFmpeg advances to the next segment.
 */
export async function streamSegmentAudio(params: {
  inputPath: string;
  outputDir: string;
  chunkDurationSec: number;
  totalDurationSec: number;
  onChunkReady: (chunk: AudioChunk) => void;
  isCancelled: () => boolean;
}): Promise<number> {
  await fs.mkdir(params.outputDir, { recursive: true });
  const pattern = path.join(params.outputDir, 'chunk_%04d.mp3');

  return new Promise<number>((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-threads',
      '0',
      '-i',
      params.inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-compression_level',
      '0',
      '-f',
      'segment',
      '-segment_time',
      String(params.chunkDurationSec),
      '-reset_timestamps',
      '1',
      pattern,
    ]);

    let stderrTail = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-1500);
    });

    const emitted = new Set<string>();
    let finished = false;

    const scanReady = async (allFinalized: boolean) => {
      if (params.isCancelled()) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore
        }
        return;
      }
      const files = (await fs.readdir(params.outputDir).catch(() => []))
        .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
        .sort();

      // A file chunk_N is guaranteed flushed once chunk_{N+1} exists, OR once ffmpeg exits.
      const limit = allFinalized ? files.length : Math.max(0, files.length - 1);
      for (let i = 0; i < limit; i++) {
        const fname = files[i];
        if (emitted.has(fname)) continue;
        emitted.add(fname);

        const match = fname.match(/chunk_(\d+)\.mp3/);
        const idx = match ? Number.parseInt(match[1], 10) : i;
        const offsetSec = idx * params.chunkDurationSec;
        const remaining =
          params.totalDurationSec > offsetSec
            ? params.totalDurationSec - offsetSec
            : params.chunkDurationSec;
        const durationSec = Math.max(1, Math.min(params.chunkDurationSec, Math.round(remaining)));

        params.onChunkReady({
          index: idx,
          filePath: path.join(params.outputDir, fname),
          offsetSec,
          durationSec,
          mimeType: 'audio/mp3',
        });
      }
    };

    const timer = setInterval(() => {
      if (!finished) {
        void scanReady(false);
      }
    }, 300);

    proc.on('error', (err) => {
      finished = true;
      clearInterval(timer);
      reject(err);
    });

    proc.on('close', async (code) => {
      finished = true;
      clearInterval(timer);
      if (params.isCancelled()) {
        resolve(emitted.size);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderrTail || `FFmpeg segmenter exited with code ${code}`));
        return;
      }
      await scanReady(true);
      resolve(emitted.size);
    });
  });
}

/**
 * Extracts a single 16kHz mono 32kbps MP3 slice from a large media file using fast pre-input seeking (-ss before -i).
 */
export async function extractSingleAudioSlice(
  inputPath: string,
  outputPath: string,
  offsetSec: number,
  durationSec: number,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['-y', '-threads', '0'];
  if (offsetSec > 0) {
    args.push('-ss', String(offsetSec));
  }
  args.push(
    '-i',
    inputPath,
    '-t',
    String(Math.max(1, durationSec)),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '32k',
    '-compression_level',
    '0',
    outputPath,
  );
  await execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 16 });
}

export async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
