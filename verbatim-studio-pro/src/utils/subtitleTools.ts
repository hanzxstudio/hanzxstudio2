import type { TranscriptSegment } from '../types/transcription';

function parseTimecodeToSec(raw: string): number {
  const clean = raw.trim().replace(',', '.');
  const parts = clean.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Parses SRT, WebVTT, or `[MM:SS] text` lines into structured TranscriptSegment items.
 */
export function parseSubtitleOrTranscriptText(raw: string): TranscriptSegment[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;

    // Look for SRT / VTT cue line: 00:00:01,000 --> 00:00:04,000
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx !== -1) {
      const [startRaw, endRawPart] = lines[arrowIdx].split('-->');
      const endRaw = (endRawPart || '').trim().split(/\s+/)[0] || '';
      const startSec = parseTimecodeToSec(startRaw);
      const endSec = Math.max(startSec + 1, parseTimecodeToSec(endRaw));
      const text = lines
        .slice(arrowIdx + 1)
        .join(' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        segments.push({
          id: `sub_${segments.length}`,
          startSec,
          endSec,
          text,
        });
      }
      continue;
    }

    // Fallback: line-by-line `[MM:SS]` or `[HH:MM:SS]` parsing
    for (const line of lines) {
      const m = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/);
      if (m) {
        const startSec = parseTimecodeToSec(m[1]);
        const text = m[2].replace(/<[^>]+>/g, '').trim();
        if (text) {
          segments.push({
            id: `sub_${segments.length}`,
            startSec,
            endSec: startSec + 4,
            text,
          });
        }
      }
    }
  }

  return segments;
}

export function shiftSegmentTimestamps(
  segments: TranscriptSegment[],
  offsetSeconds: number,
): TranscriptSegment[] {
  if (!offsetSeconds) return segments;
  return segments.map((s) => {
    const nextStart = Math.max(0, Math.round((s.startSec + offsetSeconds) * 10) / 10);
    const dur = Math.max(1, s.endSec - s.startSec);
    return {
      ...s,
      startSec: nextStart,
      endSec: Math.round((nextStart + dur) * 10) / 10,
    };
  });
}
