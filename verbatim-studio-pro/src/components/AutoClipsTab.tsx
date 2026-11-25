import {
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Download,
  FileAudio,
  FileText,
  Film,
  KeyRound,
  Loader2,
  Play,
  SlidersHorizontal,
  Sparkles,
  StopCircle,
  Upload,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  AutoClipCandidate,
  ClipAspectRatio,
  ClipFramingMode,
  ClipTitleStyle,
  SubtitleCue,
  SubtitleFontSize,
  SubtitlePosition,
  SubtitleStyleConfig,
  ToolJob,
} from '../types/tools';
import type { TranscriptionJob } from '../types/transcription';
import { uploadFileChunked } from '../utils/chunkedUpload';
import { downloadTextFile, safeBaseFilename, toSRT } from '../utils/exporters';
import { formatBytes, formatDuration } from '../utils/formatters';
import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_TEMPLATES,
  getSubtitleTemplate,
} from '../utils/subtitleTemplates';

interface AutoClipsTabProps {
  savedJobs: TranscriptionJob[];
  onError: (msg: string | null) => void;
}

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect language' },
  { value: 'Urdu (Pure Nastaliq Script)', label: 'Urdu Only (صرف خالص اردو — Pure Script)' },
  { value: 'Roman Urdu (Latin Script)', label: 'Roman Urdu Only' },
  { value: 'Urdu + English (Bilingual)', label: 'Urdu + English' },
  { value: 'English', label: 'English' },
  { value: 'Hindi (हिन्दी)', label: 'Hindi (हिन्दी)' },
  { value: 'Arabic (العربية)', label: 'Arabic (العربية)' },
];

const DURATION_PRESETS = [
  { id: 'short', label: 'Short Reels (20–45s)', minSec: 20, maxSec: 45 },
  { id: 'balanced', label: 'Balanced Clips (25–65s)', minSec: 25, maxSec: 65 },
  { id: 'deep', label: 'Deep Highlights (45–90s)', minSec: 45, maxSec: 90 },
] as const;

