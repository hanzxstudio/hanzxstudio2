import type { TranscriptSegment } from '../types/transcription';
import type {
  AudioVideoBackdrop,
  SubtitleCue,
  SubtitleFontSize,
  SubtitlePosition,
  SubtitleStyleConfig,
  SubtitleTemplateId,
} from '../types/tools';

export interface SubtitleTemplateSpec {
  id: SubtitleTemplateId;
  name: string;
  category: string;
  description: string;
  fontFamily: string;
  assFontName: string;
  textHex: string;
  bgRgba: string;
  borderColor: string;
  /** ASS BorderStyle: 1 = outline + shadow, 3 = opaque box */
  assBorderStyle: 1 | 3;
  /** ASS format &HAABBGGRR */
  assPrimaryColor: string;
  assOutlineColor: string;
  assBackColor: string;
  assOutlineWidth: number;
  assShadowDepth: number;
  bold: boolean;
  hasSpeakerAccent?: boolean;
  speakerHex?: string;
  previewBgClass: string;
  isRtlOptimized?: boolean;
  /** Render Latin-script captions in ALL CAPS (classic viral Reels look). Ignored for Urdu/Arabic text. */
  uppercase?: boolean;
  /** Extra font-size multiplier on top of the size setting (e.g. 1.22 for big social captions). */
  fontScale?: number;
}

