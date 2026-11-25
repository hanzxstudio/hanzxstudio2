import { ChevronDown, ChevronUp, FileAudio, FileVideo, Trash2, Youtube } from 'lucide-react';
import { useState } from 'react';
import type { TranscriptionJob } from '../types/transcription';
import { formatDuration } from '../utils/formatters';

interface HistorySidebarProps {
  jobs: TranscriptionJob[];
  activeJobId: string | null;
  onSelectJob: (jobId: string) => void;
  onDeleteJob: (jobId: string) => void;
}

export function HistorySidebar({
  jobs,
  activeJobId,
  onSelectJob,
  onDeleteJob,
}: HistorySidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <aside className="w-full lg:w-[272px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#E2E8F0] bg-white">
      {/* Desktop Header */}
      <div className="hidden lg:flex px-4 py-3.5 border-b border-[#E2E8F0] items-center justify-between">
        <h2 className="font-display text-xs font-semibold text-[#475569]">
          Recent Sessions
        </h2>
        <span className="font-mono text-xs text-[#64748B] tabular-nums">
          {jobs.length}
        </span>
      </div>

      {/* Mobile Collapsible Bar */}
      <button
        type="button"
        onClick={() => setMobileOpen((v) => !v)}
        aria-expanded={mobileOpen}
        className="lg:hidden w-full px-4 min-h-[44px] py-2.5 border-b border-[#E2E8F0] flex items-center justify-between text-left cursor-pointer hover:bg-[#F8FAFC]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-xs font-semibold text-[#475569] whitespace-nowrap">
            Recent Sessions
          </span>
          <span className="font-mono text-xs text-[#64748B] tabular-nums">
            ({jobs.length})
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-[#2563EB] shrink-0">
          <span>{mobileOpen ? 'Hide' : 'Show'}</span>
          {mobileOpen ? (
            <ChevronUp className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          )}
        </span>
      </button>

      <div className={`${mobileOpen ? 'block' : 'hidden'} lg:block`}>
        {jobs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-[#64748B] leading-relaxed">
              Uploaded videos, audio recordings, voice memos, and YouTube transcripts appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[#F1F5F9] max-h-[280px] lg:max-h-[calc(100vh-140px)] overflow-y-auto">
            {jobs.map((job) => {
              const isSelected = job.id === activeJobId;
              const isWorking =
                job.status !== 'completed' &&
                job.status !== 'error' &&
                job.status !== 'cancelled';

              return (
                <li key={job.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectJob(job.id);
                      setMobileOpen(false);
                    }}
                    className={`w-full text-left px-4 py-3 pr-12 min-h-[52px] transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563EB] ${
                      isSelected ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 text-[#64748B] shrink-0" aria-hidden="true">
                        {job.sourceKind === 'youtube' ? (
                          <Youtube className="w-4 h-4 text-[#DC2626]" />
                        ) : job.sourceKind === 'video' ? (
                          <FileVideo className="w-4 h-4 text-[#2563EB]" />
                        ) : (
                          <FileAudio className="w-4 h-4 text-[#0F172A]" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm font-medium truncate ${
                            isSelected ? 'text-[#1D4ED8]' : 'text-[#0F172A]'
                          }`}
                        >
                          {job.title}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-[#64748B]">
                          <span className="capitalize">{job.sourceKind}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {job.durationSeconds > 0 ? formatDuration(job.durationSeconds) : '—'}
                          </span>
                          {isWorking && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-[#2563EB] tabular-nums">
                                {job.progressPercent}%
                              </span>
                            </>
                          )}
                          {job.status === 'error' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-[#DC2626] font-medium">Failed</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteJob(job.id);
                    }}
                    aria-label={`Remove ${job.title}`}
                    className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center text-[#94A3B8] hover:text-[#DC2626] opacity-75 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer rounded-md"
                  >
                    <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
