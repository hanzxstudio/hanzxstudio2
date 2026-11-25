export type SourceKind = 'video' | 'audio' | 'youtube';

export type JobStatus =
  | 'queued'
  | 'inspecting'
  | 'extracting'
  | 'chunking'
  | 'transcribing'
  | 'analyzing'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface TranscriptSegment {
  id: string;
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
}

export interface ChapterItem {
  title: string;
  startSec: number;
  summary: string;
}

export interface TranscriptionAnalysis {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  chapters: ChapterItem[];
  detectedLanguage?: string;
}

export interface TranscriptionOptions {
  language: string;
  translateToEnglish: boolean;
  identifySpeakers: boolean;
  timestampInterval: 'turn' | '30s' | '60s';
  autoAnalyze: boolean;
}

export interface YouTubeInfo {
  videoId: string;
  url: string;
  title: string;
  author: string;
  durationSeconds: number;
  thumbnailUrl: string;
  hasCaptions?: boolean;
}

export interface TranscriptionJob {
  id: string;
  title: string;
  sourceKind: SourceKind;
  status: JobStatus;
  stageLabel: string;
  progressPercent: number;
  totalChunks: number;
  completedChunks: number;
  durationSeconds: number;
  fileSizeBytes?: number;
  mimeType?: string;
  mediaUrl?: string;
  youtubeInfo?: YouTubeInfo;
  strategyUsed?: string;
  options: TranscriptionOptions;
  segments: TranscriptSegment[];
  analysis?: TranscriptionAnalysis;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
