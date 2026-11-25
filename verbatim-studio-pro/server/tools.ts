import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type {
  ClipAspectRatio,
  ClipFramingMode,
  ClipTitleStyle,
  MediaOutputFormat,
  SubtitleCue,
  SubtitleStyleConfig,
  ToolAuthStatus,
  ToolJob,
  UrlProbeFormatOption,
  UrlProbeResult,
} from '../src/types/tools.ts';
import type { TranscriptSegment, TranscriptionOptions } from '../src/types/transcription.ts';
import {
  AUDIO_BACKDROP_THEMES,
  generateAssDocument,
  splitSegmentsIntoSubtitleCues,
} from '../src/utils/subtitleTemplates.ts';
import { findBestVideoClips, formatApiError, transcribeAudioChunk } from './ai.ts';
import {
  type AudioChunk,
  extractAndChunkAudio,
  probeMedia,
  safeRemoveDir,
  streamSegmentAudio,
} from './media.ts';
import { extractYouTubeId, fetchYouTubeInfo } from './youtube.ts';

const execFileAsync = promisify(execFile);

const STUDIO_TMP = path.join(os.tmpdir(), 'verbatim-studio');
const TOOLS_ROOT = path.join(STUDIO_TMP, 'tools');
const BIN_DIR = path.join(STUDIO_TMP, 'bin');
const COOKIES_FILE = path.join(STUDIO_TMP, 'cookies.txt');
const PROXY_FILE = path.join(STUDIO_TMP, 'proxy.txt');
const IS_WIN = process.platform === 'win32';
const YTDLP_PATH = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_RELEASE_URL = IS_WIN
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : process.platform === 'darwin'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

