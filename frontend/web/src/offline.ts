import { bindPreferences, readPreference, writePreference } from './user-preferences';
import { streamUrl, type Track, type User } from './api';
import i18n from './i18n';

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'failed' | 'complete';
export interface OfflineTrack {
  key: string;
  userId: string;
  track: Track;
  state: DownloadState;
  bytes: number;
  total: number;
  blob: Blob;
  cover?: Blob;
  etag?: string;
  error?: string;
  updated: number;
  bitrate?: number;
  sourceEtag?: string;
  automatic?: boolean;
}
const DB = 'wildstring-offline-v1';
const STORE = 'tracks';
const SESSION = 'wildstring:offline-account';
const MAX_ITEMS = 1000;
let account: User | null = null;
let generation = 0;
let rememberedCleared = false;
let offlineAccess = false;
export function usingOfflineAccess() {
  return offlineAccess;
}
const removed = new Set<string>();
const active = new Map<string, AbortController>();
export function activeOfflineUserId() {
  return account?.id || null;
}
export function downloadBitrate() {
  const value = Number(readPreference('wildstring:download-bitrate')) || 0;
  return [0, 128, 192, 256, 320].includes(value) ? value : 0;
}
export function setDownloadBitrate(value: number) {
  if (![0, 128, 192, 256, 320].includes(value)) return;
  writePreference('wildstring:download-bitrate', String(value));
  changed();
}
export function automaticDownloadNetworkAllowed() {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return (
    navigator.onLine &&
    (readPreference('wildstring:download-any-network') === 'true' ||
      ['wifi', 'ethernet'].includes(connection?.type || ''))
  );
}
function changed() {
  window.dispatchEvent(new Event('wildstring:offline-updated'));
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(i18n.t('offlineStore.openStorageFailed')));
  });
}
async function storage<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error(i18n.t('offlineStore.storageIncomplete')));
    });
  } finally {
    db.close();
  }
}
const key = (userId: string, id: string) => `${userId}:${id}`;
export function offlineLimit() {
  return (
    Math.max(100, Math.min(2048, Number(readPreference('wildstring:offline-limit')) || 512)) *
    1024 *
    1024
  );
}
export function setOfflineLimit(mb: number) {
  writePreference('wildstring:offline-limit', String(Math.max(100, Math.min(2048, mb))));
  changed();
}
export function offlineUser(): User | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION) || 'null');
    return saved?.user?.id && Date.now() - saved.time < 7 * 86400000 ? saved.user : null;
  } catch {
    return null;
  }
}
export function setOfflineAccount(user: User, remember = true) {
  if (account?.id !== user.id) {
    generation++;
    active.forEach((c) => c.abort());
    active.clear();
  }
  account = user;
  bindPreferences(user.id);
  offlineAccess = !remember;
  rememberedCleared = false;
  try {
    if (remember) localStorage.setItem(SESSION, JSON.stringify({ user, time: Date.now() }));
  } catch {
    /* optional */
  }
}
export async function clearOfflineAccount() {
  const user = account || (!rememberedCleared ? offlineUser() : null);
  rememberedCleared = true;
  account = null;
  bindPreferences(null);
  generation++;
  active.forEach((c) => c.abort());
  active.clear();
  if (offlineUser()?.id === user?.id) localStorage.removeItem(SESSION);
  if (user) {
    localStorage.removeItem(`wildstring:playback:${user.id}`);
    await storage('readwrite', (s) =>
      s.delete(IDBKeyRange.bound(`${user.id}:`, `${user.id}:\uffff`)),
    );
  }
  changed();
}
export async function offlineTracks(): Promise<OfflineTrack[]> {
  if (!account) return [];
  const user = account;
  const records = await storage<OfflineTrack[]>('readonly', (s) =>
    s.getAll(IDBKeyRange.bound(`${user.id}:`, `${user.id}:\uffff`)),
  );
  return records
    .filter((r) => r.userId === account?.id)
    .map((r) => ({
      ...r,
      state: r.state === 'downloading' && !active.has(r.track.id) ? 'paused' : r.state,
    }));
}
async function write(record: OfflineTrack, expectedGeneration = generation) {
  await storage('readwrite', (s) => {
    if (
      generation !== expectedGeneration ||
      record.userId !== account?.id ||
      removed.has(record.key)
    )
      return s.get(record.key);
    return s.put(record);
  });
  changed();
}
export async function offlineAudio(id: string, signal?: AbortSignal): Promise<Blob | null> {
  const user = account;
  const epoch = generation;
  if (!user) return null;
  const record = await storage<OfflineTrack | undefined>('readonly', (s) =>
    s.get(key(user.id, id)),
  ).catch((error) => {
    if (!navigator.onLine) throw error;
    return undefined;
  });
  if (!record || record.state !== 'complete' || epoch !== generation || account?.id !== user.id)
    return null;
  const leaseValid = () => offlineUser()?.id === user.id;
  if (!navigator.onLine && !leaseValid()) throw new Error(i18n.t('offlineStore.accessExpired'));
  if (navigator.onLine) {
    let response: Response;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);
    try {
      response = await fetch(streamUrl(record.track), {
        method: 'HEAD',
        signal: controller.signal,
        credentials: 'same-origin',
        headers: { 'X-Wildstring-Client': 'web', 'X-Wildstring-Account': user.id },
      });
    } catch (error) {
      if (
        !signal?.aborted &&
        (error instanceof TypeError || timedOut) &&
        leaseValid() &&
        epoch === generation
      )
        return record.blob;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    if (epoch !== generation) return null;
    if (response.status === 401 || response.status === 403) {
      await clearOfflineAccount();
      window.dispatchEvent(new Event('wildstring:unauthorized'));
      throw new Error(i18n.t('offlineStore.authRevoked'));
    }
    if (
      response.status === 404 ||
      response.status === 409 ||
      (response.ok &&
        (record.sourceEtag || (!record.bitrate && record.etag)) &&
        response.headers.get('etag') !== (record.sourceEtag || record.etag))
    ) {
      await removeDownload(id);
      throw new Error(i18n.t('offlineStore.audioChangedRemoved'));
    }
    if (!response.ok) throw new Error(i18n.t('offlineStore.verifyCopyFailed'));
  }
  return epoch === generation && account?.id === user.id ? record.blob : null;
}
export async function offlineCover(id: string): Promise<Blob | null> {
  const user = account,
    epoch = generation;
  if (!user) return null;
  const record = await storage<OfflineTrack | undefined>('readonly', (s) =>
    s.get(key(user.id, id)),
  ).catch(() => undefined);
  return epoch === generation && account?.id === user.id ? record?.cover || null : null;
}
export async function removeDownload(id: string) {
  if (!account) return;
  const user = account;
  const epoch = generation;
  removed.add(key(user.id, id));
  active.get(id)?.abort();
  active.delete(id);
  await storage('readwrite', (s) =>
    epoch === generation && account?.id === user.id
      ? s.delete(key(user.id, id))
      : s.get(key(user.id, id)),
  );
  changed();
}
export function pauseDownload(id: string) {
  active.get(id)?.abort();
  if (!active.has(id))
    void offlineTracks().then((records) => {
      const record = records.find((r) => r.track.id === id);
      if (record?.state === 'queued') return write({ ...record, state: 'paused' });
    });
}
let scheduling: Promise<void> = Promise.resolve();
export function saveDownloads(tracks: Track[], automatic = false): Promise<void> {
  const epoch = generation,
    user = account;
  if (!user) return Promise.reject(new Error(i18n.t('offlineStore.loginRequired')));
  const task = scheduling.then(() => {
    if (epoch === generation && account?.id === user.id) return queueDownloads(tracks, automatic);
  });
  scheduling = task.catch(() => {});
  return task;
}
async function queueDownloads(tracks: Track[], automatic: boolean) {
  if (!account) throw new Error(i18n.t('offlineStore.loginRequired'));
  const epoch = generation,
    user = account;
  const before = await offlineTracks();
  if (epoch !== generation || account?.id !== user.id) return;
  const unique = [...new Map(tracks.map((t) => [t.id, t])).values()];
  if (new Set([...before.map((r) => r.track.id), ...unique.map((t) => t.id)]).size > MAX_ITEMS)
    throw new Error(i18n.t('offlineStore.limitExceeded'));
  for (const track of unique) {
    if (epoch !== generation || account?.id !== user.id) return;
    removed.delete(key(user.id, track.id));
    const previous = before.find((entry) => entry.track.id === track.id);
    if (
      automatic &&
      previous?.automatic &&
      previous.state === 'paused' &&
      previous.error === i18n.t('offlineStore.waitingForNetwork')
    )
      await write({ ...previous, state: 'queued', error: undefined }, epoch);
    if (!before.some((r) => r.track.id === track.id))
      await write(
        {
          key: key(user.id, track.id),
          userId: user.id,
          track,
          state: 'queued',
          bytes: 0,
          total: 0,
          blob: new Blob(),
          updated: Date.now(),
          bitrate: downloadBitrate(),
          automatic,
        },
        epoch,
      );
  }
  void runDownloads();
}
let runner = false;
export async function resumeDownload(id: string) {
  const epoch = generation;
  const record = (await offlineTracks()).find((r) => r.track.id === id);
  if (epoch === generation && record && !active.has(id)) {
    await write({ ...record, state: 'queued', error: undefined }, epoch);
    void runDownloads();
  }
}
export async function runDownloads() {
  if (runner) return;
  runner = true;
  const currentGeneration = generation;
  try {
    while (account && generation === currentGeneration) {
      const records = await offlineTracks();
      const record = records.find((r) => r.state === 'queued');
      if (!record || generation !== currentGeneration) break;
      await download(
        record,
        records.reduce((s, r) => s + r.bytes, 0),
        currentGeneration,
      );
    }
  } finally {
    runner = false;
    if (generation !== currentGeneration && account) void runDownloads();
  }
}
async function download(record: OfflineTrack, used: number, currentGeneration: number) {
  const controller = new AbortController();
  active.set(record.track.id, controller);
  const guard = () => {
    if (record.automatic && !automaticDownloadNetworkAllowed()) controller.abort();
    if (generation !== currentGeneration || !account || controller.signal.aborted)
      throw new DOMException('Paused', 'AbortError');
  };
  let next = {
    ...record,
    state: 'downloading' as DownloadState,
    error: undefined as string | undefined,
  };
  try {
    await write(next, currentGeneration);
    guard();
    const target = new URL(streamUrl(record.track), window.location.origin);
    if (record.bitrate) {
      const source = await fetch(target, {
        method: 'HEAD',
        headers: { 'X-Wildstring-Client': 'web', 'X-Wildstring-Account': record.userId },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!source.ok) throw new Error(i18n.t('offlineStore.verifySourceFailed'));
      const sourceEtag = source.headers.get('etag') || undefined;
      if (record.sourceEtag && record.sourceEtag !== sourceEtag)
        throw new Error(i18n.t('offlineStore.sourceChanged'));
      next.sourceEtag = sourceEtag;
      target.searchParams.set('format', 'aac');
      target.searchParams.set('bitrate_kbps', String(record.bitrate));
    }
    const response = await fetch(target, {
      credentials: 'same-origin',
      signal: controller.signal,
      headers:
        record.bytes && record.etag && record.bytes < record.total
          ? {
              Range: `bytes=${record.bytes}-`,
              ...(record.etag ? { 'If-Range': record.etag } : {}),
              'X-Wildstring-Client': 'web',
              'X-Wildstring-Account': record.userId,
            }
          : { 'X-Wildstring-Client': 'web', 'X-Wildstring-Account': record.userId },
    });
    guard();
    if (response.status === 401 || response.status === 403) {
      await clearOfflineAccount();
      window.dispatchEvent(new Event('wildstring:unauthorized'));
      throw new Error(i18n.t('offlineStore.authRevoked'));
    }
    if (!response.ok || !response.body)
      throw new Error(i18n.t('offlineStore.downloadConnectionFailed'));
    const resumed = response.status === 206 && record.bytes > 0 && !!record.etag;
    if (resumed && response.headers.get('etag') !== record.etag)
      throw new Error(i18n.t('offlineStore.audioVersionChanged'));
    if (resumed && !response.headers.get('content-range')?.startsWith(`bytes ${record.bytes}-`))
      throw new Error(i18n.t('offlineStore.resumeMismatch'));
    const streamingAac =
      !!record.bitrate && response.headers.get('x-wildstring-playback') === 'transcode';
    const total = Number(response.headers.get('content-length')) + (resumed ? record.bytes : 0);
    if (!Number.isFinite(total) || (total <= 0 && !streamingAac))
      throw new Error(i18n.t('offlineStore.noAudioSize'));
    if (used - record.bytes + total > offlineLimit())
      throw new Error(i18n.t('offlineStore.storageLimitReached'));
    const estimate = await navigator.storage?.estimate();
    if (estimate?.quota && (estimate.usage || 0) + total - record.bytes > estimate.quota * 0.9)
      throw new Error(i18n.t('offlineStore.quotaExceeded'));
    next = {
      ...next,
      total,
      etag: response.headers.get('etag') || undefined,
      bytes: resumed ? record.bytes : 0,
      blob: resumed ? record.blob : new Blob(),
    };
    const reader = response.body.getReader();
    let pieces: BlobPart[] = [next.blob],
      checkpoint = next.bytes;
    try {
      while (true) {
        guard();
        const part = await reader.read();
        if (part.done) break;
        next.bytes += part.value.byteLength;
        if ((total > 0 && next.bytes > total) || used - record.bytes + next.bytes > offlineLimit())
          throw new Error(i18n.t('offlineStore.audioSizeInvalid'));
        pieces.push(part.value.slice().buffer);
        if (next.bytes - checkpoint >= 4 * 1024 * 1024) {
          next.blob = new Blob(pieces, {
            type: response.headers.get('content-type') || 'audio/mpeg',
          });
          pieces = [next.blob];
          checkpoint = next.bytes;
          await write(next, currentGeneration);
        }
      }
    } finally {
      reader.releaseLock();
    }
    guard();
    next.blob = new Blob(pieces, { type: response.headers.get('content-type') || 'audio/mpeg' });
    if (!next.bytes || (total > 0 && next.bytes !== total))
      throw new Error(i18n.t('offlineStore.downloadIncomplete'));
    next.total = next.bytes;
    try {
      const cover = await fetch(`/api/v1/tracks/${record.track.id}/cover?size=320`, {
        signal: controller.signal,
        headers: { 'X-Wildstring-Account': record.userId },
      });
      const coverSize = Number(cover.headers.get('content-length'));
      if (cover.ok && coverSize > 0 && coverSize < 5 * 1024 * 1024) next.cover = await cover.blob();
    } catch {
      /* Artwork is optional; a complete audio download remains usable. */
    }
    guard();
    await write({ ...next, state: 'complete', updated: Date.now() }, currentGeneration);
  } catch (reason) {
    if (generation !== currentGeneration || !account) return;
    // Only checkpointed bytes are persisted; resuming starts exactly at this boundary.
    const bytes = next.blob.size;
    await write(
      {
        ...next,
        bytes,
        state: controller.signal.aborted ? 'paused' : 'failed',
        error:
          record.automatic && !automaticDownloadNetworkAllowed()
            ? i18n.t('offlineStore.waitingForNetwork')
            : controller.signal.aborted
              ? undefined
              : reason instanceof Error
                ? reason.message
                : i18n.t('offlineStore.downloadFailed'),
      },
      currentGeneration,
    );
  } finally {
    if (active.get(record.track.id) === controller) active.delete(record.track.id);
    changed();
  }
}
