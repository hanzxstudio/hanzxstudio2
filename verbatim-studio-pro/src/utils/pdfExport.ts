import { jsPDF } from 'jspdf';
import type { TranscriptionJob } from '../types/transcription';
import {
  groupSegmentsIntoParagraphs,
  normalizeTranscriptSegments,
  safeBaseFilename,
} from './exporters';
import { formatBytes, formatDateShort, formatDuration, getWordCount } from './formatters';

export interface PdfExportOptions {
  layout: 'paragraphs' | 'timeline';
  includeTimestamps: boolean;
  includeSpeakers: boolean;
  includeAnalysis: boolean;
  pageSize: 'a4' | 'letter';
}

export const DEFAULT_PDF_OPTIONS: PdfExportOptions = {
  layout: 'paragraphs',
  includeTimestamps: true,
  includeSpeakers: true,
  includeAnalysis: true,
  pageSize: 'a4',
};

const NON_LATIN_SCRIPT_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u0D7F\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF]/;

const RTL_TEXT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0590-\u05FF]/;

function sanitizeLatinPdfText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25CF\u25AA]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');
}

function hasNonLatinScript(job: TranscriptionJob): boolean {
  if (NON_LATIN_SCRIPT_RE.test(job.title)) return true;
  if (job.analysis) {
    if (NON_LATIN_SCRIPT_RE.test(job.analysis.summary)) return true;
    if (job.analysis.keyPoints.some((p) => NON_LATIN_SCRIPT_RE.test(p))) return true;
    if (job.analysis.actionItems.some((a) => NON_LATIN_SCRIPT_RE.test(a))) return true;
    if (
      job.analysis.chapters.some(
        (c) => NON_LATIN_SCRIPT_RE.test(c.title) || NON_LATIN_SCRIPT_RE.test(c.summary),
      )
    ) {
      return true;
    }
  }
  return job.segments.some(
    (s) => NON_LATIN_SCRIPT_RE.test(s.text) || (s.speaker ? NON_LATIN_SCRIPT_RE.test(s.speaker) : false),
  );
}

interface PrintableEntry {
  startSec: number;
  speaker?: string;
  text: string;
}

function buildPrintableEntries(
  job: TranscriptionJob,
  options: PdfExportOptions,
): PrintableEntry[] {
  const cleanSegments = normalizeTranscriptSegments(job.segments);
  if (options.layout === 'paragraphs') {
    return groupSegmentsIntoParagraphs(cleanSegments).map((p) => ({
      startSec: p.startSec,
      speaker: options.includeSpeakers ? p.speaker : undefined,
      text: p.text,
    }));
  }
  return cleanSegments
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({
      startSec: s.startSec,
      speaker: options.includeSpeakers ? s.speaker : undefined,
      text: s.text.trim(),
    }));
}

function resolveMetadataLanguageLabel(job: TranscriptionJob): string | undefined {
  const optLang = job.options?.language;
  if (optLang && optLang !== 'auto') {
    if (optLang === 'Urdu (Pure Nastaliq Script)' || optLang === 'Urdu (اردو)') return 'Urdu';
    if (optLang === 'Urdu + English (Bilingual)') return 'Urdu + English';
    if (optLang === 'Roman Urdu (Latin Script)' || optLang === 'Roman Urdu / Hinglish') {
      return 'Roman Urdu';
    }
    return optLang;
  }
  const detected = job.analysis?.detectedLanguage?.trim();
  const hasUrduSegs = job.segments.some((s) => /[\u0600-\u06FF]/.test(s.text));
  if (hasUrduSegs && (!detected || /^english$/i.test(detected))) {
    return 'Urdu + English';
  }
  return detected;
}

