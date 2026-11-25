import type { TranscriptionJob } from '../types/transcription';

const DB_NAME = 'verbatim_studio_db';
const STORE_NAME = 'jobs';
const LEGACY_KEY = 'verbatim_studio_jobs_v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadPersistedJobs(): Promise<TranscriptionJob[]> {
  try {
    const db = await openDb();
    const jobs = await new Promise<TranscriptionJob[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as TranscriptionJob[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (jobs.length > 0) {
      return jobs.sort((a, b) => b.createdAt - a.createdAt);
    }
  } catch {
    // Fall back to legacy localStorage
  }

  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TranscriptionJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function savePersistedJobs(jobs: TranscriptionJob[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const job of jobs.slice(0, 50)) {
        store.put(job);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage errors
  }
}
