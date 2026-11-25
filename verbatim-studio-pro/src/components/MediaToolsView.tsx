import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Clapperboard,
  Download,
  FileAudio,
  FileVideo,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Music,
  Plus,
  Scissors,
  Sparkles,
  Subtitles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  MediaOutputFormat,
  ToolAuthStatus,
  ToolJob,
  UrlProbeResult,
} from '../types/tools';
import type { TranscriptionJob, TranscriptionOptions } from '../types/transcription';
import { uploadFileChunked } from '../utils/chunkedUpload';
import { formatBytes, formatDuration } from '../utils/formatters';
import { AutoClipsTab } from './AutoClipsTab';
import { SubtitleStudioTab } from './SubtitleStudioTab';

type MediaToolTab = 'downloader' | 'converter' | 'trimmer' | 'merge' | 'subtitles' | 'auto-clips';

interface MediaToolsViewProps {
  savedJobs?: TranscriptionJob[];
  initialSubtitlesJob?: TranscriptionJob | null;
  onConsumeInitialSubtitlesJob?: () => void;
  onTranscribedJobStarted: (job: TranscriptionJob) => void;
  onStartYouTubeTranscribe?: (url: string, language?: string) => Promise<void>;
}

const DEFAULT_TRANSCRIBE_OPTIONS: TranscriptionOptions = {
  language: 'auto',
  translateToEnglish: false,
  identifySpeakers: true,
  timestampInterval: 'turn',
  autoAnalyze: true,
};

const QUICK_TRANSCRIBE_LANGUAGES = [
  { value: 'auto', label: 'Auto-detect language' },
  { value: 'Urdu (Pure Nastaliq Script)', label: 'Urdu Only (صرف خالص اردو)' },
  { value: 'Roman Urdu (Latin Script)', label: 'Roman Urdu Only' },
  { value: 'Urdu + English (Bilingual)', label: 'Urdu + English' },
  { value: 'English', label: 'English' },
  { value: 'Hindi (हिन्दी)', label: 'Hindi (हिन्दी)' },
  { value: 'Arabic (العربية)', label: 'Arabic (العربية)' },
];

function parseTimestampInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

