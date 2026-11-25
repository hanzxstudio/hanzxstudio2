import { Ytdl } from '@distube/ytdl-core';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Innertube, Log } from 'youtubei.js';
import type { TranscriptSegment, YouTubeInfo } from '../src/types/transcription.ts';

try {
  Log.setLevel(Log.Level.NONE);
} catch {
  // Ignore if Log API differs
}

let innertubeInstance: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create({
      retrieve_player: true,
    });
  }
  return innertubeInstance;
}

export function extractYouTubeId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtube-nocookie.com'
    ) {
      const v = parsed.searchParams.get('v');
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (['shorts', 'live', 'embed', 'v'].includes(parts[0] || '') && parts[1]) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function fetchYouTubeInfo(urlOrId: string): Promise<YouTubeInfo> {
  const videoId = extractYouTubeId(urlOrId);
  if (!videoId) {
    throw new Error('Please enter a valid YouTube video URL (youtube.com/watch?v=... or youtu.be/...).');
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const fallbackThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  // Fast oEmbed lookup (~150ms, immune to player bot-checks)
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
  const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    throw new Error('Could not retrieve details for this YouTube video. Verify the link is public.');
  }
  const data = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };

  return {
    videoId,
    url: canonicalUrl,
    title: data.title || `YouTube Video (${videoId})`,
    author: data.author_name || 'YouTube Channel',
    durationSeconds: 0,
    thumbnailUrl: data.thumbnail_url || fallbackThumb,
  };
}

export async function downloadYouTubeAudio(videoId: string, outputPath: string): Promise<void> {
  // Primary: youtubei.js audio stream
  try {
    const yt = await getInnertube();
    const stream = await yt.download(videoId, {
      type: 'audio',
      quality: 'bestefficiency',
    });
    const nodeStream = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(nodeStream, fs.createWriteStream(outputPath));
    const stat = await fs.promises.stat(outputPath);
    if (stat.size > 4096) {
      return;
    }
  } catch {
    // Continue to ytdl-core fallback
  }

  // Secondary: @distube/ytdl-core audio stream
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const ytdl = new Ytdl();
  await new Promise<void>((resolve, reject) => {
    const audioStream = ytdl.download(url, {
      filter: { hasAudio: true, hasVideo: false },
      quality: 'lowestaudio',
    });
    const fileStream = fs.createWriteStream(outputPath);
    audioStream.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', () => resolve());
    audioStream.pipe(fileStream);
  });

  const stat = await fs.promises.stat(outputPath);
  if (stat.size <= 4096) {
    throw new Error('Downloaded YouTube audio stream was empty.');
  }
}

export async function fetchYouTubeCaptions(videoId: string): Promise<TranscriptSegment[]> {
  const yt = await getInnertube();
  const info = await yt.getInfo(videoId);
  const transcriptData = await info.getTranscript();

  const rawSegments =
    (
      transcriptData as unknown as {
        transcript?: {
          content?: {
            body?: {
              initial_segments?: Array<{
                start_ms?: string | number;
                end_ms?: string | number;
                snippet?: { text?: string; toString?: () => string };
              }>;
            };
          };
        };
      }
    )?.transcript?.content?.body?.initial_segments || [];

  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const item = rawSegments[i];
    const startMs = Number(item.start_ms || 0);
    const endMs = Number(item.end_ms || startMs + 4000);
    const text = (item.snippet?.text || item.snippet?.toString?.() || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    segments.push({
      id: `ytcap_${i}`,
      startSec: Math.round(startMs / 1000),
      endSec: Math.max(Math.round(startMs / 1000) + 1, Math.round(endMs / 1000)),
      text,
    });
  }

  return segments;
}
