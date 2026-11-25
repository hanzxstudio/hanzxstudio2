import {
  AlertCircle,
  Check,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Film,
  Loader2,
  Plus,
  Sparkles,
  Subtitles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudioVideoBackdrop,
  SubtitleCue,
  SubtitleFontSize,
  SubtitlePosition,
  SubtitleStyleConfig,
  ToolJob,
} from '../types/tools';
import type { TranscriptionJob, TranscriptionOptions } from '../types/transcription';
import { uploadFileChunked } from '../utils/chunkedUpload';
import {
  downloadTextFile,
  groupSegmentsIntoParagraphs,
  safeBaseFilename,
  toParagraphText,
  toSRT,
  toVTT,
} from '../utils/exporters';
import { formatBytes, formatDuration } from '../utils/formatters';
import { exportTranscriptToPdf } from '../utils/pdfExport';
import {
  AUDIO_BACKDROP_THEMES,
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_TEMPLATES,
  generateAssDocument,
  getSubtitleTemplate,
  splitSegmentsIntoSubtitleCues,
} from '../utils/subtitleTemplates';
import {
  parseSubtitleOrTranscriptText,
  shiftSegmentTimestamps,
} from '../utils/subtitleTools';

interface SubtitleStudioTabProps {
  savedJobs: TranscriptionJob[];
  initialJob?: TranscriptionJob | null;
  onConsumeInitialJob?: () => void;
  onError: (msg: string | null) => void;
}

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect spoken language' },
  { value: 'Urdu (Pure Nastaliq Script)', label: 'Urdu Only (صرف خالص اردو — Pure Script)' },
  { value: 'Roman Urdu (Latin Script)', label: 'Roman Urdu Only (Latin Script)' },
  { value: 'Urdu + English (Bilingual)', label: 'Urdu + English (اردو + صرف انگریزی الفاظ)' },
  { value: 'English', label: 'English' },
  { value: 'Hindi (हिन्दी)', label: 'Hindi (हिन्दी)' },
  { value: 'Arabic (العربية)', label: 'Arabic (العربية)' },
];

const DEFAULT_OPTS: TranscriptionOptions = {
  language: 'auto',
  translateToEnglish: false,
  identifySpeakers: false,
  timestampInterval: 'turn',
  autoAnalyze: false,
};

function cuesToSegments(cues: SubtitleCue[]) {
  return cues.map((c) => ({
    id: c.id,
    startSec: c.startSec,
    endSec: c.endSec,
    speaker: c.speaker,
    text: c.text,
  }));
}