export const SUBTITLE_TEMPLATES: SubtitleTemplateSpec[] = [
  {
    id: 'cinema-clean',
    name: 'Cinema Standard',
    category: 'Streaming / Film',
    description: 'Clean white sans-serif with subtle drop shadow and zero backdrop.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", Arial, sans-serif',
    assFontName: 'Noto Sans',
    textHex: '#FFFFFF',
    bgRgba: 'transparent',
    borderColor: 'transparent',
    assBorderStyle: 1,
    assPrimaryColor: '&H00FFFFFF',
    assOutlineColor: '&H20000000',
    assBackColor: '&H88000000',
    assOutlineWidth: 1.8,
    assShadowDepth: 1.5,
    bold: true,
    previewBgClass: 'bg-[#1E293B]',
  },
  {
    id: 'broadcast-box',
    name: 'Broadcast News Bar',
    category: 'Journalism / TV',
    description: 'High-contrast white captions over a clean charcoal slate bar.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", Arial, sans-serif',
    assFontName: 'Noto Sans',
    textHex: '#FFFFFF',
    bgRgba: 'rgba(15, 23, 42, 0.86)',
    borderColor: 'rgba(148, 163, 184, 0.25)',
    assBorderStyle: 3,
    assPrimaryColor: '&H00FFFFFF',
    assOutlineColor: '&H242A170F',
    assBackColor: '&H242A170F',
    assOutlineWidth: 8,
    assShadowDepth: 0,
    bold: false,
    previewBgClass: 'bg-[#334155]',
  },
  {
    id: 'editorial-ivory',
    name: 'Documentary Editorial',
    category: 'Essays / Film',
    description: 'Warm ivory serif-balanced type with crisp outline for interviews.',
    fontFamily: '"DejaVu Serif", Georgia, serif',
    assFontName: 'DejaVu Serif',
    textHex: '#F8FAFC',
    bgRgba: 'transparent',
    borderColor: 'transparent',
    assBorderStyle: 1,
    assPrimaryColor: '&H00FCFAF8',
    assOutlineColor: '&H18101418',
    assBackColor: '&H70000000',
    assOutlineWidth: 2,
    assShadowDepth: 1.2,
    bold: false,
    previewBgClass: 'bg-[#1E293B]',
  },
  {
    id: 'corporate-light',
    name: 'Corporate Minimal',
    category: 'Presentations / SaaS',
    description: 'Crisp dark slate typography on a clean frosted white card.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", Arial, sans-serif',
    assFontName: 'Noto Sans',
    textHex: '#0F172A',
    bgRgba: 'rgba(255, 255, 255, 0.94)',
    borderColor: 'rgba(203, 213, 225, 0.9)',
    assBorderStyle: 3,
    assPrimaryColor: '&H002A170F',
    assOutlineColor: '&H10FFFFFF',
    assBackColor: '&H10FFFFFF',
    assOutlineWidth: 8,
    assShadowDepth: 0,
    bold: true,
    previewBgClass: 'bg-[#475569]',
  },
  {
    id: 'amber-35mm',
    name: 'Classic 35mm Amber',
    category: 'Cinema Archive',
    description: 'Timeless warm gold theatrical subtitling with fine dark edge.',
    fontFamily: '"Noto Sans", "Liberation Sans", Arial, sans-serif',
    assFontName: 'Noto Sans',
    textHex: '#FDE68A',
    bgRgba: 'transparent',
    borderColor: 'transparent',
    assBorderStyle: 1,
    assPrimaryColor: '&H008AE6FD',
    assOutlineColor: '&H10000000',
    assBackColor: '&H80000000',
    assOutlineWidth: 2.1,
    assShadowDepth: 1.4,
    bold: true,
    previewBgClass: 'bg-[#0F172A]',
  },
  {
    id: 'lecture-slate',
    name: 'Academic Lecture',
    category: 'Courses / Tutorials',
    description: 'Balanced cool off-white captions on a deep matte navy band.',
    fontFamily: '"Inter", "Noto Sans", sans-serif',
    assFontName: 'Liberation Sans',
    textHex: '#F1F5F9',
    bgRgba: 'rgba(15, 23, 42, 0.90)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
    assBorderStyle: 3,
    assPrimaryColor: '&H00F9F5F1',
    assOutlineColor: '&H1A2A170F',
    assBackColor: '&H1A2A170F',
    assOutlineWidth: 9,
    assShadowDepth: 0,
    bold: false,
    previewBgClass: 'bg-[#1E293B]',
  },
  {
    id: 'lower-third',
    name: 'Podcast Lower-Third',
    category: 'Podcasts / Panels',
    description: 'Structured dark lower-third band with clear speaker label styling.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", sans-serif',
    assFontName: 'Noto Sans',
    textHex: '#F8FAFC',
    bgRgba: 'rgba(17, 24, 39, 0.88)',
    borderColor: 'rgba(37, 99, 235, 0.55)',
    assBorderStyle: 3,
    assPrimaryColor: '&H00FCFAF8',
    assOutlineColor: '&H1E271811',
    assBackColor: '&H1E271811',
    assOutlineWidth: 9,
    assShadowDepth: 0,
    bold: false,
    hasSpeakerAccent: true,
    speakerHex: '#93C5FD',
    previewBgClass: 'bg-[#0F172A]',
  },
  {
    id: 'viral-bold',
    name: 'Viral Bold — Reels / TikTok',
    category: 'Social / Viral',
    description:
      'Big bold ALL-CAPS white captions with a thick black edge — the classic high-retention Reels/TikTok look. Best for 9:16.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", Arial, sans-serif',
    assFontName: 'Inter',
    textHex: '#FFFFFF',
    bgRgba: 'transparent',
    borderColor: 'transparent',
    assBorderStyle: 1,
    assPrimaryColor: '&H00FFFFFF',
    assOutlineColor: '&H00000000',
    assBackColor: '&H80000000',
    assOutlineWidth: 3.4,
    assShadowDepth: 2.2,
    bold: true,
    uppercase: true,
    fontScale: 1.22,
    previewBgClass: 'bg-[#0F172A]',
  },
  {
    id: 'gold-premium',
    name: 'Premium Gold',
    category: 'Luxury / Brand',
    description:
      'Warm gold captions on a deep charcoal band — premium brand / podcast highlight look.',
    fontFamily: '"Inter", "Plus Jakarta Sans", "Noto Sans", Arial, sans-serif',
    assFontName: 'Inter',
    textHex: '#FDE68A',
    bgRgba: 'rgba(12, 12, 14, 0.82)',
    borderColor: 'rgba(253, 230, 138, 0.35)',
    assBorderStyle: 3,
    assPrimaryColor: '&H008AE6FD',
    assOutlineColor: '&H1E0E0C0A',
    assBackColor: '&H1E0E0C0A',
    assOutlineWidth: 8,
    assShadowDepth: 0,
    bold: true,
    previewBgClass: 'bg-[#18181B]',
  },
  {
    id: 'urdu-editorial',
    name: 'Urdu & Arabic Editorial',
    category: 'RTL / Bilingual',
    description: 'Tuned for Urdu Nastaliq/Naskh clarity with generous line clearance.',
    fontFamily: '"Noto Naskh Arabic", "Noto Nastaliq Urdu", "Noto Sans", sans-serif',
    assFontName: 'Noto Naskh Arabic',
    textHex: '#FFFFFF',
    bgRgba: 'rgba(15, 23, 42, 0.88)',
    borderColor: 'rgba(148, 163, 184, 0.25)',
    assBorderStyle: 3,
    assPrimaryColor: '&H00FFFFFF',
    assOutlineColor: '&H202A170F',
    assBackColor: '&H202A170F',
    assOutlineWidth: 10,
    assShadowDepth: 0,
    bold: false,
    previewBgClass: 'bg-[#1E293B]',
    isRtlOptimized: true,
  },
];

