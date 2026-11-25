export interface ChunkedUploadProgress {
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
}

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB (well below Cloud Run's 32 MB cap)
const LARGE_FILE_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB for > 512 MB files
const MAX_CONCURRENT_CHUNKS = 4;
const MAX_RETRIES_PER_CHUNK = 3;

async function uploadSingleChunkWithRetry(params: {
  uploadId: string;
  index: number;
  blob: Blob;
  onAttemptFailed?: () => void;
}): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_CHUNK; attempt++) {
    try {
      const res = await fetch(
        `/api/uploads/${encodeURIComponent(params.uploadId)}/chunk?index=${params.index}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-chunk-index': String(params.index),
          },
          body: params.blob,
        },
      );

      if (!res.ok) {
        let errMsg = `Chunk upload failed (${res.status})`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed.error) errMsg = parsed.error;
        } catch {
          // Ignore non-JSON error
        }
        throw new Error(errMsg);
      }
      return;
    } catch (err) {
      lastError = err;
      params.onAttemptFailed?.();
      if (attempt < MAX_RETRIES_PER_CHUNK) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to upload media chunk.');
}

/**
 * Uploads any media file (even 5-10 GB / 6+ hr videos) in parallel 4-8 MB chunks.
 * Eliminates HTTP 413 payload limits and maximizes upload speed via concurrent streams.
 */
export async function uploadFileChunked(
  file: File,
  onProgress: (percent: number) => void,
): Promise<string> {
  const chosenChunkSize =
    file.size > 512 * 1024 * 1024 ? LARGE_FILE_CHUNK_SIZE : DEFAULT_CHUNK_SIZE;

  const initRes = await fetch('/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      fileSizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream',
      chunkSizeBytes: chosenChunkSize,
    }),
  });

  const initData = (await initRes.json().catch(() => ({}))) as {
    uploadId?: string;
    chunkSizeBytes?: number;
    totalChunks?: number;
    error?: string;
  };

  if (!initRes.ok || !initData.uploadId || !initData.chunkSizeBytes || !initData.totalChunks) {
    throw new Error(initData.error || `Could not start file upload (${initRes.status}).`);
  }

  const { uploadId, chunkSizeBytes, totalChunks } = initData;
  let completedBytes = 0;
  let nextChunkIndex = 0;

  onProgress(1);

  const worker = async () => {
    while (true) {
      const idx = nextChunkIndex++;
      if (idx >= totalChunks) break;

      const start = idx * chunkSizeBytes;
      const end = Math.min(file.size, start + chunkSizeBytes);
      const slice = file.slice(start, end);

      await uploadSingleChunkWithRetry({
        uploadId,
        index: idx,
        blob: slice,
      });

      completedBytes += slice.size;
      const pct = Math.min(99, Math.max(1, Math.round((completedBytes / file.size) * 100)));
      onProgress(pct);
    }
  };

  try {
    const workerCount = Math.min(MAX_CONCURRENT_CHUNKS, totalChunks);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    onProgress(100);
    return uploadId;
  } catch (err) {
    void fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(
      () => {},
    );
    throw err;
  }
}
