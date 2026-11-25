import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FileAudio,
  FileVideo,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Upload,
  Youtube,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SourceKind, TranscriptionOptions, YouTubeInfo } from '../types/transcription';
import { formatBytes, formatDuration } from '../utils/formatters';

interface IngestWorkbenchProps {
  onStartUpload: (params: {
    file: File;
    sourceKind: 'video' | 'audio';
    options: TranscriptionOptions;
    onUploadProgress: (pct: number) => void;
  }) => Promise<void>;
  onStartYouTube: (params: {
    url: string;
    info?: YouTubeInfo;
    options: TranscriptionOptions;
  }) => Promise<void>;
}

type IngestTab = SourceKind | 'record';

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto-detect (Original spoken language)' },
  { value: 'Urdu (Pure Nastaliq Script)', label: 'Urdu Only (صرف خالص اردو — No Roman/English)' },
  { value: 'Roman Urdu (Latin Script)', label: 'Roman Urdu Only (Latin Script — e.g., Aap kaise hain)' },
  { value: 'Urdu + English (Bilingual)', label: 'Urdu + English (اردو + صرف بولے گئے انگریزی الفاظ)' },
  { value: 'English', label: 'English' },
  { value: 'Hindi (हिन्दी)', label: 'Hindi (हिन्दी)' },
  { value: 'Arabic (العربية)', label: 'Arabic (العربية)' },
  { value: 'Spanish', label: 'Spanish' },
  { value: 'French', label: 'French' },
  { value: 'German', label: 'German' },
];

