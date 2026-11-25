export type ToolJobKind =
  | 'url-download'
  | 'convert'
  | 'trim'
  | 'merge'
  | 'subtitle-gen'
  | 'subtitle-render'
  | 'auto-clips-find'
  | 'auto-clip-render';

export type ToolJobStatus = 'queued' | 'probing' | 'processing' | 'completed' | 'error';

export type MediaOutputFormat = 'mp3' | 'wav' | 'm4a' | 'ogg' | 'flac' | 'mp4';

export type SubtitleTemplateId =
  | 'cinema-clean'
  | 'broadcast-box'
  | 'editorial-ivory'
  | 'corporate-light'
  | 'amber-35mm'
  | 'lecture-slate'
  | 'lower-third'
  | 'viral-bold'
  | 'gold-premium'
  | 'urdu-editorial';

export type SubtitlePosition = 'bottom' | 'lower-third' | 'top';
export type SubtitleFontSize = 'small' | 'standard' | 'large';
export type AudioVideoBackdrop = 'slate-dark' | 'midnight-navy' | 'charcoal' | 'paper-light';
export type ClipAspectRatio = '9:16' | '16:9' | '1:1';
export type ClipFramingMode = 'blurred-fit' | 'center-crop';

export interface SubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
}

export type ClipTitleStyle = 'banner' | 'minimal' | 'off';

export interface AutoClipCandidate {
  id: string;
  title: string;
  hookSummary: string;
  reason: string;
  category: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** 0-100 local hook score (questions, numbers, strong words, ideal length). Shown as a badge in the UI. */
  score?: number;
  cues: SubtitleCue[];
}

export interface SubtitleStyleConfig {
  templateId: SubtitleTemplateId;
  position: SubtitlePosition;
  fontSize: SubtitleFontSize;
  includeSpeakers: boolean;
  audioBackdrop: AudioVideoBackdrop;
  audioTitle: string;
  showWaveform: boolean;
}

export interface UrlProbeFormatOption {
  label: string;
  height?: number;
  filesizeApprox?: number;
}

export interface UrlProbeResult {
  url: string;
  title: string;
  platform: string;
  author: string;
  durationSeconds: number;
  thumbnailUrl?: string;
  webpageUrl: string;
  isDirectMedia?: boolean;
  authWarning?: boolean;
  videoQualities: UrlProbeFormatOption[];
}

export interface ToolJob {
  id: string;
  kind: ToolJobKind;
  status: ToolJobStatus;
  title: string;
  stageLabel: string;
  progressPercent: number;
  outputFormat: string;
  outputFilename?: string;
  outputMimeType?: string;
  inputBytes?: number;
  outputBytes?: number;
  durationSeconds?: number;
  platform?: string;
  error?: string;
  requiresAuth?: boolean;
  sourceUrl?: string;
  sourceIsAudio?: boolean;
  cues?: SubtitleCue[];
  clips?: AutoClipCandidate[];
  createdAt: number;
}

export interface ToolAuthStatus {
  hasCookies: boolean;
  cookieEntries: number;
  hasProxy: boolean;
  proxyMasked?: string;
}