export const AUDIO_BACKDROP_THEMES: Record<
  AudioVideoBackdrop,
  { label: string; hex: string; titleHex: string; waveHex: string; borderHex: string }
> = {
  'slate-dark': {
    label: 'Studio Slate',
    hex: '#0F172A',
    titleHex: '#F8FAFC',
    waveHex: '#3B82F6',
    borderHex: '#1E293B',
  },
  'midnight-navy': {
    label: 'Midnight Navy',
    hex: '#0B132B',
    titleHex: '#F1F5F9',
    waveHex: '#60A5FA',
    borderHex: '#1C2541',
  },
  charcoal: {
    label: 'Editorial Charcoal',
    hex: '#18181B',
    titleHex: '#FAFAFA',
    waveHex: '#A1A1AA',
    borderHex: '#27272A',
  },
  'paper-light': {
    label: 'Minimalist Light',
    hex: '#F8FAFC',
    titleHex: '#0F172A',
    waveHex: '#2563EB',
    borderHex: '#E2E8F0',
  },
};

export function getSubtitleTemplate(id: SubtitleTemplateId): SubtitleTemplateSpec {
  return SUBTITLE_TEMPLATES.find((t) => t.id === id) || SUBTITLE_TEMPLATES[0];
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  templateId: 'broadcast-box',
  position: 'bottom',
  fontSize: 'standard',
  includeSpeakers: false,
  audioBackdrop: 'slate-dark',
  audioTitle: 'Audio Transcript',
  showWaveform: true,
};

/**
 * Splits full transcript segments into short, crisp, readable subtitle cues
 * (<= maxWordsPerCue words) with proportional non-overlapping timestamps.
 */
