import { Download, ExternalLink, FileText, Loader2, Search, Subtitles, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SourceKind, TranscriptionJob } from '../types/transcription';
import { downloadTextFile, safeBaseFilename, toParagraphText, toSRT } from '../utils/exporters';
import { formatDateShort, formatDuration, getWordCount } from '../utils/formatters';
import { exportTranscriptToPdf } from '../utils/pdfExport';

interface LibraryViewProps {
  jobs: TranscriptionJob[];
  onOpenJob: (jobId: string) => void;
  onOpenInSubtitleStudio: (job: TranscriptionJob) => void;
  onDeleteJob: (jobId: string) => void;
  onNewTranscription: () => void;
}

export function LibraryView({
  jobs,
  onOpenJob,
  onOpenInSubtitleStudio,
  onDeleteJob,
  onNewTranscription,
}: LibraryViewProps) {
  const [query, setQuery] = useState('');
  const [filterKind, setFilterKind] = useState<'all' | SourceKind>('all');
  const [exportingJobId, setExportingJobId] = useState<string | null>(null);

  const handleQuickPdf = async (job: TranscriptionJob) => {
    if (job.segments.length === 0 || exportingJobId) return;
    setExportingJobId(job.id);
    try {
      await exportTranscriptToPdf(job);
    } finally {
      setExportingJobId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filterKind !== 'all' && job.sourceKind !== filterKind) return false;
      if (!q) return true;
      return (
        job.title.toLowerCase().includes(q) ||
        job.segments.some((s) => s.text.toLowerCase().includes(q))
      );
    });
  }, [jobs, query, filterKind]);

  return (
    <div className="max-w-[1160px] mx-auto px-4 sm:px-8 py-8 sm:py-10 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A] tracking-tight">
            Transcript Library
          </h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Browse, search, export, or send completed transcripts into the Subtitle Studio.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 sm:flex-initial min-w-[200px]">
            <Search
              className="w-3.5 h-3.5 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles or text..."
              className="w-full h-10 pl-8 pr-3 text-xs bg-white border border-[#CBD5E1] rounded-lg text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <div className="inline-flex items-center p-0.5 bg-[#F1F5F9] rounded-lg overflow-x-auto max-w-full">
            {(['all', 'video', 'audio', 'youtube'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setFilterKind(kind)}
                className={`px-3 py-1.5 min-h-[34px] text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filterKind === kind
                    ? 'bg-white text-[#0F172A] shadow-xs'
                    : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                {kind === 'youtube' ? 'YouTube' : kind}
              </button>
            ))}
          </div>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-10 sm:p-12 text-center">
          <p className="text-sm font-medium text-[#0F172A]">No transcriptions yet</p>
          <p className="mt-1.5 text-xs text-[#64748B] max-w-md mx-auto leading-relaxed">
            Upload a video or audio recording, record live voice notes, or paste a YouTube link to generate your first timestamped transcript.
          </p>
          <button
            type="button"
            onClick={onNewTranscription}
            className="mt-5 px-4 py-2.5 min-h-[40px] text-xs font-medium text-white bg-[#2563EB] hover:bg-[#1D4ED8] rounded-lg cursor-pointer"
          >
            Start First Transcription
          </button>
        </div>
      ) : (
        <>
          {/* Mobile Cards (< md) */}
          <div className="md:hidden space-y-3">
            {filtered.map((job) => {
              const words = getWordCount(job.segments.map((s) => s.text));
              const base = safeBaseFilename(job.title);
              return (
                <div
                  key={job.id}
                  className="bg-white border border-[#E2E8F0] rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenJob(job.id)}
                      className="text-sm font-semibold text-[#0F172A] hover:text-[#2563EB] text-left leading-snug break-words flex-1 cursor-pointer"
                    >
                      {job.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteJob(job.id)}
                      aria-label={`Delete ${job.title}`}
                      className="p-2 -mr-1 -mt-1 text-[#94A3B8] hover:text-[#DC2626] cursor-pointer rounded-md shrink-0"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                    <span className="capitalize">
                      {job.sourceKind === 'youtube' ? 'YouTube' : job.sourceKind}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {job.durationSeconds > 0 ? formatDuration(job.durationSeconds) : '—'}
                    </span>
                    {words > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{words.toLocaleString()} words</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{formatDateShort(job.createdAt)}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#F1F5F9]">
                    <button
                      type="button"
                      onClick={() => onOpenJob(job.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium text-[#0F172A] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Open</span>
                    </button>
                    <button
                      type="button"
                      disabled={job.segments.length === 0 || exportingJobId === job.id}
                      onClick={() => void handleQuickPdf(job)}
                      className="inline-flex items-center gap-1 px-3 py-2 min-h-[36px] text-xs font-mono font-semibold text-[#2563EB] bg-[#EFF6FF] border border-[#BFDBFE] disabled:opacity-35 rounded-lg cursor-pointer"
                    >
                      {exportingJobId === job.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>PDF</span>
                    </button>
                    <button
                      type="button"
                      disabled={job.segments.length === 0}
                      onClick={() =>
                        downloadTextFile(
                          `${base}.txt`,
                          toParagraphText(job.segments, true, true),
                        )
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-2 min-h-[36px] text-xs font-mono text-[#475569] bg-white border border-[#E2E8F0] disabled:opacity-35 rounded-lg cursor-pointer"
                    >
                      <Download className="w-3 h-3" aria-hidden="true" />
                      <span>TXT</span>
                    </button>
                    <button
                      type="button"
                      disabled={job.segments.length === 0}
                      onClick={() => onOpenInSubtitleStudio(job)}
                      className="inline-flex items-center gap-1 px-2.5 py-2 min-h-[36px] text-xs font-medium text-[#334155] bg-white border border-[#E2E8F0] disabled:opacity-35 rounded-lg cursor-pointer"
                    >
                      <Subtitles className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Subtitles</span>
                    </button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="bg-white border border-[#E2E8F0] rounded-xl py-8 text-center text-xs text-[#64748B]">
                No transcripts match your current filter.
              </div>
            )}
          </div>

          {/* Desktop Table (>= md) */}
          <div className="hidden md:block bg-white border border-[#E2E8F0] rounded-xl overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#64748B]">
                  <th className="py-3 px-4">Title</th>
                  <th className="py-3 px-3">Source</th>
                  <th className="py-3 px-3 text-right">Duration</th>
                  <th className="py-3 px-3 text-right">Words</th>
                  <th className="py-3 px-3">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1F5F9] text-sm">
                {filtered.map((job) => {
                  const words = getWordCount(job.segments.map((s) => s.text));
                  const base = safeBaseFilename(job.title);
                  return (
                    <tr
                      key={job.id}
                      className="h-11 hover:bg-[#F8FAFC] transition-colors"
                    >
                      <td className="py-2.5 px-4 max-w-[320px]">
                        <button
                          type="button"
                          onClick={() => onOpenJob(job.id)}
                          className="font-medium text-[#0F172A] hover:text-[#2563EB] truncate block text-left w-full cursor-pointer"
                        >
                          {job.title}
                        </button>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-[#475569] capitalize whitespace-nowrap">
                        {job.sourceKind === 'youtube' ? 'YouTube' : job.sourceKind}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#475569] tabular-nums whitespace-nowrap">
                        {job.durationSeconds > 0 ? formatDuration(job.durationSeconds) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#475569] tabular-nums whitespace-nowrap">
                        {words > 0 ? words.toLocaleString() : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-[#64748B] whitespace-nowrap">
                        {formatDateShort(job.createdAt)}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onOpenJob(job.id)}
                            title="Open in workspace"
                            className="p-1.5 text-[#475569] hover:text-[#2563EB] cursor-pointer rounded"
                          >
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={job.segments.length === 0}
                            onClick={() => onOpenInSubtitleStudio(job)}
                            title="Open in Subtitle Studio"
                            className="p-1.5 text-[#475569] hover:text-[#2563EB] disabled:opacity-30 cursor-pointer rounded"
                          >
                            <Subtitles className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={job.segments.length === 0 || exportingJobId === job.id}
                            onClick={() => void handleQuickPdf(job)}
                            title="Download formatted PDF"
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono font-semibold text-[#2563EB] hover:bg-[#EFF6FF] disabled:opacity-30 cursor-pointer rounded"
                          >
                            {exportingJobId === job.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                            ) : (
                              <FileText className="w-3 h-3" aria-hidden="true" />
                            )}
                            <span>PDF</span>
                          </button>
                          <button
                            type="button"
                            disabled={job.segments.length === 0}
                            onClick={() =>
                              downloadTextFile(
                                `${base}.txt`,
                                toParagraphText(job.segments, true, true),
                              )
                            }
                            title="Download timestamped TXT"
                            className="p-1.5 text-[#475569] hover:text-[#0F172A] disabled:opacity-30 cursor-pointer rounded"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={job.segments.length === 0}
                            onClick={() => downloadTextFile(`${base}.srt`, toSRT(job.segments))}
                            title="Download SRT"
                            className="px-1.5 py-0.5 text-[11px] font-mono text-[#475569] hover:text-[#0F172A] disabled:opacity-30 cursor-pointer rounded"
                          >
                            SRT
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteJob(job.id)}
                            title="Delete"
                            className="p-1.5 text-[#94A3B8] hover:text-[#DC2626] cursor-pointer rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-xs text-[#64748B]">
                      No transcripts match your current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
