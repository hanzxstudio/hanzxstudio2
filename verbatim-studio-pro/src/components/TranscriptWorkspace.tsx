import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Download,
  Edit3,
  FileText,
  Languages,
  Loader2,
  Navigation,
  Replace,
  Search,
  Sparkles,
  Subtitles,
  Users,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptSegment, TranscriptionAnalysis, TranscriptionJob } from '../types/transcription';
import {
  downloadTextFile,
  groupSegmentsIntoParagraphs,
  safeBaseFilename,
  toMarkdown,
  toParagraphText,
  toPlainText,
  toSRT,
  toVTT,
  toWordDocumentHtml,
} from '../utils/exporters';
import { formatBytes, formatDuration, getWordCount } from '../utils/formatters';
import {
  DEFAULT_PDF_OPTIONS,
  exportTranscriptToPdf,
  type PdfExportOptions,
} from '../utils/pdfExport';

interface TranscriptWorkspaceProps {
  job: TranscriptionJob;
  localMediaUrl?: string;
  onCancelJob: (jobId: string) => void;
  onUpdateSegments: (jobId: string, segments: TranscriptSegment[]) => void;
  onUpdateAnalysis: (jobId: string, analysis: TranscriptionAnalysis) => void;
  onOpenInSubtitleStudio?: (job: TranscriptionJob) => void;
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, idx) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={idx}
            className="bg-[#FEF08A] text-[#0F172A] rounded-xs px-0.5"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={idx}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function TranscriptWorkspace({
  job,
  localMediaUrl,
  onCancelJob,
  onUpdateSegments,
  onUpdateAnalysis,
  onOpenInSubtitleStudio,
}: TranscriptWorkspaceProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'paragraphs' | 'timeline' | 'prose'>('paragraphs');
  const [outlineTab, setOutlineTab] = useState<'chapters' | 'summary' | 'repurpose'>('chapters');
  const [currentTimeSec, setCurrentTimeSec] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [copiedBlockId, setCopiedBlockId] = useState<string | null>(null);
  const [followPlayback, setFollowPlayback] = useState(true);

  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  const [showSpeakerManager, setShowSpeakerManager] = useState(false);
  const [speakerRenames, setSpeakerRenames] = useState<Record<string, string>>({});

  const [showFindReplace, setShowFindReplace] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);

  const [showScriptConverter, setShowScriptConverter] = useState(false);
  const [convertingScript, setConvertingScript] = useState<string | null>(null);
  const [scriptNotice, setScriptNotice] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);

  const [repurposeFormat, setRepurposeFormat] = useState<
    'study-notes' | 'blog-article' | 'youtube-pack' | 'social-thread'
  >('study-notes');
  const [repurposeLang, setRepurposeLang] = useState<'match' | 'urdu' | 'roman-urdu' | 'english'>(
    'match',
  );
  const [repurposing, setRepurposing] = useState(false);
  const [repurposeError, setRepurposeError] = useState<string | null>(null);
  const [repurposeResult, setRepurposeResult] = useState<string>('');
  const [repurposeCopied, setRepurposeCopied] = useState(false);

  const [showPdfMenu, setShowPdfMenu] = useState(false);
  const [pdfOptions, setPdfOptions] = useState<PdfExportOptions>(DEFAULT_PDF_OPTIONS);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [pdfNotice, setPdfNotice] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const youtubeIframeRef = useRef<HTMLIFrameElement | null>(null);
  const pdfMenuRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLDivElement | null>(null);

  const isWorking =
    job.status !== 'completed' && job.status !== 'error' && job.status !== 'cancelled';

  const mediaSrc = localMediaUrl || job.mediaUrl;

  useEffect(() => {
    if (!showPdfMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (pdfMenuRef.current && !pdfMenuRef.current.contains(e.target as Node)) {
        setShowPdfMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [showPdfMenu]);

  const uniqueSpeakers = useMemo(() => {
    const set = new Set<string>();
    for (const seg of job.segments) {
      if (seg.speaker) set.add(seg.speaker);
    }
    return Array.from(set);
  }, [job.segments]);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const sp of uniqueSpeakers) {
      init[sp] = sp;
    }
    setSpeakerRenames(init);
  }, [uniqueSpeakers]);

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return job.segments;
    return job.segments.filter(
      (s) =>
        s.text.toLowerCase().includes(q) ||
        (s.speaker && s.speaker.toLowerCase().includes(q)),
    );
  }, [job.segments, searchQuery]);

  const groupedParagraphs = useMemo(
    () => groupSegmentsIntoParagraphs(filteredSegments),
    [filteredSegments],
  );

  const wordCount = useMemo(
    () => getWordCount(job.segments.map((s) => s.text)),
    [job.segments],
  );

  const readingMinutes = wordCount > 0 ? Math.max(1, Math.round(wordCount / 200)) : 0;
  const speakingWpm =
    wordCount > 0 && job.durationSeconds >= 10
      ? Math.round((wordCount / job.durationSeconds) * 60)
      : 0;

  const findMatchCount = useMemo(() => {
    const needle = findText.trim();
    if (!needle) return 0;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let total = 0;
    for (const seg of job.segments) {
      const matches = seg.text.match(regex);
      if (matches) total += matches.length;
    }
    return total;
  }, [job.segments, findText]);

  useEffect(() => {
    if (!followPlayback || !activeItemRef.current) return;
    activeItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [currentTimeSec, followPlayback, viewMode]);

  const seekToTime = (seconds: number) => {
    const target = Math.max(0, Math.floor(seconds));
    setCurrentTimeSec(target);

    if (job.sourceKind === 'youtube') {
      const iframe = youtubeIframeRef.current;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'seekTo', args: [target, true] }),
          '*',
        );
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: 'playVideo', args: [] }),
          '*',
        );
      }
      return;
    }

    const mediaEl = job.sourceKind === 'video' ? videoRef.current : audioRef.current;
    if (mediaEl) {
      mediaEl.currentTime = target;
      mediaEl.playbackRate = playbackRate;
      void mediaEl.play().catch(() => {});
    }
  };

  const skipMedia = (deltaSec: number) => {
    const mediaEl = job.sourceKind === 'video' ? videoRef.current : audioRef.current;
    if (mediaEl) {
      const next = Math.max(0, mediaEl.currentTime + deltaSec);
      mediaEl.currentTime = next;
      setCurrentTimeSec(Math.floor(next));
      return;
    }
    seekToTime(Math.max(0, currentTimeSec + deltaSec));
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    const mediaEl = job.sourceKind === 'video' ? videoRef.current : audioRef.current;
    if (mediaEl) {
      mediaEl.playbackRate = rate;
    }
  };

  const handleCopyAll = async () => {
    const text =
      viewMode === 'paragraphs'
        ? toParagraphText(job.segments, true, true)
        : toPlainText(job.segments, viewMode === 'timeline', viewMode !== 'prose');
    await navigator.clipboard.writeText(text);
    setCopiedNotice(true);
    setTimeout(() => setCopiedNotice(false), 1800);
  };

  const handleCopyBlock = async (blockId: string, startSec: number, speaker: string | undefined, text: string) => {
    const sp = speaker ? `${speaker}: ` : '';
    await navigator.clipboard.writeText(`[${formatDuration(startSec)}] ${sp}${text.trim()}`);
    setCopiedBlockId(blockId);
    setTimeout(() => setCopiedBlockId((prev) => (prev === blockId ? null : prev)), 1500);
  };

  const handleReplaceAll = () => {
    const needle = findText.trim();
    if (!needle || findMatchCount === 0) return;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const updated = job.segments.map((seg) => ({
      ...seg,
      text: seg.text.replace(regex, replaceText),
    }));
    onUpdateSegments(job.id, updated);
    setReplaceNotice(`Replaced ${findMatchCount} occurrence${findMatchCount === 1 ? '' : 's'}`);
    setTimeout(() => setReplaceNotice(null), 2500);
  };

  const handleDownloadPdf = async (customOptions?: PdfExportOptions) => {
    if (job.segments.length === 0 || exportingPdf) return;
    setExportingPdf(true);
    try {
      await exportTranscriptToPdf(job, customOptions ?? pdfOptions);
      setShowPdfMenu(false);
      setPdfNotice(true);
      setTimeout(() => setPdfNotice(false), 2000);
    } finally {
      setExportingPdf(false);
    }
  };

  const handleApplySpeakerRenames = () => {
    const updated = job.segments.map((seg) => {
      if (!seg.speaker) return seg;
      const nextName = speakerRenames[seg.speaker]?.trim();
      return nextName ? { ...seg, speaker: nextName } : seg;
    });
    onUpdateSegments(job.id, updated);
    setShowSpeakerManager(false);
  };

  const saveSegmentEdit = (segmentId: string) => {
    const trimmed = editingDraft.trim();
    if (!trimmed) {
      setEditingSegmentId(null);
      return;
    }
    const updated = job.segments.map((s) =>
      s.id === segmentId ? { ...s, text: trimmed } : s,
    );
    onUpdateSegments(job.id, updated);
    setEditingSegmentId(null);
  };

  const handleGenerateAnalysis = async () => {
    if (job.segments.length === 0) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: job.title,
          segments: job.segments,
        }),
      });
      const data = (await res.json()) as TranscriptionAnalysis & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not analyze transcript.');
      }
      onUpdateAnalysis(job.id, data);
      setOutlineTab('summary');
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Summary generation failed.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleConvertScript = async (
    targetMode: 'urdu-pure' | 'roman-urdu' | 'urdu-english' | 'english',
    label: string,
  ) => {
    if (job.segments.length === 0 || convertingScript) return;
    setConvertingScript(targetMode);
    setScriptError(null);
    setScriptNotice(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/transform-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetMode,
          segments: job.segments,
        }),
      });
      const data = (await res.json()) as { segments?: TranscriptSegment[]; error?: string };
      if (!res.ok || !Array.isArray(data.segments)) {
        throw new Error(data.error || 'Could not convert transcript script.');
      }
      onUpdateSegments(job.id, data.segments);
      setScriptNotice(`Converted transcript to ${label}`);
      setTimeout(() => setScriptNotice(null), 3200);
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : 'Script conversion failed.');
    } finally {
      setConvertingScript(null);
    }
  };

  const handleGenerateRepurpose = async () => {
    if (job.segments.length === 0 || repurposing) return;
    setRepurposing(true);
    setRepurposeError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/repurpose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: job.title,
          format: repurposeFormat,
          outputLanguage: repurposeLang,
          segments: job.segments,
        }),
      });
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok || !data.content) {
        throw new Error(data.error || 'Could not generate notes.');
      }
      setRepurposeResult(data.content);
    } catch (err) {
      setRepurposeError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setRepurposing(false);
    }
  };

  const baseFilename = safeBaseFilename(job.title);

  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-8 py-6 sm:py-8 space-y-6">
      {/* Header & Unboxed Metadata */}
      <div className="pb-5 border-b border-[#E2E8F0] flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-xl sm:text-2xl font-bold text-[#0F172A] tracking-tight break-words">
            {job.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
            <span className="capitalize">{job.sourceKind}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {job.durationSeconds > 0 ? formatDuration(job.durationSeconds) : 'Duration pending'}
            </span>
            {job.fileSizeBytes ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{formatBytes(job.fileSizeBytes)}</span>
              </>
            ) : null}
            {job.totalChunks > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {job.completedChunks}/{job.totalChunks} chunks
                </span>
              </>
            )}
            {wordCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{wordCount.toLocaleString()} words</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">~{readingMinutes} min read</span>
                {speakingWpm > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">{speakingWpm} wpm</span>
                  </>
                )}
              </>
            )}
            {job.analysis?.detectedLanguage && (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.analysis.detectedLanguage}</span>
              </>
            )}
            {job.strategyUsed && (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.strategyUsed}</span>
              </>
            )}
          </div>
        </div>

        {isWorking && (
          <button
            type="button"
            onClick={() => onCancelJob(job.id)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium text-[#475569] bg-white border border-[#CBD5E1] hover:bg-[#F8FAFC] hover:text-[#0F172A] rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Cancel Job</span>
          </button>
        )}
      </div>

      {/* Processing Progress Banner */}
      {isWorking && (
        <div className="p-4 sm:p-5 bg-white border border-[#E2E8F0] rounded-xl space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <Loader2 className="w-4 h-4 text-[#2563EB] animate-spin shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium text-[#0F172A] truncate">
                {job.stageLabel}
              </span>
            </div>
            <span className="font-mono text-xs font-semibold text-[#2563EB] tabular-nums shrink-0">
              {job.progressPercent}%
            </span>
          </div>

          <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#2563EB] transition-all duration-200"
              style={{ width: `${Math.max(3, job.progressPercent)}%` }}
            />
          </div>

          {job.totalChunks > 1 && (
            <p className="text-xs text-[#64748B]">
              Long-form media mode active: completed segments stream directly into the transcript below as each chunk finishes.
            </p>
          )}
        </div>
      )}

      {/* Error State */}
      {job.status === 'error' && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-sm text-[#B91C1C] flex items-start gap-3"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold">Transcription failed</p>
            <p className="mt-1 text-xs sm:text-sm text-[#991B1B]">{job.error || job.stageLabel}</p>
          </div>
        </div>
      )}

      {/* Main Split Workspace: Media + Outline on Left, Transcript Document on Right */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left Column: Synchronized Player & Chapters/Summary */}
        <div className="xl:col-span-4 space-y-5 xl:sticky xl:top-22">
          {/* Media Player */}
          {job.sourceKind === 'youtube' && job.youtubeInfo ? (
            <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden">
              <div className="aspect-video bg-[#0F172A]">
                <iframe
                  ref={youtubeIframeRef}
                  title={job.title}
                  src={`https://www.youtube.com/embed/${job.youtubeInfo.videoId}?enablejsapi=1&rel=0`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-full border-0"
                />
              </div>
              <div className="px-4 py-2.5 border-t border-[#E2E8F0] flex items-center justify-between text-xs text-[#64748B]">
                <span>Click any timestamp to jump</span>
                <span className="font-mono tabular-nums">{formatDuration(currentTimeSec)}</span>
              </div>
            </div>
          ) : mediaSrc ? (
            <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden">
              {job.sourceKind === 'video' ? (
                <video
                  ref={videoRef}
                  src={mediaSrc}
                  controls
                  onLoadedMetadata={(e) => {
                    e.currentTarget.playbackRate = playbackRate;
                  }}
                  onTimeUpdate={(e) => setCurrentTimeSec(Math.floor(e.currentTarget.currentTime))}
                  className="w-full aspect-video bg-[#0F172A]"
                />
              ) : (
                <div className="p-4 bg-[#F8FAFC]">
                  <p className="text-xs font-medium text-[#475569] mb-2.5 truncate">
                    Audio Playback
                  </p>
                  <audio
                    ref={audioRef}
                    src={mediaSrc}
                    controls
                    onLoadedMetadata={(e) => {
                      e.currentTarget.playbackRate = playbackRate;
                    }}
                    onTimeUpdate={(e) => setCurrentTimeSec(Math.floor(e.currentTarget.currentTime))}
                    className="w-full"
                  />
                </div>
              )}
              <div className="px-3.5 py-2 border-t border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => skipMedia(-10)}
                    className="px-2 py-1 font-mono text-[#334155] bg-white border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded cursor-pointer"
                  >
                    -10s
                  </button>
                  <button
                    type="button"
                    onClick={() => skipMedia(10)}
                    className="px-2 py-1 font-mono text-[#334155] bg-white border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded cursor-pointer"
                  >
                    +10s
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => changePlaybackRate(rate)}
                      className={`px-1.5 py-1 font-mono rounded cursor-pointer ${
                        playbackRate === rate
                          ? 'bg-[#2563EB] text-white font-semibold'
                          : 'text-[#475569] hover:bg-white'
                      }`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* Chapters, Summary & Create Notes Panel */}
          <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-0.5 p-0.5 bg-[#F1F5F9] rounded-lg">
                <button
                  type="button"
                  onClick={() => setOutlineTab('chapters')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    outlineTab === 'chapters'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Chapters
                </button>
                <button
                  type="button"
                  onClick={() => setOutlineTab('summary')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    outlineTab === 'summary'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Summary
                </button>
                <button
                  type="button"
                  onClick={() => setOutlineTab('repurpose')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    outlineTab === 'repurpose'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Notes
                </button>
              </div>

              {job.segments.length > 0 && !isWorking && outlineTab !== 'repurpose' && (
                <button
                  type="button"
                  onClick={handleGenerateAnalysis}
                  disabled={analyzing}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2563EB] hover:text-[#1D4ED8] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {analyzing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{job.analysis ? 'Refresh' : 'Analyze'}</span>
                </button>
              )}
            </div>

            <div className="p-4 max-h-[460px] overflow-y-auto">
              {outlineTab === 'repurpose' ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        { id: 'study-notes', label: 'Study Notes' },
                        { id: 'blog-article', label: 'Blog Article' },
                        { id: 'youtube-pack', label: 'YouTube Pack' },
                        { id: 'social-thread', label: 'Social Thread' },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setRepurposeFormat(item.id)}
                        className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border text-left cursor-pointer ${
                          repurposeFormat === item.id
                            ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                            : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Notes output language"
                      value={repurposeLang}
                      onChange={(e) =>
                        setRepurposeLang(
                          e.target.value as 'match' | 'urdu' | 'roman-urdu' | 'english',
                        )
                      }
                      className="flex-1 h-8 px-2 text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A]"
                    >
                      <option value="match">Match Transcript Language</option>
                      <option value="urdu">Pure Urdu (اردو)</option>
                      <option value="roman-urdu">Roman Urdu</option>
                      <option value="english">English</option>
                    </select>

                    <button
                      type="button"
                      disabled={job.segments.length === 0 || isWorking || repurposing}
                      onClick={() => void handleGenerateRepurpose()}
                      className="px-3 h-8 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {repurposing ? (
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="w-3 h-3" aria-hidden="true" />
                      )}
                      <span>{repurposing ? 'Creating...' : 'Create'}</span>
                    </button>
                  </div>

                  {repurposeError && (
                    <p className="text-xs text-[#DC2626]">{repurposeError}</p>
                  )}

                  {repurposeResult ? (
                    <div className="space-y-2.5 pt-1">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(repurposeResult);
                            setRepurposeCopied(true);
                            setTimeout(() => setRepurposeCopied(false), 1600);
                          }}
                          className="px-2.5 py-1 text-[11px] font-medium text-[#0F172A] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded-md cursor-pointer"
                        >
                          {repurposeCopied ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadTextFile(
                              `${baseFilename}_${repurposeFormat}.md`,
                              repurposeResult,
                            )
                          }
                          className="px-2.5 py-1 text-[11px] font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] rounded-md cursor-pointer"
                        >
                          Save .MD
                        </button>
                      </div>
                      <pre
                        dir="auto"
                        className="whitespace-pre-wrap font-sans text-xs text-[#334155] leading-relaxed bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3"
                      >
                        {repurposeResult}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-xs text-[#64748B] py-4 text-center leading-relaxed">
                      Turn this transcript into ready-to-use Study Notes, a Blog Article, YouTube Chapters/Tags, or a Social Thread.
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {analyzeError && (
                    <p className="mb-3 text-xs text-[#DC2626]">{analyzeError}</p>
                  )}

                  {!job.analysis ? (
                    <div className="py-6 text-center space-y-2">
                      <p className="text-xs text-[#64748B] leading-relaxed">
                        {isWorking
                          ? 'Chapters and executive summary will appear once transcription finishes.'
                          : 'Generate structured chapters, key takeaways, and action items from this transcript.'}
                      </p>
                      {!isWorking && job.segments.length > 0 && (
                        <button
                          type="button"
                          onClick={handleGenerateAnalysis}
                          disabled={analyzing}
                          className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg cursor-pointer"
                        >
                          {analyzing ? 'Generating...' : 'Generate Chapters & Summary'}
                        </button>
                      )}
                    </div>
                  ) : outlineTab === 'chapters' ? (
                    job.analysis.chapters.length === 0 ? (
                      <p className="text-xs text-[#64748B] py-4 text-center">
                        No distinct chapters were detected.
                      </p>
                    ) : (
                      <ul className="divide-y divide-[#F1F5F9] -my-2">
                        {job.analysis.chapters.map((ch, idx) => (
                          <li key={`${ch.startSec}_${idx}`} className="py-3">
                            <button
                              type="button"
                              onClick={() => seekToTime(ch.startSec)}
                              className="w-full text-left group cursor-pointer"
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-semibold text-[#0F172A] group-hover:text-[#2563EB] transition-colors">
                                  {ch.title}
                                </span>
                                <span className="font-mono text-xs text-[#2563EB] tabular-nums shrink-0">
                                  {formatDuration(ch.startSec)}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-[#64748B] leading-relaxed">
                                {ch.summary}
                              </p>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : (
                    <div className="space-y-4 text-xs sm:text-sm text-[#334155] leading-relaxed">
                      <div>
                        <h3 className="font-display text-xs font-semibold text-[#0F172A] mb-1.5">
                          Executive Summary
                        </h3>
                        <p className="text-xs text-[#475569] leading-relaxed">
                          {job.analysis.summary}
                        </p>
                      </div>

                      {job.analysis.keyPoints.length > 0 && (
                        <div className="pt-3 border-t border-[#F1F5F9]">
                          <h3 className="font-display text-xs font-semibold text-[#0F172A] mb-2">
                            Key Points
                          </h3>
                          <ul className="space-y-1.5 list-disc pl-4 text-xs text-[#475569]">
                            {job.analysis.keyPoints.map((pt, i) => (
                              <li key={i}>{pt}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {job.analysis.actionItems.length > 0 && (
                        <div className="pt-3 border-t border-[#F1F5F9]">
                          <h3 className="font-display text-xs font-semibold text-[#0F172A] mb-2">
                            Action Items
                          </h3>
                          <ul className="space-y-1.5 list-disc pl-4 text-xs text-[#475569]">
                            {job.analysis.actionItems.map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Main Transcript Document */}
        <div className="xl:col-span-8 bg-white border border-[#E2E8F0] rounded-xl">
          {/* Document Toolbar */}
          <div className="px-4 py-3 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]">
              <div className="relative flex-1 min-w-[160px] max-w-[220px]">
                <Search
                  className="w-3.5 h-3.5 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search transcript..."
                  aria-label="Search transcript"
                  className="w-full h-9 pl-8 pr-3 text-xs bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:border-[#2563EB]"
                />
              </div>

              <div className="inline-flex items-center p-0.5 bg-[#F1F5F9] rounded-lg shrink-0">
                <button
                  type="button"
                  onClick={() => setViewMode('paragraphs')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    viewMode === 'paragraphs'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Paragraphs
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('timeline')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    viewMode === 'timeline'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Timeline
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('prose')}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    viewMode === 'prose'
                      ? 'bg-white text-[#0F172A] shadow-xs'
                      : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  Clean Prose
                </button>
              </div>

              {job.segments.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowFindReplace((v) => !v)}
                  title="Find and Replace"
                  className={`inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium border rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                    showFindReplace
                      ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <Replace className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Replace</span>
                </button>
              )}

              {(mediaSrc || job.sourceKind === 'youtube') && job.segments.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFollowPlayback((v) => !v)}
                  title="Auto-scroll active segment during playback"
                  className={`inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium border rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                    followPlayback
                      ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <Navigation className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden md:inline">Follow</span>
                </button>
              )}

              {job.segments.length > 0 && !isWorking && (
                <button
                  type="button"
                  onClick={() => setShowScriptConverter((v) => !v)}
                  title="Convert Urdu / Roman Urdu / English Script"
                  className={`inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium border rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                    showScriptConverter
                      ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <Languages className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Script</span>
                </button>
              )}

              {uniqueSpeakers.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSpeakerManager((v) => !v)}
                  className={`inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium border rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                    showSpeakerManager
                      ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Speakers</span>
                </button>
              )}

              {onOpenInSubtitleStudio && job.segments.length > 0 && !isWorking && (
                <button
                  type="button"
                  onClick={() => onOpenInSubtitleStudio(job)}
                  title="Style & burn subtitles in Subtitle Studio"
                  className="inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium border border-[#E2E8F0] bg-white text-[#475569] hover:border-[#2563EB] hover:text-[#1D4ED8] rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Subtitles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Subtitles</span>
                </button>
              )}
            </div>

            {/* Export Actions */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {/* Primary PDF Export Studio Trigger */}
              <div className="relative" ref={pdfMenuRef}>
                <button
                  type="button"
                  disabled={job.segments.length === 0 || exportingPdf}
                  onClick={() => setShowPdfMenu((v) => !v)}
                  className="inline-flex items-center gap-1.5 px-3 h-9 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  {exportingPdf ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : pdfNotice ? (
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{exportingPdf ? 'Building PDF...' : pdfNotice ? 'PDF Saved' : 'PDF'}</span>
                  <ChevronDown className="w-3 h-3 opacity-80" aria-hidden="true" />
                </button>

                {showPdfMenu && (
                  <div className="absolute left-0 sm:left-auto sm:right-0 mt-2 w-[min(18rem,calc(100vw-2rem))] bg-white border border-[#E2E8F0] rounded-xl shadow-lg p-4 z-30 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#0F172A]">
                        Structured PDF Export
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowPdfMenu(false)}
                        className="text-[#94A3B8] hover:text-[#0F172A] cursor-pointer"
                        aria-label="Close PDF options"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      <span className="block text-[11px] font-medium text-[#64748B]">
                        Document Layout
                      </span>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setPdfOptions((prev) => ({ ...prev, layout: 'paragraphs' }))
                          }
                          className={`px-2.5 py-2 text-xs font-medium rounded-lg border text-left cursor-pointer ${
                            pdfOptions.layout === 'paragraphs'
                              ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                              : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                          }`}
                        >
                          Paragraphs
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPdfOptions((prev) => ({ ...prev, layout: 'timeline' }))
                          }
                          className={`px-2.5 py-2 text-xs font-medium rounded-lg border text-left cursor-pointer ${
                            pdfOptions.layout === 'timeline'
                              ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                              : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                          }`}
                        >
                          Timeline
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2 pt-1">
                      <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pdfOptions.includeTimestamps}
                          onChange={(e) =>
                            setPdfOptions((prev) => ({
                              ...prev,
                              includeTimestamps: e.target.checked,
                            }))
                          }
                          className="rounded border-[#CBD5E1] text-[#2563EB]"
                        />
                        <span>Aligned [MM:SS] timestamps</span>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pdfOptions.includeSpeakers}
                          onChange={(e) =>
                            setPdfOptions((prev) => ({
                              ...prev,
                              includeSpeakers: e.target.checked,
                            }))
                          }
                          className="rounded border-[#CBD5E1] text-[#2563EB]"
                        />
                        <span>Speaker labels</span>
                      </label>

                      <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pdfOptions.includeAnalysis}
                          onChange={(e) =>
                            setPdfOptions((prev) => ({
                              ...prev,
                              includeAnalysis: e.target.checked,
                            }))
                          }
                          className="rounded border-[#CBD5E1] text-[#2563EB]"
                        />
                        <span>
                          Summary &amp; chapters
                          {!job.analysis ? ' (if analyzed)' : ''}
                        </span>
                      </label>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-[11px] font-medium text-[#64748B]">Paper Size</span>
                      <div className="inline-flex p-0.5 bg-[#F1F5F9] rounded-md">
                        {(['a4', 'letter'] as const).map((sz) => (
                          <button
                            key={sz}
                            type="button"
                            onClick={() => setPdfOptions((prev) => ({ ...prev, pageSize: sz }))}
                            className={`px-2 py-1 text-[11px] font-mono uppercase rounded cursor-pointer ${
                              pdfOptions.pageSize === sz
                                ? 'bg-white text-[#0F172A] shadow-xs font-semibold'
                                : 'text-[#64748B]'
                            }`}
                          >
                            {sz}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleDownloadPdf()}
                      disabled={exportingPdf}
                      className="w-full py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Download PDF</span>
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleCopyAll}
                disabled={job.segments.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedNotice ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() =>
                  downloadTextFile(
                    `${baseFilename}.doc`,
                    toWordDocumentHtml(job),
                    'application/msword;charset=utf-8',
                  )
                }
                title="Download editable Word document (.doc)"
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                <span>DOC</span>
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() =>
                  downloadTextFile(
                    `${baseFilename}.txt`,
                    viewMode === 'paragraphs'
                      ? toParagraphText(job.segments, true, true)
                      : toPlainText(job.segments, true, true),
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                <span>TXT</span>
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() => downloadTextFile(`${baseFilename}.srt`, toSRT(job.segments))}
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>SRT</span>
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() => downloadTextFile(`${baseFilename}.vtt`, toVTT(job.segments))}
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>VTT</span>
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() => downloadTextFile(`${baseFilename}.md`, toMarkdown(job))}
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>MD</span>
              </button>

              <button
                type="button"
                disabled={job.segments.length === 0}
                onClick={() =>
                  downloadTextFile(
                    `${baseFilename}.json`,
                    JSON.stringify(job, null, 2),
                    'application/json;charset=utf-8',
                  )
                }
                className="inline-flex items-center gap-1 px-2.5 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] hover:text-[#0F172A] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>JSON</span>
              </button>
            </div>
          </div>

          {/* Inline Find & Replace Panel */}
          {showFindReplace && job.segments.length > 0 && (
            <div className="px-4 py-3 bg-[#F8FAFC] border-b border-[#E2E8F0] flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                value={findText}
                onChange={(e) => {
                  setFindText(e.target.value);
                  setSearchQuery(e.target.value);
                }}
                placeholder="Find word or phrase..."
                aria-label="Find word or phrase"
                className="h-8 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] flex-1 min-w-[140px]"
              />
              <input
                type="text"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="Replace with..."
                aria-label="Replace with"
                className="h-8 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] flex-1 min-w-[140px]"
              />
              <span className="font-mono text-[11px] text-[#64748B] tabular-nums whitespace-nowrap">
                {findText.trim() ? `${findMatchCount} matches` : '0 matches'}
              </span>
              <button
                type="button"
                onClick={handleReplaceAll}
                disabled={!findText.trim() || findMatchCount === 0}
                className="px-3 h-8 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 rounded-md whitespace-nowrap cursor-pointer"
              >
                Replace All
              </button>
              {replaceNotice && (
                <span className="text-xs font-medium text-[#16A34A]">{replaceNotice}</span>
              )}
              <button
                type="button"
                onClick={() => setShowFindReplace(false)}
                className="text-xs text-[#64748B] hover:text-[#0F172A] ml-auto cursor-pointer"
              >
                Close
              </button>
            </div>
          )}

          {/* Inline Script & Language Converter Panel */}
          {showScriptConverter && job.segments.length > 0 && (
            <div className="px-4 py-3 bg-[#F8FAFC] border-b border-[#E2E8F0] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Languages className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
                  <span className="text-xs font-semibold text-[#0F172A]">
                    One-Click Script &amp; Language Converter
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowScriptConverter(false)}
                  className="text-xs text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  Close
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { mode: 'urdu-pure', label: 'Pure Urdu (صرف اردو)' },
                    { mode: 'roman-urdu', label: 'Roman Urdu Only' },
                    { mode: 'urdu-english', label: 'Urdu + English Words' },
                    { mode: 'english', label: 'Translate to English' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    disabled={Boolean(convertingScript)}
                    onClick={() => void handleConvertScript(item.mode, item.label)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0F172A] bg-white border border-[#CBD5E1] hover:border-[#2563EB] hover:text-[#1D4ED8] disabled:opacity-50 rounded-md whitespace-nowrap cursor-pointer"
                  >
                    {convertingScript === item.mode && (
                      <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    )}
                    <span>{item.label}</span>
                  </button>
                ))}
                {scriptNotice && (
                  <span className="text-xs font-medium text-[#16A34A]">{scriptNotice}</span>
                )}
                {scriptError && (
                  <span className="text-xs font-medium text-[#DC2626]">{scriptError}</span>
                )}
              </div>
            </div>
          )}

          {/* Inline Speaker Rename Panel */}
          {showSpeakerManager && uniqueSpeakers.length > 0 && (
            <div className="px-4 py-3 bg-[#F8FAFC] border-b border-[#E2E8F0] space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-[#0F172A]">Rename Speakers</p>
                <button
                  type="button"
                  onClick={() => setShowSpeakerManager(false)}
                  className="text-xs text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  Close
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                {uniqueSpeakers.map((sp) => (
                  <div key={sp} className="flex items-center gap-2">
                    <span className="text-xs text-[#64748B] w-24 truncate shrink-0">{sp}</span>
                    <input
                      type="text"
                      value={speakerRenames[sp] ?? sp}
                      onChange={(e) =>
                        setSpeakerRenames((prev) => ({ ...prev, [sp]: e.target.value }))
                      }
                      className="flex-1 min-w-0 h-8 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleApplySpeakerRenames}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-md cursor-pointer"
                >
                  Apply Speaker Names
                </button>
              </div>
            </div>
          )}

          {/* Transcript Body */}
          <div className="p-4 sm:p-6 max-h-[72vh] overflow-y-auto">
            {job.segments.length === 0 ? (
              isWorking ? (
                <div className="space-y-4 py-4" aria-busy="true" aria-label="Loading transcript">
                  {[1, 2, 3, 4].map((n) => (
                    <div key={n} className="flex items-start gap-4 animate-pulse">
                      <div className="w-14 h-4 bg-[#F1F5F9] rounded shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-[#F1F5F9] rounded w-5/6" />
                        <div className="h-4 bg-[#F1F5F9] rounded w-2/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center">
                  <p className="text-sm text-[#64748B]">
                    No spoken dialogue was extracted from this media.
                  </p>
                </div>
              )
            ) : filteredSegments.length === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm text-[#64748B]">
                  No transcript segments match &ldquo;{searchQuery}&rdquo;.
                </p>
              </div>
            ) : viewMode === 'paragraphs' ? (
              <div className="space-y-5">
                {groupedParagraphs.map((para) => {
                  const isActivePlayback =
                    currentTimeSec >= para.startSec && currentTimeSec < para.endSec;

                  return (
                    <div
                      key={para.id}
                      ref={isActivePlayback ? activeItemRef : undefined}
                      className={`group p-3 -mx-3 rounded-lg transition-colors duration-150 flex items-start gap-4 sm:gap-5 ${
                        isActivePlayback ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => seekToTime(para.startSec)}
                        title="Jump to paragraph timestamp"
                        className={`w-16 text-left font-mono text-xs tabular-nums pt-1 shrink-0 cursor-pointer transition-colors ${
                          isActivePlayback
                            ? 'text-[#1D4ED8] font-semibold'
                            : 'text-[#64748B] hover:text-[#2563EB]'
                        }`}
                      >
                        {formatDuration(para.startSec)}
                      </button>

                      <div className="min-w-0 flex-1 border-l border-[#E2E8F0] pl-4">
                        {para.speaker && (
                          <span className="block text-xs font-semibold text-[#0F172A] mb-1">
                            {para.speaker}
                          </span>
                        )}
                        <p
                          dir="auto"
                          className="text-[15px] leading-[1.7] text-[#1E293B] max-w-[68ch] break-words"
                        >
                          <HighlightText text={para.text} query={searchQuery} />
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          void handleCopyBlock(para.id, para.startSec, para.speaker, para.text)
                        }
                        aria-label="Copy paragraph"
                        title="Copy paragraph with timestamp"
                        className="p-2 text-[#94A3B8] hover:text-[#0F172A] opacity-75 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0 cursor-pointer rounded"
                      >
                        {copiedBlockId === para.id ? (
                          <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : viewMode === 'prose' ? (
              <div className="prose prose-slate max-w-[68ch] text-[15px] leading-[1.75] text-[#1E293B] space-y-5">
                {groupedParagraphs.map((para) => (
                  <p key={para.id} dir="auto">
                    {para.speaker && (
                      <strong className="font-semibold text-[#0F172A] mr-1.5">
                        {para.speaker}:
                      </strong>
                    )}
                    <HighlightText text={para.text} query={searchQuery} />
                  </p>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-[#F1F5F9]">
                {filteredSegments.map((seg) => {
                  const isActivePlayback =
                    currentTimeSec >= seg.startSec && currentTimeSec < seg.endSec;
                  const isEditing = editingSegmentId === seg.id;

                  return (
                    <div
                      key={seg.id}
                      ref={isActivePlayback ? activeItemRef : undefined}
                      className={`group py-3 px-2.5 -mx-2.5 rounded-lg transition-colors duration-150 flex items-start gap-3 sm:gap-4 ${
                        isActivePlayback ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => seekToTime(seg.startSec)}
                        title="Jump to timestamp"
                        className={`w-16 text-left font-mono text-xs tabular-nums pt-1 shrink-0 cursor-pointer transition-colors ${
                          isActivePlayback
                            ? 'text-[#1D4ED8] font-semibold'
                            : 'text-[#64748B] hover:text-[#2563EB]'
                        }`}
                      >
                        {formatDuration(seg.startSec)}
                      </button>

                      <div className="min-w-0 flex-1 border-l border-[#E2E8F0] pl-4">
                        {seg.speaker && (
                          <span className="block text-xs font-semibold text-[#0F172A] mb-0.5">
                            {seg.speaker}
                          </span>
                        )}

                        {isEditing ? (
                          <div className="space-y-2 mt-1">
                            <textarea
                              dir="auto"
                              value={editingDraft}
                              onChange={(e) => setEditingDraft(e.target.value)}
                              rows={3}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setEditingSegmentId(null);
                              }}
                              className="w-full p-2.5 text-sm bg-white border border-[#2563EB] rounded-lg text-[#0F172A] focus:outline-none"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => saveSegmentEdit(seg.id)}
                                className="px-3 py-1 text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-md cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingSegmentId(null)}
                                className="px-3 py-1 text-xs font-medium text-[#475569] hover:text-[#0F172A] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p
                            dir="auto"
                            className="text-[15px] leading-[1.65] text-[#1E293B] max-w-[68ch] break-words"
                          >
                            <HighlightText text={seg.text} query={searchQuery} />
                          </p>
                        )}
                      </div>

                      {!isEditing && (
                        <div className="flex items-center gap-0.5 opacity-75 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyBlock(seg.id, seg.startSec, seg.speaker, seg.text)
                            }
                            aria-label="Copy segment"
                            title="Copy segment"
                            className="p-1.5 text-[#94A3B8] hover:text-[#0F172A] cursor-pointer rounded"
                          >
                            {copiedBlockId === seg.id ? (
                              <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingSegmentId(seg.id);
                              setEditingDraft(seg.text);
                            }}
                            aria-label="Edit segment text"
                            title="Edit segment"
                            className="p-1.5 text-[#94A3B8] hover:text-[#0F172A] cursor-pointer rounded"
                          >
                            <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