export function splitSegmentsIntoSubtitleCues(
  segments: TranscriptSegment[],
  maxWordsPerCue = 9,
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const cap = Math.max(3, Math.min(20, maxWordsPerCue));

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const clean = seg.text.trim().replace(/\s+/g, ' ');
    if (!clean) continue;

    const nextStart = sIdx < segments.length - 1 ? segments[sIdx + 1].startSec : seg.endSec;
    const rawEnd = Math.max(seg.startSec + 1.5, seg.endSec, nextStart);
    const totalSpan = Math.max(1.5, rawEnd - seg.startSec);

    // Split along sentence boundaries first, then word count cap
    const sentences = clean.match(/[^.!?؟۔।]+(?:[.!?؟۔।]+)?/g) || [clean];
    const phrases: string[] = [];

    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      if (words.length <= cap) {
        phrases.push(words.join(' '));
      } else {
        for (let i = 0; i < words.length; i += cap) {
          phrases.push(words.slice(i, i + cap).join(' '));
        }
      }
    }

    if (phrases.length === 0) continue;

    // Never leave a lonely 1-word orphan line at the end — merge it into the previous cue.
    if (phrases.length > 1) {
      const last = phrases[phrases.length - 1];
      if (last.trim().split(/\s+/).length === 1 && phrases[phrases.length - 2].split(/\s+/).length > 1) {
        phrases[phrases.length - 2] = `${phrases[phrases.length - 2]} ${last}`.trim();
        phrases.pop();
      }
    }

    const totalChars = phrases.reduce((sum, p) => sum + p.length, 0) || 1;
    let cursor = seg.startSec;

    for (let i = 0; i < phrases.length; i++) {
      const phrase = phrases[i];
      const weight = phrase.length / totalChars;
      const startSec = Number(cursor.toFixed(2));
      cursor += totalSpan * weight;
      const endSec =
        i === phrases.length - 1
          ? Number(Math.max(startSec + 0.8, rawEnd).toFixed(2))
          : Number(Math.max(startSec + 0.8, cursor).toFixed(2));

      cues.push({
        id: `${seg.id}_c${i}`,
        startSec,
        endSec,
        speaker: seg.speaker,
        text: phrase,
      });
    }
  }

  return cues;
}

function formatAssTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function wrapTwoBalancedLines(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= 5 || text.length <= 36) return text.trim();
  const mid = Math.ceil(words.length / 2);
  return `${words.slice(0, mid).join(' ')}\\N${words.slice(mid).join(' ')}`;
}

export function generateAssDocument(
  cues: SubtitleCue[],
  styleConfig: Pick<
    SubtitleStyleConfig,
    'templateId' | 'position' | 'fontSize' | 'includeSpeakers'
  >,
  videoWidth = 1280,
  videoHeight = 720,
): string {
  const tpl = getSubtitleTemplate(styleConfig.templateId);
  const baseFontPx =
    styleConfig.fontSize === 'small'
      ? Math.round(videoHeight * 0.042)
      : styleConfig.fontSize === 'large'
        ? Math.round(videoHeight * 0.062)
        : Math.round(videoHeight * 0.051);
  const scaledFontPx = tpl.fontScale ? Math.round(baseFontPx * tpl.fontScale) : baseFontPx;
  const finalFontSize = tpl.isRtlOptimized ? Math.round(scaledFontPx * 1.08) : scaledFontPx;

  const alignment = styleConfig.position === 'top' ? 8 : 2; // 2=bottom-center, 8=top-center
  const marginV =
    styleConfig.position === 'top'
      ? Math.round(videoHeight * 0.06)
      : styleConfig.position === 'lower-third'
        ? Math.round(videoHeight * 0.14)
        : Math.round(videoHeight * 0.065);
  const marginLR = Math.round(videoWidth * 0.07);

  const header = [
    '[Script Info]',
    'Title: Hanzx Studio Subtitles',
    'ScriptType: v4.00+',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${tpl.assFontName},${finalFontSize},${tpl.assPrimaryColor},&H000000FF,${tpl.assOutlineColor},${tpl.assBackColor},${tpl.bold ? -1 : 0},0,0,0,100,100,0,0,${tpl.assBorderStyle},${tpl.assOutlineWidth},${tpl.assShadowDepth},${alignment},${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const isLatinOnly = (t: string) => !/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0900-\u097F]/.test(t);
  const events = cues
    .filter((c) => c.text.trim().length > 0)
    .map((c) => {
      const start = formatAssTimestamp(c.startSec);
      const end = formatAssTimestamp(Math.max(c.startSec + 0.5, c.endSec));
      const displayText =
        tpl.uppercase && isLatinOnly(c.text) ? c.text.trim().toUpperCase() : c.text.trim();
      const body = wrapTwoBalancedLines(escapeAssText(displayText));
      const line =
        styleConfig.includeSpeakers && c.speaker
          ? `${escapeAssText(c.speaker)}: ${body}`
          : body;
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${line}`;
    });

  return `${header.join('\n')}\n${events.join('\n')}\n`;
}