fs.mkdirSync(TOOLS_ROOT, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

function resolveActiveCookiesPath(): string | null {
  const envPath = process.env.YTDLP_COOKIES_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const stat = fs.statSync(COOKIES_FILE);
      if (stat.size > 20) return COOKIES_FILE;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveActiveProxy(): string | null {
  const envProxy = process.env.YTDLP_PROXY?.trim();
  if (envProxy) return envProxy;
  if (fs.existsSync(PROXY_FILE)) {
    try {
      const val = fs.readFileSync(PROXY_FILE, 'utf8').trim();
      if (val) return val;
    } catch {
      return null;
    }
  }
  return null;
}

function buildYtDlpBaseArgs(): string[] {
  const args = ['--js-runtimes', 'node'];
  const cookiesPath = resolveActiveCookiesPath();
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }
  const proxy = resolveActiveProxy();
  if (proxy) {
    args.push('--proxy', proxy);
  }
  return args;
}

export function getToolAuthStatus(): ToolAuthStatus {
  const cookiesPath = resolveActiveCookiesPath();
  let cookieEntries = 0;
  if (cookiesPath) {
    try {
      const raw = fs.readFileSync(cookiesPath, 'utf8');
      cookieEntries = raw
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#')).length;
    } catch {
      cookieEntries = 0;
    }
  }

  const proxy = resolveActiveProxy();
  let proxyMasked: string | undefined;
  if (proxy) {
    try {
      const u = new URL(proxy);
      proxyMasked = `${u.protocol}//${u.host}`;
    } catch {
      proxyMasked = 'Configured';
    }
  }

  return {
    hasCookies: Boolean(cookiesPath && cookieEntries > 0),
    cookieEntries,
    hasProxy: Boolean(proxy),
    proxyMasked,
  };
}

export async function saveToolAuth(params: {
  cookiesText?: string;
  proxyUrl?: string;
}): Promise<ToolAuthStatus> {
  if (typeof params.cookiesText === 'string') {
    const cleaned = params.cookiesText.trim();
    if (!cleaned) {
      await fsp.rm(COOKIES_FILE, { force: true });
    } else {
      const validLines = cleaned
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#'));
      if (validLines.length === 0 || !validLines.some((l) => l.includes('\t'))) {
        throw new Error(
          'Invalid cookies format. Export Netscape format cookies.txt (tab-separated lines) using "Get cookies.txt LOCALLY".',
        );
      }
      await fsp.writeFile(COOKIES_FILE, `${cleaned}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  if (typeof params.proxyUrl === 'string') {
    const trimmedProxy = params.proxyUrl.trim();
    if (!trimmedProxy) {
      await fsp.rm(PROXY_FILE, { force: true });
    } else {
      let parsed: URL;
      try {
        parsed = new URL(trimmedProxy);
      } catch {
        throw new Error('Proxy URL must be valid (e.g. http://user:pass@host:port or socks5://...).');
      }
      if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(parsed.protocol)) {
        throw new Error('Unsupported proxy protocol. Use http://, https://, or socks5://.');
      }
      await fsp.writeFile(PROXY_FILE, `${trimmedProxy}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  return getToolAuthStatus();
}

export async function clearToolAuth(): Promise<ToolAuthStatus> {
  await fsp.rm(COOKIES_FILE, { force: true }).catch(() => {});
  await fsp.rm(PROXY_FILE, { force: true }).catch(() => {});
  return getToolAuthStatus();
}

interface InternalToolJob {
  job: ToolJob;
  workDir: string;
  outputFilePath?: string;
  sourceFilePath?: string;
  sourceMimeType?: string;
}

const toolJobs = new Map<string, InternalToolJob>();
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

let ytDlpEnsurePromise: Promise<string> | null = null;

function notify(jobId: string) {
  const entry = toolJobs.get(jobId);
  if (entry) {
    emitter.emit(`tool:${jobId}`, { ...entry.job });
  }
}

function updateJob(jobId: string, patch: Partial<ToolJob>) {
  const entry = toolJobs.get(jobId);
  if (!entry) return;
  entry.job = { ...entry.job, ...patch };
  notify(jobId);
}

export function getToolJob(jobId: string): ToolJob | undefined {
  const entry = toolJobs.get(jobId);
  return entry ? { ...entry.job } : undefined;
}

export function getToolJobFile(
  jobId: string,
): { filePath: string; filename: string; mimeType: string; title: string } | undefined {
  const entry = toolJobs.get(jobId);
  if (!entry || !entry.outputFilePath || !fs.existsSync(entry.outputFilePath)) {
    return undefined;
  }
  return {
    filePath: entry.outputFilePath,
    filename: entry.job.outputFilename || path.basename(entry.outputFilePath),
    mimeType: entry.job.outputMimeType || 'application/octet-stream',
    title: entry.job.title,
  };
}

export function getToolJobSourceFile(
  jobId: string,
): { filePath: string; mimeType: string } | undefined {
  const entry = toolJobs.get(jobId);
  if (!entry || !entry.sourceFilePath || !fs.existsSync(entry.sourceFilePath)) {
    return undefined;
  }
  return {
    filePath: entry.sourceFilePath,
    mimeType: entry.sourceMimeType || 'application/octet-stream',
  };
}

export function subscribeToToolJob(
  jobId: string,
  listener: (job: ToolJob) => void,
): () => void {
  const event = `tool:${jobId}`;
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

function validatePublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Please enter a valid http:// or https:// media link.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error('Private or local network URLs are not allowed.');
  }

  return parsed;
}

export async function ensureYtDlp(): Promise<string> {
  if (fs.existsSync(YTDLP_PATH)) {
    return YTDLP_PATH;
  }
  if (!ytDlpEnsurePromise) {
    ytDlpEnsurePromise = (async () => {
      await fsp.mkdir(BIN_DIR, { recursive: true });
      const res = await fetch(YTDLP_RELEASE_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Failed to initialize yt-dlp downloader (${res.status}).`);
      }
      const tmpPath = `${YTDLP_PATH}.tmp`;
      const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeStream, fs.createWriteStream(tmpPath));
      if (!IS_WIN) {
        await fsp.chmod(tmpPath, 0o755);
      }
      await fsp.rename(tmpPath, YTDLP_PATH);
      return YTDLP_PATH;
    })().finally(() => {
      ytDlpEnsurePromise = null;
    });
  }
  return ytDlpEnsurePromise;
}

function safeDownloadFilename(title: string, ext: string): string {
  const base =
    title
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 72) || 'media';
  return `${base}.${ext.replace(/^\./, '')}`;
}

function mimeForFormat(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
    case 'aac':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    default:
      return 'application/octet-stream';
  }
}

async function tryDirectMediaProbe(parsedUrl: URL): Promise<UrlProbeResult | null> {
  const pathname = parsedUrl.pathname.toLowerCase();
  const looksDirect = /\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac)(\?|$)/i.test(pathname);

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isMedia = ct.startsWith('video/') || ct.startsWith('audio/') || looksDirect;
    if (!res.ok || !isMedia) return null;

    const rawName = decodeURIComponent(path.basename(parsedUrl.pathname) || 'Direct Media');
    const title = rawName.replace(/\.[^.]+$/, '') || 'Direct Media File';

    return {
      url: parsedUrl.toString(),
      title,
      platform: parsedUrl.hostname.replace(/^www\./, ''),
      author: parsedUrl.hostname.replace(/^www\./, ''),
      durationSeconds: 0,
      webpageUrl: parsedUrl.toString(),
      isDirectMedia: true,
      videoQualities: [{ label: 'Original Quality' }],
    };
  } catch {
    return null;
  }
}

export async function probeMediaUrl(rawUrl: string): Promise<UrlProbeResult> {
  const parsed = validatePublicHttpUrl(rawUrl);
  const ytDlp = await ensureYtDlp();

  try {
    const { stdout } = await execFileAsync(
      ytDlp,
      [
        '--no-warnings',
        '--no-playlist',
        '--dump-single-json',
        '--skip-download',
        ...buildYtDlpBaseArgs(),
        '--user-agent',
        USER_AGENT,
        parsed.toString(),
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 24 },
    );

    const data = JSON.parse(stdout) as {
      title?: string;
      extractor_key?: string;
      extractor?: string;
      uploader?: string;
      channel?: string;
      duration?: number;
      thumbnail?: string;
      webpage_url?: string;
      formats?: Array<{
        height?: number;
        vcodec?: string;
        filesize?: number;
        filesize_approx?: number;
      }>;
    };

    const heightMap = new Map<number, number | undefined>();
    for (const f of data.formats || []) {
      if (f.height && f.height >= 144 && f.vcodec && f.vcodec !== 'none') {
        const size = f.filesize || f.filesize_approx;
        const prev = heightMap.get(f.height);
        if (!prev || (size && size > prev)) {
          heightMap.set(f.height, size);
        }
      }
    }

    const sortedHeights = Array.from(heightMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map<UrlProbeFormatOption>(([height, filesizeApprox]) => ({
        label: height >= 2160 ? '4K (2160p)' : `${height}p`,
        height,
        filesizeApprox,
      }));

    const standardBuckets: UrlProbeFormatOption[] = [];
    const seenLabels = new Set<string>();
    for (const item of sortedHeights) {
      if (!seenLabels.has(item.label)) {
        seenLabels.add(item.label);
        standardBuckets.push(item);
      }
    }

    return {
      url: parsed.toString(),
      title: data.title || 'Media Download',
      platform: data.extractor_key || data.extractor || parsed.hostname.replace(/^www\./, ''),
      author: data.uploader || data.channel || parsed.hostname.replace(/^www\./, ''),
      durationSeconds: Math.round(data.duration || 0),
      thumbnailUrl: data.thumbnail,
      webpageUrl: data.webpage_url || parsed.toString(),
      videoQualities:
        standardBuckets.length > 0 ? standardBuckets : [{ label: 'Best Available' }],
    };
  } catch (err) {
    const direct = await tryDirectMediaProbe(parsed);
    if (direct) return direct;

    const msg = err instanceof Error ? err.message : String(err);
    const ytId = extractYouTubeId(parsed.toString());
    if (ytId) {
      try {
        const ytInfo = await fetchYouTubeInfo(parsed.toString());
        return {
          url: ytInfo.url,
          title: ytInfo.title,
          platform: 'YouTube',
          author: ytInfo.author,
          durationSeconds: ytInfo.durationSeconds,
          thumbnailUrl: ytInfo.thumbnailUrl,
          webpageUrl: ytInfo.url,
          authWarning: /Sign in to confirm|cookies|auth/i.test(msg),
          videoQualities: [
            { label: '1080p', height: 1080 },
            { label: '720p', height: 720 },
            { label: '480p', height: 480 },
          ],
        };
      } catch {
        // Fall through to error message
      }
    }

    if (/Sign in to confirm|cookies|auth/i.test(msg)) {
      throw new Error(
        'This video link requires cookies or proxy authentication on cloud servers. Add cookies.txt below and retry.',
      );
    }
    if (/Unsupported URL/i.test(msg)) {
      throw new Error(
        'Unsupported link or private page. Paste a public video/audio URL from YouTube, TikTok, Instagram, X, Vimeo, Reddit, SoundCloud, or a direct .mp4/.mp3 link.',
      );
    }
    throw new Error(`Could not inspect link: ${msg.split('\n')[0].slice(0, 180)}`);
  }
}

const TOOL_JOB_TTL_MS = 90 * 60 * 1000;
const MAX_RETAINED_FINISHED_TOOL_JOBS = 40;

function removeToolJobEntry(id: string, entry: InternalToolJob) {
  toolJobs.delete(id);
  void fsp.rm(entry.workDir, { recursive: true, force: true }).catch(() => {});
  if (
    entry.sourceFilePath &&
    entry.sourceFilePath.startsWith(STUDIO_TMP) &&
    !entry.sourceFilePath.startsWith(entry.workDir)
  ) {
    void fsp.rm(entry.sourceFilePath, { force: true }).catch(() => {});
  }
}

function cleanUpExpiredToolJobs() {
  const cutoff = Date.now() - TOOL_JOB_TTL_MS;
  const finished: Array<[string, InternalToolJob]> = [];

  for (const [id, entry] of toolJobs.entries()) {
    if (entry.job.status === 'processing') continue;
    if (entry.job.createdAt < cutoff) {
      removeToolJobEntry(id, entry);
    } else {
      finished.push([id, entry]);
    }
  }

  if (finished.length > MAX_RETAINED_FINISHED_TOOL_JOBS) {
    finished.sort((a, b) => a[1].job.createdAt - b[1].job.createdAt);
    const excess = finished.length - MAX_RETAINED_FINISHED_TOOL_JOBS;
    for (let i = 0; i < excess; i++) {
      const [id, entry] = finished[i];
      removeToolJobEntry(id, entry);
    }
  }
}

setInterval(() => {
  cleanUpExpiredToolJobs();
}, 15 * 60 * 1000).unref();

async function applyFfmpegTrim(
  inputPath: string,
  outputPath: string,
  startSec?: number,
  endSec?: number,
  reencodeAudioOnly = false,
): Promise<void> {
  const args = ['-y', '-threads', '0'];
  if (typeof startSec === 'number' && startSec > 0) {
    args.push('-ss', String(startSec));
  }
  args.push('-i', inputPath);
  if (typeof endSec === 'number' && endSec > (startSec || 0)) {
    args.push('-t', String(endSec - (startSec || 0)));
  }

  if (reencodeAudioOnly) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c', 'copy', '-movflags', '+faststart');
  }
  args.push(outputPath);

  try {
    await execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 16 });
  } catch {
    // Fallback re-encode if stream copy fails on non-keyframe cut
    const fallbackArgs = ['-y', '-threads', '0'];
    if (typeof startSec === 'number' && startSec > 0) {
      fallbackArgs.push('-ss', String(startSec));
    }
    fallbackArgs.push('-i', inputPath);
    if (typeof endSec === 'number' && endSec > (startSec || 0)) {
      fallbackArgs.push('-t', String(endSec - (startSec || 0)));
    }
    if (reencodeAudioOnly) {
      fallbackArgs.push('-vn', '-b:a', '192k');
    } else {
      fallbackArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
    }
    fallbackArgs.push(outputPath);
    await execFileAsync('ffmpeg', fallbackArgs, { maxBuffer: 1024 * 1024 * 16 });
  }
}

export async function startUrlDownloadJob(params: {
  url: string;
  title?: string;
  platform?: string;
  mode: 'video' | 'audio';
  maxHeight?: number;
  audioFormat?: 'mp3' | 'm4a' | 'wav' | 'flac';
  audioBitrate?: '128k' | '192k' | '320k';
  startSec?: number;
  endSec?: number;
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();
  const parsed = validatePublicHttpUrl(params.url);

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const targetExt =
    params.mode === 'audio' ? params.audioFormat || 'mp3' : 'mp4';

  const job: ToolJob = {
    id: jobId,
    kind: 'url-download',
    status: 'processing',
    title: params.title?.trim() || 'Media Download',
    stageLabel: 'Preparing link download...',
    progressPercent: 5,
    outputFormat: targetExt.toUpperCase(),
    platform: params.platform,
    sourceUrl: parsed.toString(),
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, { job, workDir });
  notify(jobId);

  void (async () => {
    try {
      const ytDlp = await ensureYtDlp();
      const outTemplate = path.join(workDir, 'download.%(ext)s');
      const baseYtArgs: string[] = [
        '--no-warnings',
        '--no-playlist',
        '--newline',
        ...buildYtDlpBaseArgs(),
        '--user-agent',
        USER_AGENT,
        '-o',
        outTemplate,
      ];

      if (params.mode === 'audio') {
        const audioFmt = params.audioFormat || 'mp3';
        const q =
          params.audioBitrate === '320k'
            ? '0'
            : params.audioBitrate === '128k'
              ? '5'
              : '2';
        baseYtArgs.push('-x', '--audio-format', audioFmt, '--audio-quality', q);
      } else {
        const cap = params.maxHeight && params.maxHeight > 0 ? `[height<=${params.maxHeight}]` : '';
        baseYtArgs.push(
          '-f',
          `bv*${cap}[ext=mp4]+ba[ext=m4a]/bv*${cap}+ba/b${cap}/b`,
          '--merge-output-format',
          'mp4',
        );
      }

      const runYtDlpAttempt = (extraArgs: string[]) =>
        new Promise<void>((resolve, reject) => {
          const proc = spawn(ytDlp, [...baseYtArgs, ...extraArgs, parsed.toString()]);
          let errBuf = '';

          const handleChunk = (chunk: Buffer) => {
            const text = chunk.toString();
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
              const pctMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
              if (pctMatch) {
                const pct = Math.min(88, Math.max(10, Math.round(Number(pctMatch[1]) * 0.85)));
                updateJob(jobId, {
                  progressPercent: pct,
                  stageLabel: `Downloading media (${pctMatch[1]}%)...`,
                });
              } else if (/\[Merger\]|\[ExtractAudio\]/i.test(line)) {
                updateJob(jobId, {
                  progressPercent: 90,
                  stageLabel:
                    params.mode === 'audio'
                      ? `Converting audio to ${targetExt.toUpperCase()}...`
                      : 'Merging video and audio streams...',
                });
              }
            }
          };

          proc.stdout.on('data', handleChunk);
          proc.stderr.on('data', (d: Buffer) => {
            errBuf += d.toString();
            handleChunk(d);
          });

          proc.on('error', reject);
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(errBuf || `yt-dlp exited with code ${code}`));
          });
        });

      updateJob(jobId, {
        stageLabel:
          params.mode === 'audio'
            ? `Downloading and extracting ${targetExt.toUpperCase()} audio...`
            : 'Downloading video stream...',
        progressPercent: 10,
      });

      let usedDirectFallback = false;
      try {
        try {
          await runYtDlpAttempt([]);
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          const isYouTube = Boolean(extractYouTubeId(parsed.toString()));
          if (isYouTube && !resolveActiveCookiesPath() && /Sign in to confirm|format|403/i.test(msg)) {
            updateJob(jobId, {
              stageLabel: 'Retrying with alternate YouTube mobile/TV client...',
              progressPercent: 14,
            });
            await runYtDlpAttempt(['--extractor-args', 'youtube:player_client=tv,mweb']);
          } else {
            throw firstErr;
          }
        }
      } catch (ytErr) {
        // Attempt direct CDN download fallback if URL looks like a raw media file
        const directProbe = await tryDirectMediaProbe(parsed);
        if (!directProbe) {
          throw ytErr;
        }
        usedDirectFallback = true;
        updateJob(jobId, {
          stageLabel: 'Downloading direct media file...',
          progressPercent: 35,
        });
        const rawRes = await fetch(parsed.toString(), {
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'follow',
        });
        if (!rawRes.ok || !rawRes.body) {
          throw new Error(`Direct media download failed (${rawRes.status}).`);
        }
        const rawExt = path.extname(parsed.pathname) || '.mp4';
        const rawPath = path.join(workDir, `raw${rawExt}`);
        const nodeStream = Readable.fromWeb(rawRes.body as Parameters<typeof Readable.fromWeb>[0]);
        await pipeline(nodeStream, fs.createWriteStream(rawPath));

        if (params.mode === 'audio') {
          updateJob(jobId, {
            stageLabel: `Extracting ${targetExt.toUpperCase()} audio...`,
            progressPercent: 80,
          });
          const audioOut = path.join(workDir, `download.${targetExt}`);
          await execFileAsync('ffmpeg', [
            '-y',
            '-threads',
            '0',
            '-i',
            rawPath,
            '-vn',
            '-b:a',
            params.audioBitrate || '192k',
            audioOut,
          ]);
          await fsp.rm(rawPath, { force: true });
        } else {
          const mp4Out = path.join(workDir, 'download.mp4');
          if (rawExt.toLowerCase() !== '.mp4') {
            await execFileAsync('ffmpeg', ['-y', '-i', rawPath, '-c', 'copy', mp4Out]);
            await fsp.rm(rawPath, { force: true });
          } else {
            await fsp.rename(rawPath, mp4Out);
          }
        }
      }

      const files = (await fsp.readdir(workDir)).filter((f) => !f.endsWith('.part'));
      if (files.length === 0) {
        throw new Error('Download finished, but no output file was produced.');
      }

      // Prefer non-raw file
      let finalFilePath = path.join(workDir, files[0]);
      const needsTrim =
        (typeof params.startSec === 'number' && params.startSec > 0) ||
        (typeof params.endSec === 'number' && params.endSec > 0);

      if (needsTrim) {
        updateJob(jobId, {
          stageLabel: 'Trimming requested time range...',
          progressPercent: 93,
        });
        const actualExt = path.extname(finalFilePath).replace(/^\./, '') || targetExt;
        const trimmedPath = path.join(workDir, `trimmed.${actualExt}`);
        await applyFfmpegTrim(
          finalFilePath,
          trimmedPath,
          params.startSec,
          params.endSec,
          params.mode === 'audio',
        );
        await fsp.rm(finalFilePath, { force: true });
        finalFilePath = trimmedPath;
      }

      const stat = await fsp.stat(finalFilePath);
      const probe = await probeMedia(finalFilePath).catch(() => ({
        durationSeconds: 0,
        hasAudio: true,
        hasVideo: params.mode === 'video',
      }));

      const finalExt = path.extname(finalFilePath).replace(/^\./, '') || targetExt;
      const entry = toolJobs.get(jobId);
      if (!entry) return;
      entry.outputFilePath = finalFilePath;

      updateJob(jobId, {
        status: 'completed',
        stageLabel: usedDirectFallback ? 'Direct download ready' : 'Download ready',
        progressPercent: 100,
        outputFormat: finalExt.toUpperCase(),
        outputFilename: safeDownloadFilename(job.title, finalExt),
        outputMimeType: mimeForFormat(finalExt),
        outputBytes: stat.size,
        durationSeconds: Math.round(probe.durationSeconds || 0),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const needsAuth = /Sign in to confirm|cookies|auth/i.test(msg);
      const friendly = needsAuth
        ? 'YouTube flagged this cloud server IP for bot verification. Upload or paste your browser cookies.txt (or set a proxy) in the Cookies & Auth panel to download, or click Transcribe Directly below.'
        : msg.split('\n').slice(-2).join(' ').slice(0, 220);

      updateJob(jobId, {
        status: 'error',
        stageLabel: needsAuth ? 'Browser Cookies Required' : 'Download failed',
        requiresAuth: needsAuth,
        error: friendly,
      });
    }
  })();

  return { ...job };
}

export async function startMediaConvertJob(params: {
  inputPath: string;
  originalName: string;
  inputBytes: number;
  kind: 'convert' | 'trim';
  outputFormat: MediaOutputFormat;
  audioBitrate?: '128k' | '192k' | '320k';
  videoResolution?: 'original' | '1080' | '720' | '480';
  startSec?: number;
  endSec?: number;
  normalizeAudio?: boolean;
  removeSilence?: boolean;
  enhanceVoice?: boolean;
  speed?: number;
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const baseTitle = params.originalName.replace(/\.[^.]+$/, '') || 'Converted Media';
  const ext = params.outputFormat;

  const job: ToolJob = {
    id: jobId,
    kind: params.kind,
    status: 'processing',
    title: baseTitle,
    stageLabel: `Inspecting ${params.originalName}...`,
    progressPercent: 5,
    outputFormat: ext.toUpperCase(),
    inputBytes: params.inputBytes,
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, { job, workDir });
  notify(jobId);

  void (async () => {
    try {
      const probe = await probeMedia(params.inputPath);
      const isAudioOutput = ext !== 'mp4';

      if (isAudioOutput && !probe.hasAudio) {
        throw new Error('This file does not contain an audio track to extract.');
      }

      const startSec = typeof params.startSec === 'number' && params.startSec > 0 ? params.startSec : 0;
      const hasEnd = typeof params.endSec === 'number' && params.endSec > startSec;
      const targetDuration = hasEnd
        ? (params.endSec as number) - startSec
        : Math.max(1, probe.durationSeconds - startSec);

      const outputPath = path.join(workDir, `output.${ext}`);
      const args: string[] = ['-y', '-threads', '0'];

      if (startSec > 0) {
        args.push('-ss', String(startSec));
      }
      args.push('-i', params.inputPath);
      if (hasEnd) {
        args.push('-t', String((params.endSec as number) - startSec));
      }

      const speed = params.speed && params.speed !== 1 ? params.speed : 1;

      if (isAudioOutput) {
        args.push('-vn');

        const afFilters: string[] = [];
        if (params.enhanceVoice) {
          afFilters.push('highpass=f=85,afftdn=nf=-24');
        }
        if (params.removeSilence) {
          afFilters.push('silenceremove=stop_periods=-1:stop_duration=0.6:stop_threshold=-38dB');
        }
        if (params.normalizeAudio || params.enhanceVoice) {
          afFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
        }
        if (speed !== 1) {
          afFilters.push(`atempo=${speed}`);
        }
        if (afFilters.length > 0) {
          args.push('-af', afFilters.join(','));
        }

        const bitrate = params.audioBitrate || '192k';
        if (ext === 'mp3') {
          args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
        } else if (ext === 'wav') {
          args.push('-c:a', 'pcm_s16le', '-ar', '44100');
        } else if (ext === 'm4a') {
          args.push('-c:a', 'aac', '-b:a', bitrate);
        } else if (ext === 'ogg') {
          args.push('-c:a', 'libvorbis', '-b:a', bitrate);
        } else if (ext === 'flac') {
          args.push('-c:a', 'flac');
        }
      } else {
        // MP4 Video output (trim or compress)
        const needsReencode =
          (params.videoResolution && params.videoResolution !== 'original') ||
          Boolean(params.normalizeAudio) ||
          Boolean(params.enhanceVoice) ||
          Boolean(params.removeSilence) ||
          speed !== 1;

        if (!needsReencode && params.kind === 'trim') {
          args.push('-c', 'copy', '-movflags', '+faststart');
        } else {
          const vfFilters: string[] = [];
          if (params.videoResolution && params.videoResolution !== 'original') {
            const h = Number(params.videoResolution);
            if (h > 0) {
              vfFilters.push(`scale=-2:'min(ih,${h})'`);
            }
          }
          if (speed !== 1) {
            vfFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
          }
          if (vfFilters.length > 0) {
            args.push('-vf', vfFilters.join(','));
          }

          if (probe.hasAudio) {
            const afFilters: string[] = [];
            if (params.enhanceVoice) afFilters.push('highpass=f=85,afftdn=nf=-24');
            if (params.normalizeAudio || params.enhanceVoice) {
              afFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
            }
            if (speed !== 1) afFilters.push(`atempo=${speed}`);
            if (afFilters.length > 0) args.push('-af', afFilters.join(','));
            args.push('-c:a', 'aac', '-b:a', params.audioBitrate || '128k');
          }

          args.push(
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
          );
        }
      }

      args.push('-progress', 'pipe:1', '-nostats', outputPath);

      updateJob(jobId, {
        stageLabel: isAudioOutput
          ? `Converting to ${ext.toUpperCase()}...`
          : `Processing MP4 video...`,
        progressPercent: 12,
      });

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        let errText = '';

        proc.stdout.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith('out_time_ms=')) {
              const ms = Number(line.split('=')[1] || 0);
              if (targetDuration > 0 && ms > 0) {
                const pct = Math.min(
                  96,
                  Math.max(14, Math.round((ms / (targetDuration * 1_000_000)) * 90) + 10),
                );
                updateJob(jobId, {
                  progressPercent: pct,
                  stageLabel: isAudioOutput
                    ? `Converting to ${ext.toUpperCase()} (${pct}%)...`
                    : `Processing video (${pct}%)...`,
                });
              }
            }
          }
        });

        proc.stderr.on('data', (d: Buffer) => {
          errText += d.toString();
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(errText.slice(-300) || `ffmpeg exited with code ${code}`));
        });
      });

      const stat = await fsp.stat(outputPath);
      const outProbe = await probeMedia(outputPath).catch(() => ({
        durationSeconds: targetDuration,
        hasAudio: true,
        hasVideo: !isAudioOutput,
      }));

      const entry = toolJobs.get(jobId);
      if (!entry) return;
      entry.outputFilePath = outputPath;

      updateJob(jobId, {
        status: 'completed',
        stageLabel: `${ext.toUpperCase()} ready`,
        progressPercent: 100,
        outputFilename: safeDownloadFilename(baseTitle, ext),
        outputMimeType: mimeForFormat(ext),
        outputBytes: stat.size,
        durationSeconds: Math.round(outProbe.durationSeconds || targetDuration),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Processing failed',
        error: err instanceof Error ? err.message : 'Could not process media file.',
      });
    } finally {
      await fsp.rm(params.inputPath, { force: true }).catch(() => {});
    }
  })();

  return { ...job };
}

export async function startMediaMergeJob(params: {
  inputs: Array<{ filePath: string; originalName: string; fileSizeBytes: number }>;
  outputFormat: 'mp3' | 'mp4' | 'wav' | 'm4a';
  audioBitrate?: '128k' | '192k' | '320k';
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  if (params.inputs.length < 2) {
    throw new Error('Select at least 2 audio or video files to merge.');
  }

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const totalInputBytes = params.inputs.reduce((sum, item) => sum + item.fileSizeBytes, 0);
  const baseName = `${params.inputs[0].originalName.replace(/\.[^.]+$/, '') || 'merged'}_merged`;
  const ext = params.outputFormat;

  const job: ToolJob = {
    id: jobId,
    kind: 'merge',
    status: 'processing',
    title: `Merged (${params.inputs.length} clips)`,
    stageLabel: `Inspecting ${params.inputs.length} media clips...`,
    progressPercent: 10,
    outputFormat: ext.toUpperCase(),
    inputBytes: totalInputBytes,
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, { job, workDir });
  notify(jobId);

  void (async () => {
    try {
      const outputPath = path.join(workDir, `merged.${ext}`);
      const isAudioOnly = ext !== 'mp4';

      const probes = await Promise.all(
        params.inputs.map((inp) =>
          probeMedia(inp.filePath).catch(() => ({
            durationSeconds: 0,
            hasAudio: true,
            hasVideo: !isAudioOnly,
          })),
        ),
      );
      const totalDur = probes.reduce((acc, p) => acc + (p.durationSeconds || 0), 0);

      updateJob(jobId, {
        stageLabel: `Merging ${params.inputs.length} files into ${ext.toUpperCase()}...`,
        progressPercent: 25,
      });

      const listFile = path.join(workDir, 'concat.txt');
      const listContent = params.inputs
        .map((inp) => `file '${inp.filePath.replace(/'/g, "'\\''")}'`)
        .join('\n');
      await fsp.writeFile(listFile, listContent, 'utf8');

      // Fast path if all inputs match cleanly; else re-encode smoothly via concat filter
      let mergedFast = false;
      try {
        const fastArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
        if (isAudioOnly) {
          fastArgs.push('-vn');
          if (ext === 'mp3') fastArgs.push('-c:a', 'libmp3lame', '-b:a', params.audioBitrate || '192k');
          else if (ext === 'wav') fastArgs.push('-c:a', 'pcm_s16le', '-ar', '44100');
          else fastArgs.push('-c:a', 'aac', '-b:a', params.audioBitrate || '192k');
        } else {
          fastArgs.push('-c', 'copy', '-movflags', '+faststart');
        }
        fastArgs.push(outputPath);
        await execFileAsync('ffmpeg', fastArgs, { maxBuffer: 1024 * 1024 * 16 });
        mergedFast = true;
      } catch {
        mergedFast = false;
      }

      if (!mergedFast) {
        updateJob(jobId, {
          stageLabel: 'Normalizing differing formats and joining clips...',
          progressPercent: 55,
        });

        const inputArgs: string[] = ['-y', '-threads', '0'];
        params.inputs.forEach((inp) => inputArgs.push('-i', inp.filePath));

        if (isAudioOnly) {
          const validAudioClips = params.inputs.filter((_, idx) => probes[idx]?.hasAudio !== false);
          if (validAudioClips.length === 0) {
            throw new Error('None of the selected clips contain an audio stream.');
          }
          const filterInputs = params.inputs
            .map((_, idx) =>
              probes[idx]?.hasAudio !== false
                ? `[${idx}:a]aresample=44100:async=1,aformat=channel_layouts=stereo[a${idx}]`
                : `anullsrc=channel_layout=stereo:sample_rate=44100:d=${Math.max(1, probes[idx]?.durationSeconds || 3)}[a${idx}]`,
            )
            .join(';');
          const concatAudioRefs = params.inputs.map((_, idx) => `[a${idx}]`).join('');
          inputArgs.push(
            '-filter_complex',
            `${filterInputs};${concatAudioRefs}concat=n=${params.inputs.length}:v=0:a=1[outa]`,
            '-map',
            '[outa]',
          );
          if (ext === 'mp3') inputArgs.push('-c:a', 'libmp3lame', '-b:a', params.audioBitrate || '192k');
          else if (ext === 'wav') inputArgs.push('-c:a', 'pcm_s16le', '-ar', '44100');
          else inputArgs.push('-c:a', 'aac', '-b:a', params.audioBitrate || '192k');
        } else {
          const streamsFilter = params.inputs
            .map((_, idx) => {
              const dur = Math.max(1, probes[idx]?.durationSeconds || 3);
              const vPart =
                probes[idx]?.hasVideo !== false
                  ? `[${idx}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${idx}]`
                  : `color=c=0x0F172A:s=1280x720:r=30:d=${dur}[v${idx}]`;
              const aPart =
                probes[idx]?.hasAudio !== false
                  ? `[${idx}:a]aresample=44100:async=1,aformat=channel_layouts=stereo[a${idx}]`
                  : `anullsrc=channel_layout=stereo:sample_rate=44100:d=${dur}[a${idx}]`;
              return `${vPart};${aPart}`;
            })
            .join(';');
          const concatRefs = params.inputs.map((_, idx) => `[v${idx}][a${idx}]`).join('');
          inputArgs.push(
            '-filter_complex',
            `${streamsFilter};${concatRefs}concat=n=${params.inputs.length}:v=1:a=1[outv][outa]`,
            '-map',
            '[outv]',
            '-map',
            '[outa]',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
          );
        }
        inputArgs.push(outputPath);
        await execFileAsync('ffmpeg', inputArgs, { maxBuffer: 1024 * 1024 * 16 });
      }

      const stat = await fsp.stat(outputPath);
      const outProbe = await probeMedia(outputPath).catch(() => ({
        durationSeconds: totalDur,
        hasAudio: true,
        hasVideo: !isAudioOnly,
      }));

      const entry = toolJobs.get(jobId);
      if (!entry) return;
      entry.outputFilePath = outputPath;

      updateJob(jobId, {
        status: 'completed',
        stageLabel: `Merged ${params.inputs.length} files into ${ext.toUpperCase()}`,
        progressPercent: 100,
        outputFilename: safeDownloadFilename(baseName, ext),
        outputMimeType: mimeForFormat(ext),
        outputBytes: stat.size,
        durationSeconds: Math.round(outProbe.durationSeconds || totalDur),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Merge failed',
        error: err instanceof Error ? err.message : 'Could not merge selected files.',
      });
    } finally {
      for (const inp of params.inputs) {
        await fsp.rm(inp.filePath, { force: true }).catch(() => {});
      }
    }
  })();

  return { ...job };
}

/**
 * Generates crisp word-capped subtitle cues directly from any uploaded Video or Audio file
 * using single-pass streaming audio extraction + parallel Gemini transcription.
 */
export async function startSubtitleGenerateJob(params: {
  inputPath: string;
  originalName: string;
  inputBytes: number;
  mimeType: string;
  language: string;
  maxWordsPerCue: number;
  identifySpeakers: boolean;
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  const chunksDir = path.join(workDir, 'chunks');
  await fsp.mkdir(chunksDir, { recursive: true });

  const baseTitle = params.originalName.replace(/\.[^.]+$/, '') || 'Subtitles';

  const job: ToolJob = {
    id: jobId,
    kind: 'subtitle-gen',
    status: 'processing',
    title: baseTitle,
    stageLabel: 'Inspecting audio & video stream...',
    progressPercent: 6,
    outputFormat: 'SUBTITLES',
    inputBytes: params.inputBytes,
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, {
    job,
    workDir,
    sourceFilePath: params.inputPath,
    sourceMimeType: params.mimeType,
  });
  notify(jobId);

  void (async () => {
    try {
      const probe = await probeMedia(params.inputPath);
      if (!probe.hasAudio) {
        throw new Error('This media file does not contain an audio stream for subtitling.');
      }

      const sourceIsAudio = !probe.hasVideo;
      const totalDurationSec = probe.durationSeconds > 0 ? probe.durationSeconds : 0;
      const CHUNK_SEC = totalDurationSec > 7200 ? 300 : 240;
      const CONCURRENCY = 3;

      updateJob(jobId, {
        durationSeconds: Math.round(totalDurationSec),
        sourceIsAudio,
        stageLabel: 'Extracting audio for synced captioning...',
        progressPercent: 14,
      });

      const options: TranscriptionOptions = {
        language: params.language || 'auto',
        translateToEnglish: false,
        identifySpeakers: params.identifySpeakers,
        timestampInterval: 'turn',
        autoAnalyze: false,
      };

      const collectedSegments: TranscriptSegment[] = [];

      if (totalDurationSec > CHUNK_SEC + 30) {
        const estimatedTotal = Math.max(1, Math.ceil(totalDurationSec / CHUNK_SEC));
        const queue: AudioChunk[] = [];
        let producerDone = false;
        let producerErr: unknown = null;
        let waiters: Array<() => void> = [];

        const wake = () => {
          const list = waiters;
          waiters = [];
          for (const w of list) w();
        };

        const pop = async (): Promise<AudioChunk | null> => {
          while (queue.length === 0) {
            if (producerErr || producerDone) return null;
            await new Promise<void>((r) => waiters.push(r));
          }
          return queue.shift() || null;
        };

        const producer = streamSegmentAudio({
          inputPath: params.inputPath,
          outputDir: chunksDir,
          chunkDurationSec: CHUNK_SEC,
          totalDurationSec,
          isCancelled: () => false,
          onChunkReady: (c) => {
            queue.push(c);
            wake();
          },
        })
          .then(() => {
            producerDone = true;
            wake();
          })
          .catch((e) => {
            producerErr = e;
            producerDone = true;
            wake();
          });

        let doneCount = 0;
        const worker = async () => {
          while (true) {
            const chunk = await pop();
            if (!chunk) break;
            try {
              const segs = await transcribeAudioChunk({
                filePath: chunk.filePath,
                mimeType: chunk.mimeType,
                offsetSec: chunk.offsetSec,
                chunkDurationSec: chunk.durationSec,
                chunkIndex: chunk.index,
                totalChunks: estimatedTotal,
                options,
              });
              collectedSegments.push(...segs);
              doneCount += 1;
              const pct = 18 + Math.min(76, Math.round((doneCount / estimatedTotal) * 76));
              updateJob(jobId, {
                progressPercent: pct,
                stageLabel: `Generating synced cues (${doneCount}/${estimatedTotal})...`,
              });
            } finally {
              await fsp.rm(chunk.filePath, { force: true }).catch(() => {});
            }
          }
        };

        await Promise.all([
          producer,
          ...Array.from({ length: Math.min(CONCURRENCY, estimatedTotal) }, () => worker()),
        ]);
        if (producerErr && collectedSegments.length === 0) throw producerErr;
      } else {
        const { chunks } = await extractAndChunkAudio(params.inputPath, chunksDir, CHUNK_SEC, probe);
        let doneCount = 0;
        let nextIdx = 0;
        const worker = async () => {
          while (true) {
            const pos = nextIdx++;
            if (pos >= chunks.length) break;
            const ch = chunks[pos];
            const segs = await transcribeAudioChunk({
              filePath: ch.filePath,
              mimeType: ch.mimeType,
              offsetSec: ch.offsetSec,
              chunkDurationSec: ch.durationSec,
              chunkIndex: ch.index,
              totalChunks: chunks.length,
              options,
            });
            collectedSegments.push(...segs);
            doneCount += 1;
            updateJob(jobId, {
              progressPercent: 20 + Math.round((doneCount / chunks.length) * 72),
              stageLabel: `Generating synced cues (${doneCount}/${chunks.length})...`,
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
        );
      }

      collectedSegments.sort((a, b) => a.startSec - b.startSec);
      const cues = splitSegmentsIntoSubtitleCues(collectedSegments, params.maxWordsPerCue);

      updateJob(jobId, {
        status: 'completed',
        stageLabel: `${cues.length} subtitle cues ready`,
        progressPercent: 100,
        cues,
        sourceIsAudio,
        durationSeconds: Math.round(totalDurationSec || cues[cues.length - 1]?.endSec || 0),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Subtitle generation failed',
        error: formatApiError(err),
      });
    } finally {
      await safeRemoveDir(chunksDir);
    }
  })();

  return { ...job };
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

/** Greedy word-wrap for the top hook headline — max 2 lines, never cut mid-word. */
export function wrapTitleLines(title: string, maxCharsPerLine: number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharsPerLine) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
      if (lines.length === 1 && current) {
        // Second line is the last one — keep it, truncation happens below
      }
    }
    if (lines.length >= 2) break;
  }
  if (lines.length < 2 && current) lines.push(current);
  if (lines.length > 2) lines.length = 2;
  if (lines.length === 2 && lines[1].length > maxCharsPerLine) {
    lines[1] = `${lines[1].slice(0, Math.max(0, maxCharsPerLine - 1)).trim()}…`;
  }
  return lines;
}

/**
 * Professional top hook headline: a full-width dark banner with a blue accent
 * bar and up to 2 wrapped, centred title lines. `minimal` keeps just the text
 * with a soft box; `off` renders nothing.
 */
function buildTitleOverlaySteps(params: {
  inputNode: string;
  title: string;
  style: ClipTitleStyle;
  targetW: number;
  fontName: string;
  fontSize: number;
}): { steps: string[]; outNode: string } {
  const { inputNode, title, style } = params;
  if (style === 'off' || !title.trim()) return { steps: [], outNode: inputNode };
  const maxChars = params.targetW >= 1080 ? 30 : 44;
  const lines = wrapTitleLines(title, maxChars);
  if (lines.length === 0) return { steps: [], outNode: inputNode };

  const lineHeight = Math.round(params.fontSize * 1.35);
  const topPad = Math.round(params.fontSize * 0.65);
  const safeTitle = (line: string) => escapeDrawtext(line);
  const steps: string[] = [];
  let node = inputNode;

  if (style === 'banner') {
    const bannerH = topPad + lines.length * lineHeight + Math.round(params.fontSize * 0.55);
    steps.push(
      `${node}drawbox=x=0:y=0:w=${params.targetW}:h=${bannerH}:color=black@0.62:t=fill[titlebg]`,
    );
    node = '[titlebg]';
    steps.push(
      `${node}drawbox=x=0:y=${bannerH}:w=${params.targetW}:h=6:color=0x2563EB:t=fill[titlebar]`,
    );
    node = '[titlebar]';
  }

  lines.forEach((line, i) => {
    const y = style === 'banner' ? topPad + i * lineHeight : Math.round(params.fontSize * 0.9) + i * lineHeight;
    const boxPart =
      style === 'minimal' ? ':box=1:boxcolor=black@0.55:boxborderw=12' : '';
    steps.push(
      `${node}drawtext=font='${params.fontName}':text='${safeTitle(line)}':fontcolor=#FFFFFF:fontsize=${params.fontSize}${boxPart}:x=(w-text_w)/2:y=${y}[title${i}]`,
    );
    node = `[title${i}]`;
  });

  return { steps, outNode: node };
}

/**
 * Burns professionally styled ASS subtitles directly onto an MP4 video, OR turns an audio
 * track into a clean 720p Studio Video (with optional animated waveform & title) with burned-in subtitles.
 */
export async function startSubtitleRenderJob(params: {
  sourceToolJobId?: string;
  inputPath?: string;
  originalName?: string;
  cues: SubtitleCue[];
  styleConfig: SubtitleStyleConfig;
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  let resolvedInputPath = params.inputPath;
  let resolvedName = params.originalName || 'subtitled_video';
  let cleanupInputAfterRender = Boolean(params.inputPath);

  if (!resolvedInputPath && params.sourceToolJobId) {
    const src = getToolJobSourceFile(params.sourceToolJobId);
    const srcJob = getToolJob(params.sourceToolJobId);
    if (src) {
      resolvedInputPath = src.filePath;
      resolvedName = srcJob?.title || resolvedName;
      cleanupInputAfterRender = false;
    }
  }

  if (!resolvedInputPath || !fs.existsSync(resolvedInputPath)) {
    throw new Error('Source media file is unavailable. Please upload the video or audio file again.');
  }

  if (params.cues.length === 0) {
    throw new Error('No subtitle cues provided to render.');
  }

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const baseTitle = resolvedName.replace(/\.[^.]+$/, '') || 'subtitled';
  const job: ToolJob = {
    id: jobId,
    kind: 'subtitle-render',
    status: 'processing',
    title: `${baseTitle} (Subtitled MP4)`,
    stageLabel: 'Preparing styled subtitle track...',
    progressPercent: 8,
    outputFormat: 'MP4',
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, { job, workDir });
  notify(jobId);

  const finalInputPath = resolvedInputPath;

  void (async () => {
    try {
      const probe = await probeMedia(finalInputPath);
      const isVideoInput = probe.hasVideo;
      const targetDuration = probe.durationSeconds > 0
        ? probe.durationSeconds
        : Math.max(1, params.cues[params.cues.length - 1]?.endSec || 10);

      const width = isVideoInput && probe.width ? probe.width : 1280;
      const height = isVideoInput && probe.height ? probe.height : 720;

      const assPath = path.join(workDir, 'styled.ass');
      const assContent = generateAssDocument(params.cues, params.styleConfig, width, height);
      await fsp.writeFile(assPath, assContent, 'utf8');

      const outputPath = path.join(workDir, 'subtitled.mp4');
      const escapedAssPath = assPath
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');

      const args: string[] = ['-y', '-threads', '0'];

      if (isVideoInput) {
        args.push(
          '-i',
          finalInputPath,
          '-vf',
          `ass=${escapedAssPath}`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '21',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          probe.hasAudio ? 'copy' : 'aac',
          '-movflags',
          '+faststart',
        );
      } else {
        // Audio-to-Subtitled-Video Studio Canvas (1280x720)
        const theme = AUDIO_BACKDROP_THEMES[params.styleConfig.audioBackdrop] || AUDIO_BACKDROP_THEMES['slate-dark'];
        const titleClean = (params.styleConfig.audioTitle || baseTitle).trim().slice(0, 72);
        const safeTitle = escapeDrawtext(titleClean);

        args.push(
          '-f',
          'lavfi',
          '-i',
          `color=c=${theme.hex}:s=1280x720:r=24:d=${Math.max(1, targetDuration)}`,
          '-i',
          finalInputPath,
        );

        const filterSteps: string[] = [];
        let videoNode = '[0:v]';

        if (params.styleConfig.showWaveform) {
          filterSteps.push(
            `[1:a]showwaves=s=1040x130:mode=cline:rate=24:colors=${theme.waveHex}[waves]`,
          );
          filterSteps.push(`${videoNode}[waves]overlay=(W-w)/2:225[bgw]`);
          videoNode = '[bgw]';
        }

        if (titleClean) {
          const titleFont = /[\u0600-\u06FF]/.test(titleClean) ? 'Noto Naskh Arabic' : 'Noto Sans';
          filterSteps.push(
            `${videoNode}drawtext=font='${titleFont}':text='${safeTitle}':fontcolor=${theme.titleHex}:fontsize=34:x=(w-text_w)/2:y=92[bgt]`,
          );
          videoNode = '[bgt]';
        }

        filterSteps.push(`${videoNode}ass=${escapedAssPath}[outv]`);

        args.push(
          '-filter_complex',
          filterSteps.join(';'),
          '-map',
          '[outv]',
          '-map',
          '1:a',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'stillimage',
          '-crf',
          '22',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-shortest',
          '-movflags',
          '+faststart',
        );
      }

      args.push('-progress', 'pipe:1', '-nostats', outputPath);

      updateJob(jobId, {
        stageLabel: isVideoInput
          ? 'Burning styled subtitles into MP4...'
          : 'Rendering studio audio video with subtitles...',
        progressPercent: 15,
      });

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        let errText = '';

        proc.stdout.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith('out_time_ms=')) {
              const ms = Number(line.split('=')[1] || 0);
              if (targetDuration > 0 && ms > 0) {
                const pct = Math.min(
                  96,
                  Math.max(18, Math.round((ms / (targetDuration * 1_000_000)) * 82) + 15),
                );
                updateJob(jobId, {
                  progressPercent: pct,
                  stageLabel: `Rendering subtitled MP4 (${pct}%)...`,
                });
              }
            }
          }
        });

        proc.stderr.on('data', (d: Buffer) => {
          errText += d.toString();
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(errText.slice(-400) || `ffmpeg exited with code ${code}`));
        });
      });

      const stat = await fsp.stat(outputPath);
      const entry = toolJobs.get(jobId);
      if (!entry) return;
      entry.outputFilePath = outputPath;

      updateJob(jobId, {
        status: 'completed',
        stageLabel: 'Subtitled MP4 ready',
        progressPercent: 100,
        outputFilename: safeDownloadFilename(`${baseTitle}_subtitled`, 'mp4'),
        outputMimeType: 'video/mp4',
        outputBytes: stat.size,
        durationSeconds: Math.round(targetDuration),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Subtitle rendering failed',
        error: err instanceof Error ? err.message : 'Could not render subtitled video.',
      });
    } finally {
      if (cleanupInputAfterRender) {
        await fsp.rm(finalInputPath, { force: true }).catch(() => {});
      }
    }
  })();

  return { ...job };
}