function buildMetadataSummary(job: TranscriptionJob, wordCount: number): string[] {
  const parts: string[] = [
    `Source: ${job.sourceKind === 'youtube' ? 'YouTube' : job.sourceKind.toUpperCase()}`,
  ];
  if (job.durationSeconds > 0) {
    parts.push(`Duration: ${formatDuration(job.durationSeconds)}`);
  }
  if (job.fileSizeBytes) {
    parts.push(`Size: ${formatBytes(job.fileSizeBytes)}`);
  }
  if (wordCount > 0) {
    parts.push(`Words: ${wordCount.toLocaleString()}`);
    const readingMins = Math.max(1, Math.round(wordCount / 200));
    parts.push(`~${readingMins} min read`);
  }
  const langLabel = resolveMetadataLanguageLabel(job);
  if (langLabel) {
    parts.push(`Language: ${langLabel}`);
  }
  parts.push(`Exported: ${formatDateShort(Date.now())}`);
  return parts;
}

function buildVectorPdf(job: TranscriptionJob, options: PdfExportOptions): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: options.pageSize,
    compress: true,
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 16;
  const topMargin = 18;
  const bottomMargin = 17;
  const contentWidth = pageWidth - marginX * 2;
  const maxY = pageHeight - bottomMargin;

  const wordCount = getWordCount(job.segments.map((s) => s.text));
  const cleanTitle = sanitizeLatinPdfText(job.title) || 'Transcript Document';

  let y = topMargin;

  const drawRunningHeader = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    const shortTitle =
      cleanTitle.length > 72 ? `${cleanTitle.slice(0, 69)}...` : cleanTitle;
    doc.text(shortTitle, marginX, 11);
    doc.text('HANZX STUDIO', pageWidth - marginX, 11, { align: 'right' });
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.25);
    doc.line(marginX, 13.5, pageWidth - marginX, 13.5);
  };

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > maxY) {
      doc.addPage();
      drawRunningHeader();
      y = topMargin + 2;
    }
  };

  // Document Eyebrow
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(37, 99, 235);
  doc.text('HANZX STUDIO  |  TRANSCRIPT DOCUMENT', marginX, y);
  y += 6;

  // Document Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(15, 23, 42);
  const titleLines = doc.splitTextToSize(cleanTitle, contentWidth) as string[];
  for (const line of titleLines) {
    ensureSpace(7);
    doc.text(line, marginX, y);
    y += 7;
  }

  // Metadata Strip
  y += 0.5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  const metaString = sanitizeLatinPdfText(buildMetadataSummary(job, wordCount).join('  ·  '));
  const metaLines = doc.splitTextToSize(metaString, contentWidth) as string[];
  for (const mLine of metaLines) {
    ensureSpace(4.5);
    doc.text(mLine, marginX, y);
    y += 4.3;
  }

  y += 2;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.4);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 7;

  // Optional Analysis Section (Summary, Key Points, Action Items, Chapters)
  if (options.includeAnalysis && job.analysis) {
    const analysis = job.analysis;

    // Executive Summary
    if (analysis.summary.trim()) {
      ensureSpace(16);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text('Executive Summary', marginX, y);
      y += 5.5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.8);
      doc.setTextColor(30, 41, 59);
      const summaryLines = doc.splitTextToSize(
        sanitizeLatinPdfText(analysis.summary.trim()),
        contentWidth,
      ) as string[];
      for (const sLine of summaryLines) {
        ensureSpace(4.8);
        doc.text(sLine, marginX, y);
        y += 4.7;
      }
      y += 4;
    }

    // Key Takeaways
    if (analysis.keyPoints.length > 0) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('Key Points', marginX, y);
      y += 5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(51, 65, 85);
      for (const kp of analysis.keyPoints) {
        const lines = doc.splitTextToSize(
          sanitizeLatinPdfText(kp.trim()),
          contentWidth - 6,
        ) as string[];
        ensureSpace(lines.length * 4.5 + 1.5);
        lines.forEach((line, idx) => {
          if (idx === 0) {
            doc.text('-', marginX + 1.5, y);
          }
          doc.text(line, marginX + 5.5, y);
          y += 4.4;
        });
        y += 0.8;
      }
      y += 3;
    }

    // Action Items
    if (analysis.actionItems.length > 0) {
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('Action Items', marginX, y);
      y += 5;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(51, 65, 85);
      for (const item of analysis.actionItems) {
        const lines = doc.splitTextToSize(
          sanitizeLatinPdfText(item.trim()),
          contentWidth - 8,
        ) as string[];
        ensureSpace(lines.length * 4.5 + 1.5);
        lines.forEach((line, idx) => {
          if (idx === 0) {
            doc.setFont('courier', 'bold');
            doc.text('[ ]', marginX + 0.5, y);
            doc.setFont('helvetica', 'normal');
          }
          doc.text(line, marginX + 8, y);
          y += 4.4;
        });
        y += 0.8;
      }
      y += 3;
    }

    // Timestamped Chapters
    if (analysis.chapters.length > 0) {
      ensureSpace(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(15, 23, 42);
      doc.text('Chapters', marginX, y);
      y += 5.5;

      const tsColWidth = 22;
      const bodyColX = marginX + tsColWidth + 3;
      const bodyColWidth = contentWidth - tsColWidth - 3;

      for (const ch of analysis.chapters) {
        const chTitle = sanitizeLatinPdfText(ch.title.trim());
        const chSummary = sanitizeLatinPdfText(ch.summary.trim());
        const titleWrapped = doc.splitTextToSize(chTitle, bodyColWidth) as string[];
        const summaryWrapped = chSummary
          ? (doc.splitTextToSize(chSummary, bodyColWidth) as string[])
          : [];
        const blockHeight = titleWrapped.length * 4.4 + summaryWrapped.length * 4.2 + 3.5;

        ensureSpace(Math.min(blockHeight, 26));

        doc.setFont('courier', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(37, 99, 235);
        doc.text(formatDuration(ch.startSec), marginX, y);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(15, 23, 42);
        for (const tLine of titleWrapped) {
          ensureSpace(4.5);
          doc.text(tLine, bodyColX, y);
          y += 4.3;
        }

        if (summaryWrapped.length > 0) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(71, 85, 105);
          for (const sLine of summaryWrapped) {
            ensureSpace(4.2);
            doc.text(sLine, bodyColX, y);
            y += 4.1;
          }
        }
        y += 2.5;
      }
      y += 2;
    }

    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 7;
  }

  // Transcript Heading
  ensureSpace(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  const modeLabel =
    options.layout === 'paragraphs' ? 'Full Transcript (Paragraphs)' : 'Full Transcript (Timeline)';
  doc.text(modeLabel, marginX, y);
  y += 6.5;

  const entries = buildPrintableEntries(job, options);
  const gutterWidth = options.includeTimestamps ? 22 : 0;
  const textX = options.includeTimestamps ? marginX + gutterWidth + 4 : marginX;
  const textWidth = contentWidth - (options.includeTimestamps ? gutterWidth + 4 : 0);
  const lineHeight = 5.0;

  for (const entry of entries) {
    const cleanBody = sanitizeLatinPdfText(entry.text);
    if (!cleanBody) continue;

    const cleanSpeaker = entry.speaker ? sanitizeLatinPdfText(entry.speaker) : undefined;
    const bodyLines = doc.splitTextToSize(cleanBody, textWidth) as string[];

    // Ensure timestamp + speaker + at least 2 body lines stay together on page
    const minNeeded =
      (cleanSpeaker ? 4.8 : 0) + Math.min(2, bodyLines.length) * lineHeight + 4;
    ensureSpace(minNeeded);

    const startBlockY = y;

    if (options.includeTimestamps) {
      doc.setFont('courier', 'bold');
      doc.setFontSize(8.8);
      doc.setTextColor(37, 99, 235);
      doc.text(`[${formatDuration(entry.startSec)}]`, marginX, y);

      // Subtle vertical separator beside timestamp gutter
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.2);
      const firstSpanHeight =
        (cleanSpeaker ? 4.6 : 0) + Math.min(bodyLines.length, 3) * lineHeight - 1.5;
      doc.line(
        marginX + gutterWidth + 1.2,
        startBlockY - 3,
        marginX + gutterWidth + 1.2,
        Math.min(maxY, startBlockY + Math.max(3, firstSpanHeight)),
      );
    }

    if (cleanSpeaker) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(cleanSpeaker, textX, y);
      y += 4.7;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(30, 41, 59);

    for (let i = 0; i < bodyLines.length; i++) {
      if (y + lineHeight > maxY) {
        doc.addPage();
        drawRunningHeader();
        y = topMargin + 2;

        // Re-apply body font after drawRunningHeader
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(30, 41, 59);
      }
      doc.text(bodyLines[i], textX, y);
      y += lineHeight;
    }

    y += options.layout === 'paragraphs' ? 3.8 : 2.6;
  }

  // Page numbering footer across all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.25);
    doc.line(marginX, pageHeight - 12.5, pageWidth - marginX, pageHeight - 12.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('Generated by Hanzx Studio', marginX, pageHeight - 8);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageHeight - 8, {
      align: 'right',
    });
  }

  return doc;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * High-DPI Canvas-to-PDF renderer for non-Latin scripts (Urdu, Arabic, Hindi, CJK)
 * where standard PDF Type1 Helvetica cannot shape RTL/Indic/Unicode glyphs.
 */