export function SubtitleStudioTab({
  savedJobs,
  initialJob = null,
  onConsumeInitialJob,
  onError,
}: SubtitleStudioTabProps) {
  const [subMode, setSubMode] = useState<'studio' | 'converter'>('studio');

  // --- AI Video / Audio Subtitle Studio State ---
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [isAudioSource, setIsAudioSource] = useState<boolean>(false);
  const [language, setLanguage] = useState<string>('auto');
  const [maxWordsPerCue, setMaxWordsPerCue] = useState<number>(9);
  const [identifySpeakers, setIdentifySpeakers] = useState<boolean>(false);

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [genJob, setGenJob] = useState<ToolJob | null>(null);
  const [renderJob, setRenderJob] = useState<ToolJob | null>(null);
  const [sourceToolJobId, setSourceToolJobId] = useState<string | null>(null);

  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [styleConfig, setStyleConfig] = useState<SubtitleStyleConfig>({
    ...DEFAULT_SUBTITLE_STYLE,
  });
  const [currentTime, setCurrentTime] = useState<number>(0);

  const mediaFileInputRef = useRef<HTMLInputElement | null>(null);
  const srtImportInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const genEsRef = useRef<EventSource | null>(null);
  const renderEsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      genEsRef.current?.close();
      renderEsRef.current?.close();
      if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialJob || initialJob.segments.length === 0) return;
    const generatedCues = splitSegmentsIntoSubtitleCues(initialJob.segments, maxWordsPerCue);
    setSubMode('studio');
    setCues(generatedCues);
    setIsAudioSource(initialJob.sourceKind === 'audio');
    setLanguage(initialJob.options.language || 'auto');
    setStyleConfig((prev) => ({
      ...prev,
      audioTitle: initialJob.title.replace(/\.[^.]+$/, ''),
      templateId:
        initialJob.options.language.toLowerCase().includes('urdu') &&
        !initialJob.options.language.toLowerCase().includes('roman')
          ? 'urdu-editorial'
          : prev.templateId,
    }));
    onConsumeInitialJob?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJob]);

  const completedLibraryJobs = useMemo(
    () => savedJobs.filter((j) => j.status === 'completed' && j.segments.length > 0),
    [savedJobs],
  );

  const activeTemplate = useMemo(
    () => getSubtitleTemplate(styleConfig.templateId),
    [styleConfig.templateId],
  );

  const activeCue = useMemo(() => {
    return cues.find((c) => currentTime >= c.startSec && currentTime <= c.endSec) || null;
  }, [cues, currentTime]);

  const handleSelectMediaFile = (file: File) => {
    onError(null);
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    const url = URL.createObjectURL(file);
    const audioGuess =
      file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name);

    setMediaFile(file);
    setMediaPreviewUrl(url);
    setIsAudioSource(audioGuess);
    setSourceToolJobId(null);
    setGenJob(null);
    setRenderJob(null);
    setCurrentTime(0);

    const baseTitle = file.name.replace(/\.[^.]+$/, '').trim() || 'Audio Recording';
    setStyleConfig((prev) => ({
      ...prev,
      audioTitle: baseTitle,
    }));
  };

  const subscribeJob = (
    jobId: string,
    esStore: typeof genEsRef,
    onUpdate: (job: ToolJob) => void,
  ) => {
    esStore.current?.close();
    const es = new EventSource(`/api/tools/jobs/${jobId}/stream`);
    esStore.current = es;

    es.onmessage = (ev) => {
      try {
        const updated = JSON.parse(ev.data) as ToolJob;
        onUpdate(updated);
        if (updated.status === 'completed' || updated.status === 'error') {
          es.close();
          esStore.current = null;
        }
      } catch {
        // Ignore parse error
      }
    };

    es.onerror = () => {
      es.close();
      esStore.current = null;
      void fetch(`/api/tools/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: ToolJob | null) => {
          if (data) {
            onUpdate(data);
            if (data.status === 'processing' || data.status === 'queued') {
              setTimeout(() => subscribeJob(jobId, esStore, onUpdate), 1500);
            }
          }
        })
        .catch(() => {});
    };
  };

  const handleGenerateSubtitles = async () => {
    if (!mediaFile) return;
    onError(null);
    setUploadPct(0);
    setRenderJob(null);

    try {
      const uploadId = await uploadFileChunked(mediaFile, (pct) => {
        setUploadPct(pct);
      });
      setUploadPct(null);

      const res = await fetch('/api/tools/subtitles/generate-from-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          language,
          maxWordsPerCue,
          identifySpeakers,
        }),
      });

      const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(job.error || `Failed to start subtitle generation (${res.status}).`);
      }

      setGenJob(job);
      setSourceToolJobId(job.id);
      subscribeJob(job.id, genEsRef, (updated) => {
        setGenJob(updated);
        if (updated.sourceIsAudio !== undefined) {
          setIsAudioSource(updated.sourceIsAudio);
        }
        if (updated.status === 'completed' && updated.cues) {
          setCues(updated.cues);
          if (language.toLowerCase().includes('urdu') && !language.toLowerCase().includes('roman')) {
            setStyleConfig((prev) => ({
              ...prev,
              templateId: 'urdu-editorial',
              includeSpeakers: identifySpeakers,
            }));
          } else {
            setStyleConfig((prev) => ({
              ...prev,
              includeSpeakers: identifySpeakers,
            }));
          }
        }
      });
    } catch (err) {
      setUploadPct(null);
      onError(err instanceof Error ? err.message : 'Subtitle generation failed.');
    }
  };

  const handleRenderMp4 = async () => {
    if (cues.length === 0) {
      onError('Generate or import subtitle cues first.');
      return;
    }
    if (!sourceToolJobId && !mediaFile) {
      onError('Upload a video or audio file to render burned-in MP4 subtitles.');
      return;
    }

    onError(null);
    setRenderJob(null);

    try {
      let uploadId: string | undefined;
      if (!sourceToolJobId && mediaFile) {
        setUploadPct(0);
        uploadId = await uploadFileChunked(mediaFile, (pct) => setUploadPct(pct));
        setUploadPct(null);
      }

      const res = await fetch('/api/tools/subtitles/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceToolJobId: sourceToolJobId || undefined,
          uploadId,
          cues,
          styleConfig,
        }),
      });

      const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(job.error || `Subtitle render failed (${res.status}).`);
      }

      setRenderJob(job);
      subscribeJob(job.id, renderEsRef, (updated) => {
        setRenderJob(updated);
      });
    } catch (err) {
      setUploadPct(null);
      onError(err instanceof Error ? err.message : 'Could not render subtitled MP4.');
    }
  };

  const handleImportFromLibrary = (jobId: string) => {
    const found = completedLibraryJobs.find((j) => j.id === jobId);
    if (!found) return;
    const generatedCues = splitSegmentsIntoSubtitleCues(found.segments, maxWordsPerCue);
    setCues(generatedCues);
    setStyleConfig((prev) => ({
      ...prev,
      audioTitle: found.title.replace(/\.[^.]+$/, ''),
      templateId:
        found.options.language.toLowerCase().includes('urdu') &&
        !found.options.language.toLowerCase().includes('roman')
          ? 'urdu-editorial'
          : prev.templateId,
    }));
  };

  const handleImportSubtitleFile = async (file: File) => {
    const raw = await file.text();
    const segs = parseSubtitleOrTranscriptText(raw);
    if (segs.length === 0) {
      onError('Could not detect timestamped subtitle lines in that file.');
      return;
    }
    setCues(
      segs.map((s) => ({
        id: s.id,
        startSec: s.startSec,
        endSec: s.endSec,
        speaker: s.speaker,
        text: s.text,
      })),
    );
  };

  const seekMediaTo = (sec: number) => {
    setCurrentTime(sec);
    if (previewVideoRef.current) {
      previewVideoRef.current.currentTime = sec;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.currentTime = sec;
    }
  };

  const updateCueText = (id: string, text: string) => {
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, text } : c)));
  };

  const deleteCue = (id: string) => {
    setCues((prev) => prev.filter((c) => c.id !== id));
  };

  const addCue = () => {
    const lastEnd = cues.length > 0 ? cues[cues.length - 1].endSec : currentTime;
    const startSec = Number(lastEnd.toFixed(2));
    const endSec = Number((startSec + 3).toFixed(2));
    setCues((prev) => [
      ...prev,
      {
        id: `cue_${Date.now()}`,
        startSec,
        endSec,
        text: 'New subtitle line',
      },
    ]);
  };

  const exportBaseName = safeBaseFilename(
    mediaFile?.name.replace(/\.[^.]+$/, '') || styleConfig.audioTitle || 'subtitles',
  );

  const handleExportStudioPdf = async () => {
    if (cues.length === 0) return;
    const segments = cuesToSegments(cues);
    const syntheticJob: TranscriptionJob = {
      id: 'studio_sub_pdf',
      title: styleConfig.audioTitle || mediaFile?.name || 'Synced Subtitles',
      sourceKind: isAudioSource ? 'audio' : 'video',
      status: 'completed',
      stageLabel: 'Ready',
      progressPercent: 100,
      totalChunks: 1,
      completedChunks: 1,
      durationSeconds: cues[cues.length - 1]?.endSec || 0,
      options: {
        ...DEFAULT_OPTS,
        language,
        identifySpeakers: styleConfig.includeSpeakers,
      },
      segments,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await exportTranscriptToPdf(syntheticJob, {
      layout: 'paragraphs',
      includeTimestamps: true,
      includeSpeakers: styleConfig.includeSpeakers,
      includeAnalysis: false,
    });
  };

  const isGenerating = genJob?.status === 'processing' || genJob?.status === 'queued';
  const isRendering = renderJob?.status === 'processing' || renderJob?.status === 'queued';
  const isBusy = uploadPct !== null || isGenerating || isRendering;

  const isUrduSample =
    language.toLowerCase().includes('urdu') && !language.toLowerCase().includes('roman');

  // --- Sub-Mode 2: SRT / VTT Converter & Shifter State ---
  const [subRawText, setSubRawText] = useState('');
  const [subTitle, setSubTitle] = useState('Subtitle_Document');
  const [subShiftSec, setSubShiftSec] = useState<string>('0');
  const [subCopied, setSubCopied] = useState(false);
  const subFileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedSubSegments = useMemo(() => {
    const base = parseSubtitleOrTranscriptText(subRawText);
    const shiftVal = Number.parseFloat(subShiftSec || '0');
    return Number.isFinite(shiftVal) && shiftVal !== 0
      ? shiftSegmentTimestamps(base, shiftVal)
      : base;
  }, [subRawText, subShiftSec]);

  const parsedSubParagraphs = useMemo(
    () => groupSegmentsIntoParagraphs(parsedSubSegments),
    [parsedSubSegments],
  );

  const handleSubtitleFileUpload = async (file: File) => {
    const text = await file.text();
    setSubRawText(text);
    setSubTitle(file.name.replace(/\.[^.]+$/, '') || 'Subtitle_Document');
  };

  const handleExportConverterPdf = async () => {
    if (parsedSubSegments.length === 0) return;
    const syntheticJob: TranscriptionJob = {
      id: 'sub_export',
      title: subTitle || 'Converted Transcript',
      sourceKind: 'video',
      status: 'completed',
      stageLabel: 'Ready',
      progressPercent: 100,
      totalChunks: 1,
      completedChunks: 1,
      durationSeconds: parsedSubSegments[parsedSubSegments.length - 1]?.endSec || 0,
      options: DEFAULT_OPTS,
      segments: parsedSubSegments,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await exportTranscriptToPdf(syntheticJob, {
      layout: 'paragraphs',
      includeTimestamps: true,
      includeSpeakers: false,
      includeAnalysis: false,
    });
  };

  const backdropTheme = AUDIO_BACKDROP_THEMES[styleConfig.audioBackdrop];

  const previewPositionClass =
    styleConfig.position === 'top'
      ? 'top-4'
      : styleConfig.position === 'lower-third'
        ? 'bottom-14'
        : 'bottom-5';

  const previewTextSizeClass =
    styleConfig.fontSize === 'small'
      ? 'text-xs sm:text-sm'
      : styleConfig.fontSize === 'large'
        ? 'text-base sm:text-xl'
        : 'text-sm sm:text-base';

  return (
    <div className="space-y-5">
      {/* Sub-mode Toggle Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-[#F1F5F9] rounded-lg max-w-full overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubMode('studio')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              subMode === 'studio'
                ? 'bg-white text-[#0F172A] shadow-xs'
                : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            <Film className="w-3.5 h-3.5" aria-hidden="true" />
            <span>AI Video &amp; Audio Subtitle Studio</span>
          </button>
          <button
            type="button"
            onClick={() => setSubMode('converter')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
              subMode === 'converter'
                ? 'bg-white text-[#0F172A] shadow-xs'
                : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            <Subtitles className="w-3.5 h-3.5" aria-hidden="true" />
            <span>SRT / VTT Editor &amp; Shifter</span>
          </button>
        </div>

        {subMode === 'studio' && completedLibraryJobs.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="import-lib-job" className="text-xs text-[#64748B] whitespace-nowrap">
              Load from Library:
            </label>
            <select
              id="import-lib-job"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) handleImportFromLibrary(e.target.value);
              }}
              className="h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] max-w-[240px]"
            >
              <option value="" disabled>
                Choose saved transcript...
              </option>
              {completedLibraryJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title} ({formatDuration(j.durationSeconds)})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {subMode === 'studio' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* LEFT COLUMN: Source Upload, AI Generation & Professional Templates */}
          <div className="lg:col-span-7 space-y-5">
            {/* Step 1: Media Source & Auto-Subtitle Generation */}
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#0F172A]">
                    1. Video or Audio Source
                  </h2>
                  <p className="mt-0.5 text-xs text-[#64748B]">
                    Upload any video to burn in crisp subtitles, or upload MP3/WAV audio to generate a subtitled Studio MP4 video.
                  </p>
                </div>

                <div>
                  <input
                    ref={srtImportInputRef}
                    type="file"
                    accept=".srt,.vtt,.txt"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImportSubtitleFile(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => srtImportInputRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-medium text-[#334155] bg-[#F8FAFC] border border-[#CBD5E1] hover:bg-[#F1F5F9] rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Import .SRT / .VTT
                  </button>
                </div>
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => mediaFileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    mediaFileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleSelectMediaFile(f);
                }}
                className="border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB]/60 bg-[#F8FAFC] rounded-xl p-5 text-center cursor-pointer transition-colors"
              >
                <input
                  ref={mediaFileInputRef}
                  type="file"
                  accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.ogg,.flac"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleSelectMediaFile(f);
                  }}
                />
                {mediaFile ? (
                  <div className="flex items-center justify-center gap-3">
                    {isAudioSource ? (
                      <FileAudio className="w-6 h-6 text-[#2563EB] shrink-0" aria-hidden="true" />
                    ) : (
                      <FileVideo className="w-6 h-6 text-[#2563EB] shrink-0" aria-hidden="true" />
                    )}
                    <div className="text-left min-w-0">
                      <p className="text-sm font-semibold text-[#0F172A] truncate max-w-md">
                        {mediaFile.name}
                      </p>
                      <p className="font-mono text-xs text-[#64748B] tabular-nums">
                        {formatBytes(mediaFile.size)} · {isAudioSource ? 'Audio → Studio MP4' : 'Video → Burned-in MP4'} · Click to replace
                      </p>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Upload className="w-5 h-5 text-[#2563EB] mx-auto mb-1.5" aria-hidden="true" />
                    <p className="text-sm font-medium text-[#0F172A]">
                      Drop a video or audio file here, or click to select
                    </p>
                    <p className="mt-1 text-xs text-[#64748B]">
                      MP4, MOV, MKV, WEBM, MP3, WAV, M4A, FLAC (up to 10 GB)
                    </p>
                  </div>
                )}
              </div>

              {/* Generation Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                <div className="sm:col-span-5">
                  <label
                    htmlFor="sub-lang"
                    className="block text-xs font-medium text-[#475569] mb-1.5"
                  >
                    Spoken Language &amp; Script
                  </label>
                  <select
                    id="sub-lang"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                  >
                    {LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-3">
                  <label
                    htmlFor="sub-density"
                    className="block text-xs font-medium text-[#475569] mb-1.5"
                  >
                    Words per Cue
                  </label>
                  <select
                    id="sub-density"
                    value={maxWordsPerCue}
                    onChange={(e) => setMaxWordsPerCue(Number(e.target.value))}
                    className="w-full h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                  >
                    <option value={5}>Short (5 words)</option>
                    <option value={9}>Balanced (9 words)</option>
                    <option value={14}>Wide (14 words)</option>
                  </select>
                </div>

                <div className="sm:col-span-4 flex items-center justify-between sm:justify-end gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs text-[#334155] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={identifySpeakers}
                      onChange={(e) => setIdentifySpeakers(e.target.checked)}
                      className="rounded border-[#CBD5E1] text-[#2563EB]"
                    />
                    <span>Speakers</span>
                  </label>

                  <button
                    type="button"
                    disabled={!mediaFile || isBusy}
                    onClick={() => void handleGenerateSubtitles()}
                    className="inline-flex items-center gap-1.5 px-3.5 h-9 text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] disabled:opacity-45 rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                  >
                    {isGenerating || uploadPct !== null ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>Generate Subtitles</span>
                  </button>
                </div>
              </div>

              {(uploadPct !== null || genJob) && (
                <div className="pt-1 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[#334155] font-medium">
                      {uploadPct !== null
                        ? 'Uploading media chunks...'
                        : genJob?.status === 'error'
                          ? genJob.error || genJob.stageLabel
                          : genJob?.stageLabel}
                    </span>
                    <span className="font-mono text-[#2563EB] tabular-nums">
                      {uploadPct !== null ? `${uploadPct}%` : `${genJob?.progressPercent ?? 0}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 ${
                        genJob?.status === 'error' ? 'bg-[#DC2626]' : 'bg-[#2563EB]'
                      }`}
                      style={{
                        width: `${Math.max(4, uploadPct !== null ? uploadPct : genJob?.progressPercent ?? 0)}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Step 2: 8 Professional Editorial & Broadcast Templates */}
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-base font-semibold text-[#0F172A]">
                    2. Professional Subtitle Templates
                  </h2>
                  <p className="mt-0.5 text-xs text-[#64748B]">
                    Broadcast, documentary, cinema, corporate, and Urdu RTL styles built for legibility.
                  </p>
                </div>
                <span className="font-mono text-xs text-[#64748B]">
                  {SUBTITLE_TEMPLATES.length} templates
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SUBTITLE_TEMPLATES.map((tpl) => {
                  const selected = styleConfig.templateId === tpl.id;
                  const sampleLine =
                    tpl.isRtlOptimized || isUrduSample
                      ? 'یہ ایک واضح اور معیاری سب ٹائٹل مثال ہے۔'
                      : tpl.hasSpeakerAccent
                        ? 'Host: Clear studio audio with balanced spacing.'
                        : 'Clear typography engineered for broadcast clarity.';

                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() =>
                        setStyleConfig((prev) => ({ ...prev, templateId: tpl.id }))
                      }
                      className={`text-left rounded-xl border overflow-hidden transition-colors cursor-pointer ${
                        selected
                          ? 'border-[#2563EB] ring-2 ring-[#2563EB]/15 bg-[#EFF6FF]/40'
                          : 'border-[#E2E8F0] hover:border-[#94A3B8] bg-white'
                      }`}
                    >
                      {/* Miniature Frame Preview */}
                      <div
                        className={`h-20 px-3 flex items-end justify-center pb-2.5 ${tpl.previewBgClass}`}
                      >
                        <span
                          dir={tpl.isRtlOptimized || isUrduSample ? 'rtl' : 'ltr'}
                          className="inline-block px-2.5 py-1 rounded text-[11px] leading-snug max-w-full text-center"
                          style={{
                            fontFamily: tpl.fontFamily,
                            color: tpl.textHex,
                            backgroundColor: tpl.bgRgba,
                            border:
                              tpl.borderColor !== 'transparent'
                                ? `1px solid ${tpl.borderColor}`
                                : 'none',
                            fontWeight: tpl.bold ? 700 : 500,
                            textShadow:
                              tpl.bgRgba === 'transparent'
                                ? '0 1px 3px rgba(0,0,0,0.9)'
                                : 'none',
                          }}
                        >
                          {sampleLine}
                        </span>
                      </div>

                      <div className="px-3.5 py-2.5 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[#0F172A] truncate">
                            {tpl.name}
                          </p>
                          <p className="text-[11px] text-[#64748B] truncate">{tpl.category}</p>
                        </div>
                        {selected && (
                          <Check
                            className="w-4 h-4 text-[#2563EB] shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Placement, Size & Speaker Fine-Tuning */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[#F1F5F9]">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1.5">
                    Position
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: 'bottom', label: 'Bottom' },
                        { id: 'lower-third', label: 'Lower 3rd' },
                        { id: 'top', label: 'Top' },
                      ] as Array<{ id: SubtitlePosition; label: string }>
                    ).map((pos) => (
                      <button
                        key={pos.id}
                        type="button"
                        onClick={() =>
                          setStyleConfig((prev) => ({ ...prev, position: pos.id }))
                        }
                        className={`py-1.5 text-[11px] font-medium rounded-md border cursor-pointer ${
                          styleConfig.position === pos.id
                            ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                            : 'bg-white border-[#E2E8F0] text-[#475569]'
                        }`}
                      >
                        {pos.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1.5">
                    Font Size
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: 'small', label: 'Small' },
                        { id: 'standard', label: 'Standard' },
                        { id: 'large', label: 'Large' },
                      ] as Array<{ id: SubtitleFontSize; label: string }>
                    ).map((sz) => (
                      <button
                        key={sz.id}
                        type="button"
                        onClick={() =>
                          setStyleConfig((prev) => ({ ...prev, fontSize: sz.id }))
                        }
                        className={`py-1.5 text-[11px] font-medium rounded-md border cursor-pointer ${
                          styleConfig.fontSize === sz.id
                            ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                            : 'bg-white border-[#E2E8F0] text-[#475569]'
                        }`}
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-xs text-[#334155] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={styleConfig.includeSpeakers}
                      onChange={(e) =>
                        setStyleConfig((prev) => ({
                          ...prev,
                          includeSpeakers: e.target.checked,
                        }))
                      }
                      className="rounded border-[#CBD5E1] text-[#2563EB]"
                    />
                    <span>Show speaker prefix</span>
                  </label>
                </div>
              </div>

              {/* Audio-to-Subtitled-MP4 Canvas Controls (shown whenever source is audio) */}
              {isAudioSource && (
                <div className="p-3.5 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-[#0F172A]">
                      Audio-to-Video Studio Canvas (1280×720 MP4)
                    </p>
                    <label className="inline-flex items-center gap-1.5 text-xs text-[#334155] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={styleConfig.showWaveform}
                        onChange={(e) =>
                          setStyleConfig((prev) => ({
                            ...prev,
                            showWaveform: e.target.checked,
                          }))
                        }
                        className="rounded border-[#CBD5E1] text-[#2563EB]"
                      />
                      <span>Include live waveform</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-[#475569] mb-1">
                        Canvas Backdrop Theme
                      </label>
                      <select
                        value={styleConfig.audioBackdrop}
                        onChange={(e) =>
                          setStyleConfig((prev) => ({
                            ...prev,
                            audioBackdrop: e.target.value as AudioVideoBackdrop,
                          }))
                        }
                        className="w-full h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                      >
                        {Object.entries(AUDIO_BACKDROP_THEMES).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-[#475569] mb-1">
                        Video Title Header
                      </label>
                      <input
                        type="text"
                        dir="auto"
                        value={styleConfig.audioTitle}
                        onChange={(e) =>
                          setStyleConfig((prev) => ({ ...prev, audioTitle: e.target.value }))
                        }
                        placeholder="Episode or Lecture Title"
                        className="w-full h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: Live Subtitle Stage, Cue Editor & MP4 / Caption Exports */}
          <div className="lg:col-span-5 space-y-5">
            {/* Live Synchronized Video / Audio Preview Stage */}
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                  Live Subtitle Preview
                </h3>
                <span className="font-mono text-xs text-[#64748B] tabular-nums">
                  {formatDuration(currentTime)} · {cues.length} cues
                </span>
              </div>

              {!mediaPreviewUrl ? (
                <div className="aspect-video rounded-lg bg-[#0F172A] flex flex-col items-center justify-center p-6 text-center relative overflow-hidden">
                  <p className="text-xs text-[#94A3B8] max-w-xs leading-relaxed">
                    Upload a video or audio file to preview your chosen template live before exporting MP4.
                  </p>
                  <div className={`absolute inset-x-4 ${previewPositionClass} flex justify-center`}>
                    <span
                      dir={activeTemplate.isRtlOptimized || isUrduSample ? 'rtl' : 'ltr'}
                      className={`inline-block px-3 py-1.5 rounded max-w-[92%] text-center ${previewTextSizeClass}`}
                      style={{
                        fontFamily: activeTemplate.fontFamily,
                        color: activeTemplate.textHex,
                        backgroundColor: activeTemplate.bgRgba,
                        border:
                          activeTemplate.borderColor !== 'transparent'
                            ? `1px solid ${activeTemplate.borderColor}`
                            : 'none',
                        fontWeight: activeTemplate.bold ? 700 : 500,
                        textShadow:
                          activeTemplate.bgRgba === 'transparent'
                            ? '0 1px 4px rgba(0,0,0,0.92)'
                            : 'none',
                      }}
                    >
                      {activeCue?.text ||
                        (activeTemplate.isRtlOptimized || isUrduSample
                          ? 'یہ آپ کے سب ٹائٹل ٹیمپلیٹ کا لائیو پیش نظارہ ہے۔'
                          : 'Live template preview will synchronize with your timeline.')}
                    </span>
                  </div>
                </div>
              ) : isAudioSource ? (
                <div className="space-y-2.5">
                  <div
                    className="aspect-video rounded-lg relative overflow-hidden flex flex-col items-center justify-center px-6 border"
                    style={{
                      backgroundColor: backdropTheme.hex,
                      borderColor: backdropTheme.borderHex,
                    }}
                  >
                    {styleConfig.audioTitle && (
                      <p
                        dir="auto"
                        className="absolute top-6 inset-x-6 text-center font-display text-sm sm:text-base font-semibold truncate"
                        style={{ color: backdropTheme.titleHex }}
                      >
                        {styleConfig.audioTitle}
                      </p>
                    )}

                    {styleConfig.showWaveform && (
                      <div className="flex items-center justify-center gap-1 h-12 opacity-80">
                        {[24, 42, 68, 36, 85, 52, 92, 40, 74, 58, 88, 34, 62, 46, 78, 30, 50, 38].map(
                          (h, idx) => (
                            <span
                              key={idx}
                              className="w-1 rounded-full"
                              style={{
                                height: `${h}%`,
                                backgroundColor: backdropTheme.waveHex,
                              }}
                            />
                          ),
                        )}
                      </div>
                    )}

                    {activeCue && (
                      <div
                        className={`absolute inset-x-4 ${previewPositionClass} flex justify-center pointer-events-none`}
                      >
                        <span
                          dir="auto"
                          className={`inline-block px-3 py-1.5 rounded max-w-[92%] text-center leading-snug ${previewTextSizeClass}`}
                          style={{
                            fontFamily: activeTemplate.fontFamily,
                            color: activeTemplate.textHex,
                            backgroundColor: activeTemplate.bgRgba,
                            border:
                              activeTemplate.borderColor !== 'transparent'
                                ? `1px solid ${activeTemplate.borderColor}`
                                : 'none',
                            fontWeight: activeTemplate.bold ? 700 : 500,
                            textShadow:
                              activeTemplate.bgRgba === 'transparent'
                                ? '0 1px 4px rgba(0,0,0,0.92)'
                                : 'none',
                          }}
                        >
                          {styleConfig.includeSpeakers && activeCue.speaker
                            ? `${activeCue.speaker}: ${activeCue.text}`
                            : activeCue.text}
                        </span>
                      </div>
                    )}
                  </div>

                  <audio
                    ref={previewAudioRef}
                    src={mediaPreviewUrl}
                    controls
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    className="w-full"
                  />
                </div>
              ) : (
                <div className="relative aspect-video rounded-lg overflow-hidden bg-[#0F172A] border border-[#E2E8F0]">
                  <video
                    ref={previewVideoRef}
                    src={mediaPreviewUrl}
                    controls
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    className="w-full h-full object-contain"
                  />
                  {activeCue && (
                    <div
                      className={`absolute inset-x-4 ${previewPositionClass} flex justify-center pointer-events-none`}
                    >
                      <span
                        dir="auto"
                        className={`inline-block px-3 py-1 rounded max-w-[92%] text-center leading-snug ${previewTextSizeClass}`}
                        style={{
                          fontFamily: activeTemplate.fontFamily,
                          color: activeTemplate.textHex,
                          backgroundColor: activeTemplate.bgRgba,
                          border:
                            activeTemplate.borderColor !== 'transparent'
                              ? `1px solid ${activeTemplate.borderColor}`
                              : 'none',
                          fontWeight: activeTemplate.bold ? 700 : 500,
                          textShadow:
                            activeTemplate.bgRgba === 'transparent'
                              ? '0 1px 4px rgba(0,0,0,0.92)'
                              : 'none',
                        }}
                      >
                        {styleConfig.includeSpeakers && activeCue.speaker
                          ? `${activeCue.speaker}: ${activeCue.text}`
                          : activeCue.text}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Export Actions */}
              <div className="space-y-2.5 pt-1">
                <button
                  type="button"
                  disabled={cues.length === 0 || (!sourceToolJobId && !mediaFile) || isBusy}
                  onClick={() => void handleRenderMp4()}
                  className="w-full py-2.5 px-4 min-h-[42px] inline-flex items-center justify-center gap-2 text-sm font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer transition-colors"
                >
                  {isRendering ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Film className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>
                    {isAudioSource
                      ? 'Render Audio-to-Subtitled MP4'
                      : 'Burn Subtitles into MP4'}
                  </span>
                </button>

                <div className="grid grid-cols-4 gap-1.5">
                  <button
                    type="button"
                    disabled={cues.length === 0}
                    onClick={() =>
                      downloadTextFile(`${exportBaseName}.srt`, toSRT(cuesToSegments(cues)))
                    }
                    className="h-9 text-xs font-mono font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] disabled:opacity-40 rounded-lg cursor-pointer"
                  >
                    .SRT
                  </button>
                  <button
                    type="button"
                    disabled={cues.length === 0}
                    onClick={() =>
                      downloadTextFile(`${exportBaseName}.vtt`, toVTT(cuesToSegments(cues)))
                    }
                    className="h-9 text-xs font-mono font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] disabled:opacity-40 rounded-lg cursor-pointer"
                  >
                    .VTT
                  </button>
                  <button
                    type="button"
                    disabled={cues.length === 0}
                    onClick={() =>
                      downloadTextFile(
                        `${exportBaseName}.ass`,
                        generateAssDocument(cues, styleConfig, 1280, 720),
                      )
                    }
                    className="h-9 text-xs font-mono font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] disabled:opacity-40 rounded-lg cursor-pointer"
                  >
                    .ASS
                  </button>
                  <button
                    type="button"
                    disabled={cues.length === 0}
                    onClick={() => void handleExportStudioPdf()}
                    className="h-9 text-xs font-semibold text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] hover:bg-[#DBEAFE] disabled:opacity-40 rounded-lg cursor-pointer"
                  >
                    PDF
                  </button>
                </div>
              </div>

              {/* MP4 Render Progress & Download Output */}
              {renderJob && (
                <div className="pt-3 border-t border-[#F1F5F9] space-y-3">
                  {renderJob.status === 'processing' || renderJob.status === 'queued' ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#0F172A]">
                          <Loader2
                            className="w-3.5 h-3.5 text-[#2563EB] animate-spin"
                            aria-hidden="true"
                          />
                          <span>{renderJob.stageLabel}</span>
                        </span>
                        <span className="font-mono text-[#2563EB] tabular-nums">
                          {renderJob.progressPercent}%
                        </span>
                      </div>
                      <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#2563EB] transition-all duration-200"
                          style={{ width: `${Math.max(5, renderJob.progressPercent)}%` }}
                        />
                      </div>
                    </div>
                  ) : renderJob.status === 'error' ? (
                    <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C] flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{renderJob.error || renderJob.stageLabel}</span>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#16A34A]">
                          <Check className="w-4 h-4" aria-hidden="true" />
                          <span>{renderJob.stageLabel}</span>
                        </span>
                        {renderJob.outputBytes && (
                          <span className="font-mono text-[#64748B] tabular-nums">
                            {formatBytes(renderJob.outputBytes)}
                          </span>
                        )}
                      </div>
                      <div className="rounded-lg overflow-hidden border border-[#E2E8F0] bg-[#0F172A]">
                        <video
                          src={`/api/tools/jobs/${renderJob.id}/file?inline=1`}
                          controls
                          className="w-full max-h-[210px]"
                        />
                      </div>
                      <a
                        href={`/api/tools/jobs/${renderJob.id}/file`}
                        download={renderJob.outputFilename || true}
                        className="w-full py-2 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] rounded-lg"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Download Subtitled MP4</span>
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Cue List Inline Editor */}
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                  Subtitle Cues Editor
                </h3>
                <button
                  type="button"
                  onClick={addCue}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[#2563EB] bg-[#EFF6FF] hover:bg-[#DBEAFE] rounded-md cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Cue</span>
                </button>
              </div>

              {cues.length === 0 ? (
                <p className="text-xs text-[#64748B] py-8 text-center leading-relaxed">
                  Click &ldquo;Generate Subtitles&rdquo; after selecting a file, import an .SRT/.VTT file, or load a transcript from your Library.
                </p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto divide-y divide-[#F1F5F9] pr-1">
                  {cues.map((cue) => {
                    const isPlayingNow =
                      currentTime >= cue.startSec && currentTime <= cue.endSec;
                    return (
                      <div
                        key={cue.id}
                        className={`py-2.5 flex items-start gap-2.5 rounded px-1.5 ${
                          isPlayingNow ? 'bg-[#EFF6FF]/60' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => seekMediaTo(cue.startSec)}
                          title="Jump preview to this subtitle"
                          className="font-mono text-[11px] text-[#2563EB] hover:underline tabular-nums shrink-0 pt-1 cursor-pointer"
                        >
                          {formatDuration(cue.startSec)}
                        </button>
                        <input
                          type="text"
                          dir="auto"
                          value={cue.text}
                          onChange={(e) => updateCueText(cue.id, e.target.value)}
                          className="flex-1 min-w-0 text-xs text-[#0F172A] bg-transparent border border-transparent focus:border-[#CBD5E1] focus:bg-white rounded px-1.5 py-1 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => deleteCue(cue.id)}
                          aria-label="Delete subtitle cue"
                          className="p-1 text-[#94A3B8] hover:text-[#DC2626] shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* SUB-MODE 2: SRT / VTT CONVERTER, TIME SHIFTER & PDF BUILDER */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#0F172A]">
                  Subtitle Converter, Time Shifter &amp; PDF Builder
                </h2>
                <p className="mt-1 text-xs text-[#64748B]">
                  Convert SRT, WebVTT, or timestamped text, shift out-of-sync captions by seconds, or turn any subtitle file into a structured PDF.
                </p>
              </div>
              <div>
                <input
                  ref={subFileInputRef}
                  type="file"
                  accept=".srt,.vtt,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSubtitleFileUpload(f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => subFileInputRef.current?.click()}
                  className="px-3 py-2 text-xs font-medium text-[#0F172A] bg-[#F8FAFC] border border-[#CBD5E1] hover:bg-[#F1F5F9] rounded-lg cursor-pointer"
                >
                  Load .SRT / .VTT / .TXT
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">
                  Document Title (for PDF)
                </label>
                <input
                  type="text"
                  value={subTitle}
                  onChange={(e) => setSubTitle(e.target.value)}
                  className="w-full h-9 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">
                  Shift All Timestamps (seconds, +/-)
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setSubShiftSec((v) => String((Number(v) || 0) - 1))
                    }
                    className="px-2.5 h-9 text-xs font-mono border border-[#CBD5E1] rounded-lg hover:bg-[#F8FAFC] cursor-pointer"
                  >
                    -1s
                  </button>
                  <input
                    type="number"
                    step="0.5"
                    value={subShiftSec}
                    onChange={(e) => setSubShiftSec(e.target.value)}
                    className="w-full h-9 px-2.5 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] text-center"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setSubShiftSec((v) => String((Number(v) || 0) + 1))
                    }
                    className="px-2.5 h-9 text-xs font-mono border border-[#CBD5E1] rounded-lg hover:bg-[#F8FAFC] cursor-pointer"
                  >
                    +1s
                  </button>
                </div>
              </div>
            </div>

            <textarea
              value={subRawText}
              onChange={(e) => setSubRawText(e.target.value)}
              rows={11}
              dir="auto"
              placeholder={`Paste .SRT, .VTT, or [00:12] timestamped transcript lines here...\n\nExample:\n1\n00:00:01,000 --> 00:00:05,000\nWelcome to Hanzx Studio.`}
              className="w-full p-3 font-mono text-xs bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:bg-white focus:border-[#2563EB]"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-mono text-xs text-[#64748B] tabular-nums">
                {parsedSubSegments.length} cues · {parsedSubParagraphs.length} grouped paragraphs
              </span>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={parsedSubSegments.length === 0}
                  onClick={() => void handleExportConverterPdf()}
                  className="inline-flex items-center gap-1.5 px-3 h-9 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>PDF</span>
                </button>
                <button
                  type="button"
                  disabled={parsedSubSegments.length === 0}
                  onClick={() =>
                    downloadTextFile(
                      `${safeBaseFilename(subTitle)}.srt`,
                      toSRT(parsedSubSegments),
                    )
                  }
                  className="px-3 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  SRT
                </button>
                <button
                  type="button"
                  disabled={parsedSubSegments.length === 0}
                  onClick={() =>
                    downloadTextFile(
                      `${safeBaseFilename(subTitle)}.vtt`,
                      toVTT(parsedSubSegments),
                    )
                  }
                  className="px-3 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  VTT
                </button>
                <button
                  type="button"
                  disabled={parsedSubSegments.length === 0}
                  onClick={() =>
                    downloadTextFile(
                      `${safeBaseFilename(subTitle)}.txt`,
                      toParagraphText(parsedSubSegments, true, false),
                    )
                  }
                  className="px-3 h-9 text-xs font-mono font-medium text-[#475569] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  TXT
                </button>
                <button
                  type="button"
                  disabled={parsedSubSegments.length === 0}
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      toParagraphText(parsedSubSegments, true, false),
                    );
                    setSubCopied(true);
                    setTimeout(() => setSubCopied(false), 1600);
                  }}
                  className="px-3 h-9 text-xs font-medium text-[#0F172A] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  {subCopied ? 'Copied' : 'Copy Text'}
                </button>
              </div>
            </div>
          </div>

          {/* Live Paragraph Preview */}
          <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-3">
            <h3 className="font-display text-sm font-semibold text-[#0F172A]">
              Timestamped Paragraph Preview
            </h3>
            {parsedSubParagraphs.length === 0 ? (
              <p className="text-xs text-[#64748B] py-10 text-center leading-relaxed">
                Load or paste an SRT / VTT file on the left to preview shifted timestamps and paragraph grouping before exporting.
              </p>
            ) : (
              <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F1F5F9]">
                {parsedSubParagraphs.slice(0, 40).map((p) => (
                  <div key={p.id} className="py-2.5 flex items-start gap-3">
                    <span className="font-mono text-[11px] text-[#2563EB] tabular-nums shrink-0 pt-0.5">
                      {formatDuration(p.startSec)}
                    </span>
                    <p dir="auto" className="text-xs text-[#334155] leading-relaxed">
                      {p.text}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
