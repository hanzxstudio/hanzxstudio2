import dotenv from 'dotenv';
// Load .env.local first (where the Gemini key lives), then .env as fallback.
// dotenv alone only reads .env, so without this the key in .env.local was ignored.
dotenv.config({ path: ['.env.local', '.env'] });
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import type { TranscriptSegment, TranscriptionOptions } from './src/types/transcription.ts';
import {
  analyzeFullTranscript,
  formatApiError,
  providerStatus,
  repurposeTranscript,
  transformTranscriptScript,
  type RepurposeFormat,
} from './server/ai.ts';
import { resetGeminiClients, type ScriptTargetMode } from './server/gemini.ts';
import {
  cancelJob,
  createFileTranscriptionJob,
  createYouTubeTranscriptionJob,
  getJob,
  getJobMediaFile,
  runOnDemandAnalysis,
  subscribeToJob,
} from './server/jobs.ts';
import { fetchYouTubeInfo } from './server/youtube.ts';
import {
  clearToolAuth,
  getToolAuthStatus,
  getToolJob,
  getToolJobFile,
  getToolJobSourceFile,
  probeMediaUrl,
  saveToolAuth,
  startAutoClipRenderJob,
  startAutoClipsAnalyzeJob,
  startMediaConvertJob,
  startMediaMergeJob,
  startSubtitleGenerateJob,
  startSubtitleRenderJob,
  startUrlDownloadJob,
  subscribeToToolJob,
} from './server/tools.ts';
import {
  UPLOAD_DIR,
  abortUploadSession,
  finalizeUploadSession,
  initUploadSession,
  writeUploadChunk,
} from './server/uploads.ts';
import type {
  ClipAspectRatio,
  ClipFramingMode,
  ClipTitleStyle,
  MediaOutputFormat,
  SubtitleCue,
  SubtitleStyleConfig,
} from './src/types/tools.ts';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.bin';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10 GB max for 5-6+ hour videos
  },
});

function parseOptions(raw: unknown): TranscriptionOptions {
  let obj: Partial<TranscriptionOptions> = {};
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Partial<TranscriptionOptions>;
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Partial<TranscriptionOptions>;
  }
  return {
    language: typeof obj.language === 'string' && obj.language ? obj.language : 'auto',
    translateToEnglish: Boolean(obj.translateToEnglish),
    identifySpeakers: obj.identifySpeakers !== false,
    timestampInterval:
      obj.timestampInterval === '30s' || obj.timestampInterval === '60s' ? obj.timestampInterval : 'turn',
    autoAnalyze: obj.autoAnalyze !== false,
  };
}