/**
 * Automated Video Best Clips Finder:
 * Transcribes an uploaded Video or Audio file (or uses existing precomputed segments),
 * finds the strongest self-contained highlight windows via Gemini, and builds 0-based
 * synced subtitle cues for every clip while caching the source media for zero-reupload renders.
 */
export async function startAutoClipsAnalyzeJob(params: {
  inputPath: string;
  originalName: string;
  inputBytes: number;
  mimeType: string;
  language: string;
  maxClips: number;
  minClipSec: number;
  maxClipSec: number;
  maxWordsPerCue: number;
  identifySpeakers: boolean;
  existingSegments?: TranscriptSegment[];
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  const chunksDir = path.join(workDir, 'chunks');
  await fsp.mkdir(chunksDir, { recursive: true });

  const baseTitle = params.originalName.replace(/\.[^.]+$/, '') || 'Auto Clips';

  const job: ToolJob = {
    id: jobId,
    kind: 'auto-clips-find',
    status: 'processing',
    title: baseTitle,
    stageLabel: 'Inspecting media & preparing clip analysis...',
    progressPercent: 6,
    outputFormat: 'CLIPS',
    inputBytes: params.inputBytes,
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, {
    job,
    workDir,
    sourceFilePath: params.inputPath,
    sourceMimeType: params.mimeType,
  });
  notify(jobId);

  void (async () => {
    try {
      const probe = await probeMedia(params.inputPath);
      const sourceIsAudio = !probe.hasVideo;
      const totalDurationSec = probe.durationSeconds > 0 ? probe.durationSeconds : 0;

      const precomputed = Array.isArray(params.existingSegments)
        ? params.existingSegments.filter((s) => s.text && s.text.trim().length > 0)
        : [];

      let collectedSegments: TranscriptSegment[] = [...precomputed];

      if (collectedSegments.length === 0) {
        if (!probe.hasAudio) {
          throw new Error('This media file has no audio stream for speech-based highlight detection.');
        }

        const CHUNK_SEC = totalDurationSec > 7200 ? 300 : 240;
        const CONCURRENCY = 3;

        updateJob(jobId, {
          durationSeconds: Math.round(totalDurationSec),
          sourceIsAudio,
          stageLabel: 'Extracting audio for AI highlight analysis...',
          progressPercent: 14,
        });

        const options: TranscriptionOptions = {
          language: params.language || 'auto',
          translateToEnglish: false,
          identifySpeakers: params.identifySpeakers,
          timestampInterval: 'turn',
          autoAnalyze: false,
        };

        if (totalDurationSec > CHUNK_SEC + 30) {
          const estimatedTotal = Math.max(1, Math.ceil(totalDurationSec / CHUNK_SEC));
          const queue: AudioChunk[] = [];
          let producerDone = false;
          let producerErr: unknown = null;
          let waiters: Array<() => void> = [];

          const wake = () => {
            const list = waiters;
            waiters = [];
            for (const w of list) w();
          };

          const pop = async (): Promise<AudioChunk | null> => {
            while (queue.length === 0) {
              if (producerErr || producerDone) return null;
              await new Promise<void>((r) => waiters.push(r));
            }
            return queue.shift() || null;
          };

          const producer = streamSegmentAudio({
            inputPath: params.inputPath,
            outputDir: chunksDir,
            chunkDurationSec: CHUNK_SEC,
            totalDurationSec,
            isCancelled: () => false,
            onChunkReady: (c) => {
              queue.push(c);
              wake();
            },
          })
            .then(() => {
              producerDone = true;
              wake();
            })
            .catch((e) => {
              producerErr = e;
              producerDone = true;
              wake();
            });

          let doneCount = 0;
          const worker = async () => {
            while (true) {
              const chunk = await pop();
              if (!chunk) break;
              try {
                const segs = await transcribeAudioChunk({
                  filePath: chunk.filePath,
                  mimeType: chunk.mimeType,
                  offsetSec: chunk.offsetSec,
                  chunkDurationSec: chunk.durationSec,
                  chunkIndex: chunk.index,
                  totalChunks: estimatedTotal,
                  options,
                });
                collectedSegments.push(...segs);
                doneCount += 1;
                const pct = 18 + Math.min(62, Math.round((doneCount / estimatedTotal) * 62));
                updateJob(jobId, {
                  progressPercent: pct,
                  stageLabel: `Listening & mapping moments (${doneCount}/${estimatedTotal})...`,
                });
              } finally {
                await fsp.rm(chunk.filePath, { force: true }).catch(() => {});
              }
            }
          };

          await Promise.all([
            producer,
            ...Array.from({ length: Math.min(CONCURRENCY, estimatedTotal) }, () => worker()),
          ]);
          if (producerErr && collectedSegments.length === 0) throw producerErr;
        } else {
          const { chunks } = await extractAndChunkAudio(params.inputPath, chunksDir, CHUNK_SEC, probe);
          let doneCount = 0;
          let nextIdx = 0;
          const worker = async () => {
            while (true) {
              const pos = nextIdx++;
              if (pos >= chunks.length) break;
              const ch = chunks[pos];
              const segs = await transcribeAudioChunk({
                filePath: ch.filePath,
                mimeType: ch.mimeType,
                offsetSec: ch.offsetSec,
                chunkDurationSec: ch.durationSec,
                chunkIndex: ch.index,
                totalChunks: chunks.length,
                options,
              });
              collectedSegments.push(...segs);
              doneCount += 1;
              updateJob(jobId, {
                progressPercent: 18 + Math.round((doneCount / chunks.length) * 62),
                stageLabel: `Listening & mapping moments (${doneCount}/${chunks.length})...`,
              });
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
          );
        }
      } else {
        updateJob(jobId, {
          durationSeconds: Math.round(totalDurationSec),
          sourceIsAudio,
          stageLabel: 'Using existing transcript to detect best clips...',
          progressPercent: 72,
        });
      }

      updateJob(jobId, {
        stageLabel: 'Finding best hooks & generating synced clip captions...',
        progressPercent: 86,
      });

      const clips = await findBestVideoClips({
        segments: collectedSegments,
        title: baseTitle,
        totalDurationSec,
        maxClips: params.maxClips,
        minClipSec: params.minClipSec,
        maxClipSec: params.maxClipSec,
        maxWordsPerCue: params.maxWordsPerCue,
        language: params.language,
      });

      updateJob(jobId, {
        status: 'completed',
        stageLabel: `${clips.length} best clip${clips.length === 1 ? '' : 's'} ready with captions`,
        progressPercent: 100,
        clips,
        sourceIsAudio,
        durationSeconds: Math.round(
          totalDurationSec || clips[clips.length - 1]?.endSec || 0,
        ),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Auto clip analysis failed',
        error: formatApiError(err),
      });
    } finally {
      await safeRemoveDir(chunksDir);
    }
  })();

  return { ...job };
}

/**
 * Splits a specific [startSec, endSec] highlight window from a cached or uploaded video/audio,
 * applies a professional aspect-ratio video setup (9:16 vertical blurred/crop, 1:1 square,
 * or 16:9 HD), optional hook title overlay, and burns synced ASS subtitles into an MP4.
 */
export async function startAutoClipRenderJob(params: {
  sourceToolJobId?: string;
  inputPath?: string;
  originalName?: string;
  clipTitle: string;
  startSec: number;
  endSec: number;
  cues: SubtitleCue[];
  aspectRatio: ClipAspectRatio;
  framingMode: ClipFramingMode;
  showTopTitle: boolean;
  titleStyle?: ClipTitleStyle;
  styleConfig: SubtitleStyleConfig;
}): Promise<ToolJob> {
  cleanUpExpiredToolJobs();

  let resolvedInputPath = params.inputPath;
  let resolvedName = params.originalName || params.clipTitle || 'clip';
  let cleanupInputAfterRender = Boolean(params.inputPath);

  if (params.sourceToolJobId) {
    const src = getToolJobSourceFile(params.sourceToolJobId);
    const srcJob = getToolJob(params.sourceToolJobId);
    if (src) {
      resolvedInputPath = src.filePath;
      resolvedName = srcJob?.title || resolvedName;
      cleanupInputAfterRender = false;
    }
  }

  if (!resolvedInputPath || !fs.existsSync(resolvedInputPath)) {
    throw new Error('Source video file is no longer cached on server. Please re-upload the video.');
  }

  const jobId = crypto.randomUUID();
  const workDir = path.join(TOOLS_ROOT, jobId);
  await fsp.mkdir(workDir, { recursive: true });

  const safeStart = Math.max(0, Number(params.startSec) || 0);
  const safeDuration = Math.max(2, Number(params.endSec || safeStart + 10) - safeStart);
  const cleanTitle = (params.clipTitle || resolvedName || 'Highlight Clip').trim().slice(0, 68);

  const job: ToolJob = {
    id: jobId,
    kind: 'auto-clip-render',
    status: 'processing',
    title: cleanTitle,
    stageLabel: `Preparing ${params.aspectRatio} clip render...`,
    progressPercent: 6,
    outputFormat: 'MP4',
    createdAt: Date.now(),
  };

  toolJobs.set(jobId, { job, workDir });
  notify(jobId);

  const finalInputPath = resolvedInputPath;

  void (async () => {
    try {
      const probe = await probeMedia(finalInputPath);
      const isVideoInput = probe.hasVideo;

      const targetW =
        params.aspectRatio === '9:16' ? 1080 : params.aspectRatio === '1:1' ? 1080 : 1280;
      const targetH =
        params.aspectRatio === '9:16' ? 1920 : params.aspectRatio === '1:1' ? 1080 : 720;

      const safeCues =
        Array.isArray(params.cues) && params.cues.length > 0
          ? params.cues
          : [
              {
                id: 'fallback_1',
                startSec: 0,
                endSec: Math.min(safeDuration, 4),
                text: cleanTitle,
              },
            ];

      const assPath = path.join(workDir, 'clip_subtitles.ass');
      const assContent = generateAssDocument(safeCues, params.styleConfig, targetW, targetH);
      await fsp.writeFile(assPath, assContent, 'utf8');

      const outputPath = path.join(workDir, 'clip_rendered.mp4');
      const escapedAssPath = assPath
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');

      const args: string[] = ['-y', '-threads', '0'];
      const titleFont = /[\u0600-\u06FF]/.test(cleanTitle) ? 'Noto Naskh Arabic' : 'Inter';
      const titleFontSize = params.aspectRatio === '9:16' ? 42 : params.aspectRatio === '1:1' ? 38 : 30;
      const titleStyle: ClipTitleStyle = params.showTopTitle
        ? params.titleStyle || 'banner'
        : 'off';

      if (isVideoInput) {
        args.push(
          '-ss',
          safeStart.toFixed(3),
          '-t',
          safeDuration.toFixed(3),
          '-i',
          finalInputPath,
        );

        const filterSteps: string[] = [];
        let videoNode = '[framed]';

        if (params.aspectRatio === '16:9') {
          filterSteps.push(
            `[0:v]setpts=PTS-STARTPTS,scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=#0F172A[framed]`,
          );
        } else if (params.framingMode === 'center-crop') {
          filterSteps.push(
            `[0:v]setpts=PTS-STARTPTS,scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}[framed]`,
          );
        } else {
          // Pro blurred cinema canvas framing (keeps speaker/slides uncropped in 9:16 or 1:1)
          filterSteps.push(
            `[0:v]setpts=PTS-STARTPTS,split=2[bg_raw][fg_raw]`,
            `[bg_raw]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=20:5,eq=brightness=-0.18[bg]`,
            `[fg_raw]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[fg]`,
            `[bg][fg]overlay=(W-w)/2:(H-h)/2[framed]`,
          );
        }

        if (titleStyle !== 'off' && cleanTitle) {
          const titleOverlay = buildTitleOverlaySteps({
            inputNode: videoNode,
            title: cleanTitle,
            style: titleStyle,
            targetW,
            fontName: titleFont,
            fontSize: titleFontSize,
          });
          filterSteps.push(...titleOverlay.steps);
          videoNode = titleOverlay.outNode;
        }

        filterSteps.push(`${videoNode}ass=${escapedAssPath}[outv]`);

        args.push(
          '-filter_complex',
          filterSteps.join(';'),
          '-map',
          '[outv]',
        );

        if (probe.hasAudio) {
          args.push('-map', '0:a:0', '-af', 'asetpts=PTS-STARTPTS', '-c:a', 'aac', '-b:a', '192k');
        } else {
          args.push('-an');
        }

        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '21',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
        );
      } else {
        // Audio-only clip turned into a styled waveform + captioned social video
        const theme =
          AUDIO_BACKDROP_THEMES[params.styleConfig.audioBackdrop] ||
          AUDIO_BACKDROP_THEMES['slate-dark'];

        args.push(
          '-f',
          'lavfi',
          '-i',
          `color=c=${theme.hex}:s=${targetW}x${targetH}:r=24:d=${safeDuration.toFixed(3)}`,
          '-ss',
          safeStart.toFixed(3),
          '-t',
          safeDuration.toFixed(3),
          '-i',
          finalInputPath,
        );

        const filterSteps: string[] = [];
        let videoNode = '[0:v]';

        if (params.styleConfig.showWaveform) {
          const waveW = Math.round(targetW * 0.84);
          const waveY = params.aspectRatio === '9:16' ? 680 : 230;
          filterSteps.push(
            `[1:a]asetpts=PTS-STARTPTS,showwaves=s=${waveW}x130:mode=cline:rate=24:colors=${theme.waveHex}[waves]`,
            `${videoNode}[waves]overlay=(W-w)/2:${waveY}[bgw]`,
          );
          videoNode = '[bgw]';
        }

        if (titleStyle !== 'off' && cleanTitle) {
          const titleOverlay = buildTitleOverlaySteps({
            inputNode: videoNode,
            title: cleanTitle,
            style: titleStyle,
            targetW,
            fontName: titleFont,
            fontSize: titleFontSize,
          });
          filterSteps.push(...titleOverlay.steps);
          videoNode = titleOverlay.outNode;
        }

        filterSteps.push(`${videoNode}ass=${escapedAssPath}[outv]`);

        args.push(
          '-filter_complex',
          filterSteps.join(';'),
          '-map',
          '[outv]',
          '-map',
          '1:a:0',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'stillimage',
          '-crf',
          '22',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-shortest',
          '-movflags',
          '+faststart',
        );
      }

      args.push('-progress', 'pipe:1', '-nostats', outputPath);

      updateJob(jobId, {
        stageLabel: `Splitting, framing (${params.aspectRatio}) & burning captions...`,
        progressPercent: 18,
      });

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args);
        let errText = '';

        proc.stdout.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith('out_time_ms=')) {
              const ms = Number(line.split('=')[1] || 0);
              if (safeDuration > 0 && ms > 0) {
                const pct = Math.min(
                  96,
                  Math.max(20, Math.round((ms / (safeDuration * 1_000_000)) * 78) + 18),
                );
                updateJob(jobId, {
                  progressPercent: pct,
                  stageLabel: `Rendering clip MP4 (${pct}%)...`,
                });
              }
            }
          }
        });

        proc.stderr.on('data', (d: Buffer) => {
          errText += d.toString();
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(errText.slice(-420) || `ffmpeg exited with code ${code}`));
        });
      });

      const stat = await fsp.stat(outputPath);
      const entry = toolJobs.get(jobId);
      if (!entry) return;
      entry.outputFilePath = outputPath;

      updateJob(jobId, {
        status: 'completed',
        stageLabel: 'Captioned clip MP4 ready',
        progressPercent: 100,
        outputFilename: safeDownloadFilename(
          `${cleanTitle}_${params.aspectRatio.replace(':', 'x')}`,
          'mp4',
        ),
        outputMimeType: 'video/mp4',
        outputBytes: stat.size,
        durationSeconds: Math.round(safeDuration),
      });
    } catch (err) {
      updateJob(jobId, {
        status: 'error',
        stageLabel: 'Clip render failed',
        error: err instanceof Error ? err.message : 'Could not render captioned clip.',
      });
    } finally {
      if (cleanupInputAfterRender) {
        await fsp.rm(finalInputPath, { force: true }).catch(() => {});
      }
    }
  })();

  return { ...job };
}