export function AutoClipsTab({ savedJobs, onError }: AutoClipsTabProps) {
  // Source & analysis configuration
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [language, setLanguage] = useState<string>('auto');
  const [maxClips, setMaxClips] = useState<number>(5);
  const [durationPreset, setDurationPreset] = useState<'short' | 'balanced' | 'deep'>('balanced');
  const [wordsPerCue, setWordsPerCue] = useState<number>(6);
  const [identifySpeakers, setIdentifySpeakers] = useState<boolean>(false);

  // Upload & analysis job tracking
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [analyzeJob, setAnalyzeJob] = useState<ToolJob | null>(null);
  const [clips, setClips] = useState<AutoClipCandidate[]>([]);

  // Pro Video Setup & Subtitle Styling
  const [aspectRatio, setAspectRatio] = useState<ClipAspectRatio>('9:16');
  const [framingMode, setFramingMode] = useState<ClipFramingMode>('blurred-fit');
  const [showTopTitle, setShowTopTitle] = useState<boolean>(true);
  const [titleStyle, setTitleStyle] = useState<ClipTitleStyle>('banner');
  const [styleConfig, setStyleConfig] = useState<SubtitleStyleConfig>({
    ...DEFAULT_SUBTITLE_STYLE,
    templateId: 'viral-bold',
    fontSize: 'large',
    position: 'lower-third',
  });

  // API key status (key itself lives in .env.local on the server — never shown here)
  const [apiStatus, setApiStatus] = useState<{
    hasApiKey: boolean;
    keySource?: string;
    provider?: string;
    groqConfigured?: boolean;
  } | null>(null);
  const [showApiKeyBox, setShowApiKeyBox] = useState<boolean>(false);
  const [keyMode, setKeyMode] = useState<'groq' | 'gemini'>('groq');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [apiKeyMsg, setApiKeyMsg] = useState<string | null>(null);
  const [savingApiKey, setSavingApiKey] = useState<boolean>(false);

  // Per-clip render jobs & expanded cue editors
  const [clipRenderJobs, setClipRenderJobs] = useState<Record<string, ToolJob>>({});
  const [expandedClipIds, setExpandedClipIds] = useState<Record<string, boolean>>({});
  const [previewingClipId, setPreviewingClipId] = useState<string | null>(null);
  const [batchRendering, setBatchRendering] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const analyzeEsRef = useRef<EventSource | null>(null);
  const renderEsMapRef = useRef<Record<string, EventSource>>({});
  const mountedRef = useRef<boolean>(true);
  const batchStopRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      batchStopRef.current = true;
      analyzeEsRef.current?.close();
      Object.values(renderEsMapRef.current).forEach((es) => es.close());
      if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check once which AI provider is live on the server
  useEffect(() => {
    void fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (data: { hasApiKey?: boolean; keySource?: string; provider?: string; groqConfigured?: boolean } | null) => {
          if (data)
            setApiStatus({
              hasApiKey: Boolean(data.hasApiKey),
              keySource: data.keySource,
              provider: data.provider,
              groqConfigured: Boolean(data.groqConfigured),
            });
        },
      )
      .catch(() => {});
  }, []);

  const handleSaveApiKey = async () => {
    const key = apiKeyInput.trim();
    if (keyMode === 'groq' && !key.startsWith('gsk_')) {
      setApiKeyMsg('Groq key gsk_ se shuru hoti hai — console.groq.com se free key banao.');
      return;
    }
    if (key.length < 20) {
      setApiKeyMsg('Key thori chhoti lag rahi hai — poori key paste karo.');
      return;
    }
    setSavingApiKey(true);
    setApiKeyMsg(null);
    try {
      const endpoint = keyMode === 'groq' ? '/api/settings/groq-key' : '/api/settings/api-key';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; provider?: string };
      if (!res.ok) throw new Error(data.error || 'Key save nahi hui.');
      setApiStatus((prev) => ({
        hasApiKey: keyMode === 'gemini' ? true : Boolean(prev?.hasApiKey),
        keySource: '.env.local',
        provider: data.provider || (keyMode === 'groq' ? 'groq' : prev?.provider),
        groqConfigured: keyMode === 'groq' ? true : Boolean(prev?.groqConfigured),
      }));
      setApiKeyInput('');
      setApiKeyMsg(
        keyMode === 'groq'
          ? 'Groq free key save ho gayi — restart ki zaroorat nahi, ab transcription + clips free mein chalenge.'
          : 'API key save ho gayi — restart ki zaroorat nahi, ab clips bana sakte ho.',
      );
    } catch (err) {
      setApiKeyMsg(err instanceof Error ? err.message : 'Key save nahi hui.');
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleSetProvider = async (provider: 'auto' | 'groq' | 'gemini') => {
    try {
      const res = await fetch('/api/settings/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; provider?: string };
      if (!res.ok) throw new Error(data.error || 'Provider change nahi hua.');
      setApiStatus((prev) => (prev ? { ...prev, provider: data.provider || provider } : prev));
    } catch (err) {
      setApiKeyMsg(err instanceof Error ? err.message : 'Provider change nahi hua.');
    }
  };

  // One-tap professional presets — sets layout + caption style + length together
  const applyPreset = (preset: 'viral' | 'podcast' | 'youtube-hd') => {
    if (preset === 'viral') {
      setAspectRatio('9:16');
      setFramingMode('blurred-fit');
      setDurationPreset('short');
      setWordsPerCue(4);
      setTitleStyle('banner');
      setShowTopTitle(true);
      setStyleConfig((prev) => ({ ...prev, templateId: 'viral-bold', fontSize: 'large', position: 'lower-third' }));
    } else if (preset === 'podcast') {
      setAspectRatio('1:1');
      setFramingMode('blurred-fit');
      setDurationPreset('deep');
      setWordsPerCue(9);
      setTitleStyle('banner');
      setShowTopTitle(true);
      setStyleConfig((prev) => ({ ...prev, templateId: 'lower-third', fontSize: 'standard', position: 'lower-third' }));
    } else {
      setAspectRatio('16:9');
      setDurationPreset('deep');
      setWordsPerCue(9);
      setTitleStyle('minimal');
      setShowTopTitle(true);
      setStyleConfig((prev) => ({ ...prev, templateId: 'cinema-clean', fontSize: 'standard', position: 'bottom' }));
    }
  };

  const completedSessions = savedJobs.filter(
    (j) => j.status === 'completed' && j.segments && j.segments.length > 0,
  );

  const handleSelectFile = (file: File) => {
    if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl);
    const url = URL.createObjectURL(file);
    setMediaFile(file);
    setSourcePreviewUrl(url);
    setAnalyzeJob(null);
    setClips([]);
    setClipRenderJobs({});
    setPreviewingClipId(null);
    onError(null);
  };

  const handleLanguageChange = (nextLang: string) => {
    setLanguage(nextLang);
    const lower = nextLang.toLowerCase();
    if ((lower.includes('urdu') && !lower.includes('roman')) || lower.includes('arabic')) {
      setStyleConfig((prev) => ({ ...prev, templateId: 'urdu-editorial' }));
    }
  };

  const subscribeAnalyzeJob = (jobId: string) => {
    analyzeEsRef.current?.close();
    const es = new EventSource(`/api/tools/jobs/${jobId}/stream`);
    analyzeEsRef.current = es;

    es.onmessage = (ev) => {
      if (!mountedRef.current) return;
      try {
        const updated = JSON.parse(ev.data) as ToolJob;
        setAnalyzeJob(updated);
        if (updated.status === 'completed' && Array.isArray(updated.clips)) {
          setClips(updated.clips);
          if (updated.clips.length > 0) {
            setPreviewingClipId(updated.clips[0].id);
          }
          es.close();
          analyzeEsRef.current = null;
        } else if (updated.status === 'error') {
          onError(updated.error || updated.stageLabel);
          es.close();
          analyzeEsRef.current = null;
        }
      } catch {
        // Ignore malformed SSE frame
      }
    };

    es.onerror = () => {
      es.close();
      analyzeEsRef.current = null;
      void fetch(`/api/tools/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: ToolJob | null) => {
          if (!mountedRef.current || !data) return;
          setAnalyzeJob(data);
          if (data.status === 'completed' && Array.isArray(data.clips)) {
            setClips(data.clips);
          } else if (data.status === 'processing' || data.status === 'queued') {
            setTimeout(() => subscribeAnalyzeJob(jobId), 1500);
          }
        })
        .catch(() => {});
    };
  };

  const handleAnalyzeBestClips = async () => {
    if (!mediaFile) return;
    onError(null);
    setClips([]);
    setClipRenderJobs({});
    setAnalyzeJob(null);
    setUploadPct(0);

    try {
      const uploadId = await uploadFileChunked(mediaFile, (pct) => {
        if (mountedRef.current) setUploadPct(pct);
      });

      const preset = DURATION_PRESETS.find((d) => d.id === durationPreset) || DURATION_PRESETS[1];
      const matchedSession = selectedSessionId
        ? completedSessions.find((s) => s.id === selectedSessionId)
        : undefined;

      const res = await fetch('/api/tools/clips/analyze-from-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          language,
          maxClips,
          minClipSec: preset.minSec,
          maxClipSec: preset.maxSec,
          maxWordsPerCue: wordsPerCue,
          identifySpeakers,
          existingSegments: matchedSession?.segments,
        }),
      });

      const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(job.error || `Clip analysis failed (${res.status}).`);
      }

      setAnalyzeJob(job);
      subscribeAnalyzeJob(job.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not analyze video for best clips.');
    } finally {
      if (mountedRef.current) setUploadPct(null);
    }
  };

  const renderSingleClip = (clip: AutoClipCandidate): Promise<void> => {
    return new Promise((resolve) => {
      if (!analyzeJob?.id) {
        onError('Analyze a video first so the source media is cached for clipping.');
        resolve();
        return;
      }

      void (async () => {
        try {
          onError(null);
          const res = await fetch('/api/tools/clips/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceToolJobId: analyzeJob.id,
              clipTitle: clip.title,
              startSec: clip.startSec,
              endSec: clip.endSec,
              cues: clip.cues,
              aspectRatio,
              framingMode,
              showTopTitle,
              titleStyle,
              styleConfig,
            }),
          });

          const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
          if (!res.ok) {
            throw new Error(job.error || `Clip render failed (${res.status}).`);
          }

          if (!mountedRef.current) {
            resolve();
            return;
          }

          setClipRenderJobs((prev) => ({ ...prev, [clip.id]: job }));

          renderEsMapRef.current[clip.id]?.close();
          const es = new EventSource(`/api/tools/jobs/${job.id}/stream`);
          renderEsMapRef.current[clip.id] = es;

          es.onmessage = (ev) => {
            if (!mountedRef.current) return;
            try {
              const updated = JSON.parse(ev.data) as ToolJob;
              setClipRenderJobs((prev) => ({ ...prev, [clip.id]: updated }));
              if (updated.status === 'completed' || updated.status === 'error') {
                es.close();
                delete renderEsMapRef.current[clip.id];
                resolve();
              }
            } catch {
              // Ignore malformed SSE frame
            }
          };

          es.onerror = () => {
            es.close();
            delete renderEsMapRef.current[clip.id];
            void fetch(`/api/tools/jobs/${job.id}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((data: ToolJob | null) => {
                if (mountedRef.current && data) {
                  setClipRenderJobs((prev) => ({ ...prev, [clip.id]: data }));
                }
              })
              .finally(() => resolve());
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to render clip.';
          onError(msg);
          setClipRenderJobs((prev) => ({
            ...prev,
            [clip.id]: {
              id: `err_${clip.id}`,
              kind: 'auto-clip-render',
              status: 'error',
              title: clip.title,
              stageLabel: 'Clip render failed',
              progressPercent: 0,
              outputFormat: 'MP4',
              error: msg,
              createdAt: Date.now(),
            },
          }));
          resolve();
        }
      })();
    });
  };

  // Render All runs 2 clips in parallel (FFmpeg is CPU-heavy — 2 is the sweet spot)
  const handleRenderAllClips = async () => {
    if (clips.length === 0 || batchRendering) return;
    setBatchRendering(true);
    batchStopRef.current = false;
    onError(null);
    try {
      const queue = clips.filter((c) => clipRenderJobs[c.id]?.status !== 'completed');
      let nextIdx = 0;
      const workers = [0, 1].map(async () => {
        while (mountedRef.current && !batchStopRef.current) {
          const clip = queue[nextIdx++];
          if (!clip) break;
          await renderSingleClip(clip);
        }
      });
      await Promise.all(workers);
    } finally {
      if (mountedRef.current) setBatchRendering(false);
    }
  };

  const updateClipField = (
    clipId: string,
    patch: Partial<Pick<AutoClipCandidate, 'title' | 'startSec' | 'endSec'>>,
  ) => {
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== clipId) return c;
        const nextStart = patch.startSec !== undefined ? Math.max(0, patch.startSec) : c.startSec;
        const nextEnd =
          patch.endSec !== undefined ? Math.max(nextStart + 2, patch.endSec) : Math.max(nextStart + 2, c.endSec);
        return {
          ...c,
          ...patch,
          startSec: Number(nextStart.toFixed(1)),
          endSec: Number(nextEnd.toFixed(1)),
          durationSec: Number((nextEnd - nextStart).toFixed(1)),
        };
      }),
    );
  };

  const updateClipCueText = (clipId: string, cueId: string, text: string) => {
    setClips((prev) =>
      prev.map((c) =>
        c.id !== clipId
          ? c
          : {
              ...c,
              cues: c.cues.map((cue) => (cue.id === cueId ? { ...cue, text } : cue)),
            },
      ),
    );
  };

  const handleDownloadClipSrt = (clip: AutoClipCandidate) => {
    const segs = clip.cues.map((c) => ({
      id: c.id,
      startSec: c.startSec,
      endSec: c.endSec,
      speaker: c.speaker,
      text: c.text,
    }));
    downloadTextFile(`${safeBaseFilename(clip.title)}.srt`, toSRT(segs), 'text/plain;charset=utf-8');
  };

  const isAnalyzing =
    uploadPct !== null ||
    analyzeJob?.status === 'processing' ||
    analyzeJob?.status === 'queued';

  const activeTemplate = getSubtitleTemplate(styleConfig.templateId);
  const previewClip = clips.find((c) => c.id === previewingClipId) || clips[0] || null;
  const bestClipScore = clips.length > 0 ? Math.max(...clips.map((c) => c.score ?? 0)) : 0;
  const samplePreviewLine =
    previewClip?.cues[0]?.text ||
    (language.toLowerCase().includes('urdu') && !language.toLowerCase().includes('roman')
      ? 'یہ آپ کی ویڈیو کا خودکار کلپ اور سب ٹائٹل ہے'
      : 'Your best clip highlights and synced captions appear right here.');
  const isLatinPreview = !/[\u0600-\u06FF\u0900-\u097F]/.test(samplePreviewLine);
  const previewCaptionText =
    activeTemplate.uppercase && isLatinPreview
      ? samplePreviewLine.toUpperCase()
      : samplePreviewLine;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* LEFT COLUMN: UPLOAD, AI CLIP FINDER & PRO VIDEO SETUP */}
      <div className="lg:col-span-5 space-y-5">
        {/* AI PROVIDER STATUS — Groq Free (default) or Gemini. Keys live in .env.local, never shown here */}
        <div className="bg-white border border-[#E2E8F0] rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
          <KeyRound className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
          {apiStatus === null ? (
            <span className="text-xs text-[#64748B]">Checking AI provider...</span>
          ) : apiStatus.provider === 'groq' && apiStatus.groqConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#15803D]">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Groq Free connected — transcription + clips free mein chalenge</span>
            </span>
          ) : apiStatus.provider === 'gemini' && apiStatus.hasApiKey ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#15803D]">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Gemini API connected{apiStatus.keySource ? ` (${apiStatus.keySource})` : ''}</span>
            </span>
          ) : (
            <span className="text-xs font-medium text-[#B91C1C]">
              AI key missing — Groq free key (console.groq.com) lagao, bina card ke.
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowApiKeyBox((v) => !v)}
            className="ml-auto px-3 py-1.5 min-h-[32px] text-xs font-medium text-[#2563EB] bg-[#EFF6FF] hover:bg-[#DBEAFE] rounded-lg cursor-pointer"
          >
            {apiStatus?.groqConfigured || apiStatus?.hasApiKey ? 'Change Key' : 'Add API Key'}
          </button>
          {showApiKeyBox && (
            <div className="w-full pt-2 space-y-2">
              <div className="flex gap-1.5">
                {(['groq', 'gemini'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setKeyMode(mode);
                      setApiKeyMsg(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                      keyMode === mode
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0]'
                    }`}
                  >
                    {mode === 'groq' ? 'Groq (Free)' : 'Gemini'}
                  </button>
                ))}
                <span className="ml-auto flex gap-1">
                  {(['auto', 'groq', 'gemini'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => void handleSetProvider(p)}
                      title={p === 'auto' ? 'Groq key ho to Groq, warna Gemini' : `Sirf ${p} use karo`}
                      className={`px-2 py-1.5 text-[11px] font-medium rounded-lg cursor-pointer ${
                        apiStatus?.provider === p
                          ? 'bg-[#15803D] text-white'
                          : 'bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0]'
                      }`}
                    >
                      {p === 'auto' ? 'Auto' : p === 'groq' ? 'Groq' : 'Gemini'}
                    </button>
                  ))}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={keyMode === 'groq' ? 'Paste Groq API key here (gsk_...)' : 'Paste Gemini API key here'}
                  autoComplete="off"
                  className="flex-1 h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                />
                <button
                  type="button"
                  disabled={savingApiKey || apiKeyInput.trim().length < 20}
                  onClick={() => void handleSaveApiKey()}
                  className="px-4 h-10 inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  {savingApiKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null}
                  <span>Save</span>
                </button>
              </div>
              {apiKeyMsg && <p className="text-xs text-[#475569]">{apiKeyMsg}</p>}
              <p className="text-[11px] text-[#64748B]">
                {keyMode === 'groq'
                  ? 'Groq key free hai, card nahi chahiye: console.groq.com → API Keys → Create API Key. Key sirf is computer ki .env.local file mein save hoti hai.'
                  : 'Gemini key: AI Studio se. Note — kuch Gemini projects par free tier band hai; aisa ho to Groq use karo. Key sirf is computer ki .env.local file mein save hoti hai.'}
              </p>
            </div>
          )}
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-semibold text-[#0F172A]">
              Auto Clips Finder &amp; Captioned Export
            </h2>
            <p className="mt-1 text-xs text-[#64748B] leading-relaxed">
              Upload any long video or podcast. AI finds the best viral moments, splits them cleanly, formats 9:16 Reels or 16:9 HD, and burns synced captions ready to download.
            </p>
          </div>

          {/* 1-TAP PRESETS */}
          <div>
            <span className="block text-xs font-medium text-[#475569] mb-1.5">
              Quick Start — 1 tap mein pro setup
            </span>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => applyPreset('viral')}
                className="px-2 py-2.5 rounded-lg border border-[#E2E8F0] bg-[#FFF7ED] hover:border-[#F59E0B] text-left cursor-pointer min-h-[44px]"
              >
                <span className="flex items-center gap-1 text-xs font-semibold text-[#0F172A]">
                  <Zap className="w-3.5 h-3.5 text-[#D97706]" aria-hidden="true" /> Viral Reel
                </span>
                <span className="block mt-0.5 text-[11px] text-[#64748B]">9:16 · Bold caps</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset('podcast')}
                className="px-2 py-2.5 rounded-lg border border-[#E2E8F0] bg-[#EFF6FF] hover:border-[#2563EB] text-left cursor-pointer min-h-[44px]"
              >
                <span className="text-xs font-semibold text-[#0F172A]">Podcast Highlight</span>
                <span className="block mt-0.5 text-[11px] text-[#64748B]">1:1 · Lower-third</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset('youtube-hd')}
                className="px-2 py-2.5 rounded-lg border border-[#E2E8F0] bg-[#F0FDF4] hover:border-[#16A34A] text-left cursor-pointer min-h-[44px]"
              >
                <span className="text-xs font-semibold text-[#0F172A]">YouTube HD</span>
                <span className="block mt-0.5 text-[11px] text-[#64748B]">16:9 · Cinema</span>
              </button>
            </div>
          </div>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) handleSelectFile(f);
            }}
            className="border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB]/60 bg-[#F8FAFC] rounded-xl p-5 text-center cursor-pointer transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*,.mkv,.mov,.avi,.mp4,.webm,.mp3,.wav,.m4a"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleSelectFile(f);
              }}
            />
            <Upload className="w-5 h-5 text-[#2563EB] mx-auto mb-2" aria-hidden="true" />
            {mediaFile ? (
              <div>
                <p className="text-sm font-semibold text-[#0F172A] truncate max-w-xs mx-auto">
                  {mediaFile.name}
                </p>
                <p className="mt-1 font-mono text-xs text-[#64748B] tabular-nums">
                  {formatBytes(mediaFile.size)} · Click to replace video
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-[#0F172A]">
                  Drop video or podcast file here
                </p>
                <p className="mt-1 text-xs text-[#64748B]">
                  Supports MP4, MOV, MKV, WEBM, MP3, WAV up to 10 GB
                </p>
              </div>
            )}
          </div>

          {completedSessions.length > 0 && (
            <div>
              <label
                htmlFor="autoclips-reuse-session"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Optional: Reuse Existing Transcript (Instant Clip Detection)
              </label>
              <select
                id="autoclips-reuse-session"
                value={selectedSessionId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedSessionId(id);
                  const found = completedSessions.find((s) => s.id === id);
                  if (found) handleLanguageChange(found.options.language || 'auto');
                }}
                className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                <option value="">Transcribe uploaded video automatically (Default)</option>
                {completedSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.segments.length} segments)
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="autoclips-lang"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Spoken Language / Script
              </label>
              <select
                id="autoclips-lang"
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="autoclips-count"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Best Clips Count
              </label>
              <select
                id="autoclips-count"
                value={maxClips}
                onChange={(e) => setMaxClips(Number(e.target.value))}
                className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                <option value={3}>Top 3 Best Clips</option>
                <option value={5}>Top 5 Best Clips</option>
                <option value={8}>Top 8 Best Clips</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="autoclips-duration"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Target Clip Length
              </label>
              <select
                id="autoclips-duration"
                value={durationPreset}
                onChange={(e) =>
                  setDurationPreset(e.target.value as 'short' | 'balanced' | 'deep')
                }
                className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                {DURATION_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="autoclips-words"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Caption Density
              </label>
              <select
                id="autoclips-words"
                value={wordsPerCue}
                onChange={(e) => setWordsPerCue(Number(e.target.value))}
                className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                <option value={4}>Punchy Reels (4 words/line)</option>
                <option value={6}>Balanced Social (6 words/line)</option>
                <option value={9}>Standard Broadcast (9 words/line)</option>
              </select>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-[#334155] cursor-pointer min-h-[36px]">
            <input
              type="checkbox"
              checked={identifySpeakers}
              onChange={(e) => setIdentifySpeakers(e.target.checked)}
              className="rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
            />
            <span>Identify speakers inside captions</span>
          </label>

          {uploadPct !== null && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-[#475569]">
                <span>Uploading source media...</span>
                <span className="font-mono tabular-nums">{uploadPct}%</span>
              </div>
              <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#2563EB] transition-all duration-150"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            </div>
          )}

          {analyzeJob && (analyzeJob.status === 'processing' || analyzeJob.status === 'queued') && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-2 text-[#0F172A] font-medium">
                  <Loader2 className="w-3.5 h-3.5 text-[#2563EB] animate-spin" aria-hidden="true" />
                  <span>{analyzeJob.stageLabel}</span>
                </span>
                <span className="font-mono text-[#2563EB] font-semibold tabular-nums">
                  {analyzeJob.progressPercent}%
                </span>
              </div>
              <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#2563EB] transition-all duration-200"
                  style={{ width: `${Math.max(5, analyzeJob.progressPercent)}%` }}
                />
              </div>
            </div>
          )}

          <button
            type="button"
            disabled={!mediaFile || isAnalyzing}
            onClick={() => void handleAnalyzeBestClips()}
            className="w-full py-2.5 px-4 min-h-[42px] inline-flex items-center justify-center gap-2 text-sm font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer transition-colors"
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>Finding Best Clips &amp; Captions...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                <span>Find Best Clips &amp; Generate Captions</span>
              </>
            )}
          </button>
        </div>

        {/* PRO VIDEO SETUP & CAPTION TEMPLATE */}
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
              <h3 className="font-display text-sm font-semibold text-[#0F172A]">
                Video Layout &amp; Caption Setup
              </h3>
            </div>
            <span className="font-mono text-[11px] text-[#64748B] tabular-nums">
              {aspectRatio === '9:16'
                ? '1080×1920'
                : aspectRatio === '1:1'
                  ? '1080×1080'
                  : '1280×720'}
            </span>
          </div>

          <div>
            <span className="block text-xs font-medium text-[#475569] mb-1.5">
              Output Aspect Ratio
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: '9:16', label: '9:16 Reels', sub: 'Shorts / TikTok' },
                  { id: '1:1', label: '1:1 Square', sub: 'Feed Post' },
                  { id: '16:9', label: '16:9 Wide', sub: 'YouTube HD' },
                ] as const
              ).map((ratio) => (
                <button
                  key={ratio.id}
                  type="button"
                  onClick={() => setAspectRatio(ratio.id)}
                  className={`p-2.5 rounded-lg border text-left cursor-pointer transition-colors min-h-[44px] ${
                    aspectRatio === ratio.id
                      ? 'bg-[#EFF6FF] border-[#2563EB] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <p className="text-xs font-semibold whitespace-nowrap">{ratio.label}</p>
                  <p className="text-[11px] text-[#64748B] truncate">{ratio.sub}</p>
                </button>
              ))}
            </div>
          </div>

          {aspectRatio !== '16:9' && (
            <div>
              <span className="block text-xs font-medium text-[#475569] mb-1.5">
                Framing Mode
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setFramingMode('blurred-fit')}
                  className={`px-3 py-2 rounded-lg border text-xs font-medium text-left cursor-pointer ${
                    framingMode === 'blurred-fit'
                      ? 'bg-[#EFF6FF] border-[#2563EB] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  Blurred Cinema Frame
                </button>
                <button
                  type="button"
                  onClick={() => setFramingMode('center-crop')}
                  className={`px-3 py-2 rounded-lg border text-xs font-medium text-left cursor-pointer ${
                    framingMode === 'center-crop'
                      ? 'bg-[#EFF6FF] border-[#2563EB] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  Center Fill Crop
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label
                htmlFor="autoclips-tpl"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Caption Style
              </label>
              <select
                id="autoclips-tpl"
                value={styleConfig.templateId}
                onChange={(e) =>
                  setStyleConfig((prev) => ({
                    ...prev,
                    templateId: e.target.value as SubtitleStyleConfig['templateId'],
                  }))
                }
                className="w-full h-10 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
              >
                {SUBTITLE_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="autoclips-pos"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Position
              </label>
              <select
                id="autoclips-pos"
                value={styleConfig.position}
                onChange={(e) =>
                  setStyleConfig((prev) => ({
                    ...prev,
                    position: e.target.value as SubtitlePosition,
                  }))
                }
                className="w-full h-10 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
              >
                <option value="bottom">Bottom Safe</option>
                <option value="lower-third">Lower-Third</option>
                <option value="top">Top</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="autoclips-size"
                className="block text-xs font-medium text-[#475569] mb-1.5"
              >
                Text Size
              </label>
              <select
                id="autoclips-size"
                value={styleConfig.fontSize}
                onChange={(e) =>
                  setStyleConfig((prev) => ({
                    ...prev,
                    fontSize: e.target.value as SubtitleFontSize,
                  }))
                }
                className="w-full h-10 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
              >
                <option value="small">Compact</option>
                <option value="standard">Standard</option>
                <option value="large">Bold / Social</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-[#334155] cursor-pointer min-h-[36px]">
              <input
                type="checkbox"
                checked={showTopTitle}
                onChange={(e) => setShowTopTitle(e.target.checked)}
                className="rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
              />
              <span>Top hook headline</span>
            </label>
            <select
              value={titleStyle}
              disabled={!showTopTitle}
              onChange={(e) => setTitleStyle(e.target.value as ClipTitleStyle)}
              aria-label="Top headline style"
              className="h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] disabled:opacity-45"
            >
              <option value="banner">Pro Banner + blue accent bar</option>
              <option value="minimal">Minimal text box</option>
              <option value="off">No headline</option>
            </select>
          </div>

          {/* Compact Live Framing & Caption Mock Preview */}
          <div className="pt-2 border-t border-[#F1F5F9]">
            <div className="flex items-center justify-between text-[11px] text-[#64748B] mb-2">
              <span>Live Layout Preview</span>
              <span className="font-mono">{activeTemplate.name}</span>
            </div>
            <div className="flex justify-center bg-[#0F172A] rounded-lg p-3 overflow-hidden">
              <div
                className={`relative flex flex-col justify-between overflow-hidden rounded-md border border-white/15 ${activeTemplate.previewBgClass} ${
                  aspectRatio === '9:16'
                    ? 'w-[140px] h-[238px]'
                    : aspectRatio === '1:1'
                      ? 'w-[190px] h-[190px]'
                      : 'w-full max-w-[290px] h-[164px]'
                }`}
              >
                {showTopTitle && titleStyle !== 'off' ? (
                  titleStyle === 'banner' ? (
                    <div className="text-center">
                      <div className="bg-black/60 px-2 pt-2 pb-1.5">
                        <span
                          dir="auto"
                          className="block text-[10px] font-bold text-white leading-tight line-clamp-2"
                        >
                          {previewClip?.title || 'Clip Hook Headline'}
                        </span>
                      </div>
                      <div className="h-[3px] bg-[#2563EB]" />
                    </div>
                  ) : (
                    <div className="px-2 pt-2.5 text-center">
                      <span
                        dir="auto"
                        className="inline-block px-2 py-1 rounded bg-black/65 text-[10px] font-semibold text-white line-clamp-1"
                      >
                        {previewClip?.title || 'Clip Hook Headline'}
                      </span>
                    </div>
                  )
                ) : (
                  <div />
                )}

                {aspectRatio !== '16:9' && framingMode === 'blurred-fit' && (
                  <div className="mx-auto w-full h-[96px] bg-slate-800/80 border-y border-white/10 flex items-center justify-center text-[10px] text-slate-300 font-mono">
                    Full Frame Video
                  </div>
                )}

                <div
                  className={`px-2.5 text-center ${
                    styleConfig.position === 'top'
                      ? 'order-first pt-2'
                      : styleConfig.position === 'lower-third'
                        ? 'pb-5'
                        : 'pb-3'
                  }`}
                >
                  <span
                    dir="auto"
                    style={{
                      color: activeTemplate.textHex,
                      backgroundColor: activeTemplate.bgRgba,
                      fontFamily: activeTemplate.fontFamily,
                      borderColor: activeTemplate.borderColor,
                    }}
                    className={`inline-block px-2 py-1 rounded text-[11px] leading-snug border ${
                      activeTemplate.bold ? 'font-bold' : 'font-medium'
                    } ${activeTemplate.uppercase ? 'uppercase' : ''}`}
                  >
                    {previewCaptionText}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: DISCOVERED BEST CLIPS & AUTOMATED EXPORT DECK */}
      <div className="lg:col-span-7 space-y-4">
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-base font-semibold text-[#0F172A]">
                Detected Best Clips
              </h3>
              <p className="mt-0.5 text-xs text-[#64748B]">
                {clips.length > 0
                  ? `${clips.length} self-contained clips extracted with relative synced captions`
                  : 'Upload a video and run Best Clips Finder to extract highlights automatically.'}
              </p>
            </div>

            {clips.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {batchRendering && (
                  <button
                    type="button"
                    onClick={() => {
                      batchStopRef.current = true;
                    }}
                    className="px-3 py-2 min-h-[40px] inline-flex items-center gap-1.5 text-xs font-semibold text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] hover:bg-[#FEE2E2] rounded-lg cursor-pointer"
                  >
                    <StopCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Stop</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={batchRendering}
                  onClick={() => void handleRenderAllClips()}
                  className="px-4 py-2 min-h-[40px] inline-flex items-center gap-2 text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
                >
                  {batchRendering ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      <span>Rendering All Clips...</span>
                    </>
                  ) : (
                    <>
                      <Clapperboard className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Render All {clips.length} Clips ({aspectRatio})</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const lines = clips.map(
                      (c, i) =>
                        `Clip ${i + 1}: ${c.title} [${formatDuration(c.startSec)} - ${formatDuration(c.endSec)}] score ${c.score ?? '-'}/100 — ${c.category}`,
                    );
                    downloadTextFile(
                      'auto-clips-list.txt',
                      lines.join('\n'),
                      'text/plain;charset=utf-8',
                    );
                  }}
                  className="px-3 py-2 min-h-[40px] inline-flex items-center gap-1.5 text-xs font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded-lg cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Clip List (.txt)</span>
                </button>
              </div>
            )}
          </div>

          {/* 4-STEP PROGRESS: Upload → Find → Review → Export */}
          <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
            {[
              { n: 1, label: 'Upload', done: Boolean(mediaFile) },
              { n: 2, label: 'Find Clips', done: clips.length > 0 },
              { n: 3, label: 'Review & Edit', done: clips.length > 0 },
              {
                n: 4,
                label: 'Export MP4',
                done: Object.values(clipRenderJobs).some((j) => j.status === 'completed'),
              },
            ].map((step, i) => (
              <span key={step.n} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-[#CBD5E1]" aria-hidden="true">→</span>}
                <span
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full ${
                    step.done ? 'bg-[#DCFCE7] text-[#15803D]' : 'bg-[#F1F5F9] text-[#64748B]'
                  }`}
                >
                  {step.done ? <Check className="w-3 h-3" aria-hidden="true" /> : <span className="font-mono">{step.n}</span>}
                  {step.label}
                </span>
              </span>
            ))}
          </div>
        </div>

        {clips.length === 0 ? (
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-8 text-center space-y-3">
            <Film className="w-8 h-8 text-[#94A3B8] mx-auto" aria-hidden="true" />
            <p className="text-sm font-semibold text-[#0F172A]">
              No Clips Extracted Yet
            </p>
            <p className="text-xs text-[#64748B] max-w-md mx-auto leading-relaxed">
              Select a video on the left and click <span className="font-semibold text-[#0F172A]">Find Best Clips &amp; Generate Captions</span>. You will get ready-to-render highlight clips with editable hook titles, synced captions, and one-click {aspectRatio} MP4 export.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {clips.map((clip, idx) => {
              const renderJob = clipRenderJobs[clip.id];
              const isRendering =
                renderJob?.status === 'processing' || renderJob?.status === 'queued';
              const isRendered = renderJob?.status === 'completed';
              const isExpanded = Boolean(expandedClipIds[clip.id]);
              const isPreviewingSource = previewingClipId === clip.id && Boolean(sourcePreviewUrl);

              return (
                <div
                  key={clip.id}
                  className="bg-white border border-[#E2E8F0] rounded-xl p-5 space-y-4"
                >
                  {/* Card Header: Index + Unboxed Metadata */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                        <span className="font-mono font-semibold text-[#2563EB] tabular-nums">
                          Clip {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{clip.category}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatDuration(clip.startSec)} – {formatDuration(clip.endSec)} ({Math.round(clip.durationSec)}s)
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {clip.cues.length} caption cues
                        </span>
                        {typeof clip.score === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span
                              className={`font-mono font-semibold tabular-nums px-1.5 py-0.5 rounded ${
                                clip.score >= 75
                                  ? 'bg-[#DCFCE7] text-[#15803D]'
                                  : clip.score >= 55
                                    ? 'bg-[#FEF9C3] text-[#854D0E]'
                                    : 'bg-[#F1F5F9] text-[#64748B]'
                              }`}
                            >
                              Hook {clip.score}/100
                            </span>
                            {clip.score > 0 && clip.score === bestClipScore && (
                              <span className="px-1.5 py-0.5 rounded bg-[#2563EB] text-white font-semibold">
                                BEST
                              </span>
                            )}
                          </>
                        )}
                      </div>

                      <input
                        type="text"
                        dir="auto"
                        value={clip.title}
                        onChange={(e) => updateClipField(clip.id, { title: e.target.value })}
                        aria-label={`Title for clip ${idx + 1}`}
                        className="w-full text-sm sm:text-base font-semibold text-[#0F172A] bg-transparent border-b border-transparent hover:border-[#CBD5E1] focus:border-[#2563EB] focus:outline-none py-0.5"
                      />
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          setPreviewingClipId((cur) => (cur === clip.id ? null : clip.id))
                        }
                        className="px-3 py-1.5 min-h-[36px] inline-flex items-center gap-1.5 text-xs font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <Play className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{previewingClipId === clip.id ? 'Hide Preview' : 'Preview Slice'}</span>
                      </button>
                    </div>
                  </div>

                  <p dir="auto" className="text-xs text-[#475569] leading-relaxed">
                    {clip.reason}
                  </p>

                  {/* Timing Adjustment Row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 items-end pt-1">
                    <div>
                      <label className="block text-[11px] font-medium text-[#64748B] mb-1">
                        Start (sec)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={clip.startSec}
                        onChange={(e) =>
                          updateClipField(clip.id, { startSec: Number(e.target.value) || 0 })
                        }
                        className="w-full h-9 px-2.5 font-mono text-xs tabular-nums bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-[#64748B] mb-1">
                        End (sec)
                      </label>
                      <input
                        type="number"
                        min={clip.startSec + 2}
                        step={0.5}
                        value={clip.endSec}
                        onChange={(e) =>
                          updateClipField(clip.id, {
                            endSec: Number(e.target.value) || clip.startSec + 5,
                          })
                        }
                        className="w-full h-9 px-2.5 font-mono text-xs tabular-nums bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                      />
                    </div>
                    <div className="col-span-2 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleDownloadClipSrt(clip)}
                        className="px-3 py-2 min-h-[36px] inline-flex items-center gap-1.5 text-xs font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>.SRT</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedClipIds((prev) => ({ ...prev, [clip.id]: !prev[clip.id] }))
                        }
                        className="px-3 py-2 min-h-[36px] inline-flex items-center gap-1.5 text-xs font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:bg-[#F1F5F9] rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <span>Edit Captions ({clip.cues.length})</span>
                        {isExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                      </button>

                      <button
                        type="button"
                        disabled={isRendering}
                        onClick={() => void renderSingleClip(clip)}
                        className="px-4 py-2 min-h-[36px] inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        {isRendering ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            <span>Rendering...</span>
                          </>
                        ) : (
                          <>
                            <Clapperboard className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{isRendered ? 'Re-Render MP4' : `Export ${aspectRatio} MP4`}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Source Slice Player Preview */}
                  {isPreviewingSource && sourcePreviewUrl && !isRendered && (
                    <div className="rounded-lg overflow-hidden border border-[#E2E8F0] bg-[#0F172A]">
                      {mediaFile?.type.startsWith('audio/') ? (
                        <div className="p-3 bg-[#F8FAFC] flex items-center gap-2">
                          <FileAudio className="w-4 h-4 text-[#2563EB] shrink-0" aria-hidden="true" />
                          <audio
                            src={`${sourcePreviewUrl}#t=${clip.startSec},${clip.endSec}`}
                            controls
                            className="w-full"
                          />
                        </div>
                      ) : (
                        <video
                          src={`${sourcePreviewUrl}#t=${clip.startSec},${clip.endSec}`}
                          controls
                          className="w-full max-h-[240px]"
                        />
                      )}
                    </div>
                  )}

                  {/* Expandable Synced Captions Editor */}
                  {isExpanded && (
                    <div className="border-t border-[#F1F5F9] pt-3 space-y-2 max-h-[260px] overflow-y-auto studio-scroll pr-1">
                      {clip.cues.map((cue) => (
                        <div key={cue.id} className="flex items-start gap-2.5">
                          <span className="font-mono text-[11px] text-[#64748B] tabular-nums shrink-0 pt-2 w-20">
                            {cue.startSec.toFixed(1)}s–{cue.endSec.toFixed(1)}s
                          </span>
                          <input
                            type="text"
                            dir="auto"
                            value={cue.text}
                            onChange={(e) => updateClipCueText(clip.id, cue.id, e.target.value)}
                            className="flex-1 h-8 px-2.5 text-xs bg-[#F8FAFC] border border-[#E2E8F0] rounded-md text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Per-Clip Render Progress / Completed MP4 Download */}
                  {renderJob && (
                    <div className="border-t border-[#F1F5F9] pt-3 space-y-3">
                      {isRendering ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="inline-flex items-center gap-2 text-[#0F172A] font-medium">
                              <Loader2
                                className="w-3.5 h-3.5 text-[#2563EB] animate-spin"
                                aria-hidden="true"
                              />
                              <span>{renderJob.stageLabel}</span>
                            </span>
                            <span className="font-mono text-[#2563EB] font-semibold tabular-nums">
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
                        <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C]">
                          {renderJob.error || renderJob.stageLabel}
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 font-medium text-[#16A34A]">
                              <Check className="w-4 h-4" aria-hidden="true" />
                              <span>{renderJob.stageLabel}</span>
                              {renderJob.outputBytes && (
                                <span className="font-mono text-[#64748B] tabular-nums">
                                  · {formatBytes(renderJob.outputBytes)}
                                </span>
                              )}
                            </span>

                            <a
                              href={`/api/tools/jobs/${renderJob.id}/file`}
                              download={renderJob.outputFilename || true}
                              className="px-3.5 py-2 min-h-[38px] inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-[#16A34A] hover:bg-[#15803D] rounded-lg whitespace-nowrap"
                            >
                              <Download className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Download Captioned MP4</span>
                            </a>
                          </div>

                          <div className="rounded-lg overflow-hidden border border-[#E2E8F0] bg-[#0F172A]">
                            <video
                              src={`/api/tools/jobs/${renderJob.id}/file?inline=1`}
                              controls
                              className="w-full max-h-[280px]"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