function encodeContentDisposition(filename: string): string {
  const safeAscii = filename.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

function streamFileWithRange(
  req: express.Request,
  res: express.Response,
  filePath: string,
  mimeType: string,
  downloadFilename?: string,
): void {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = mimeType || 'application/octet-stream';

  if (downloadFilename) {
    res.setHeader('Content-Disposition', encodeContentDisposition(downloadFilename));
  }
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (!range || fileSize === 0) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    res.end();
    return;
  }

  let start = match[1] ? Number.parseInt(match[1], 10) : NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : NaN;

  if (Number.isNaN(start) && !Number.isNaN(end)) {
    // Suffix range: last N bytes
    const suffixLen = Math.min(fileSize, Math.max(0, end));
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
  }

  if (start < 0 || start >= fileSize || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    res.end();
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Content-Length': chunkSize,
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '25mb' }));

  function detectKeySource(): '.env.local' | '.env' | 'missing' {
    for (const file of ['.env.local', '.env'] as const) {
      try {
        const raw = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
        const m = raw.match(/^GEMINI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
        if (m && m[1].trim() && m[1].trim() !== 'MY_GEMINI_API_KEY') return file;
      } catch {
        // file missing — try next
      }
    }
    return 'missing';
  }

  app.get('/api/health', (_req, res) => {
    const status = providerStatus();
    res.json({
      ok: true,
      hasApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      keySource: detectKeySource(),
      provider: status.provider,
      groqConfigured: status.groqConfigured,
      geminiConfigured: status.geminiConfigured,
    });
  });

  // Save / replace the Groq API key from the UI (no restart needed).
  // Writes only to .env.local (git-ignored). The key value is never returned.
  // Groq is free (no card): console.groq.com -> API Keys -> Create API Key.
  app.post('/api/settings/groq-key', async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || '').trim();
      if (!apiKey.startsWith('gsk_') || apiKey.length < 20) {
        res.status(400).json({ error: 'Please paste a valid Groq API key — it starts with gsk_ (free at console.groq.com).' });
        return;
      }
      const envPath = path.resolve(process.cwd(), '.env.local');
      let raw = '';
      try {
        raw = fs.readFileSync(envPath, 'utf8');
      } catch {
        raw = '';
      }
      const line = `GROQ_API_KEY="${apiKey.replace(/"/g, '')}"`;
      if (/^GROQ_API_KEY\s*=.*$/m.test(raw)) {
        raw = raw.replace(/^GROQ_API_KEY\s*=.*$/m, line);
      } else {
        raw = `${raw.replace(/\s+$/, '')}\n${line}\n`;
      }
      await fs.promises.writeFile(envPath, raw, { encoding: 'utf8', mode: 0o600 });
      process.env.GROQ_API_KEY = apiKey;
      const status = providerStatus();
      res.json({ ok: true, groqConfigured: true, provider: status.provider });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save Groq API key.' });
    }
  });

  // Switch provider: 'auto' (Groq when a key is set, else Gemini), 'groq', or 'gemini'.
  app.post('/api/settings/provider', async (req, res) => {
    try {
      const provider = String(req.body?.provider || 'auto').trim().toLowerCase();
      if (provider !== 'auto' && provider !== 'groq' && provider !== 'gemini') {
        res.status(400).json({ error: 'Provider must be auto, groq, or gemini.' });
        return;
      }
      const envPath = path.resolve(process.cwd(), '.env.local');
      let raw = '';
      try {
        raw = fs.readFileSync(envPath, 'utf8');
      } catch {
        raw = '';
      }
      const line =
        provider === 'auto' ? '' : `TRANSCRIPTION_PROVIDER="${provider}"`;
      if (/^TRANSCRIPTION_PROVIDER\s*=.*$/m.test(raw)) {
        raw = line ? raw.replace(/^TRANSCRIPTION_PROVIDER\s*=.*$/m, line) : raw.replace(/^TRANSCRIPTION_PROVIDER\s*=.*$\n?/m, '');
      } else if (line) {
        raw = `${raw.replace(/\s+$/, '')}\n${line}\n`;
      }
      await fs.promises.writeFile(envPath, raw, { encoding: 'utf8', mode: 0o600 });
      process.env.TRANSCRIPTION_PROVIDER = provider === 'auto' ? '' : provider;
      res.json({ ok: true, provider: providerStatus().provider });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save provider setting.' });
    }
  });

  // Save / replace the Gemini API key from the UI (no restart needed).
  // Writes only to .env.local (git-ignored). The key value is never returned.
  app.post('/api/settings/api-key', async (req, res) => {
    try {
      const apiKey = String(req.body?.apiKey || '').trim();
      if (apiKey.length < 20 || apiKey === 'MY_GEMINI_API_KEY') {
        res.status(400).json({ error: 'Please paste a valid Gemini API key (at least 20 characters).' });
        return;
      }
      const envPath = path.resolve(process.cwd(), '.env.local');
      let raw = '';
      try {
        raw = fs.readFileSync(envPath, 'utf8');
      } catch {
        raw = '';
      }
      const line = `GEMINI_API_KEY="${apiKey.replace(/"/g, '')}"`;
      if (/^GEMINI_API_KEY\s*=.*$/m.test(raw)) {
        raw = raw.replace(/^GEMINI_API_KEY\s*=.*$/m, line);
      } else {
        raw = `${raw.replace(/\s+$/, '')}\n${line}\n`;
      }
      await fs.promises.writeFile(envPath, raw, { encoding: 'utf8', mode: 0o600 });
      process.env.GEMINI_API_KEY = apiKey;
      resetGeminiClients();
      res.json({ ok: true, hasApiKey: true, keySource: '.env.local' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save API key.' });
    }
  });

  app.get('/api/youtube/info', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Missing url query parameter.' });
      return;
    }
    try {
      const info = await fetchYouTubeInfo(url);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/transcribe/upload', upload.single('media'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No audio or video file was uploaded.' });
      return;
    }

    try {
      const jobId = crypto.randomUUID();
      const sourceKind =
        req.body?.sourceKind === 'audio' || req.file.mimetype.startsWith('audio/') ? 'audio' : 'video';
      const title =
        (typeof req.body?.title === 'string' && req.body.title.trim()) ||
        req.file.originalname ||
        'Uploaded Media';
      const options = parseOptions(req.body?.options);

      const job = await createFileTranscriptionJob({
        jobId,
        title,
        sourceKind,
        filePath: req.file.path,
        fileSizeBytes: req.file.size,
        mimeType: req.file.mimetype || (sourceKind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
        options,
      });

      res.status(202).json(job);
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  // --- Parallel Chunked Upload Endpoints (Bypasses Cloud Run 32 MB request limit & accelerates multi-GB uploads) ---
  app.post('/api/uploads/init', async (req, res) => {
    try {
      const result = await initUploadSession({
        filename: String(req.body?.filename || 'media_file'),
        fileSizeBytes: Number(req.body?.fileSizeBytes || 0),
        mimeType: typeof req.body?.mimeType === 'string' ? req.body.mimeType : undefined,
        chunkSizeBytes: req.body?.chunkSizeBytes ? Number(req.body.chunkSizeBytes) : undefined,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.put(
    '/api/uploads/:uploadId/chunk',
    express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    async (req, res) => {
      try {
        const indexRaw = req.query.index ?? req.headers['x-chunk-index'];
        const index = Number(indexRaw);
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = await writeUploadChunk({
          uploadId: req.params.uploadId,
          index,
          buffer: buf,
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: formatApiError(err) });
      }
    },
  );

  app.delete('/api/uploads/:uploadId', async (req, res) => {
    await abortUploadSession(req.params.uploadId);
    res.json({ aborted: true });
  });

  app.post('/api/transcribe/from-upload', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '').trim();
    if (!uploadId) {
      res.status(400).json({ error: 'Missing uploadId.' });
      return;
    }

    try {
      const uploaded = await finalizeUploadSession(uploadId);
      const jobId = crypto.randomUUID();
      const sourceKind =
        req.body?.sourceKind === 'audio' || uploaded.mimeType.startsWith('audio/')
          ? 'audio'
          : 'video';
      const title =
        (typeof req.body?.title === 'string' && req.body.title.trim()) ||
        uploaded.filename ||
        'Uploaded Media';
      const options = parseOptions(req.body?.options);

      const job = await createFileTranscriptionJob({
        jobId,
        title,
        sourceKind,
        filePath: uploaded.filePath,
        fileSizeBytes: uploaded.fileSizeBytes,
        mimeType: uploaded.mimeType || (sourceKind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
        options,
      });

      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/transcribe/youtube', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Please provide a YouTube video link.' });
      return;
    }

    try {
      const jobId = crypto.randomUUID();
      const options = parseOptions(req.body?.options);
      const job = await createYouTubeTranscriptionJob({
        jobId,
        url,
        options,
        prefetchedInfo: req.body?.info,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Transcription job not found.' });
      return;
    }
    res.json(job);
  });

  app.get('/api/jobs/:jobId/stream', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Transcription job not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    const unsubscribe = subscribeToJob(req.params.jobId, (updated) => {
      res.write(`data: ${JSON.stringify(updated)}\n\n`);
      if (updated.status === 'completed' || updated.status === 'error' || updated.status === 'cancelled') {
        unsubscribe();
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  app.post('/api/jobs/:jobId/cancel', (req, res) => {
    const ok = cancelJob(req.params.jobId);
    if (!ok) {
      res.status(404).json({ error: 'Transcription job not found.' });
      return;
    }
    res.json({ cancelled: true });
  });

  app.post('/api/jobs/:jobId/analyze', async (req, res) => {
    try {
      const segments = Array.isArray(req.body?.segments)
        ? (req.body.segments as TranscriptSegment[])
        : undefined;
      const title = typeof req.body?.title === 'string' ? req.body.title : 'Transcript';

      if (getJob(req.params.jobId)) {
        const analysis = await runOnDemandAnalysis(req.params.jobId, segments);
        res.json(analysis);
        return;
      }

      if (!segments || segments.length === 0) {
        res.status(404).json({ error: 'No transcript segments provided for analysis.' });
        return;
      }

      const analysis = await analyzeFullTranscript(segments, title);
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/jobs/:jobId/transform-script', async (req, res) => {
    try {
      const targetMode = req.body?.targetMode as ScriptTargetMode;
      if (!['urdu-pure', 'roman-urdu', 'urdu-english', 'english'].includes(targetMode)) {
        res.status(400).json({ error: 'Invalid target script mode.' });
        return;
      }
      const segments = Array.isArray(req.body?.segments)
        ? (req.body.segments as TranscriptSegment[])
        : getJob(req.params.jobId)?.segments;

      if (!segments || segments.length === 0) {
        res.status(400).json({ error: 'No transcript segments available to convert.' });
        return;
      }

      const converted = await transformTranscriptScript(segments, targetMode);
      res.json({ segments: converted });
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/jobs/:jobId/repurpose', async (req, res) => {
    try {
      const format = req.body?.format as RepurposeFormat;
      if (!['study-notes', 'blog-article', 'youtube-pack', 'social-thread'].includes(format)) {
        res.status(400).json({ error: 'Invalid repurpose format.' });
        return;
      }
      const segments = Array.isArray(req.body?.segments)
        ? (req.body.segments as TranscriptSegment[])
        : getJob(req.params.jobId)?.segments;
      const title =
        (typeof req.body?.title === 'string' && req.body.title.trim()) ||
        getJob(req.params.jobId)?.title ||
        'Transcript';
      const outputLanguage = ['match', 'urdu', 'english', 'roman-urdu'].includes(
        req.body?.outputLanguage,
      )
        ? (req.body.outputLanguage as 'match' | 'urdu' | 'english' | 'roman-urdu')
        : 'match';

      if (!segments || segments.length === 0) {
        res.status(400).json({ error: 'No transcript segments available to repurpose.' });
        return;
      }

      const result = await repurposeTranscript({
        segments,
        title,
        format,
        outputLanguage,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  // Stream uploaded local media with HTTP Range support for instant video/audio seeking
  app.get('/api/jobs/:jobId/media', (req, res) => {
    const media = getJobMediaFile(req.params.jobId);
    if (!media || !fs.existsSync(media.filePath)) {
      res.status(404).json({ error: 'Media file is no longer cached on the server.' });
      return;
    }

    streamFileWithRange(req, res, media.filePath, media.mimeType || 'application/octet-stream');
  });

  // --- Media Tools Endpoints (Link Downloader, Video-to-Audio, Trimmer) ---
  app.get('/api/tools/auth', (_req, res) => {
    res.json(getToolAuthStatus());
  });

  app.post('/api/tools/auth', async (req, res) => {
    try {
      const status = await saveToolAuth({
        cookiesText: typeof req.body?.cookiesText === 'string' ? req.body.cookiesText : undefined,
        proxyUrl: typeof req.body?.proxyUrl === 'string' ? req.body.proxyUrl : undefined,
      });
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.delete('/api/tools/auth', async (_req, res) => {
    const status = await clearToolAuth();
    res.json(status);
  });

  app.get('/api/tools/probe', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Missing url query parameter.' });
      return;
    }
    try {
      const result = await probeMediaUrl(url);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/download', async (req, res) => {
    const url = String(req.body?.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'Please paste a media link to download.' });
      return;
    }
    try {
      const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
      const maxHeight = req.body?.maxHeight ? Number(req.body.maxHeight) : undefined;
      const audioFormat = ['mp3', 'm4a', 'wav', 'flac'].includes(req.body?.audioFormat)
        ? (req.body.audioFormat as 'mp3' | 'm4a' | 'wav' | 'flac')
        : 'mp3';
      const audioBitrate = ['128k', '192k', '320k'].includes(req.body?.audioBitrate)
        ? (req.body.audioBitrate as '128k' | '192k' | '320k')
        : '192k';
      const startSec =
        req.body?.startSec !== undefined && req.body?.startSec !== ''
          ? Number(req.body.startSec)
          : undefined;
      const endSec =
        req.body?.endSec !== undefined && req.body?.endSec !== ''
          ? Number(req.body.endSec)
          : undefined;

      const job = await startUrlDownloadJob({
        url,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        platform: typeof req.body?.platform === 'string' ? req.body.platform : undefined,
        mode,
        maxHeight,
        audioFormat,
        audioBitrate,
        startSec: Number.isFinite(startSec) ? startSec : undefined,
        endSec: Number.isFinite(endSec) ? endSec : undefined,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/convert', upload.single('media'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No video or audio file uploaded.' });
      return;
    }
    try {
      const allowedFormats: MediaOutputFormat[] = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4'];
      const outputFormat = allowedFormats.includes(req.body?.outputFormat)
        ? (req.body.outputFormat as MediaOutputFormat)
        : 'mp3';
      const kind = req.body?.kind === 'trim' ? 'trim' : 'convert';
      const audioBitrate = ['128k', '192k', '320k'].includes(req.body?.audioBitrate)
        ? (req.body.audioBitrate as '128k' | '192k' | '320k')
        : '192k';
      const videoResolution = ['original', '1080', '720', '480'].includes(
        req.body?.videoResolution,
      )
        ? (req.body.videoResolution as 'original' | '1080' | '720' | '480')
        : 'original';
      const startSec =
        req.body?.startSec !== undefined && req.body?.startSec !== ''
          ? Number(req.body.startSec)
          : undefined;
      const endSec =
        req.body?.endSec !== undefined && req.body?.endSec !== ''
          ? Number(req.body.endSec)
          : undefined;
      const speed = req.body?.speed ? Number(req.body.speed) : 1;

      const job = await startMediaConvertJob({
        inputPath: req.file.path,
        originalName: req.file.originalname || 'media_file',
        inputBytes: req.file.size,
        kind,
        outputFormat,
        audioBitrate,
        videoResolution,
        startSec: Number.isFinite(startSec) ? startSec : undefined,
        endSec: Number.isFinite(endSec) ? endSec : undefined,
        normalizeAudio: req.body?.normalizeAudio === 'true',
        removeSilence: req.body?.removeSilence === 'true',
        enhanceVoice: req.body?.enhanceVoice === 'true',
        speed: [0.75, 1, 1.25, 1.5, 2].includes(speed) ? speed : 1,
      });

      res.status(202).json(job);
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/convert-uploaded', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '').trim();
    if (!uploadId) {
      res.status(400).json({ error: 'Missing uploadId.' });
      return;
    }
    try {
      const uploaded = await finalizeUploadSession(uploadId);
      const allowedFormats: MediaOutputFormat[] = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4'];
      const outputFormat = allowedFormats.includes(req.body?.outputFormat)
        ? (req.body.outputFormat as MediaOutputFormat)
        : 'mp3';
      const kind = req.body?.kind === 'trim' ? 'trim' : 'convert';
      const audioBitrate = ['128k', '192k', '320k'].includes(req.body?.audioBitrate)
        ? (req.body.audioBitrate as '128k' | '192k' | '320k')
        : '192k';
      const videoResolution = ['original', '1080', '720', '480'].includes(
        req.body?.videoResolution,
      )
        ? (req.body.videoResolution as 'original' | '1080' | '720' | '480')
        : 'original';
      const startSec =
        req.body?.startSec !== undefined && req.body?.startSec !== ''
          ? Number(req.body.startSec)
          : undefined;
      const endSec =
        req.body?.endSec !== undefined && req.body?.endSec !== ''
          ? Number(req.body.endSec)
          : undefined;
      const speed = req.body?.speed ? Number(req.body.speed) : 1;

      const job = await startMediaConvertJob({
        inputPath: uploaded.filePath,
        originalName: uploaded.filename || 'media_file',
        inputBytes: uploaded.fileSizeBytes,
        kind,
        outputFormat,
        audioBitrate,
        videoResolution,
        startSec: Number.isFinite(startSec) ? startSec : undefined,
        endSec: Number.isFinite(endSec) ? endSec : undefined,
        normalizeAudio: req.body?.normalizeAudio === true || req.body?.normalizeAudio === 'true',
        removeSilence: req.body?.removeSilence === true || req.body?.removeSilence === 'true',
        enhanceVoice: req.body?.enhanceVoice === true || req.body?.enhanceVoice === 'true',
        speed: [0.75, 1, 1.25, 1.5, 2].includes(speed) ? speed : 1,
      });

      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/merge-uploaded', async (req, res) => {
    const uploadIds = Array.isArray(req.body?.uploadIds)
      ? (req.body.uploadIds as string[]).filter((id) => typeof id === 'string' && id.trim())
      : [];

    if (uploadIds.length < 2) {
      res.status(400).json({ error: 'Upload at least 2 audio or video files to merge.' });
      return;
    }

    try {
      const inputs: Array<{ filePath: string; originalName: string; fileSizeBytes: number }> = [];
      for (const uid of uploadIds) {
        const finalized = await finalizeUploadSession(uid);
        inputs.push({
          filePath: finalized.filePath,
          originalName: finalized.filename,
          fileSizeBytes: finalized.fileSizeBytes,
        });
      }

      const outputFormat = ['mp3', 'mp4', 'wav', 'm4a'].includes(req.body?.outputFormat)
        ? (req.body.outputFormat as 'mp3' | 'mp4' | 'wav' | 'm4a')
        : 'mp4';
      const audioBitrate = ['128k', '192k', '320k'].includes(req.body?.audioBitrate)
        ? (req.body.audioBitrate as '128k' | '192k' | '320k')
        : '192k';

      const job = await startMediaMergeJob({
        inputs,
        outputFormat,
        audioBitrate,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.get('/api/tools/jobs/:jobId', (req, res) => {
    const job = getToolJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Tool job not found.' });
      return;
    }
    res.json(job);
  });

  app.get('/api/tools/jobs/:jobId/stream', (req, res) => {
    const job = getToolJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Tool job not found.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === 'completed' || job.status === 'error') {
      res.end();
      return;
    }

    const unsubscribe = subscribeToToolJob(req.params.jobId, (updated) => {
      res.write(`data: ${JSON.stringify(updated)}\n\n`);
      if (updated.status === 'completed' || updated.status === 'error') {
        unsubscribe();
        res.end();
      }
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  app.get('/api/tools/jobs/:jobId/file', (req, res) => {
    const fileInfo = getToolJobFile(req.params.jobId);
    if (!fileInfo) {
      res.status(404).json({ error: 'Processed file is no longer available on the server.' });
      return;
    }

    const isInline = req.query.inline === '1';
    streamFileWithRange(
      req,
      res,
      fileInfo.filePath,
      fileInfo.mimeType,
      isInline ? undefined : fileInfo.filename,
    );
  });

  app.post('/api/tools/subtitles/generate-from-upload', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '').trim();
    if (!uploadId) {
      res.status(400).json({ error: 'Missing uploadId.' });
      return;
    }
    try {
      const uploaded = await finalizeUploadSession(uploadId);
      const maxWordsRaw = Number(req.body?.maxWordsPerCue || 9);
      const maxWordsPerCue = Number.isFinite(maxWordsRaw)
        ? Math.max(3, Math.min(20, Math.round(maxWordsRaw)))
        : 9;
      const language =
        typeof req.body?.language === 'string' && req.body.language.trim()
          ? req.body.language.trim()
          : 'auto';
      const identifySpeakers = Boolean(req.body?.identifySpeakers);

      const job = await startSubtitleGenerateJob({
        inputPath: uploaded.filePath,
        originalName: uploaded.filename || 'media_file',
        inputBytes: uploaded.fileSizeBytes,
        mimeType: uploaded.mimeType || 'application/octet-stream',
        language,
        maxWordsPerCue,
        identifySpeakers,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/subtitles/render', async (req, res) => {
    try {
      const cues = Array.isArray(req.body?.cues) ? (req.body.cues as SubtitleCue[]) : [];
      if (cues.length === 0) {
        res.status(400).json({ error: 'No subtitle cues provided to render.' });
        return;
      }
      const styleConfig = req.body?.styleConfig as SubtitleStyleConfig;
      if (!styleConfig || !styleConfig.templateId) {
        res.status(400).json({ error: 'Missing subtitle template styleConfig.' });
        return;
      }

      const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
      const sourceToolJobId =
        typeof req.body?.sourceToolJobId === 'string' ? req.body.sourceToolJobId.trim() : '';

      let inputPath: string | undefined;
      let originalName: string | undefined;
      if (uploadId) {
        const finalized = await finalizeUploadSession(uploadId);
        inputPath = finalized.filePath;
        originalName = finalized.filename;
      }

      const job = await startSubtitleRenderJob({
        sourceToolJobId: sourceToolJobId || undefined,
        inputPath,
        originalName,
        cues,
        styleConfig,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/clips/analyze-from-upload', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '').trim();
    if (!uploadId) {
      res.status(400).json({ error: 'Missing uploadId.' });
      return;
    }
    try {
      const uploaded = await finalizeUploadSession(uploadId);
      const maxClipsRaw = Number(req.body?.maxClips || 5);
      const maxClips = Number.isFinite(maxClipsRaw)
        ? Math.max(1, Math.min(8, Math.round(maxClipsRaw)))
        : 5;
      const minClipRaw = Number(req.body?.minClipSec || 22);
      const minClipSec = Number.isFinite(minClipRaw)
        ? Math.max(12, Math.min(60, Math.round(minClipRaw)))
        : 22;
      const maxClipRaw = Number(req.body?.maxClipSec || 65);
      const maxClipSec = Number.isFinite(maxClipRaw)
        ? Math.max(minClipSec + 8, Math.min(120, Math.round(maxClipRaw)))
        : 65;
      const maxWordsRaw = Number(req.body?.maxWordsPerCue || 7);
      const maxWordsPerCue = Number.isFinite(maxWordsRaw)
        ? Math.max(3, Math.min(16, Math.round(maxWordsRaw)))
        : 7;
      const language =
        typeof req.body?.language === 'string' && req.body.language.trim()
          ? req.body.language.trim()
          : 'auto';
      const identifySpeakers = Boolean(req.body?.identifySpeakers);
      const existingSegments = Array.isArray(req.body?.existingSegments)
        ? (req.body.existingSegments as TranscriptSegment[])
        : undefined;

      const job = await startAutoClipsAnalyzeJob({
        inputPath: uploaded.filePath,
        originalName: uploaded.filename || 'video_file',
        inputBytes: uploaded.fileSizeBytes,
        mimeType: uploaded.mimeType || 'video/mp4',
        language,
        maxClips,
        minClipSec,
        maxClipSec,
        maxWordsPerCue,
        identifySpeakers,
        existingSegments,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.post('/api/tools/clips/render', async (req, res) => {
    try {
      const startSec = Number(req.body?.startSec);
      const endSec = Number(req.body?.endSec);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec + 1) {
        res.status(400).json({ error: 'Invalid clip start/end timestamps.' });
        return;
      }

      const styleConfig = req.body?.styleConfig as SubtitleStyleConfig;
      if (!styleConfig || !styleConfig.templateId) {
        res.status(400).json({ error: 'Missing subtitle template styleConfig.' });
        return;
      }

      const aspectRatio: ClipAspectRatio = ['9:16', '16:9', '1:1'].includes(req.body?.aspectRatio)
        ? (req.body.aspectRatio as ClipAspectRatio)
        : '9:16';
      const framingMode: ClipFramingMode =
        req.body?.framingMode === 'center-crop' ? 'center-crop' : 'blurred-fit';
      const showTopTitle = req.body?.showTopTitle !== false;
      const titleStyle: ClipTitleStyle = ['banner', 'minimal', 'off'].includes(req.body?.titleStyle)
        ? (req.body.titleStyle as ClipTitleStyle)
        : 'banner';
      const clipTitle =
        typeof req.body?.clipTitle === 'string' && req.body.clipTitle.trim()
          ? req.body.clipTitle.trim()
          : 'Highlight Clip';
      const cues = Array.isArray(req.body?.cues) ? (req.body.cues as SubtitleCue[]) : [];

      const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
      const sourceToolJobId =
        typeof req.body?.sourceToolJobId === 'string' ? req.body.sourceToolJobId.trim() : '';

      let inputPath: string | undefined;
      let originalName: string | undefined;
      if (uploadId) {
        const finalized = await finalizeUploadSession(uploadId);
        inputPath = finalized.filePath;
        originalName = finalized.filename;
      }

      const job = await startAutoClipRenderJob({
        sourceToolJobId: sourceToolJobId || undefined,
        inputPath,
        originalName,
        clipTitle,
        startSec,
        endSec,
        cues,
        aspectRatio,
        framingMode,
        showTopTitle,
        titleStyle,
        styleConfig,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(400).json({ error: formatApiError(err) });
    }
  });

  app.get('/api/tools/jobs/:jobId/source', (req, res) => {
    const src = getToolJobSourceFile(req.params.jobId);
    if (!src) {
      res.status(404).json({ error: 'Source file is not cached on server.' });
      return;
    }
    streamFileWithRange(req, res, src.filePath, src.mimeType);
  });

  app.post('/api/tools/jobs/:jobId/transcribe', async (req, res) => {
    const fileInfo = getToolJobFile(req.params.jobId);
    if (!fileInfo) {
      res.status(404).json({ error: 'Processed file is no longer available to transcribe.' });
      return;
    }

    try {
      const jobId = crypto.randomUUID();
      const ext = path.extname(fileInfo.filePath) || '.bin';
      const destPath = path.join(UPLOAD_DIR, `${jobId}${ext}`);
      await fs.promises.copyFile(fileInfo.filePath, destPath);
      const stat = await fs.promises.stat(destPath);
      const sourceKind = fileInfo.mimeType.startsWith('audio/') ? 'audio' : 'video';
      const options = parseOptions(req.body?.options);

      const job = await createFileTranscriptionJob({
        jobId,
        title: fileInfo.title || fileInfo.filename,
        sourceKind,
        filePath: destPath,
        fileSizeBytes: stat.size,
        mimeType: fileInfo.mimeType,
        options,
      });
      res.status(202).json(job);
    } catch (err) {
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!err) {
        next();
        return;
      }
      const message = err instanceof Error ? err.message : 'Request failed.';
      res.status(400).json({ error: message });
    },
  );

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*path', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = app.listen(port, '0.0.0.0', () => {
    const status = providerStatus();
    console.log(`Hanzx Studio running at http://0.0.0.0:${port}`);
    console.log(
      `AI provider: ${status.provider}${status.provider === 'groq' ? ' (free)' : ''} — Groq key: ${status.groqConfigured ? 'yes' : 'no'}, Gemini key: ${status.geminiConfigured ? 'yes' : 'no'}`,
    );
    if (!status.groqConfigured && !status.geminiConfigured) {
      console.log('No AI key found. Add a free Groq key in the app: Media Tools > Auto Clips > Add API Key > Groq (Free), or put GROQ_API_KEY in .env.local.');
    }
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`Port ${port} pehle se use ho raha hai — purana server abhi bhi chal raha hai.`);
      console.error('Fix: purani terminal mein Ctrl + C dabao (ya us terminal ko band karo), phir run.bat dobara chalao.');
      console.error(`Port ${port} is already in use — an old server is still running. Stop it first (Ctrl+C in its terminal), then run run.bat again.`);
      process.exit(1);
    }
    throw err;
  });
  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