function buildUnicodeCanvasPdf(job: TranscriptionJob, options: PdfExportOptions): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: options.pageSize,
    compress: true,
  });

  const pageWidthMm = doc.internal.pageSize.getWidth();
  const pageHeightMm = doc.internal.pageSize.getHeight();
  const pxPerMm = 7; // ~178 DPI crisp output without excessive PDF size
  const canvasW = Math.round(pageWidthMm * pxPerMm);
  const canvasH = Math.round(pageHeightMm * pxPerMm);

  const marginX = Math.round(16 * pxPerMm);
  const topY = Math.round(18 * pxPerMm);
  const bottomLimit = canvasH - Math.round(17 * pxPerMm);
  const contentW = canvasW - marginX * 2;
  const wordCount = getWordCount(job.segments.map((s) => s.text));

  const pages: HTMLCanvasElement[] = [];

  const createPageCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);
    pages.push(canvas);
    return { canvas, ctx };
  };

  let { ctx } = createPageCanvas();
  let y = topY;

  const drawHeaderOnContinuation = () => {
    ctx.save();
    ctx.font = `500 ${Math.round(3.0 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'left';
    ctx.direction = 'ltr';
    const shortTitle = job.title.length > 64 ? `${job.title.slice(0, 61)}...` : job.title;
    ctx.fillText(shortTitle, marginX, Math.round(11 * pxPerMm));
    ctx.textAlign = 'right';
    ctx.fillText('HANZX STUDIO', canvasW - marginX, Math.round(11 * pxPerMm));
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(marginX, Math.round(13.5 * pxPerMm));
    ctx.lineTo(canvasW - marginX, Math.round(13.5 * pxPerMm));
    ctx.stroke();
    ctx.restore();
  };

  const nextPage = () => {
    ({ ctx } = createPageCanvas());
    drawHeaderOnContinuation();
    y = topY + Math.round(2 * pxPerMm);
  };

  const ensureSpacePx = (neededPx: number) => {
    if (y + neededPx > bottomLimit) {
      nextPage();
    }
  };

  // Eyebrow
  ctx.font = `700 ${Math.round(2.9 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
  ctx.fillStyle = '#2563EB';
  ctx.textAlign = 'left';
  ctx.fillText('HANZX STUDIO  |  TRANSCRIPT DOCUMENT', marginX, y);
  y += Math.round(6 * pxPerMm);

  // Title
  const titleIsRtl = RTL_TEXT_RE.test(job.title);
  ctx.font = `700 ${Math.round(5.8 * pxPerMm)}px "Plus Jakarta Sans", "Noto Nastaliq Urdu", system-ui, sans-serif`;
  ctx.fillStyle = '#0F172A';
  ctx.direction = titleIsRtl ? 'rtl' : 'ltr';
  ctx.textAlign = titleIsRtl ? 'right' : 'left';
  const titleLines = wrapCanvasText(ctx, job.title, contentW);
  for (const line of titleLines) {
    ensureSpacePx(Math.round(7.5 * pxPerMm));
    ctx.fillText(line, titleIsRtl ? canvasW - marginX : marginX, y);
    y += Math.round(7.5 * pxPerMm);
  }

  // Metadata
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = `400 ${Math.round(3.1 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
  ctx.fillStyle = '#475569';
  const metaText = buildMetadataSummary(job, wordCount).join('  ·  ');
  const metaLines = wrapCanvasText(ctx, metaText, contentW);
  for (const mLine of metaLines) {
    ensureSpacePx(Math.round(4.6 * pxPerMm));
    ctx.fillText(mLine, marginX, y);
    y += Math.round(4.6 * pxPerMm);
  }

  y += Math.round(2 * pxPerMm);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(marginX, y);
  ctx.lineTo(canvasW - marginX, y);
  ctx.stroke();
  y += Math.round(7 * pxPerMm);

  const drawTextLines = (
    lines: string[],
    xLeft: number,
    xRight: number,
    lineStepPx: number,
    isRtl: boolean,
    fontSpec: string,
    color: string,
  ) => {
    for (const line of lines) {
      if (y + lineStepPx > bottomLimit) {
        nextPage();
      }
      ctx.font = fontSpec;
      ctx.fillStyle = color;
      ctx.direction = isRtl ? 'rtl' : 'ltr';
      ctx.textAlign = isRtl ? 'right' : 'left';
      ctx.fillText(line, isRtl ? xRight : xLeft, y);
      y += lineStepPx;
    }
  };

  if (options.includeAnalysis && job.analysis) {
    const analysis = job.analysis;
    if (analysis.summary.trim()) {
      ensureSpacePx(Math.round(14 * pxPerMm));
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(4.0 * pxPerMm)}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText('Executive Summary', marginX, y);
      y += Math.round(5.8 * pxPerMm);

      const isRtl = RTL_TEXT_RE.test(analysis.summary);
      const bodyFont = `400 ${Math.round(3.5 * pxPerMm)}px "DM Sans", "Noto Naskh Arabic", system-ui, sans-serif`;
      ctx.font = bodyFont;
      const lines = wrapCanvasText(ctx, analysis.summary.trim(), contentW);
      drawTextLines(lines, marginX, canvasW - marginX, Math.round(5.4 * pxPerMm), isRtl, bodyFont, '#1E293B');
      y += Math.round(4 * pxPerMm);
    }

    if (analysis.keyPoints.length > 0) {
      ensureSpacePx(Math.round(12 * pxPerMm));
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(3.8 * pxPerMm)}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText('Key Points', marginX, y);
      y += Math.round(5.2 * pxPerMm);

      const kpFont = `400 ${Math.round(3.4 * pxPerMm)}px "DM Sans", "Noto Naskh Arabic", system-ui, sans-serif`;
      for (const kp of analysis.keyPoints) {
        const isRtl = RTL_TEXT_RE.test(kp);
        ctx.font = kpFont;
        const lines = wrapCanvasText(ctx, `• ${kp.trim()}`, contentW - Math.round(4 * pxPerMm));
        drawTextLines(
          lines,
          marginX + Math.round(3 * pxPerMm),
          canvasW - marginX - Math.round(3 * pxPerMm),
          Math.round(5.0 * pxPerMm),
          isRtl,
          kpFont,
          '#334155',
        );
        y += Math.round(1 * pxPerMm);
      }
      y += Math.round(3 * pxPerMm);
    }

    if (analysis.actionItems.length > 0) {
      ensureSpacePx(Math.round(12 * pxPerMm));
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(3.8 * pxPerMm)}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText('Action Items', marginX, y);
      y += Math.round(5.4 * pxPerMm);

      const itemFont = `400 ${Math.round(3.4 * pxPerMm)}px "DM Sans", "Noto Naskh Arabic", system-ui, sans-serif`;
      const boxSize = Math.round(2.7 * pxPerMm);
      const itemIndent = Math.round(5.5 * pxPerMm);
      for (const item of analysis.actionItems) {
        const isRtl = RTL_TEXT_RE.test(item);
        ctx.font = itemFont;
        const lines = wrapCanvasText(ctx, item.trim(), contentW - itemIndent);
        ensureSpacePx(Math.round(5.4 * pxPerMm));
        // Draw crisp vector checkbox square
        ctx.save();
        ctx.strokeStyle = '#64748B';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(marginX + Math.round(0.5 * pxPerMm), y - boxSize + 1, boxSize, boxSize);
        ctx.restore();

        drawTextLines(
          lines,
          marginX + itemIndent,
          canvasW - marginX,
          Math.round(5.0 * pxPerMm),
          isRtl,
          itemFont,
          '#334155',
        );
        y += Math.round(1.2 * pxPerMm);
      }
      y += Math.round(3 * pxPerMm);
    }

    if (analysis.chapters.length > 0) {
      ensureSpacePx(Math.round(14 * pxPerMm));
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(3.9 * pxPerMm)}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText('Chapters', marginX, y);
      y += Math.round(5.5 * pxPerMm);

      const tsW = Math.round(21 * pxPerMm);
      const bodyX = marginX + tsW + Math.round(3 * pxPerMm);
      const bodyW = contentW - tsW - Math.round(3 * pxPerMm);

      for (const ch of analysis.chapters) {
        ensureSpacePx(Math.round(12 * pxPerMm));
        ctx.direction = 'ltr';
        ctx.textAlign = 'left';
        ctx.font = `700 ${Math.round(3.2 * pxPerMm)}px "JetBrains Mono", monospace`;
        ctx.fillStyle = '#2563EB';
        ctx.fillText(formatDuration(ch.startSec), marginX, y);

        const chFont = `700 ${Math.round(3.4 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
        ctx.font = chFont;
        const chLines = wrapCanvasText(ctx, ch.title, bodyW);
        const chRtl = RTL_TEXT_RE.test(ch.title);
        drawTextLines(chLines, bodyX, canvasW - marginX, Math.round(4.8 * pxPerMm), chRtl, chFont, '#0F172A');

        if (ch.summary) {
          const sumFont = `400 ${Math.round(3.2 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
          ctx.font = sumFont;
          const sumLines = wrapCanvasText(ctx, ch.summary, bodyW);
          const sumRtl = RTL_TEXT_RE.test(ch.summary);
          drawTextLines(sumLines, bodyX, canvasW - marginX, Math.round(4.6 * pxPerMm), sumRtl, sumFont, '#475569');
        }
        y += Math.round(2.5 * pxPerMm);
      }
      y += Math.round(3 * pxPerMm);
    }
  }

  // Transcript Heading
  ensureSpacePx(Math.round(12 * pxPerMm));
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = `700 ${Math.round(4.2 * pxPerMm)}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.fillStyle = '#0F172A';
  ctx.fillText(
    options.layout === 'paragraphs' ? 'Full Transcript (Paragraphs)' : 'Full Transcript (Timeline)',
    marginX,
    y,
  );
  y += Math.round(7 * pxPerMm);

  const entries = buildPrintableEntries(job, options);
  const gutterPx = options.includeTimestamps ? Math.round(23 * pxPerMm) : 0;
  const textLeft = options.includeTimestamps ? marginX + gutterPx + Math.round(4 * pxPerMm) : marginX;
  const textRight = canvasW - marginX;
  const textWidth = textRight - textLeft;
  const bodyFont = `400 ${Math.round(3.7 * pxPerMm)}px "DM Sans", "Noto Naskh Arabic", "Noto Sans Devanagari", system-ui, sans-serif`;
  const speakerFont = `700 ${Math.round(3.4 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
  const lineStepPx = Math.round(5.6 * pxPerMm);

  for (const entry of entries) {
    const isRtl = RTL_TEXT_RE.test(entry.text);
    ctx.font = bodyFont;
    const lines = wrapCanvasText(ctx, entry.text, textWidth);
    if (lines.length === 0) continue;

    const neededPx =
      (entry.speaker ? Math.round(5 * pxPerMm) : 0) +
      Math.min(2, lines.length) * lineStepPx +
      Math.round(4 * pxPerMm);
    ensureSpacePx(neededPx);

    if (options.includeTimestamps) {
      ctx.direction = 'ltr';
      ctx.textAlign = 'left';
      ctx.font = `700 ${Math.round(3.15 * pxPerMm)}px "JetBrains Mono", monospace`;
      ctx.fillStyle = '#2563EB';
      ctx.fillText(`[${formatDuration(entry.startSec)}]`, marginX, y);

      // Subtle vertical divider beside timestamp gutter
      const dividerX = marginX + gutterPx + Math.round(1.2 * pxPerMm);
      const spanLines = Math.min(lines.length, 3);
      const dividerBottom = Math.min(
        bottomLimit,
        y + (entry.speaker ? Math.round(5 * pxPerMm) : 0) + Math.max(0, spanLines - 1) * lineStepPx + Math.round(1.2 * pxPerMm),
      );
      ctx.save();
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(dividerX, y - Math.round(2.8 * pxPerMm));
      ctx.lineTo(dividerX, dividerBottom);
      ctx.stroke();
      ctx.restore();
    }

    if (entry.speaker) {
      const spRtl = RTL_TEXT_RE.test(entry.speaker);
      ctx.font = speakerFont;
      ctx.fillStyle = '#0F172A';
      ctx.direction = spRtl ? 'rtl' : 'ltr';
      ctx.textAlign = spRtl ? 'right' : 'left';
      ctx.fillText(entry.speaker, spRtl ? textRight : textLeft, y);
      y += Math.round(5.0 * pxPerMm);
    }

    drawTextLines(lines, textLeft, textRight, lineStepPx, isRtl, bodyFont, '#1E293B');
    y += Math.round((options.layout === 'paragraphs' ? 4.2 : 2.8) * pxPerMm);
  }

  // Footers and embed canvases into jsPDF
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const pCanvas = pages[i];
    const pCtx = pCanvas.getContext('2d')!;
    pCtx.save();
    pCtx.strokeStyle = '#E2E8F0';
    pCtx.lineWidth = 1.5;
    pCtx.beginPath();
    pCtx.moveTo(marginX, canvasH - Math.round(12.5 * pxPerMm));
    pCtx.lineTo(canvasW - marginX, canvasH - Math.round(12.5 * pxPerMm));
    pCtx.stroke();

    pCtx.font = `400 ${Math.round(2.9 * pxPerMm)}px "DM Sans", system-ui, sans-serif`;
    pCtx.fillStyle = '#64748B';
    pCtx.direction = 'ltr';
    pCtx.textAlign = 'left';
    pCtx.fillText('Generated by Hanzx Studio', marginX, canvasH - Math.round(8 * pxPerMm));
    pCtx.textAlign = 'right';
    pCtx.fillText(`Page ${i + 1} of ${totalPages}`, canvasW - marginX, canvasH - Math.round(8 * pxPerMm));
    pCtx.restore();

    if (i > 0) doc.addPage();
    const imgData = pCanvas.toDataURL('image/jpeg', 0.92);
    doc.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, pageHeightMm, undefined, 'FAST');
  }

  return doc;
}

export function buildTranscriptPdf(
  job: TranscriptionJob,
  partialOptions: Partial<PdfExportOptions> = {},
): jsPDF {
  const options: PdfExportOptions = { ...DEFAULT_PDF_OPTIONS, ...partialOptions };
  const needsCanvasUnicode = typeof document !== 'undefined' && hasNonLatinScript(job);

  if (needsCanvasUnicode) {
    return buildUnicodeCanvasPdf(job, options);
  }
  return buildVectorPdf(job, options);
}

export async function exportTranscriptToPdf(
  job: TranscriptionJob,
  partialOptions: Partial<PdfExportOptions> = {},
): Promise<void> {
  const doc = buildTranscriptPdf(job, partialOptions);
  const filename = `${safeBaseFilename(job.title)}.pdf`;
  doc.save(filename);
}