export function MediaToolsView({
  savedJobs = [],
  initialSubtitlesJob = null,
  onConsumeInitialSubtitlesJob,
  onTranscribedJobStarted,
  onStartYouTubeTranscribe,
}: MediaToolsViewProps) {
  const [activeTab, setActiveTab] = useState<MediaToolTab>(
    initialSubtitlesJob ? 'subtitles' : 'downloader',
  );
  const [quickTranscribeLang, setQuickTranscribeLang] = useState<string>('auto');

  useEffect(() => {
    if (initialSubtitlesJob) {
      setActiveTab('subtitles');
    }
  }, [initialSubtitlesJob]);

  // --- Shared active tool job & SSE tracking ---
  const [activeToolJob, setActiveToolJob] = useState<ToolJob | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [sendingToTranscribe, setSendingToTranscribe] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const subscribeToolJob = (jobId: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/tools/jobs/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const updated = JSON.parse(ev.data) as ToolJob;
        setActiveToolJob(updated);
        if (updated.requiresAuth) {
          setShowAuthPanel(true);
        }
        if (updated.status === 'completed' || updated.status === 'error') {
          es.close();
          esRef.current = null;
        }
      } catch {
        // Ignore malformed frame
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      void fetch(`/api/tools/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: ToolJob | null) => {
          if (data) {
            setActiveToolJob(data);
            if (data.status === 'processing' || data.status === 'queued') {
              setTimeout(() => subscribeToolJob(jobId), 1500);
            }
          }
        })
        .catch(() => {});
    };
  };

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const handleTranscribeToolResult = async (jobId: string, languageOverride?: string) => {
    setSendingToTranscribe(true);
    setToolError(null);
    try {
      const res = await fetch(`/api/tools/jobs/${jobId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          options: {
            ...DEFAULT_TRANSCRIBE_OPTIONS,
            language: languageOverride || quickTranscribeLang || 'auto',
          },
        }),
      });
      const data = (await res.json()) as TranscriptionJob & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not start transcription.');
      }
      onTranscribedJobStarted(data);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Transcription handoff failed.');
    } finally {
      setSendingToTranscribe(false);
    }
  };

  // --- Tab 1: Link Downloader State ---
  const [linkUrl, setLinkUrl] = useState('');
  const [probingLink, setProbingLink] = useState(false);
  const [probeResult, setProbeResult] = useState<UrlProbeResult | null>(null);
  const [dlMode, setDlMode] = useState<'video' | 'audio'>('video');
  const [dlMaxHeight, setDlMaxHeight] = useState<number>(1080);
  const [dlAudioFormat, setDlAudioFormat] = useState<'mp3' | 'm4a' | 'wav' | 'flac'>('mp3');
  const [dlAudioBitrate, setDlAudioBitrate] = useState<'128k' | '192k' | '320k'>('192k');
  const [dlStartStr, setDlStartStr] = useState('');
  const [dlEndStr, setDlEndStr] = useState('');
  const [startingDownload, setStartingDownload] = useState(false);

  // Cookies & Proxy Auth State (for cloud IP bot-check bypass)
  const [authStatus, setAuthStatus] = useState<ToolAuthStatus | null>(null);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [cookiesInput, setCookiesInput] = useState('');
  const [proxyInput, setProxyInput] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const cookiesFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetch('/api/tools/auth')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ToolAuthStatus | null) => {
        if (data) setAuthStatus(data);
      })
      .catch(() => {});
  }, []);

  const handleSaveAuth = async (retryDownloadAfterSave = false) => {
    setSavingAuth(true);
    setToolError(null);
    setAuthMessage(null);
    try {
      const payload: { cookiesText?: string; proxyUrl?: string } = {};
      if (cookiesInput.trim()) payload.cookiesText = cookiesInput;
      if (proxyInput.trim()) payload.proxyUrl = proxyInput;

      const res = await fetch('/api/tools/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ToolAuthStatus & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not save authentication settings.');
      }
      setAuthStatus(data);
      setAuthMessage(
        data.hasCookies
          ? `Saved ${data.cookieEntries} cookies cleanly.`
          : data.hasProxy
            ? 'Saved proxy configuration.'
            : 'Updated settings.',
      );
      if (retryDownloadAfterSave && linkUrl.trim()) {
        setShowAuthPanel(false);
        await handleStartLinkDownload();
      }
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Failed to save cookies/proxy.');
    } finally {
      setSavingAuth(false);
    }
  };

  const handleClearAuth = async () => {
    const res = await fetch('/api/tools/auth', { method: 'DELETE' });
    if (res.ok) {
      const data = (await res.json()) as ToolAuthStatus;
      setAuthStatus(data);
      setCookiesInput('');
      setProxyInput('');
      setAuthMessage('Cleared saved cookies and proxy.');
    }
  };

  const handleProbeLink = async () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    setProbingLink(true);
    setToolError(null);
    setProbeResult(null);
    try {
      const res = await fetch(`/api/tools/probe?url=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as UrlProbeResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not inspect this link.');
      }
      setProbeResult(data);
      if (data.authWarning) {
        setShowAuthPanel(true);
      }
      const firstH = data.videoQualities.find((q) => q.height)?.height;
      if (firstH) {
        setDlMaxHeight(Math.min(firstH, 1080));
      }
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Failed to inspect URL.');
    } finally {
      setProbingLink(false);
    }
  };

  const handleStartLinkDownload = async () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    setStartingDownload(true);
    setToolError(null);
    try {
      const res = await fetch('/api/tools/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: trimmed,
          title: probeResult?.title,
          platform: probeResult?.platform,
          mode: dlMode,
          maxHeight: dlMode === 'video' ? dlMaxHeight : undefined,
          audioFormat: dlMode === 'audio' ? dlAudioFormat : undefined,
          audioBitrate: dlAudioBitrate,
          startSec: parseTimestampInput(dlStartStr),
          endSec: parseTimestampInput(dlEndStr),
        }),
      });
      const data = (await res.json()) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Could not start download.');
      }
      setActiveToolJob(data);
      subscribeToolJob(data.id);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Download request failed.');
    } finally {
      setStartingDownload(false);
    }
  };

  // --- Tab 2: Video-to-Audio & Media Converter State ---
  const [convFile, setConvFile] = useState<File | null>(null);
  const [convFormat, setConvFormat] = useState<MediaOutputFormat>('mp3');
  const [convBitrate, setConvBitrate] = useState<'128k' | '192k' | '320k'>('192k');
  const [convResolution, setConvResolution] = useState<'original' | '1080' | '720' | '480'>('720');
  const [convStartStr, setConvStartStr] = useState('');
  const [convEndStr, setConvEndStr] = useState('');
  const [convNormalize, setConvNormalize] = useState(false);
  const [convRemoveSilence, setConvRemoveSilence] = useState(false);
  const [convEnhanceVoice, setConvEnhanceVoice] = useState(false);
  const [convSpeed, setConvSpeed] = useState<number>(1);
  const [convUploadPct, setConvUploadPct] = useState<number | null>(null);
  const convFileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Tab 4: Join / Merge Studio State ---
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  const [mergeFormat, setMergeFormat] = useState<'mp4' | 'mp3' | 'm4a' | 'wav'>('mp4');
  const [mergeBitrate, setMergeBitrate] = useState<'128k' | '192k' | '320k'>('192k');
  const [mergeUploadPct, setMergeUploadPct] = useState<number | null>(null);
  const [mergeUploadLabel, setMergeUploadLabel] = useState<string | null>(null);
  const mergeFileInputRef = useRef<HTMLInputElement | null>(null);

  const addMergeFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setMergeFiles((prev) => {
      const next = [...prev, ...incoming];
      if (prev.length === 0 && next.every((f) => f.type.startsWith('audio/'))) {
        setMergeFormat('mp3');
      }
      return next;
    });
  };

  const moveMergeFile = (idx: number, dir: -1 | 1) => {
    setMergeFiles((prev) => {
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const removeMergeFile = (idx: number) => {
    setMergeFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const runMergeUploadAndJob = async () => {
    if (mergeFiles.length < 2) return;
    setToolError(null);
    setMergeUploadPct(0);
    setMergeUploadLabel(`Uploading clip 1 of ${mergeFiles.length}...`);
    try {
      const uploadIds: string[] = [];
      for (let i = 0; i < mergeFiles.length; i++) {
        const f = mergeFiles[i];
        const uid = await uploadFileChunked(f, (pct) => {
          const overall = Math.round(((i + pct / 100) / mergeFiles.length) * 100);
          setMergeUploadPct(overall);
          setMergeUploadLabel(`Uploading clip ${i + 1} of ${mergeFiles.length} (${pct}%)...`);
        });
        uploadIds.push(uid);
      }

      setMergeUploadLabel('Joining clips on server...');
      const res = await fetch('/api/tools/merge-uploaded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadIds,
          outputFormat: mergeFormat,
          audioBitrate: mergeBitrate,
        }),
      });
      const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(job.error || `Merge failed (${res.status})`);
      }
      setActiveToolJob(job);
      subscribeToolJob(job.id);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Media merge failed.');
    } finally {
      setMergeUploadPct(null);
      setMergeUploadLabel(null);
    }
  };

  const runUploadAndConvert = async (params: {
    file: File;
    kind: 'convert' | 'trim';
    outputFormat: MediaOutputFormat;
    audioBitrate: '128k' | '192k' | '320k';
    videoResolution: 'original' | '1080' | '720' | '480';
    startSec?: number;
    endSec?: number;
    normalizeAudio: boolean;
    removeSilence: boolean;
    enhanceVoice?: boolean;
    speed: number;
    onProgress: (pct: number | null) => void;
  }) => {
    setToolError(null);
    params.onProgress(0);
    try {
      const uploadId = await uploadFileChunked(params.file, (pct) => {
        params.onProgress(pct);
      });

      const res = await fetch('/api/tools/convert-uploaded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId,
          kind: params.kind,
          outputFormat: params.outputFormat,
          audioBitrate: params.audioBitrate,
          videoResolution: params.videoResolution,
          startSec: params.startSec,
          endSec: params.endSec,
          normalizeAudio: params.normalizeAudio,
          removeSilence: params.removeSilence,
          enhanceVoice: Boolean(params.enhanceVoice),
          speed: params.speed,
        }),
      });

      const job = (await res.json().catch(() => ({}))) as ToolJob & { error?: string };
      if (!res.ok) {
        throw new Error(job.error || `Conversion failed (${res.status})`);
      }

      setActiveToolJob(job);
      subscribeToolJob(job.id);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Media conversion failed.');
    } finally {
      params.onProgress(null);
    }
  };

  // --- Tab 3: Trim & Cut Studio State ---
  const [trimFile, setTrimFile] = useState<File | null>(null);
  const [trimPreviewUrl, setTrimPreviewUrl] = useState<string | null>(null);
  const [trimDurationSec, setTrimDurationSec] = useState<number>(0);
  const [trimCurrentSec, setTrimCurrentSec] = useState<number>(0);
  const [trimStartStr, setTrimStartStr] = useState('00:00');
  const [trimEndStr, setTrimEndStr] = useState('');
  const [trimOutputFormat, setTrimOutputFormat] = useState<MediaOutputFormat>('mp4');
  const [trimUploadPct, setTrimUploadPct] = useState<number | null>(null);
  const trimMediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const trimFileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSelectTrimFile = (file: File) => {
    if (trimPreviewUrl) URL.revokeObjectURL(trimPreviewUrl);
    const url = URL.createObjectURL(file);
    setTrimFile(file);
    setTrimPreviewUrl(url);
    setTrimStartStr('00:00');
    setTrimEndStr('');
    setTrimDurationSec(0);
    setTrimCurrentSec(0);
    setTrimOutputFormat(file.type.startsWith('audio/') ? 'mp3' : 'mp4');
  };

  useEffect(() => {
    return () => {
      if (trimPreviewUrl) URL.revokeObjectURL(trimPreviewUrl);
    };
  }, [trimPreviewUrl]);

  const isToolBusy =
    activeToolJob?.status === 'processing' || activeToolJob?.status === 'queued';

  const tabs: Array<{ id: MediaToolTab; label: string; icon: typeof Link2 }> = [
    { id: 'downloader', label: 'Link Downloader', icon: Link2 },
    { id: 'converter', label: 'Video to Audio', icon: Music },
    { id: 'trimmer', label: 'Trim & Cut', icon: Scissors },
    { id: 'merge', label: 'Join / Merge', icon: Layers },
    { id: 'subtitles', label: 'Subtitle Studio', icon: Subtitles },
    { id: 'auto-clips', label: 'Auto Clips', icon: Clapperboard },
  ];

  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-6">
      {/* Page Header & Segmented Tool Switcher */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[#E2E8F0] pb-5">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#0F172A] tracking-tight">
            Media &amp; Audio Toolkit
          </h1>
          <p className="mt-1.5 text-sm text-[#64748B] max-w-2xl">
            Download videos or MP3s from links, convert videos to clean audio, trim or join clips, generate styled subtitles, and auto-extract captioned highlight reels.
          </p>
        </div>

        <div className="inline-flex items-center gap-1 p-1 bg-[#F1F5F9] rounded-xl max-w-full overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setToolError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {toolError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs sm:text-sm text-[#B91C1C] flex items-start gap-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{toolError}</span>
        </div>
      )}

      {/* TAB 1: ANY-PLATFORM LINK DOWNLOADER */}
      {activeTab === 'downloader' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#0F172A]">
                  Download Video or Audio from Link
                </h2>
                <p className="mt-1 text-xs text-[#64748B]">
                  Supports YouTube, TikTok, Instagram, Facebook, X/Twitter, Vimeo, Reddit, SoundCloud, and direct MP4/MP3 URLs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAuthPanel((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border whitespace-nowrap shrink-0 cursor-pointer ${
                  authStatus?.hasCookies || authStatus?.hasProxy
                    ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#15803D]'
                    : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {authStatus?.hasCookies
                    ? `Cookies Active (${authStatus.cookieEntries})`
                    : authStatus?.hasProxy
                      ? 'Proxy Active'
                      : 'Cookies & Auth'}
                </span>
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Link2
                  className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleProbeLink();
                  }}
                  placeholder="https://www.youtube.com/watch?v=... or TikTok / Instagram / Vimeo link"
                  aria-label="Media link URL"
                  className="w-full h-11 pl-10 pr-3.5 text-sm bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/15"
                />
              </div>
              <button
                type="button"
                disabled={!linkUrl.trim() || probingLink}
                onClick={() => void handleProbeLink()}
                className="px-4 h-11 text-xs font-medium text-[#0F172A] bg-[#F8FAFC] border border-[#CBD5E1] hover:bg-[#F1F5F9] disabled:opacity-40 rounded-lg whitespace-nowrap shrink-0 cursor-pointer inline-flex items-center justify-center gap-1.5"
              >
                {probingLink ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    <span>Inspecting...</span>
                  </>
                ) : (
                  <span>Inspect Link</span>
                )}
              </button>
            </div>

            {probeResult && (
              <div className="flex items-start gap-3.5 p-3.5 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">
                {probeResult.thumbnailUrl && (
                  <img
                    src={probeResult.thumbnailUrl}
                    alt={probeResult.title}
                    referrerPolicy="no-referrer"
                    className="w-28 h-16 object-cover rounded-md shrink-0 bg-[#0F172A]"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[#0F172A] line-clamp-2">
                    {probeResult.title}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                    <span>{probeResult.platform}</span>
                    <span aria-hidden="true">·</span>
                    <span>{probeResult.author}</span>
                    {probeResult.durationSeconds > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatDuration(probeResult.durationSeconds)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Mode & Format Configuration */}
            <div className="space-y-4 pt-1">
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setDlMode('video')}
                  className={`flex items-center gap-2.5 p-3 rounded-lg border text-left cursor-pointer transition-colors ${
                    dlMode === 'video'
                      ? 'bg-[#EFF6FF] border-[#2563EB] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <FileVideo className="w-4 h-4 text-[#2563EB] shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-xs font-semibold">Video (MP4)</p>
                    <p className="text-[11px] text-[#64748B]">HD video + audio merged</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setDlMode('audio')}
                  className={`flex items-center gap-2.5 p-3 rounded-lg border text-left cursor-pointer transition-colors ${
                    dlMode === 'audio'
                      ? 'bg-[#EFF6FF] border-[#2563EB] text-[#0F172A]'
                      : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <FileAudio className="w-4 h-4 text-[#2563EB] shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-xs font-semibold">Audio Only</p>
                    <p className="text-[11px] text-[#64748B]">Extract MP3, M4A, WAV</p>
                  </div>
                </button>
              </div>

              {dlMode === 'video' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="dl-resolution"
                      className="block text-xs font-medium text-[#475569] mb-1.5"
                    >
                      Target Video Resolution
                    </label>
                    <select
                      id="dl-resolution"
                      value={dlMaxHeight}
                      onChange={(e) => setDlMaxHeight(Number(e.target.value))}
                      className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                    >
                      <option value={2160}>Best Available (Up to 4K)</option>
                      <option value={1080}>1080p Full HD</option>
                      <option value={720}>720p HD (Balanced)</option>
                      <option value={480}>480p SD (Compact)</option>
                      <option value={360}>360p (Fast / Smallest)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1.5">
                      Optional Clip Range (MM:SS)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={dlStartStr}
                        onChange={(e) => setDlStartStr(e.target.value)}
                        placeholder="00:00"
                        aria-label="Clip start time"
                        className="w-full h-10 px-2.5 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                      />
                      <span className="text-xs text-[#94A3B8]">to</span>
                      <input
                        type="text"
                        value={dlEndStr}
                        onChange={(e) => setDlEndStr(e.target.value)}
                        placeholder="Full"
                        aria-label="Clip end time"
                        className="w-full h-10 px-2.5 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label
                      htmlFor="dl-audio-fmt"
                      className="block text-xs font-medium text-[#475569] mb-1.5"
                    >
                      Audio Format
                    </label>
                    <select
                      id="dl-audio-fmt"
                      value={dlAudioFormat}
                      onChange={(e) =>
                        setDlAudioFormat(e.target.value as 'mp3' | 'm4a' | 'wav' | 'flac')
                      }
                      className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                    >
                      <option value="mp3">MP3 (Universal)</option>
                      <option value="m4a">M4A (AAC)</option>
                      <option value="wav">WAV (Lossless)</option>
                      <option value="flac">FLAC (Hi-Fi)</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="dl-audio-br"
                      className="block text-xs font-medium text-[#475569] mb-1.5"
                    >
                      Audio Quality
                    </label>
                    <select
                      id="dl-audio-br"
                      value={dlAudioBitrate}
                      onChange={(e) =>
                        setDlAudioBitrate(e.target.value as '128k' | '192k' | '320k')
                      }
                      className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                    >
                      <option value="320k">320 kbps (Studio)</option>
                      <option value="192k">192 kbps (High)</option>
                      <option value="128k">128 kbps (Compact)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1.5">
                      Clip Range (MM:SS)
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={dlStartStr}
                        onChange={(e) => setDlStartStr(e.target.value)}
                        placeholder="00:00"
                        className="w-full h-10 px-2 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                      />
                      <input
                        type="text"
                        value={dlEndStr}
                        onChange={(e) => setDlEndStr(e.target.value)}
                        placeholder="End"
                        className="w-full h-10 px-2 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                disabled={!linkUrl.trim() || startingDownload || isToolBusy}
                onClick={() => void handleStartLinkDownload()}
                className="w-full sm:w-auto px-5 py-2.5 min-h-[42px] inline-flex items-center justify-center gap-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer transition-colors"
              >
                {startingDownload || isToolBusy ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {dlMode === 'audio'
                    ? `Download ${dlAudioFormat.toUpperCase()} Audio`
                    : 'Download MP4 Video'}
                </span>
              </button>
            </div>

            {showAuthPanel && (
              <div className="p-4 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-[#0F172A]">
                      Cloud Server Bypass: Cookies or Proxy (YouTube / Private Links)
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#64748B] leading-relaxed">
                      YouTube blocks unauthenticated downloads from cloud server IPs. Export your browser&apos;s <span className="font-mono">cookies.txt</span> (Netscape format via &ldquo;Get cookies.txt LOCALLY&rdquo;) once to unlock all YouTube &amp; social video downloads.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAuthPanel(false)}
                    className="text-xs text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                  >
                    Hide
                  </button>
                </div>

                <ol className="text-[11px] text-[#334155] bg-white border border-[#E2E8F0] rounded-lg p-3 space-y-1.5 list-decimal list-inside">
                  <li>
                    Install <span className="font-semibold text-[#0F172A]">Get cookies.txt LOCALLY</span> extension on Chrome, Edge, or Brave.
                  </li>
                  <li>
                    Open <span className="font-mono text-[#0F172A]">youtube.com</span> (logged into any account), click the extension icon, and choose <span className="font-semibold text-[#0F172A]">Export</span> to download <span className="font-mono">cookies.txt</span>.
                  </li>
                  <li>
                    Click <span className="font-semibold text-[#0F172A]">Upload cookies.txt</span> below (or paste the text) and press <span className="font-semibold text-[#0F172A]">Save</span>.
                  </li>
                </ol>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={cookiesFileRef}
                    type="file"
                    accept=".txt"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        const txt = await f.text();
                        setCookiesInput(txt);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => cookiesFileRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-medium text-[#0F172A] bg-white border border-[#CBD5E1] hover:bg-[#F1F5F9] rounded-md cursor-pointer"
                  >
                    Upload cookies.txt
                  </button>
                  {(authStatus?.hasCookies || authStatus?.hasProxy) && (
                    <button
                      type="button"
                      onClick={() => void handleClearAuth()}
                      className="px-3 py-1.5 text-xs font-medium text-[#DC2626] bg-white border border-[#FECACA] hover:bg-[#FEF2F2] rounded-md cursor-pointer"
                    >
                      Clear Saved Auth
                    </button>
                  )}
                  {authMessage && (
                    <span className="text-xs font-medium text-[#16A34A]">{authMessage}</span>
                  )}
                </div>

                <textarea
                  value={cookiesInput}
                  onChange={(e) => setCookiesInput(e.target.value)}
                  rows={4}
                  placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	TRUE	..."
                  aria-label="Paste Netscape cookies.txt"
                  className="w-full p-2.5 font-mono text-[11px] bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB]"
                />

                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                  <input
                    type="text"
                    value={proxyInput}
                    onChange={(e) => setProxyInput(e.target.value)}
                    placeholder="Optional proxy: http://user:pass@host:port"
                    aria-label="Optional proxy URL"
                    className="sm:col-span-7 h-9 px-3 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB]"
                  />
                  <button
                    type="button"
                    disabled={savingAuth || (!cookiesInput.trim() && !proxyInput.trim())}
                    onClick={() => void handleSaveAuth(Boolean(linkUrl.trim()))}
                    className="sm:col-span-5 h-9 px-3 text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] disabled:opacity-40 rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    {savingAuth
                      ? 'Saving...'
                      : linkUrl.trim()
                        ? 'Save & Retry Download'
                        : 'Save Cookies / Proxy'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <ToolOutputPanel
            job={activeToolJob}
            sendingToTranscribe={sendingToTranscribe}
            transcribeLanguage={quickTranscribeLang}
            onTranscribeLanguageChange={setQuickTranscribeLang}
            onTranscribe={(id) => void handleTranscribeToolResult(id)}
            onOpenAuth={() => setShowAuthPanel(true)}
            onDirectYouTubeTranscribe={
              onStartYouTubeTranscribe
                ? (url) => {
                    void onStartYouTubeTranscribe(url, quickTranscribeLang);
                  }
                : undefined
            }
          />
        </div>
      )}

      {/* TAB 2: VIDEO TO AUDIO & CONVERTER */}
      {activeTab === 'converter' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-[#0F172A]">
                Video-to-Audio Converter &amp; Compressor
              </h2>
              <p className="mt-1 text-xs text-[#64748B]">
                Convert any video into MP3, WAV, M4A, OGG, or FLAC audio, or compress large videos into clean 720p/480p MP4 files.
              </p>
            </div>

            <div
              role="button"
              tabIndex={0}
              onClick={() => convFileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  convFileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) setConvFile(f);
              }}
              className="border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB]/60 bg-[#F8FAFC] rounded-xl p-6 text-center cursor-pointer transition-colors"
            >
              <input
                ref={convFileInputRef}
                type="file"
                accept="video/*,audio/*,.mkv,.mov,.avi,.flv,.m4a,.mp3,.wav,.ogg,.flac"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setConvFile(f);
                }}
              />
              <Upload className="w-6 h-6 text-[#2563EB] mx-auto mb-2" aria-hidden="true" />
              {convFile ? (
                <div>
                  <p className="text-sm font-semibold text-[#0F172A] truncate max-w-md mx-auto">
                    {convFile.name}
                  </p>
                  <p className="mt-1 font-mono text-xs text-[#64748B] tabular-nums">
                    {formatBytes(convFile.size)} · Click to replace file
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-[#0F172A]">
                    Drop any video or audio file here, or click to select
                  </p>
                  <p className="mt-1 text-xs text-[#64748B]">
                    Supports MP4, MOV, MKV, WEBM, AVI, MP3, WAV, M4A (up to 10 GB)
                  </p>
                </div>
              )}
            </div>

            {/* Quick One-Click Presets */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-[#64748B]">Quick Presets:</span>
              <button
                type="button"
                onClick={() => {
                  setConvFormat('mp3');
                  setConvBitrate('192k');
                  setConvNormalize(true);
                  setConvEnhanceVoice(true);
                  setConvSpeed(1);
                }}
                className="px-2.5 py-1 text-[11px] font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#2563EB] hover:text-[#1D4ED8] rounded-md cursor-pointer"
              >
                Podcast Clean MP3
              </button>
              <button
                type="button"
                onClick={() => {
                  setConvFormat('mp4');
                  setConvResolution('480');
                  setConvNormalize(true);
                  setConvEnhanceVoice(false);
                  setConvSpeed(1);
                }}
                className="px-2.5 py-1 text-[11px] font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#2563EB] hover:text-[#1D4ED8] rounded-md cursor-pointer"
              >
                WhatsApp Video (480p)
              </button>
              <button
                type="button"
                onClick={() => {
                  setConvFormat('wav');
                  setConvNormalize(false);
                  setConvEnhanceVoice(true);
                  setConvSpeed(1);
                }}
                className="px-2.5 py-1 text-[11px] font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] hover:border-[#2563EB] hover:text-[#1D4ED8] rounded-md cursor-pointer"
              >
                Studio Lossless WAV
              </button>
            </div>

            {/* Output Format Grid */}
            <div className="space-y-2">
              <span className="block text-xs font-medium text-[#475569]">Output Format</span>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4'] as MediaOutputFormat[]).map(
                  (fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setConvFormat(fmt)}
                      className={`py-2 px-2 text-xs font-mono font-semibold uppercase rounded-lg border cursor-pointer transition-colors ${
                        convFormat === fmt
                          ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                          : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                      }`}
                    >
                      {fmt === 'mp4' ? 'MP4 Video' : fmt}
                    </button>
                  ),
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {convFormat !== 'mp4' ? (
                <div>
                  <label
                    htmlFor="conv-bitrate"
                    className="block text-xs font-medium text-[#475569] mb-1.5"
                  >
                    Audio Bitrate
                  </label>
                  <select
                    id="conv-bitrate"
                    value={convBitrate}
                    onChange={(e) =>
                      setConvBitrate(e.target.value as '128k' | '192k' | '320k')
                    }
                    disabled={convFormat === 'wav' || convFormat === 'flac'}
                    className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] disabled:opacity-50"
                  >
                    <option value="320k">320 kbps (Highest)</option>
                    <option value="192k">192 kbps (Standard)</option>
                    <option value="128k">128 kbps (Compact)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="conv-res"
                    className="block text-xs font-medium text-[#475569] mb-1.5"
                  >
                    Target Video Size
                  </label>
                  <select
                    id="conv-res"
                    value={convResolution}
                    onChange={(e) =>
                      setConvResolution(
                        e.target.value as 'original' | '1080' | '720' | '480',
                      )
                    }
                    className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                  >
                    <option value="720">720p HD (Balanced Compress)</option>
                    <option value="480">480p SD (Max Savings)</option>
                    <option value="1080">1080p Full HD</option>
                    <option value="original">Original Resolution</option>
                  </select>
                </div>
              )}

              <div>
                <label
                  htmlFor="conv-speed"
                  className="block text-xs font-medium text-[#475569] mb-1.5"
                >
                  Playback Speed
                </label>
                <select
                  id="conv-speed"
                  value={convSpeed}
                  onChange={(e) => setConvSpeed(Number(e.target.value))}
                  className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                >
                  <option value={0.75}>0.75x (Slower)</option>
                  <option value={1}>1.0x (Original)</option>
                  <option value={1.25}>1.25x (Podcast Pace)</option>
                  <option value={1.5}>1.5x (Fast)</option>
                  <option value={2}>2.0x (Double Speed)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1.5">
                  Optional Trim (MM:SS)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={convStartStr}
                    onChange={(e) => setConvStartStr(e.target.value)}
                    placeholder="00:00"
                    className="w-full h-10 px-2 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                  />
                  <input
                    type="text"
                    value={convEndStr}
                    onChange={(e) => setConvEndStr(e.target.value)}
                    placeholder="End"
                    className="w-full h-10 px-2 font-mono text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A]"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-5 pt-1">
              <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                <input
                  type="checkbox"
                  checked={convNormalize}
                  onChange={(e) => setConvNormalize(e.target.checked)}
                  className="rounded border-[#CBD5E1] text-[#2563EB]"
                />
                <span>Normalize voice loudness (-16 LUFS)</span>
              </label>

              <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                <input
                  type="checkbox"
                  checked={convEnhanceVoice}
                  onChange={(e) => setConvEnhanceVoice(e.target.checked)}
                  className="rounded border-[#CBD5E1] text-[#2563EB]"
                />
                <span>Clean vocal clarity &amp; noise reduction</span>
              </label>

              {convFormat !== 'mp4' && (
                <label className="flex items-center gap-2 text-xs text-[#334155] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={convRemoveSilence}
                    onChange={(e) => setConvRemoveSilence(e.target.checked)}
                    className="rounded border-[#CBD5E1] text-[#2563EB]"
                  />
                  <span>Trim long dead-air pauses</span>
                </label>
              )}
            </div>

            {convUploadPct !== null && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-[#475569]">
                  <span>Uploading media to server...</span>
                  <span className="font-mono tabular-nums">{convUploadPct}%</span>
                </div>
                <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#2563EB]"
                    style={{ width: `${convUploadPct}%` }}
                  />
                </div>
              </div>
            )}

            <div className="pt-1 flex justify-end">
              <button
                type="button"
                disabled={!convFile || convUploadPct !== null || isToolBusy}
                onClick={() =>
                  convFile &&
                  void runUploadAndConvert({
                    file: convFile,
                    kind: 'convert',
                    outputFormat: convFormat,
                    audioBitrate: convBitrate,
                    videoResolution: convResolution,
                    startSec: parseTimestampInput(convStartStr),
                    endSec: parseTimestampInput(convEndStr),
                    normalizeAudio: convNormalize,
                    removeSilence: convRemoveSilence,
                    enhanceVoice: convEnhanceVoice,
                    speed: convSpeed,
                    onProgress: setConvUploadPct,
                  })
                }
                className="w-full sm:w-auto px-5 py-2.5 min-h-[42px] inline-flex items-center justify-center gap-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer transition-colors"
              >
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
                <span>
                  {convFormat === 'mp4'
                    ? 'Compress & Export MP4'
                    : `Convert to ${convFormat.toUpperCase()}`}
                </span>
              </button>
            </div>
          </div>

          <ToolOutputPanel
            job={activeToolJob}
            sendingToTranscribe={sendingToTranscribe}
            transcribeLanguage={quickTranscribeLang}
            onTranscribeLanguageChange={setQuickTranscribeLang}
            onTranscribe={(id) => void handleTranscribeToolResult(id)}
          />
        </div>
      )}

      {/* TAB 3: VISUAL TRIM & CUT STUDIO */}
      {activeTab === 'trimmer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#0F172A]">
                  Trim &amp; Clip Studio
                </h2>
                <p className="mt-1 text-xs text-[#64748B]">
                  Preview your video or audio, scrub to exact moments, mark Start / End points, and extract a crisp clip.
                </p>
              </div>
              {trimFile && (
                <button
                  type="button"
                  onClick={() => trimFileInputRef.current?.click()}
                  className="text-xs font-medium text-[#2563EB] hover:underline whitespace-nowrap cursor-pointer"
                >
                  Change File
                </button>
              )}
            </div>

            <input
              ref={trimFileInputRef}
              type="file"
              accept="video/*,audio/*,.mkv,.mov,.mp4,.mp3,.wav,.m4a"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleSelectTrimFile(f);
              }}
            />

            {!trimFile || !trimPreviewUrl ? (
              <button
                type="button"
                onClick={() => trimFileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB]/60 bg-[#F8FAFC] rounded-xl p-10 text-center cursor-pointer transition-colors"
              >
                <Scissors className="w-6 h-6 text-[#2563EB] mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm font-medium text-[#0F172A]">
                  Select a Video or Audio file to trim
                </p>
                <p className="mt-1 text-xs text-[#64748B]">
                  Instant local preview with frame-accurate Start / End playhead markers
                </p>
              </button>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg overflow-hidden border border-[#E2E8F0] bg-[#0F172A]">
                  {trimFile.type.startsWith('audio/') ? (
                    <div className="p-4 bg-[#F8FAFC]">
                      <audio
                        ref={(el) => {
                          trimMediaRef.current = el;
                        }}
                        src={trimPreviewUrl}
                        controls
                        onLoadedMetadata={(e) => {
                          const dur = Math.floor(e.currentTarget.duration || 0);
                          setTrimDurationSec(dur);
                          if (!trimEndStr && dur > 0) setTrimEndStr(formatDuration(dur));
                        }}
                        onTimeUpdate={(e) =>
                          setTrimCurrentSec(Math.floor(e.currentTarget.currentTime))
                        }
                        className="w-full"
                      />
                    </div>
                  ) : (
                    <video
                      ref={(el) => {
                        trimMediaRef.current = el;
                      }}
                      src={trimPreviewUrl}
                      controls
                      onLoadedMetadata={(e) => {
                        const dur = Math.floor(e.currentTarget.duration || 0);
                        setTrimDurationSec(dur);
                        if (!trimEndStr && dur > 0) setTrimEndStr(formatDuration(dur));
                      }}
                      onTimeUpdate={(e) =>
                        setTrimCurrentSec(Math.floor(e.currentTarget.currentTime))
                      }
                      className="w-full max-h-[300px] bg-[#0F172A]"
                    />
                  )}
                </div>

                {/* Playhead Marker Buttons */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#475569]">Start Time (In)</span>
                      <button
                        type="button"
                        onClick={() => setTrimStartStr(formatDuration(trimCurrentSec))}
                        className="text-[11px] font-semibold text-[#2563EB] hover:underline cursor-pointer"
                      >
                        Use Playhead ({formatDuration(trimCurrentSec)})
                      </button>
                    </div>
                    <input
                      type="text"
                      value={trimStartStr}
                      onChange={(e) => setTrimStartStr(e.target.value)}
                      placeholder="00:00"
                      className="w-full h-9 px-2.5 font-mono text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A]"
                    />
                  </div>

                  <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#475569]">End Time (Out)</span>
                      <button
                        type="button"
                        onClick={() => setTrimEndStr(formatDuration(trimCurrentSec))}
                        className="text-[11px] font-semibold text-[#2563EB] hover:underline cursor-pointer"
                      >
                        Use Playhead ({formatDuration(trimCurrentSec)})
                      </button>
                    </div>
                    <input
                      type="text"
                      value={trimEndStr}
                      onChange={(e) => setTrimEndStr(e.target.value)}
                      placeholder={trimDurationSec > 0 ? formatDuration(trimDurationSec) : 'End'}
                      className="w-full h-9 px-2.5 font-mono text-xs bg-white border border-[#CBD5E1] rounded-md text-[#0F172A]"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#64748B]">Export as:</span>
                    <div className="inline-flex p-0.5 bg-[#F1F5F9] rounded-lg">
                      {(['mp4', 'mp3', 'wav', 'm4a'] as MediaOutputFormat[]).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => setTrimOutputFormat(fmt)}
                          className={`px-2.5 py-1 text-xs font-mono uppercase rounded-md cursor-pointer ${
                            trimOutputFormat === fmt
                              ? 'bg-white text-[#0F172A] shadow-xs font-semibold'
                              : 'text-[#64748B]'
                          }`}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={trimUploadPct !== null || isToolBusy}
                    onClick={() =>
                      void runUploadAndConvert({
                        file: trimFile,
                        kind: 'trim',
                        outputFormat: trimOutputFormat,
                        audioBitrate: '192k',
                        videoResolution: 'original',
                        startSec: parseTimestampInput(trimStartStr),
                        endSec: parseTimestampInput(trimEndStr),
                        normalizeAudio: false,
                        removeSilence: false,
                        speed: 1,
                        onProgress: setTrimUploadPct,
                      })
                    }
                    className="px-5 py-2.5 min-h-[40px] inline-flex items-center gap-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer"
                  >
                    <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {trimUploadPct !== null
                        ? `Uploading ${trimUploadPct}%...`
                        : `Cut & Export ${trimOutputFormat.toUpperCase()}`}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <ToolOutputPanel
            job={activeToolJob}
            sendingToTranscribe={sendingToTranscribe}
            transcribeLanguage={quickTranscribeLang}
            onTranscribeLanguageChange={setQuickTranscribeLang}
            onTranscribe={(id) => void handleTranscribeToolResult(id)}
          />
        </div>
      )}

      {/* TAB 4: MULTI-FILE JOIN / MERGE STUDIO */}
      {activeTab === 'merge' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#0F172A]">
                  Join / Merge Audio &amp; Video Clips
                </h2>
                <p className="mt-1 text-xs text-[#64748B]">
                  Combine multiple voice recordings, lecture parts, or video segments into one seamless MP4, MP3, M4A, or WAV file.
                </p>
              </div>
              {mergeFiles.length > 0 && (
                <button
                  type="button"
                  onClick={() => mergeFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#2563EB] bg-[#EFF6FF] hover:bg-[#DBEAFE] rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add Clips</span>
                </button>
              )}
            </div>

            <input
              ref={mergeFileInputRef}
              type="file"
              multiple
              accept="video/*,audio/*,.mkv,.mov,.mp4,.mp3,.wav,.m4a,.aac,.ogg,.flac"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addMergeFiles(e.target.files);
                e.target.value = '';
              }}
            />

            {mergeFiles.length === 0 ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => mergeFileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    mergeFileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addMergeFiles(e.dataTransfer.files);
                }}
                className="border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB]/60 bg-[#F8FAFC] rounded-xl p-8 text-center cursor-pointer transition-colors"
              >
                <Layers className="w-6 h-6 text-[#2563EB] mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm font-medium text-[#0F172A]">
                  Drop 2 or more audio/video clips here, or click to select
                </p>
                <p className="mt-1 text-xs text-[#64748B]">
                  Supports mixed formats or resolutions — automatically stitched cleanly in order
                </p>
              </div>
            ) : (
              <div className="space-y-2 border border-[#E2E8F0] rounded-lg divide-y divide-[#F1F5F9]">
                {mergeFiles.map((file, idx) => (
                  <div
                    key={`${file.name}_${idx}`}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 bg-white first:rounded-t-lg last:rounded-b-lg"
                  >
                    <div className="min-w-0 flex items-center gap-2.5">
                      <span className="font-mono text-xs text-[#64748B] w-5 shrink-0 tabular-nums">
                        {idx + 1}.
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-[#0F172A] truncate">{file.name}</p>
                        <p className="font-mono text-[11px] text-[#64748B] tabular-nums">
                          {formatBytes(file.size)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveMergeFile(idx, -1)}
                        aria-label="Move clip up"
                        className="p-1.5 text-[#64748B] hover:text-[#0F172A] disabled:opacity-30 cursor-pointer rounded"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === mergeFiles.length - 1}
                        onClick={() => moveMergeFile(idx, 1)}
                        aria-label="Move clip down"
                        className="p-1.5 text-[#64748B] hover:text-[#0F172A] disabled:opacity-30 cursor-pointer rounded"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeMergeFile(idx)}
                        aria-label="Remove clip"
                        className="p-1.5 text-[#94A3B8] hover:text-[#DC2626] cursor-pointer rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1.5">
                  Output Format
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {(['mp4', 'mp3', 'm4a', 'wav'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setMergeFormat(fmt)}
                      className={`py-2 text-xs font-mono uppercase font-semibold rounded-lg border cursor-pointer ${
                        mergeFormat === fmt
                          ? 'bg-[#EFF6FF] border-[#2563EB] text-[#1D4ED8]'
                          : 'bg-white border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC]'
                      }`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="merge-bitrate"
                  className="block text-xs font-medium text-[#475569] mb-1.5"
                >
                  Audio Quality
                </label>
                <select
                  id="merge-bitrate"
                  value={mergeBitrate}
                  onChange={(e) =>
                    setMergeBitrate(e.target.value as '128k' | '192k' | '320k')
                  }
                  disabled={mergeFormat === 'wav'}
                  className="w-full h-9 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] disabled:opacity-50"
                >
                  <option value="320k">320 kbps (Studio)</option>
                  <option value="192k">192 kbps (High)</option>
                  <option value="128k">128 kbps (Compact)</option>
                </select>
              </div>
            </div>

            {mergeUploadPct !== null && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-[#475569]">
                  <span>{mergeUploadLabel || 'Uploading clips...'}</span>
                  <span className="font-mono tabular-nums">{mergeUploadPct}%</span>
                </div>
                <div className="h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#2563EB] transition-all duration-150"
                    style={{ width: `${mergeUploadPct}%` }}
                  />
                </div>
              </div>
            )}

            <div className="pt-1 flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-[#64748B] tabular-nums">
                {mergeFiles.length} clip{mergeFiles.length === 1 ? '' : 's'} queued
              </span>
              <button
                type="button"
                disabled={mergeFiles.length < 2 || mergeUploadPct !== null || isToolBusy}
                onClick={() => void runMergeUploadAndJob()}
                className="px-5 py-2.5 min-h-[42px] inline-flex items-center gap-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-45 rounded-lg cursor-pointer transition-colors"
              >
                <Layers className="w-4 h-4" aria-hidden="true" />
                <span>Join {mergeFiles.length} Clips</span>
              </button>
            </div>
          </div>

          <ToolOutputPanel
            job={activeToolJob}
            sendingToTranscribe={sendingToTranscribe}
            transcribeLanguage={quickTranscribeLang}
            onTranscribeLanguageChange={setQuickTranscribeLang}
            onTranscribe={(id) => void handleTranscribeToolResult(id)}
          />
        </div>
      )}

      {/* TAB 5: AI VIDEO & AUDIO SUBTITLE STUDIO */}
      {activeTab === 'subtitles' && (
        <SubtitleStudioTab
          savedJobs={savedJobs}
          initialJob={initialSubtitlesJob}
          onConsumeInitialJob={onConsumeInitialSubtitlesJob}
          onError={setToolError}
        />
      )}

      {/* TAB 6: AI AUTO CLIPS FINDER & CAPTIONED REEL STUDIO */}
      {activeTab === 'auto-clips' && (
        <AutoClipsTab savedJobs={savedJobs} onError={setToolError} />
      )}
    </div>
  );
}

function ToolOutputPanel({
  job,
  sendingToTranscribe,
  transcribeLanguage,
  onTranscribeLanguageChange,
  onTranscribe,
  onOpenAuth,
  onDirectYouTubeTranscribe,
}: {
  job: ToolJob | null;
  sendingToTranscribe: boolean;
  transcribeLanguage: string;
  onTranscribeLanguageChange: (lang: string) => void;
  onTranscribe: (jobId: string) => void;
  onOpenAuth?: () => void;
  onDirectYouTubeTranscribe?: (url: string) => void;
}) {
  if (!job) {
    return (
      <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-6 space-y-3">
        <h3 className="font-display text-sm font-semibold text-[#0F172A]">
          Output &amp; Quick Transcribe
        </h3>
        <p className="text-xs text-[#64748B] leading-relaxed">
          Your processed video or extracted audio will appear here for instant playback preview, download, or one-click transcription.
        </p>
        <div className="pt-2 border-t border-[#F1F5F9] space-y-2 text-xs text-[#475569]">
          <p>· Download full videos or clip highlights from links</p>
          <p>· Extract clean MP3 / WAV / M4A / FLAC audio tracks</p>
          <p>· Send any output directly into Hanzx Studio transcription</p>
        </div>
      </div>
    );
  }

  const inlineUrl = `/api/tools/jobs/${job.id}/file?inline=1`;
  const downloadUrl = `/api/tools/jobs/${job.id}/file`;
  const isAudio = job.outputMimeType?.startsWith('audio/');
  const isYouTubeSource = Boolean(
    job.sourceUrl && /(?:youtube\.com|youtu\.be)/i.test(job.sourceUrl),
  );

  const savingsPct =
    job.inputBytes && job.outputBytes && job.inputBytes > job.outputBytes
      ? Math.round(((job.inputBytes - job.outputBytes) / job.inputBytes) * 100)
      : null;

  return (
    <div className="lg:col-span-5 bg-white border border-[#E2E8F0] rounded-xl p-5 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold text-[#0F172A] truncate">
            {job.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
            <span className="font-mono">{job.outputFormat}</span>
            {job.platform && (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.platform}</span>
              </>
            )}
            {job.durationSeconds ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {formatDuration(job.durationSeconds)}
                </span>
              </>
            ) : null}
            {job.outputBytes ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{formatBytes(job.outputBytes)}</span>
              </>
            ) : null}
            {savingsPct !== null && savingsPct > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[#16A34A] tabular-nums">
                  {savingsPct}% smaller
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {job.status === 'processing' || job.status === 'queued' ? (
        <div className="space-y-2.5 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-2 text-[#0F172A] font-medium">
              <Loader2 className="w-3.5 h-3.5 text-[#2563EB] animate-spin" aria-hidden="true" />
              <span>{job.stageLabel}</span>
            </span>
            <span className="font-mono text-[#2563EB] font-semibold tabular-nums">
              {job.progressPercent}%
            </span>
          </div>
          <div className="h-2 bg-[#F1F5F9] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#2563EB] transition-all duration-200"
              style={{ width: `${Math.max(4, job.progressPercent)}%` }}
            />
          </div>
        </div>
      ) : job.status === 'error' ? (
        <div className="space-y-3">
          <div className="p-3.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#B91C1C] leading-relaxed">
            {job.error || job.stageLabel}
          </div>
          {job.requiresAuth && (
            <div className="flex flex-col gap-2">
              {onOpenAuth && (
                <button
                  type="button"
                  onClick={onOpenAuth}
                  className="w-full py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] rounded-lg cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add cookies.txt to Unlock Download</span>
                </button>
              )}
              {isYouTubeSource && job.sourceUrl && onDirectYouTubeTranscribe && (
                <button
                  type="button"
                  onClick={() => onDirectYouTubeTranscribe(job.sourceUrl!)}
                  className="w-full py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#1D4ED8] bg-[#EFF6FF] border border-[#BFDBFE] hover:bg-[#DBEAFE] rounded-lg cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Transcribe This YouTube Video Without Cookies</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium text-[#16A34A]">
            <Check className="w-4 h-4" aria-hidden="true" />
            <span>{job.stageLabel}</span>
          </div>

          {isAudio ? (
            <div className="p-3 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">
              <audio src={inlineUrl} controls className="w-full" />
            </div>
          ) : (
            <div className="rounded-lg overflow-hidden border border-[#E2E8F0] bg-[#0F172A]">
              <video src={inlineUrl} controls className="w-full max-h-[240px]" />
            </div>
          )}

          <div className="space-y-2.5">
            <div>
              <label
                htmlFor="quick-transcribe-lang"
                className="block text-[11px] font-medium text-[#475569] mb-1"
              >
                Transcription Language / Script
              </label>
              <select
                id="quick-transcribe-lang"
                value={transcribeLanguage}
                onChange={(e) => onTranscribeLanguageChange(e.target.value)}
                className="w-full h-9 px-2.5 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB]"
              >
                {QUICK_TRANSCRIBE_LANGUAGES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <a
                href={downloadUrl}
                download={job.outputFilename || true}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[40px] text-xs font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Download {job.outputFormat}</span>
              </a>

              <button
                type="button"
                disabled={sendingToTranscribe}
                onClick={() => onTranscribe(job.id)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[40px] text-xs font-semibold text-[#0F172A] bg-[#F8FAFC] border border-[#CBD5E1] hover:bg-[#F1F5F9] disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
              >
                {sendingToTranscribe ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" aria-hidden="true" />
                )}
                <span>Transcribe This</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
