import studioPipelineImg from '../assets/images/hanzx_studio_pipeline_1794916338350.jpg';

interface ArchitectureViewProps {
  onStartNew: () => void;
}

export function ArchitectureView({ onStartNew }: ArchitectureViewProps) {
  const stages = [
    {
      index: '01',
      title: 'Parallel Chunked Upload & Streaming Audio Extraction',
      summary:
        'Files up to 10 GB upload in concurrent chunks straight to disk without hitting single-request caps or exhausting server memory. FFprobe inspects duration while FFmpeg extracts a fast 16 kHz mono speech track.',
    },
    {
      index: '02',
      title: 'Single-Pass Streaming & Adaptive 4–5 Minute Chunking',
      summary:
        'Multi-hour recordings stream through FFmpeg once sequentially into 240–300 second segments. Workers transcribe finished chunks in parallel with strict timestamp alignment and script-purity enforcement.',
    },
    {
      index: '03',
      title: 'Multi-Layer YouTube & Social Ingestion',
      summary:
        'YouTube links attempt full audio-stream extraction with optional browser cookies, fall back seamlessly to 5-minute video window chunking, and normalize timed captions when stream access is restricted.',
    },
    {
      index: '04',
      title: 'Subtitle Studio, Script Conversion & Studio Exports',
      summary:
        'Export structured vector and RTL Urdu PDFs, editable Word (.doc), Markdown, SRT, VTT, or ASS subtitles—or burn studio-grade subtitle templates directly into MP4 video and audio tracks.',
    },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 sm:py-12 space-y-8">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center pb-8 border-b border-[#E2E8F0]">
        <div className="lg:col-span-7">
          <p className="font-mono text-xs font-semibold text-[#2563EB] tracking-wide uppercase mb-2">
            Hanzx Studio Pipeline
          </p>
          <h1
            className="font-display text-2xl sm:text-3xl font-bold text-[#0F172A] tracking-tight"
            style={{ textWrap: 'balance' }}
          >
            Engineered for multi-hour recordings without truncation
          </h1>
          <p className="mt-3 text-sm sm:text-base text-[#475569] leading-relaxed max-w-2xl">
            Standard single-shot transcription fails on long podcasts, lectures, and webinars due to upload size and output token ceilings. Hanzx Studio streams bounded audio segments in parallel and delivers live results cleanly across any device.
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={onStartNew}
              className="px-5 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg cursor-pointer transition-colors"
            >
              Open Transcription Workbench
            </button>
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="rounded-xl overflow-hidden border border-[#E2E8F0] bg-white">
            <img
              src={studioPipelineImg}
              alt="Hanzx Studio acoustic and video post-production workstation"
              referrerPolicy="no-referrer"
              className="w-full aspect-video object-cover block"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {stages.map((stage) => (
          <div
            key={stage.index}
            className="p-5 sm:p-6 bg-white border border-[#E2E8F0] rounded-xl space-y-2"
          >
            <span className="font-mono text-xs font-semibold text-[#2563EB] tabular-nums">
              {stage.index}
            </span>
            <h2 className="font-display text-base font-semibold text-[#0F172A]">
              {stage.title}
            </h2>
            <p className="text-sm text-[#475569] leading-relaxed">
              {stage.summary}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
