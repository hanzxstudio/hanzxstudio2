import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const UPLOAD_DIR = path.join(os.tmpdir(), 'verbatim-studio', 'uploads');
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB (safely below Cloud Run's 32 MB limit)
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export interface UploadSession {
  id: string;
  filename: string;
  fileSizeBytes: number;
  mimeType: string;
  chunkSizeBytes: number;
  totalChunks: number;
  filePath: string;
  receivedChunks: Set<number>;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, UploadSession>();

function cleanupExpiredSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions.entries()) {
    if (session.updatedAt < cutoff) {
      sessions.delete(id);
      void fsp.rm(session.filePath, { force: true }).catch(() => {});
    }
  }
}

export async function initUploadSession(params: {
  filename: string;
  fileSizeBytes: number;
  mimeType?: string;
  chunkSizeBytes?: number;
}): Promise<{
  uploadId: string;
  chunkSizeBytes: number;
  totalChunks: number;
}> {
  cleanupExpiredSessions();

  const filename = (params.filename || 'media_file').trim() || 'media_file';
  const fileSizeBytes = Number(params.fileSizeBytes);
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    throw new Error('File size must be a positive number.');
  }
  if (fileSizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds the 10 GB maximum upload limit.');
  }

  const chunkSizeBytes = Math.min(
    MAX_CHUNK_BYTES,
    Math.max(256 * 1024, Math.floor(Number(params.chunkSizeBytes) || 4 * 1024 * 1024)),
  );
  const totalChunks = Math.max(1, Math.ceil(fileSizeBytes / chunkSizeBytes));
  const uploadId = crypto.randomUUID();
  const ext = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12) || '.bin';
  const filePath = path.join(UPLOAD_DIR, `${uploadId}${ext}`);

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const fh = await fsp.open(filePath, 'w');
  await fh.close();

  const now = Date.now();
  sessions.set(uploadId, {
    id: uploadId,
    filename,
    fileSizeBytes,
    mimeType: (params.mimeType || '').trim() || 'application/octet-stream',
    chunkSizeBytes,
    totalChunks,
    filePath,
    receivedChunks: new Set<number>(),
    createdAt: now,
    updatedAt: now,
  });

  return {
    uploadId,
    chunkSizeBytes,
    totalChunks,
  };
}

export async function writeUploadChunk(params: {
  uploadId: string;
  index: number;
  buffer: Buffer;
}): Promise<{
  index: number;
  receivedCount: number;
  totalChunks: number;
}> {
  const session = sessions.get(params.uploadId);
  if (!session) {
    throw new Error('Upload session expired or not found. Please retry the upload.');
  }

  const index = Math.floor(Number(params.index));
  if (!Number.isFinite(index) || index < 0 || index >= session.totalChunks) {
    throw new Error(`Invalid chunk index ${params.index}.`);
  }

  const expectedOffset = index * session.chunkSizeBytes;
  const remaining = session.fileSizeBytes - expectedOffset;
  const expectedLength = Math.min(session.chunkSizeBytes, remaining);

  if (params.buffer.length !== expectedLength) {
    throw new Error(
      `Chunk ${index} size mismatch (expected ${expectedLength} bytes, got ${params.buffer.length} bytes).`,
    );
  }

  const fh = await fsp.open(session.filePath, 'r+');
  try {
    let written = 0;
    while (written < params.buffer.length) {
      const res = await fh.write(
        params.buffer,
        written,
        params.buffer.length - written,
        expectedOffset + written,
      );
      written += res.bytesWritten;
    }
  } finally {
    await fh.close();
  }

  session.receivedChunks.add(index);
  session.updatedAt = Date.now();

  return {
    index,
    receivedCount: session.receivedChunks.size,
    totalChunks: session.totalChunks,
  };
}

export async function finalizeUploadSession(uploadId: string): Promise<{
  filePath: string;
  filename: string;
  fileSizeBytes: number;
  mimeType: string;
}> {
  const session = sessions.get(uploadId);
  if (!session) {
    throw new Error('Upload session expired or not found.');
  }

  if (session.receivedChunks.size < session.totalChunks) {
    const missingCount = session.totalChunks - session.receivedChunks.size;
    throw new Error(`Upload incomplete (${missingCount} chunk(s) missing). Please retry.`);
  }

  const stat = await fsp.stat(session.filePath);
  if (stat.size !== session.fileSizeBytes) {
    throw new Error(
      `Uploaded file size mismatch (${stat.size} vs ${session.fileSizeBytes} bytes).`,
    );
  }

  sessions.delete(uploadId);

  return {
    filePath: session.filePath,
    filename: session.filename,
    fileSizeBytes: session.fileSizeBytes,
    mimeType: session.mimeType,
  };
}

export async function abortUploadSession(uploadId: string): Promise<void> {
  const session = sessions.get(uploadId);
  if (!session) return;
  sessions.delete(uploadId);
  await fsp.rm(session.filePath, { force: true }).catch(() => {});
}