export function IngestWorkbench({ onStartUpload, onStartYouTube }: IngestWorkbenchProps) {
  const [ingestTab, setIngestTab] = useState<IngestTab>('video');
  const sourceKind: SourceKind = ingestTab === 'record' ? 'audio' : ingestTab;

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localDurationSec, setLocalDurationSec] = useState<number>(0);
  const [isDragging, setIsDragging] = useState(false);

  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeInfo, setYoutubeInfo] = useState<YouTubeInfo | null>(null);
  const [fetchingYt, setFetchingYt] = useState(false);
  const [ytLookupError, setYtLookupError] = useState<string | null>(null);

  // Live Voice Recorder State
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused' | 'recorded'>('idle');
  const [recSeconds, setRecSeconds] = useState(0);
  const [recLevels, setRecLevels] = useState<number[]>(() => Array(16).fill(12));
  const [recTitle, setRecTitle] = useState('');
  const [recFile, setRecFile] = useState<File | null>(null);
  const [recPreviewUrl, setRecPreviewUrl] = useState<string | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  const [options, setOptions] = useState<TranscriptionOptions>({
    language: 'auto',
    translateToEnglish: false,
    identifySpeakers: true,
    timestampInterval: 'turn',
    autoAnalyze: true,
  });

  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const recChunksRef = useRef<Blob[]>([]);

  const cleanupRecorderResources = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (recTimerRef.current !== null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      cleanupRecorderResources();
      if (recPreviewUrl) URL.revokeObjectURL(recPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (tab: IngestTab) => {
    if (recState === 'recording' || recState === 'paused') {
      stopRecording();
    }
    setIngestTab(tab);
    setSelectedFile(null);
    setLocalDurationSec(0);
    setSubmitError(null);
    setRecError(null);
    setUploadProgress(0);
  };

  // Probe local file duration directly in browser metadata so user gets chunk estimate before upload
  useEffect(() => {
    if (!selectedFile) {
      setLocalDurationSec(0);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    const el = document.createElement(sourceKind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setLocalDurationSec(Math.round(el.duration));
      }
      URL.revokeObjectURL(url);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
    };
    el.src = url;
  }, [selectedFile, sourceKind]);

  // Debounced YouTube info lookup
  useEffect(() => {
    if (ingestTab !== 'youtube') return;
    const trimmed = youtubeUrl.trim();
    if (!trimmed) {
      setYoutubeInfo(null);
      setYtLookupError(null);
      return;
    }
    if (!trimmed.includes('youtube.com') && !trimmed.includes('youtu.be') && trimmed.length !== 11) {
      setYoutubeInfo(null);
      setYtLookupError(null);
      return;
    }

    const timer = setTimeout(async () => {
      setFetchingYt(true);
      setYtLookupError(null);
      try {
        const res = await fetch(`/api/youtube/info?url=${encodeURIComponent(trimmed)}`);
        const data = (await res.json()) as YouTubeInfo & { error?: string };
        if (!res.ok) {
          setYoutubeInfo(null);
          setYtLookupError(data.error || 'Could not load video details.');
        } else {
          setYoutubeInfo(data);
        }
      } catch {
        setYtLookupError('Network error while checking YouTube link.');
      } finally {
        setFetchingYt(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [youtubeUrl, ingestTab]);

  const startRecording = async () => {
    setRecError(null);
    setSubmitError(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecError('Live microphone recording is not supported in this browser context.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recChunksRef.current = [];

      if (recPreviewUrl) {
        URL.revokeObjectURL(recPreviewUrl);
        setRecPreviewUrl(null);
      }
      setRecFile(null);
      setRecSeconds(0);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        cleanupRecorderResources();
        const actualMime = recorder.mimeType || mimeType || 'audio/webm';
        const ext = actualMime.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(recChunksRef.current, { type: actualMime });
        const stamp = new Date().toTimeString().slice(0, 5).replace(':', '');
        const cleanTitle = (recTitle.trim() || `Voice_Note_${stamp}`).replace(/[^a-zA-Z0-9 _-]+/g, '_');
        const file = new File([blob], `${cleanTitle}.${ext}`, { type: actualMime });
        const url = URL.createObjectURL(blob);
        setRecFile(file);
        setRecPreviewUrl(url);
        setRecState('recorded');
        setRecLevels(Array(16).fill(12));
      };

      // Setup live waveform analyzer
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        const ctx = new AudioContextCtor();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tickMeter = () => {
          analyser.getByteFrequencyData(data);
          const bars: number[] = [];
          for (let i = 0; i < 16; i++) {
            const val = data[i % data.length] || 0;
            bars.push(Math.max(12, Math.min(100, Math.round((val / 255) * 100))));
          }
          setRecLevels(bars);
          rafRef.current = requestAnimationFrame(tickMeter);
        };
        rafRef.current = requestAnimationFrame(tickMeter);
      }

      recorder.start(300);
      setRecState('recording');
      recTimerRef.current = window.setInterval(() => {
        setRecSeconds((s) => s + 1);
      }, 1000);
    } catch (err) {
      cleanupRecorderResources();
      const msg = err instanceof Error ? err.message : 'Microphone access denied.';
      setRecError(
        /denied|permission|notallowed/i.test(msg)
          ? 'Microphone permission was blocked. Allow mic access in your browser bar or upload an audio file instead.'
          : msg,
      );
    }
  };

  const togglePauseRecording = () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.pause();
      if (recTimerRef.current !== null) {
        window.clearInterval(recTimerRef.current);
        recTimerRef.current = null;
      }
      setRecState('paused');
    } else if (rec.state === 'paused') {
      rec.resume();
      recTimerRef.current = window.setInterval(() => {
        setRecSeconds((s) => s + 1);
      }, 1000);
      setRecState('recording');
    }
  };

  const stopRecording = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    } else {
      cleanupRecorderResources();
      setRecState('idle');
    }
  };

  const resetRecording = () => {
    if (recPreviewUrl) URL.revokeObjectURL(recPreviewUrl);
    setRecPreviewUrl(null);
    setRecFile(null);
    setRecSeconds(0);
    setRecState('idle');
    setRecError(null);
  };

  const handleFileChosen = (file: File | undefined) => {
    if (!file) return;
    setSubmitError(null);
    setSelectedFile(file);
    if (file.type.startsWith('audio/')) {
      setIngestTab('audio');
    } else if (file.type.startsWith('video/')) {
      setIngestTab('video');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (ingestTab === 'youtube') {
      if (!youtubeUrl.trim()) {
        setSubmitError('Paste a valid YouTube video URL to continue.');
        return;
      }
      setSubmitting(true);
      try {
        await onStartYouTube({
          url: youtubeUrl.trim(),
          info: youtubeInfo || undefined,
          options,
        });
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to start YouTube transcription.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const fileToSend = ingestTab === 'record' ? recFile : selectedFile;
    if (!fileToSend) {
      setSubmitError(
        ingestTab === 'record'
          ? 'Record and stop a voice memo first before transcribing.'
          : `Select a ${sourceKind} file to transcribe.`,
      );
      return;
    }

    setSubmitting(true);
    setUploadProgress(0);
    try {
      await onStartUpload({
        file: fileToSend,
        sourceKind: ingestTab === 'record' ? 'audio' : sourceKind === 'audio' ? 'audio' : 'video',
        options,
        onUploadProgress: setUploadProgress,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to upload media file.');
    } finally {
      setSubmitting(false);
    }
  };

  const activeDuration =
    ingestTab === 'youtube'
      ? youtubeInfo?.durationSeconds || 0
      : ingestTab === 'record'
        ? recSeconds
        : localDurationSec;
  const chunkWindowSec = activeDuration > 7200 ? 300 : 240;
  const estimatedChunks = activeDuration > 0 ? Math.max(1, Math.ceil(activeDuration / chunkWindowSec)) : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
      <div className="mb-6 sm:mb-8">
        <h1
          className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-[#0F172A]"
          style={{ textWrap: 'balance' }}
        >
          Transcribe video, audio, voice &amp; YouTube links
        </h1>
        <p className="mt-2 text-sm sm:text-base text-[#475569] max-w-2xl leading-relaxed">
          Long-form recordings use single-pass streaming segmentation and adaptive parallel processing so 5–10+ hour lectures, podcasts, and interviews transcribe cleanly across Pure Urdu, Roman Urdu, bilingual, and global languages.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden"
      >
        {/* Mode Switcher */}
        <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-4 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex items-center p-1 bg-[#F1F5F9] rounded-lg overflow-x-auto max-w-full"
            role="tablist"
            aria-label="Media source type"
          >
            <button
              type="button"
              role="tab"
              aria-selected={ingestTab === 'video'}
              onClick={() => switchMode('video')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                ingestTab === 'video'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <FileVideo className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Video File</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={ingestTab === 'audio'}
              onClick={() => switchMode('audio')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                ingestTab === 'audio'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <FileAudio className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Audio File</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={ingestTab === 'youtube'}
              onClick={() => switchMode('youtube')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                ingestTab === 'youtube'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <Youtube className="w-3.5 h-3.5" aria-hidden="true" />
              <span>YouTube Link</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={ingestTab === 'record'}
              onClick={() => switchMode('record')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                ingestTab === 'record'
                  ? 'bg-white text-[#0F172A] shadow-xs'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <Mic className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Voice Mic</span>
            </button>
          </div>

          <span className="text-xs text-[#64748B] font-mono tabular-nums">
            {ingestTab === 'youtube'
              ? 'Supports 5–10+ hr videos'
              : ingestTab === 'record'
                ? 'Live browser microphone'
                : 'Up to 10 GB · 5–10+ hr recordings'}
          </span>
        </div>

        {/* Input Zone */}
        <div className="p-4 sm:p-6 space-y-6">
          {ingestTab === 'youtube' ? (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="youtube-url-input"
                  className="block text-sm font-medium text-[#0F172A] mb-2"
                >
                  YouTube Video URL
                </label>
                <div className="relative">
                  <input
                    id="youtube-url-input"
                    type="url"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full h-11 px-3.5 pr-10 text-sm bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20"
                  />
                  {fetchingYt && (
                    <Loader2
                      className="w-4 h-4 text-[#2563EB] animate-spin absolute right-3.5 top-1/2 -translate-y-1/2"
                      aria-label="Loading YouTube details"
                    />
                  )}
                </div>
                {ytLookupError && (
                  <p className="mt-2 text-xs text-[#DC2626] flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{ytLookupError}</span>
                  </p>
                )}
              </div>

              {youtubeInfo && (
                <div className="flex flex-col sm:flex-row items-stretch gap-4 p-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg">
                  <div className="w-full sm:w-44 aspect-video rounded-md overflow-hidden bg-[#E2E8F0] shrink-0 relative">
                    <img
                      src={youtubeInfo.thumbnailUrl}
                      alt={youtubeInfo.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col justify-between py-0.5">
                    <div>
                      <p className="text-sm font-semibold text-[#0F172A] line-clamp-2">
                        {youtubeInfo.title}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                        <span>{youtubeInfo.author}</span>
                        {youtubeInfo.durationSeconds > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {formatDuration(youtubeInfo.durationSeconds)}
                            </span>
                          </>
                        )}
                        {estimatedChunks > 1 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums text-[#2563EB]">
                              {estimatedChunks} auto-chunks
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-[#475569]">
                      Ready to process via multi-layer YouTube audio &amp; video chunking.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : ingestTab === 'record' ? (
            <div className="border border-[#E2E8F0] bg-[#F8FAFC] rounded-xl p-5 sm:p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-[#0F172A]">
                    Live Microphone Recorder
                  </h2>
                  <p className="mt-0.5 text-xs text-[#64748B]">
                    Record voice notes, lectures, or meetings directly and transcribe in one click.
                  </p>
                </div>
                <span className="font-mono text-xl font-bold text-[#0F172A] tabular-nums">
                  {formatDuration(recSeconds)}
                </span>
              </div>

              {/* Waveform Meter */}
              <div
                className="h-14 px-4 bg-white border border-[#E2E8F0] rounded-lg flex items-center justify-center gap-1.5"
                aria-hidden="true"
              >
                {recLevels.map((lvl, idx) => (
                  <span
                    key={idx}
                    className={`w-1.5 rounded-full transition-all duration-75 ${
                      recState === 'recording' ? 'bg-[#2563EB]' : 'bg-[#CBD5E1]'
                    }`}
                    style={{ height: `${lvl}%` }}
                  />
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                <div className="sm:col-span-6">
                  <input
                    type="text"
                    value={recTitle}
                    onChange={(e) => setRecTitle(e.target.value)}
                    disabled={recState === 'recording' || recState === 'paused'}
                    placeholder="Optional recording title (e.g. Client Meeting)"
                    aria-label="Recording title"
                    className="w-full h-10 px-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] disabled:opacity-60 focus:outline-none focus:border-[#2563EB]"
                  />
                </div>

                <div className="sm:col-span-6 flex flex-wrap items-center justify-start sm:justify-end gap-2">
                  {recState === 'idle' && (
                    <button
                      type="button"
                      onClick={() => void startRecording()}
                      className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] text-xs font-semibold text-white bg-[#DC2626] hover:bg-[#B91C1C] rounded-lg cursor-pointer"
                    >
                      <Mic className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Start Recording</span>
                    </button>
                  )}

                  {(recState === 'recording' || recState === 'paused') && (
                    <>
                      <button
                        type="button"
                        onClick={togglePauseRecording}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium text-[#0F172A] bg-white border border-[#CBD5E1] hover:bg-[#F1F5F9] rounded-lg cursor-pointer"
                      >
                        {recState === 'recording' ? (
                          <>
                            <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Pause</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Resume</span>
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={stopRecording}
                        className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] text-xs font-semibold text-white bg-[#0F172A] hover:bg-[#1E293B] rounded-lg cursor-pointer"
                      >
                        <Square className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Stop &amp; Save</span>
                      </button>
                    </>
                  )}

                  {recState === 'recorded' && (
                    <button
                      type="button"
                      onClick={resetRecording}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium text-[#475569] bg-white border border-[#CBD5E1] hover:text-[#0F172A] rounded-lg cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Re-record</span>
                    </button>
                  )}
                </div>
              </div>

              {recFile && recPreviewUrl && (
                <div className="p-3.5 bg-white border border-[#E2E8F0] rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-xs text-[#475569]">
                    <span className="font-medium text-[#0F172A] truncate">{recFile.name}</span>
                    <span className="font-mono tabular-nums">{formatBytes(recFile.size)}</span>
                  </div>
                  <audio src={recPreviewUrl} controls className="w-full" />
                </div>
              )}

              {recError && (
                <p className="text-xs text-[#DC2626] flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{recError}</span>
                </p>
              )}
            </div>
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept={
                  sourceKind === 'video'
                    ? 'video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v'
                    : 'audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm'
                }
                onChange={(e) => handleFileChosen(e.target.files?.[0])}
                className="sr-only"
                id="media-file-input"
              />

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  handleFileChosen(e.dataTransfer.files?.[0]);
                }}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`border border-dashed rounded-lg p-6 sm:p-7 text-center transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
                  isDragging
                    ? 'border-[#2563EB] bg-[#EFF6FF]'
                    : selectedFile
                      ? 'border-[#CBD5E1] bg-[#F8FAFC]'
                      : 'border-[#CBD5E1] hover:border-[#94A3B8] bg-[#F8FAFC]/60'
                }`}
              >
                {selectedFile ? (
                  <div className="flex flex-col items-center">
                    <CheckCircle2 className="w-7 h-7 text-[#16A34A] mb-2.5" aria-hidden="true" />
                    <p className="text-sm font-semibold text-[#0F172A] break-all max-w-lg">
                      {selectedFile.name}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2 text-xs text-[#64748B]">
                      <span className="font-mono tabular-nums">{formatBytes(selectedFile.size)}</span>
                      {localDurationSec > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatDuration(localDurationSec)}
                          </span>
                        </>
                      )}
                      {estimatedChunks > 1 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-[#2563EB]">
                            Will process in {estimatedChunks} segments
                          </span>
                        </>
                      )}
                    </div>
                    <span className="mt-3 text-xs font-medium text-[#2563EB] hover:underline">
                      Choose a different file
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div className="w-10 h-10 rounded-lg bg-white border border-[#E2E8F0] flex items-center justify-center mb-3">
                      <Upload className="w-4 h-4 text-[#475569]" aria-hidden="true" />
                    </div>
                    <p className="text-sm font-medium text-[#0F172A]">
                      Drop your {sourceKind} file here, or click to browse
                    </p>
                    <p className="mt-1 text-xs text-[#64748B]">
                      {sourceKind === 'video'
                        ? 'MP4, MOV, MKV, WEBM, AVI — audio track extracted automatically on server'
                        : 'MP3, WAV, M4A, FLAC, OGG, AAC — supports multi-hour podcasts & voice notes'}
                    </p>
                  </div>
                )}
              </div>

              {submitting && uploadProgress > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-[#475569] mb-1.5">
                    <span>
                      {uploadProgress >= 100
                        ? 'Finalizing media & launching AI transcription...'
                        : 'Uploading media in fast parallel chunks...'}
                    </span>
                    <span className="font-mono tabular-nums">{uploadProgress}%</span>
                  </div>
                  <div className="h-1.5 bg-[#E2E8F0] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#2563EB] transition-all duration-150"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Processing Options */}
          <div className="pt-4 border-t border-[#E2E8F0] grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="language-select" className="block text-xs font-medium text-[#475569] mb-1.5">
                Spoken Language
              </label>
              <select
                id="language-select"
                value={options.language}
                onChange={(e) => setOptions((prev) => ({ ...prev, language: e.target.value }))}
                className="w-full h-10 px-3 text-sm bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {options.language === 'Urdu (Pure Nastaliq Script)' && (
                <p className="mt-1.5 text-[11px] text-[#2563EB]">
                  100% pure Urdu script (اردو) — zero Roman Urdu; English words are transliterated into Urdu.
                </p>
              )}
              {options.language === 'Roman Urdu (Latin Script)' && (
                <p className="mt-1.5 text-[11px] text-[#2563EB]">
                  100% Roman Urdu in Latin script — zero Urdu Arabic script characters.
                </p>
              )}
              {options.language === 'Urdu + English (Bilingual)' && (
                <p className="mt-1.5 text-[11px] text-[#2563EB]">
                  Spoken Urdu stays strictly in Urdu script (اردو) while keeping only genuinely spoken English words inline.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="timestamp-select" className="block text-xs font-medium text-[#475569] mb-1.5">
                Timestamp Density
              </label>
              <select
                id="timestamp-select"
                value={options.timestampInterval}
                onChange={(e) =>
                  setOptions((prev) => ({
                    ...prev,
                    timestampInterval: e.target.value as TranscriptionOptions['timestampInterval'],
                  }))
                }
                className="w-full h-10 px-3 text-sm bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20"
              >
                <option value="turn">Natural speaker turns (15–25s)</option>
                <option value="30s">Every 30 seconds</option>
                <option value="60s">Every 60 seconds</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-1">
            <label className="inline-flex items-center gap-2 min-h-[36px] text-sm text-[#334155] cursor-pointer">
              <input
                type="checkbox"
                checked={options.identifySpeakers}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, identifySpeakers: e.target.checked }))
                }
                className="w-4 h-4 rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
              />
              <span>Identify speakers</span>
            </label>

            <label className="inline-flex items-center gap-2 min-h-[36px] text-sm text-[#334155] cursor-pointer">
              <input
                type="checkbox"
                checked={options.translateToEnglish}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, translateToEnglish: e.target.checked }))
                }
                className="w-4 h-4 rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
              />
              <span>Translate output to English</span>
            </label>

            <label className="inline-flex items-center gap-2 min-h-[36px] text-sm text-[#334155] cursor-pointer">
              <input
                type="checkbox"
                checked={options.autoAnalyze}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, autoAnalyze: e.target.checked }))
                }
                className="w-4 h-4 rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
              />
              <span>Generate chapters &amp; summary</span>
            </label>
          </div>

          {submitError && (
            <div
              role="alert"
              className="p-3.5 rounded-lg bg-[#FEF2F2] border border-[#FECACA] text-xs sm:text-sm text-[#B91C1C] flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting || recState === 'recording' || recState === 'paused'}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-60 disabled:cursor-not-allowed rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>
                    {ingestTab === 'youtube' ? 'Connecting to YouTube...' : 'Uploading & Starting...'}
                  </span>
                </>
              ) : (
                <>
                  <span>Start Transcription</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
