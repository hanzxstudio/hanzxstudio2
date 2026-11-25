import type { TranscriptSegment, TranscriptionJob } from '../types/transcription';
import { formatDuration, formatSrtTime, formatVttTime } from './formatters';

export interface TranscriptParagraph {
  id: string;
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
  segmentIds: string[];
}

export interface ParagraphGroupingOptions {
  maxGapSec?: number;
  maxDurationSec?: number;
  maxChars?: number;
}

const SENTENCE_END_RE = /[.!?؟।。]["'”’)\]]*$/;

function parseClockToSeconds(raw: string): number {
  const parts = raw.split(':').map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function splitSentencesUniversal(text: string): string[] {
  const matches = text.match(/[^.!?؟۔।。]+(?:[.!?؟۔।。]+["'”’)\]]*)?/g);
  if (!matches) return [text.trim()].filter(Boolean);
  return matches.map((s) => s.trim()).filter(Boolean);
}

function sanitizeClientSpeakerLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  let cleaned = raw.replace(/[\[\]*:]/g, '').replace(/[,\-.\s]+$/g, '').trim();
  if (!cleaned || cleaned.length > 36) return undefined;
  if (/^\d+(?:[.:]\d+)*$/.test(cleaned)) return undefined;
  if (/^speaker\s+\d+\.\d+/i.test(cleaned)) return undefined;
  if (/^speaker\s+\d{3,}/i.test(cleaned)) return undefined;
  if (/^\d{1,2}$/.test(cleaned)) cleaned = `Speaker ${cleaned}`;
  return cleaned;
}

/**
 * Cleans up transcripts (including previously saved long jobs) by:
 * 1) Extracting any literal inline `[MM:SS]` timestamps into separate timestamped segments.
 * 2) Subdividing any mega-segment (>440 chars or >50s span) along sentence boundaries with proportional timestamps.
 * 3) Stripping malformed numeric speaker noise (e.g. "Speaker 329.83,") and de-stacking identical chunk-boundary timestamp runs.
 */
export function normalizeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length === 0) return [];

  const result: TranscriptSegment[] = [];
  const inlineMarkerRe = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*(?:([A-Za-z0-9 _.-]{1,28}):\s*)?/g;

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const clean = seg.text.trim().replace(/\s+/g, ' ');
    if (!clean) continue;

    const cleanSpeaker = sanitizeClientSpeakerLabel(seg.speaker);
    const nextSegStart =
      sIdx < segments.length - 1 ? segments[sIdx + 1].startSec : seg.endSec;
    const effectiveEnd = Math.max(seg.startSec + 2, seg.endSec, nextSegStart);
    const segSpan = Math.max(2, effectiveEnd - seg.startSec);

    const matches = Array.from(clean.matchAll(inlineMarkerRe));
    const stageOne: TranscriptSegment[] = [];

    if (matches.length === 0) {
      stageOne.push({ ...seg, speaker: cleanSpeaker, endSec: effectiveEnd, text: clean });
    } else {
      let lastEnd = 0;
      let curStart = seg.startSec;
      let curSpeaker = cleanSpeaker;
      const pieces: Array<{ startSec: number; speaker?: string; text: string }> = [];

      for (const m of matches) {
        const idx = m.index ?? 0;
        const before = clean.slice(lastEnd, idx).trim();
        if (before) {
          pieces.push({ startSec: curStart, speaker: curSpeaker, text: before });
        }

        const parsedSec = parseClockToSeconds(m[1]);
        if (parsedSec >= seg.startSec && parsedSec <= effectiveEnd + 15) {
          curStart = Math.round(parsedSec);
        } else if (parsedSec <= segSpan + 15) {
          curStart = Math.min(effectiveEnd, Math.round(seg.startSec + parsedSec));
        } else {
          curStart = Math.min(effectiveEnd, curStart + 15);
        }

        if (m[2]) {
          const parsedSpeaker = sanitizeClientSpeakerLabel(m[2]);
          if (parsedSpeaker) curSpeaker = parsedSpeaker;
        }
        lastEnd = idx + m[0].length;
      }

      const tail = clean.slice(lastEnd).trim();
      if (tail) {
        pieces.push({ startSec: curStart, speaker: curSpeaker, text: tail });
      }

      for (let i = 0; i < pieces.length; i++) {
        const pieceEnd =
          i < pieces.length - 1
            ? Math.max(pieces[i].startSec + 1, pieces[i + 1].startSec)
            : Math.max(pieces[i].startSec + 2, effectiveEnd);
        stageOne.push({
          id: `${seg.id}_m${i}`,
          startSec: pieces[i].startSec,
          endSec: pieceEnd,
          speaker: pieces[i].speaker,
          text: pieces[i].text,
        });
      }
    }

    for (const part of stageOne) {
      const spanSec = Math.max(2, part.endSec - part.startSec);
      if (part.text.length <= 440 && (spanSec <= 50 || part.text.length <= 240)) {
        result.push(part);
        continue;
      }

      const sentences = splitSentencesUniversal(part.text);
      const groups: string[] = [];
      let buf = '';
      const targetLen = 300;

      for (const sentence of sentences) {
        if (buf && (buf + ' ' + sentence).length > targetLen) {
          groups.push(buf.trim());
          buf = sentence;
        } else {
          buf = buf ? `${buf} ${sentence}` : sentence;
        }
      }
      if (buf.trim()) groups.push(buf.trim());

      if (groups.length === 1 && groups[0].length > 440) {
        const words = groups[0].split(/\s+/);
        groups.length = 0;
        for (let w = 0; w < words.length; w += 52) {
          groups.push(words.slice(w, w + 52).join(' '));
        }
      }

      if (groups.length <= 1) {
        result.push(part);
        continue;
      }

      const totalChars = groups.reduce((acc, g) => acc + g.length, 0) || 1;
      let cursorSec = part.startSec;

      for (let gIdx = 0; gIdx < groups.length; gIdx++) {
        const text = groups[gIdx];
        const frac = text.length / totalChars;
        const gStart = Math.round(cursorSec);
        cursorSec += spanSec * frac;
        const gEnd =
          gIdx === groups.length - 1
            ? Math.max(gStart + 1, part.endSec)
            : Math.max(gStart + 1, Math.round(cursorSec));
        result.push({
          id: `${part.id}_s${gIdx}`,
          startSec: gStart,
          endSec: gEnd,
          speaker: part.speaker,
          text,
        });
      }
    }
  }

  // De-stack runs of 3+ consecutive segments stuck on identical timestamps (e.g., [08:00], [32:00] boundary stacks)
  let i = 0;
  while (i < result.length) {
    let j = i + 1;
    while (j < result.length && result[j].startSec === result[i].startSec) {
      j += 1;
    }
    const runLen = j - i;
    if (runLen >= 3) {
      const prevStart = i > 0 ? result[i - 1].startSec : Math.max(0, result[i].startSec - runLen * 6);
      const nextCap =
        j < result.length
          ? Math.max(prevStart + 1, result[j].startSec - 1)
          : result[i].startSec + Math.max(runLen * 4, Math.min(180, runLen * 8));
      const winStart = Math.min(result[i].startSec, prevStart + 2);
      const winEnd = Math.max(winStart + 1, nextCap);
      const span = Math.max(1, winEnd - winStart);
      const totalChars =
        result.slice(i, j).reduce((acc, s) => acc + Math.max(8, s.text.length), 0) || 1;

      let cursor = winStart;
      for (let k = i; k < j; k++) {
        result[k].startSec = Math.max(prevStart, Math.min(nextCap, Math.round(cursor)));
        cursor += (Math.max(8, result[k].text.length) / totalChars) * span;
      }
    }
    i = j;
  }

  for (let k = 0; k < result.length; k++) {
    if (k < result.length - 1) {
      result[k].endSec = Math.max(result[k].startSec + 1, result[k + 1].startSec);
    } else {
      result[k].endSec = Math.max(result[k].startSec + 2, result[k].endSec);
    }
  }

  return result;
}

export function groupSegmentsIntoParagraphs(
  segments: TranscriptSegment[],
  options: ParagraphGroupingOptions = {},
): TranscriptParagraph[] {
  const cleanSegments = normalizeTranscriptSegments(segments);
  if (cleanSegments.length === 0) return [];

  const maxGapSec = options.maxGapSec ?? 5;
  const maxDurationSec = options.maxDurationSec ?? 55;
  const maxChars = options.maxChars ?? 520;

  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;
  let prevEndSec = 0;

  for (const seg of cleanSegments) {
    const cleanText = seg.text.trim().replace(/\s+/g, ' ');
    if (!cleanText) continue;

    const segSpeaker = seg.speaker?.trim() || undefined;

    if (!current) {
      current = {
        id: `para_${seg.id}`,
        startSec: seg.startSec,
        endSec: Math.max(seg.startSec, seg.endSec),
        speaker: segSpeaker,
        text: cleanText,
        segmentIds: [seg.id],
      };
      prevEndSec = current.endSec;
      continue;
    }

    const gap = seg.startSec - prevEndSec;
    const speakerChanged =
      Boolean(segSpeaker || current.speaker) && segSpeaker !== current.speaker;
    const currentDuration = seg.startSec - current.startSec;
    const projectedLength = current.text.length + 1 + cleanText.length;
    const endedSentence = SENTENCE_END_RE.test(current.text);

    const shouldBreak =
      speakerChanged ||
      gap > maxGapSec ||
      (currentDuration >= maxDurationSec && endedSentence) ||
      currentDuration >= maxDurationSec * 1.45 ||
      (projectedLength > maxChars && endedSentence) ||
      projectedLength > maxChars * 1.4;

    if (shouldBreak) {
      paragraphs.push(current);
      current = {
        id: `para_${seg.id}`,
        startSec: seg.startSec,
        endSec: Math.max(seg.startSec, seg.endSec),
        speaker: segSpeaker,
        text: cleanText,
        segmentIds: [seg.id],
      };
    } else {
      current.text = `${current.text} ${cleanText}`;
      current.endSec = Math.max(current.endSec, seg.endSec, seg.startSec);
      current.segmentIds.push(seg.id);
    }

    prevEndSec = Math.max(seg.endSec, seg.startSec);
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

export function toParagraphText(
  segments: TranscriptSegment[],
  includeTimestamps = true,
  includeSpeakers = true,
): string {
  const paragraphs = groupSegmentsIntoParagraphs(segments);
  return paragraphs
    .map((p) => {
      const ts = includeTimestamps ? `[${formatDuration(p.startSec)}] ` : '';
      const sp = includeSpeakers && p.speaker ? `${p.speaker}: ` : '';
      return `${ts}${sp}${p.text}`;
    })
    .join('\n\n');
}

export function toPlainText(
  segments: TranscriptSegment[],
  includeTimestamps = true,
  includeSpeakers = true,
): string {
  const cleanSegments = normalizeTranscriptSegments(segments);
  if (!includeTimestamps && !includeSpeakers) {
    return cleanSegments.map((s) => s.text.trim()).join(' ');
  }
  return cleanSegments
    .map((s) => {
      const ts = includeTimestamps ? `[${formatDuration(s.startSec)}] ` : '';
      const sp = includeSpeakers && s.speaker ? `${s.speaker}: ` : '';
      return `${ts}${sp}${s.text.trim()}`;
    })
    .join('\n');
}

export function toSRT(segments: TranscriptSegment[]): string {
  const cleanSegments = normalizeTranscriptSegments(segments);
  return cleanSegments
    .map((seg, idx) => {
      const start = formatSrtTime(seg.startSec);
      const end = formatSrtTime(Math.max(seg.startSec + 1, seg.endSec));
      const line = seg.speaker ? `${seg.speaker}: ${seg.text.trim()}` : seg.text.trim();
      return `${idx + 1}\n${start} --> ${end}\n${line}`;
    })
    .join('\n\n');
}

export function toVTT(segments: TranscriptSegment[]): string {
  const cleanSegments = normalizeTranscriptSegments(segments);
  const body = cleanSegments
    .map((seg) => {
      const start = formatVttTime(seg.startSec);
      const end = formatVttTime(Math.max(seg.startSec + 1, seg.endSec));
      const line = seg.speaker ? `${seg.speaker}: ${seg.text.trim()}` : seg.text.trim();
      return `${start} --> ${end}\n${line}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

export function toMarkdown(job: TranscriptionJob): string {
  const lines: string[] = [];
  lines.push(`# ${job.title}`);
  lines.push('');
  lines.push(
    `Source: ${job.sourceKind.toUpperCase()} · Duration: ${formatDuration(job.durationSeconds)} · Segments: ${job.segments.length}`,
  );
  lines.push('');

  if (job.analysis) {
    lines.push('## Summary');
    lines.push('');
    lines.push(job.analysis.summary);
    lines.push('');

    if (job.analysis.keyPoints.length > 0) {
      lines.push('## Key Points');
      lines.push('');
      for (const kp of job.analysis.keyPoints) {
        lines.push(`- ${kp}`);
      }
      lines.push('');
    }

    if (job.analysis.actionItems.length > 0) {
      lines.push('## Action Items');
      lines.push('');
      for (const item of job.analysis.actionItems) {
        lines.push(`- [ ] ${item}`);
      }
      lines.push('');
    }

    if (job.analysis.chapters.length > 0) {
      lines.push('## Chapters');
      lines.push('');
      for (const ch of job.analysis.chapters) {
        lines.push(`- **${formatDuration(ch.startSec)} — ${ch.title}**: ${ch.summary}`);
      }
      lines.push('');
    }
  }

  lines.push('## Full Transcript');
  lines.push('');
  for (const seg of normalizeTranscriptSegments(job.segments)) {
    const sp = seg.speaker ? `**${seg.speaker}:** ` : '';
    lines.push(`- \`${formatDuration(seg.startSec)}\` ${sp}${seg.text.trim()}`);
  }

  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toWordDocumentHtml(job: TranscriptionJob): string {
  const paragraphs = groupSegmentsIntoParagraphs(job.segments);
  const analysisHtml = job.analysis
    ? `
      <div class="box">
        <h2>Executive Summary</h2>
        <p dir="auto">${escapeHtml(job.analysis.summary)}</p>
        ${
          job.analysis.keyPoints.length > 0
            ? `<h3>Key Points</h3><ul>${job.analysis.keyPoints
                .map((kp) => `<li dir="auto">${escapeHtml(kp)}</li>`)
                .join('')}</ul>`
            : ''
        }
        ${
          job.analysis.chapters.length > 0
            ? `<h3>Chapters</h3><ul>${job.analysis.chapters
                .map(
                  (ch) =>
                    `<li dir="auto"><strong>[${formatDuration(ch.startSec)}] ${escapeHtml(
                      ch.title,
                    )}:</strong> ${escapeHtml(ch.summary)}</li>`,
                )
                .join('')}</ul>`
            : ''
        }
      </div>
    `
    : '';

  const bodyRows = paragraphs
    .map((p) => {
      const sp = p.speaker ? `<strong>${escapeHtml(p.speaker)}:</strong> ` : '';
      return `
        <tr>
          <td class="ts">[${formatDuration(p.startSec)}]</td>
          <td class="txt" dir="auto">${sp}${escapeHtml(p.text)}</td>
        </tr>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(job.title)}</title>
<style>
  body { font-family: 'Segoe UI', 'Noto Nastaliq Urdu', Arial, sans-serif; color: #0F172A; line-height: 1.65; margin: 36px; }
  h1 { font-size: 20pt; margin: 0 0 6px 0; color: #0F172A; }
  .meta { font-size: 9.5pt; color: #475569; border-bottom: 1px solid #CBD5E1; padding-bottom: 10px; margin-bottom: 18px; }
  .box { background: #F8FAFC; border: 1px solid #E2E8F0; padding: 14px 18px; margin-bottom: 22px; }
  h2 { font-size: 13pt; margin: 0 0 8px 0; color: #1E293B; }
  h3 { font-size: 11pt; margin: 12px 0 6px 0; color: #1E293B; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 8px 6px; border-bottom: 1px solid #F1F5F9; font-size: 10.5pt; }
  td.ts { width: 78px; font-family: Consolas, monospace; font-size: 9.5pt; color: #2563EB; white-space: nowrap; }
  td.txt { color: #1E293B; }
</style>
</head>
<body>
  <h1>${escapeHtml(job.title)}</h1>
  <div class="meta">Source: ${escapeHtml(job.sourceKind.toUpperCase())} &middot; Duration: ${formatDuration(
    job.durationSeconds,
  )} &middot; Paragraphs: ${paragraphs.length}</div>
  ${analysisHtml}
  <h2>Full Transcript</h2>
  <table>${bodyRows}</table>
</body>
</html>`;
}

export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeBaseFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'transcript'
  );
}
