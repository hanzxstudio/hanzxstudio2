import { useEffect, useRef, useState } from 'react';
import { ArchitectureView } from './components/ArchitectureView';
import { HistorySidebar } from './components/HistorySidebar';
import { IngestWorkbench } from './components/IngestWorkbench';
import { LibraryView } from './components/LibraryView';
import { MediaToolsView } from './components/MediaToolsView';
import { TopBar, type AppView } from './components/TopBar';
import { TranscriptWorkspace } from './components/TranscriptWorkspace';
import type {
  TranscriptSegment,
  TranscriptionAnalysis,
  TranscriptionJob,
  TranscriptionOptions,
  YouTubeInfo,
} from './types/transcription';

import { uploadFileChunked } from './utils/chunkedUpload';
import { normalizeTranscriptSegments } from './utils/exporters';
import { loadPersistedJobs, savePersistedJobs } from './utils/storage';

export default function App() {
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<AppView>('workspace');
  const [localMediaUrls, setLocalMediaUrls] = useState<Record<string, string>>({});
  const [subtitleJobDraft, setSubtitleJobDraft] = useState<TranscriptionJob | null>(null);

  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    void loadPersistedJobs().then((saved) => {
      if (saved.length > 0) {
        const normalizedJobs = saved.map((job) => ({
          ...job,
          segments: normalizeTranscriptSegments(job.segments),
        }));
        setJobs(normalizedJobs);
        for (const job of normalizedJobs) {
          if (
            job.status !== 'completed' &&
            job.status !== 'error' &&
            job.status !== 'cancelled'
          ) {
            subscribeJobUpdates(job.id);
          }
        }
      }
      setHydrated(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void savePersistedJobs(jobs);
  }, [jobs, hydrated]);

  const upsertJob = (updated: TranscriptionJob) => {
    const cleanJob: TranscriptionJob = {
      ...updated,
      segments: normalizeTranscriptSegments(updated.segments),
    };
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === cleanJob.id);
      if (idx === -1) return [cleanJob, ...prev];
      const next = [...prev];
      next[idx] = cleanJob;
      return next;
    });
  };

  const subscribeJobUpdates = (jobId: string) => {
    if (eventSourcesRef.current.has(jobId)) return;

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    eventSourcesRef.current.set(jobId, es);

    es.onmessage = (event) => {
      try {
        const updated = JSON.parse(event.data) as TranscriptionJob;
        upsertJob(updated);
        if (
          updated.status === 'completed' ||
          updated.status === 'error' ||
          updated.status === 'cancelled'
        ) {
          es.close();
          eventSourcesRef.current.delete(jobId);
        }
      } catch {
        // Ignore malformed SSE frame
      }
    };

    es.onerror = () => {
      es.close();
      eventSourcesRef.current.delete(jobId);
      // Fallback poll once if SSE disconnected early
      void fetch(`/api/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: TranscriptionJob | null) => {
          if (data) {
            upsertJob(data);
            if (
              data.status !== 'completed' &&
              data.status !== 'error' &&
              data.status !== 'cancelled'
            ) {
              setTimeout(() => subscribeJobUpdates(jobId), 2000);
            }
          }
        })
        .catch(() => {});
    };
  };

  // Re-attach SSE to any in-flight jobs if page was refreshed mid-job
  useEffect(() => {
    for (const job of jobs) {
      if (
        job.status !== 'completed' &&
        job.status !== 'error' &&
        job.status !== 'cancelled'
      ) {
        subscribeJobUpdates(job.id);
      }
    }
    return () => {
      for (const es of eventSourcesRef.current.values()) {
        es.close();
      }
      eventSourcesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStartUpload = async (params: {
    file: File;
    sourceKind: 'video' | 'audio';
    options: TranscriptionOptions;
    onUploadProgress: (pct: number) => void;
  }) => {
    const uploadId = await uploadFileChunked(params.file, params.onUploadProgress);

    const res = await fetch('/api/transcribe/from-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        sourceKind: params.sourceKind,
        title: params.file.name,
        options: params.options,
      }),
    });

    const job = (await res.json().catch(() => ({}))) as TranscriptionJob & { error?: string };
    if (!res.ok) {
      throw new Error(job.error || `Failed to start transcription (${res.status}).`);
    }

    const objectUrl = URL.createObjectURL(params.file);
    setLocalMediaUrls((prev) => ({ ...prev, [job.id]: objectUrl }));
    upsertJob(job);
    setActiveJobId(job.id);
    setActiveView('workspace');
    subscribeJobUpdates(job.id);
  };

  const handleStartYouTube = async (params: {
    url: string;
    info?: YouTubeInfo;
    options: TranscriptionOptions;
  }) => {
    const res = await fetch('/api/transcribe/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as TranscriptionJob & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to start YouTube transcription.');
    }

    upsertJob(data);
    setActiveJobId(data.id);
    setActiveView('workspace');
    subscribeJobUpdates(data.id);
  };

  const handleCancelJob = async (jobId: string) => {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? { ...j, status: 'cancelled', stageLabel: 'Transcription cancelled by user.' }
          : j,
      ),
    );
  };

  const handleDeleteJob = (jobId: string) => {
    const es = eventSourcesRef.current.get(jobId);
    if (es) {
      es.close();
      eventSourcesRef.current.delete(jobId);
    }
    const objUrl = localMediaUrls[jobId];
    if (objUrl) {
      URL.revokeObjectURL(objUrl);
      setLocalMediaUrls((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    }
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    if (activeJobId === jobId) {
      setActiveJobId(null);
    }
  };

  const handleUpdateSegments = (jobId: string, segments: TranscriptSegment[]) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, segments, updatedAt: Date.now() } : j)),
    );
  };

  const handleUpdateAnalysis = (jobId: string, analysis: TranscriptionAnalysis) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, analysis, updatedAt: Date.now() } : j)),
    );
  };

  const handleOpenInSubtitleStudio = (job: TranscriptionJob) => {
    setSubtitleJobDraft(job);
    setActiveView('tools');
  };

  const activeJob = jobs.find((j) => j.id === activeJobId) || null;

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <TopBar
        activeView={activeView}
        onNavigate={(view) => setActiveView(view)}
        onNewTranscription={() => {
          setActiveJobId(null);
          setActiveView('workspace');
        }}
      />

      {activeView === 'workspace' && (
        <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
          <HistorySidebar
            jobs={jobs}
            activeJobId={activeJobId}
            onSelectJob={(id) => {
              setActiveJobId(id);
              setActiveView('workspace');
            }}
            onDeleteJob={handleDeleteJob}
          />

          <main className="flex-1 min-w-0">
            {activeJob ? (
              <TranscriptWorkspace
                key={activeJob.id}
                job={activeJob}
                localMediaUrl={localMediaUrls[activeJob.id]}
                onCancelJob={handleCancelJob}
                onUpdateSegments={handleUpdateSegments}
                onUpdateAnalysis={handleUpdateAnalysis}
                onOpenInSubtitleStudio={handleOpenInSubtitleStudio}
              />
            ) : (
              <IngestWorkbench
                onStartUpload={handleStartUpload}
                onStartYouTube={handleStartYouTube}
              />
            )}
          </main>
        </div>
      )}

      {activeView === 'tools' && (
        <main className="flex-1">
          <MediaToolsView
            savedJobs={jobs}
            initialSubtitlesJob={subtitleJobDraft}
            onConsumeInitialSubtitlesJob={() => setSubtitleJobDraft(null)}
            onTranscribedJobStarted={(job) => {
              upsertJob(job);
              setActiveJobId(job.id);
              setActiveView('workspace');
              subscribeJobUpdates(job.id);
            }}
            onStartYouTubeTranscribe={async (url, language) => {
              await handleStartYouTube({
                url,
                options: {
                  language: language || 'auto',
                  translateToEnglish: false,
                  identifySpeakers: true,
                  timestampInterval: 'turn',
                  autoAnalyze: true,
                },
              });
            }}
          />
        </main>
      )}

      {activeView === 'library' && (
        <main className="flex-1">
          <LibraryView
            jobs={jobs}
            onOpenJob={(id) => {
              setActiveJobId(id);
              setActiveView('workspace');
            }}
            onOpenInSubtitleStudio={handleOpenInSubtitleStudio}
            onDeleteJob={handleDeleteJob}
            onNewTranscription={() => {
              setActiveJobId(null);
              setActiveView('workspace');
            }}
          />
        </main>
      )}

      {activeView === 'architecture' && (
        <main className="flex-1">
          <ArchitectureView
            onStartNew={() => {
              setActiveJobId(null);
              setActiveView('workspace');
            }}
          />
        </main>
      )}

      <footer className="border-t border-[#E2E8F0] bg-white mt-auto">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-[#64748B]">
          <span className="font-medium text-[#0F172A]">Hanzx Studio</span>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => setActiveView('workspace')}
              className="hover:text-[#0F172A] cursor-pointer"
            >
              Transcription
            </button>
            <button
              type="button"
              onClick={() => setActiveView('tools')}
              className="hover:text-[#0F172A] cursor-pointer"
            >
              Media &amp; Subtitle Studio
            </button>
            <button
              type="button"
              onClick={() => setActiveView('library')}
              className="hover:text-[#0F172A] cursor-pointer"
            >
              Library
            </button>
            <button
              type="button"
              onClick={() => setActiveView('architecture')}
              className="hover:text-[#0F172A] cursor-pointer"
            >
              Pipeline
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
