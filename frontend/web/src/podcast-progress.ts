import { api, ApiError, eventId } from './api';
import i18n from './i18n';

export type PodcastProgressEvent = 'play' | 'progress' | 'pause' | 'seek' | 'stop' | 'ended';
export interface EpisodeProgress {
  episode_id: string;
  version: number;
  session_id: string;
  device_id: string;
  sequence: number;
  position_seconds: number;
  duration_seconds: number;
  completed: boolean;
  updated_at: string | null;
}
export interface EpisodeCheckpoint {
  remote: EpisodeProgress;
  session_id: string;
  base_version: number;
  sequence: number;
  position_seconds: number;
  duration_seconds: number;
  event: PodcastProgressEvent;
  dirty: boolean;
  conflict: boolean;
  intent?: 'resume' | 'restart';
  offline_start?: boolean;
  permission_pending?: boolean;
  superseded_session_id?: string;
}

export const emptyProgress = (id: string): EpisodeProgress => ({
  episode_id: id,
  version: 0,
  session_id: '',
  device_id: '',
  sequence: 0,
  position_seconds: 0,
  duration_seconds: 0,
  completed: false,
  updated_at: null,
});
export const episodeId = (id?: string) => (id?.startsWith('podcast_ep_') ? id.slice(11) : null);
export type EpisodeResumeMode = 'ask' | 'auto' | 'restart';
const volatileResumeModes = new Map<string, EpisodeResumeMode>();
export function episodeResumeMode(user: string): EpisodeResumeMode {
  if (volatileResumeModes.has(user)) return volatileResumeModes.get(user)!;
  try {
    const value = localStorage.getItem(`wildstring:podcast-resume-account:${user}`);
    return value === 'ask' || value === 'restart' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

function cacheEpisodeResumeMode(user: string, mode: EpisodeResumeMode) {
  try {
    localStorage.setItem(`wildstring:podcast-resume-account:${user}`, mode);
    volatileResumeModes.delete(user);
  } catch {
    // A successful account change remains usable when persistent storage is unavailable.
    volatileResumeModes.set(user, mode);
  }
  window.dispatchEvent(new Event('wildstring:podcast-resume-mode'));
}

export async function refreshEpisodeResumeMode(user: string): Promise<EpisodeResumeMode> {
  const result = await api<{ resume_mode: EpisodeResumeMode }>('/podcasts/resume-mode');
  cacheEpisodeResumeMode(user, result.resume_mode);
  return result.resume_mode;
}

export async function saveEpisodeResumeMode(user: string, mode: EpisodeResumeMode) {
  const result = await api<{ resume_mode: EpisodeResumeMode }>('/podcasts/resume-mode', {
    method: 'PUT',
    body: JSON.stringify({ resume_mode: mode }),
  });
  cacheEpisodeResumeMode(user, result.resume_mode);
  return result.resume_mode;
}

/** Small, durable per-episode outbox. Origin + user scopes prevent cross-server/account replay. */
export class PodcastProgressStore {
  private prefix: string;
  private device: string;
  private active: { id: string; session: string } | null = null;
  private sending = new Map<string, { promise: Promise<void> }>();
  private controller = new AbortController();
  private lastSent = new Map<string, number>();
  private volatile = new Map<string, EpisodeCheckpoint>();
  constructor(
    private user: string,
    private changed: (id: string, problem?: string) => void = () => {},
  ) {
    this.prefix = `wildstring:podcast-progress:${user}:`;
    const key = `wildstring:device:${user}`;
    this.device = eventId();
    try {
      this.device = localStorage.getItem(key) || this.device;
      localStorage.setItem(key, this.device);
    } catch {
      /* Playback remains available when storage is disabled. */
    }
  }
  dispose() {
    this.controller.abort();
    this.active = null;
  }
  isActive(id: string) {
    return this.active?.id === id && this.read(id)?.session_id === this.active.session;
  }
  conflicted(id: string) {
    return this.isActive(id) && !!this.read(id)?.conflict;
  }
  adoptManualChange(id: string) {
    this.volatile.delete(id);
    const record = this.read(id);
    if (!record || this.active?.id !== id) return;
    this.active = { id, session: record.session_id };
    this.changed(id);
  }
  leave() {
    this.active = null;
  }
  read(id: string): EpisodeCheckpoint | null {
    if (this.volatile.has(id)) return this.volatile.get(id)!;
    try {
      const record = JSON.parse(localStorage.getItem(this.prefix + id) || 'null');
      if (record?.remote?.episode_id !== id || !Number.isFinite(record.sequence)) return null;
      this.volatile.set(id, record);
      return record;
    } catch {
      return null;
    }
  }
  private save(id: string, record: EpisodeCheckpoint) {
    // Each live player retains its own session even when another tab updates the durable fallback.
    this.volatile.set(id, record);
    try {
      localStorage.setItem(this.prefix + id, JSON.stringify(record));
    } catch {
      this.changed(id, i18n.t('podcastProgress.localStorageError'));
    }
  }
  private async request(id: string, body?: object, timeout = 6000, signal?: AbortSignal) {
    const response = await fetch(`/api/v1/podcasts/episodes/${encodeURIComponent(id)}/progress`, {
      method: body ? 'PUT' : 'GET',
      credentials: 'same-origin',
      keepalive: !!body,
      signal: AbortSignal.any([
        this.controller.signal,
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        'Content-Type': 'application/json',
        'X-Wildstring-Client': 'web',
        'X-Wildstring-Account': this.user,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  }
  async remote(id: string, timeout = 6000, signal?: AbortSignal): Promise<EpisodeProgress> {
    const response = await this.request(id, undefined, timeout, signal);
    if (!response.ok) throw new ApiError(response.status, `progress_${response.status}`);
    return response.json();
  }
  async inspect(id: string, resume = false, signal?: AbortSignal) {
    if (!resume) this.leave();
    try {
      const remote = await this.remote(id, 1500, signal);
      return { remote, local: this.read(id), online: true };
    } catch (error) {
      if (
        signal?.aborted ||
        this.controller.signal.aborted ||
        (error instanceof ApiError && error.status < 500)
      )
        throw error;
      const local = this.read(id);
      return { remote: local?.remote || emptyProgress(id), local, online: false };
    }
  }
  async begin(
    id: string,
    remote: EpisodeProgress,
    position: number,
    duration: number,
    intent: 'resume' | 'restart',
    online: boolean,
    reuse = false,
  ) {
    if (this.controller.signal.aborted) return;
    const local = this.read(id);
    const continuing =
      reuse && this.isActive(id) && !local?.conflict && local?.intent !== 'restart';
    const session = continuing ? local!.session_id : eventId();
    const predecessor =
      online &&
      local &&
      !local.conflict &&
      (remote.version === local.remote.version ||
        (remote.session_id === local.session_id && remote.device_id === this.device))
        ? local
        : null;
    const base =
      predecessor &&
      predecessor.remote.session_id === predecessor.session_id &&
      predecessor.remote.version > remote.version
        ? predecessor.remote
        : remote;
    this.save(id, {
      remote: base,
      session_id: session,
      base_version: base.version,
      sequence: continuing ? local!.sequence + 1 : 1,
      position_seconds: Math.max(0, Math.floor(position)),
      duration_seconds: Math.max(0, Math.floor(duration)),
      event: 'play',
      intent,
      offline_start: !online,
      permission_pending: true,
      dirty: true,
      conflict: false,
      superseded_session_id: continuing ? undefined : predecessor?.session_id,
    });
    this.active = { id, session };
    this.lastSent.set(id, Date.now());
  }
  waitingForPermission(id: string) {
    return this.isActive(id) && this.read(id)?.permission_pending === true;
  }
  activate(id: string) {
    const record = this.read(id);
    if (!this.isActive(id) || !record?.permission_pending) return;
    this.save(id, { ...record, permission_pending: false });
    if (!record.offline_start) void this.flush(id);
  }
  async finish(id: string) {
    const session = this.active?.id === id ? this.active.session : null;
    if (!session || this.conflicted(id)) return false;
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      this.flush(id),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1500);
      }),
    ]);
    clearTimeout(timer!);
    const record = this.read(id);
    return (
      this.active?.session === session &&
      record?.session_id === session &&
      !record.conflict &&
      record.remote.session_id === session &&
      record.remote.sequence >= record.sequence &&
      record.remote.completed
    );
  }
  async takeOver(id: string) {
    const record = this.read(id);
    if (!record || !this.conflicted(id)) return;
    const session = eventId();
    this.active = { id, session };
    this.save(id, {
      ...record,
      session_id: session,
      base_version: record.remote.version,
      sequence: 1,
      event: 'progress',
      intent: 'resume',
      dirty: true,
      conflict: false,
    });
    await this.flush(id);
  }
  checkpoint(
    id: string,
    position: number,
    duration: number,
    event: PodcastProgressEvent,
    force = false,
  ) {
    const record = this.read(id);
    if (
      this.controller.signal.aborted ||
      !record ||
      this.active?.id !== id ||
      this.active.session !== record.session_id
    )
      return;
    if (!Number.isFinite(position) || position < 0) return;
    const seconds = Math.floor(position);
    if (
      record.event === 'ended' &&
      seconds === record.position_seconds &&
      ['stop', 'pause', 'progress'].includes(event)
    )
      event = 'ended';
    if (record.position_seconds !== seconds || record.event !== event) {
      this.save(id, {
        ...record,
        position_seconds: seconds,
        duration_seconds:
          Number.isFinite(duration) && duration > 0
            ? Math.floor(duration)
            : record.duration_seconds,
        sequence: record.sequence + 1,
        event: record.permission_pending ? 'play' : event,
        dirty: true,
      });
    }
    if (force || record.offline_start || Date.now() - (this.lastSent.get(id) || 0) >= 10000)
      void this.flush(id);
  }
  async flush(id: string): Promise<void> {
    if (this.controller.signal.aborted) return;
    const previous = this.sending.get(id);
    if (previous) {
      await previous.promise;
      return this.flush(id);
    }
    const entry = { promise: this.send(id) };
    this.sending.set(id, entry);
    try {
      await entry.promise;
    } finally {
      if (this.sending.get(id) === entry) this.sending.delete(id);
    }
  }
  private async send(id: string) {
    const pending = this.read(id);
    if (!pending?.dirty || pending.conflict || pending.permission_pending) return;
    this.lastSent.set(id, Date.now());
    try {
      const response = await this.request(id, {
        session_id: pending.session_id,
        device_id: this.device,
        base_version: pending.base_version,
        sequence: pending.sequence,
        position_seconds: pending.position_seconds,
        duration_seconds: pending.duration_seconds,
        event: pending.event,
        ...(pending.intent ? { intent: pending.intent } : {}),
      });
      if (this.controller.signal.aborted) return;
      const latest = this.read(id);
      if (!latest) return;
      if (latest.session_id !== pending.session_id) {
        if (response.ok) {
          const remote: EpisodeProgress = await response.json();
          if (this.controller.signal.aborted) return;
          const current = this.read(id);
          // The per-episode send chain keeps this successor unsent until the old request returns.
          if (
            current &&
            !current.conflict &&
            current.superseded_session_id === pending.session_id &&
            remote.session_id === pending.session_id &&
            remote.device_id === this.device &&
            current.base_version === current.remote.version &&
            remote.version > current.remote.version
          ) {
            this.save(id, {
              ...current,
              remote,
              base_version: remote.version,
              superseded_session_id: undefined,
            });
          }
        }
        return;
      }
      if (response.status === 409) {
        const { detail } = await response.json();
        const remote: EpisodeProgress = detail.current;
        const current = this.read(id);
        if (!current || current.session_id !== pending.session_id) return;
        if (!this.isActive(id)) {
          this.save(id, { ...current, remote, dirty: false, conflict: false });
          window.dispatchEvent(
            new CustomEvent('wildstring:podcast-progress-updated', { detail: remote }),
          );
        } else {
          this.save(id, { ...current, remote, conflict: true });
          this.changed(id, i18n.t('podcastProgress.conflictNotice'));
        }
      } else if (response.ok) {
        const remote: EpisodeProgress = await response.json();
        if (this.controller.signal.aborted) return;
        const current = this.read(id);
        if (!current || current.session_id !== pending.session_id) return;
        this.save(id, {
          ...current,
          remote,
          dirty: current.sequence > pending.sequence,
          offline_start: false,
          superseded_session_id: undefined,
        });
        this.changed(id);
        window.dispatchEvent(
          new CustomEvent('wildstring:podcast-progress-updated', { detail: remote }),
        );
      } else if (response.status !== 401) {
        this.changed(
          id,
          response.status === 422
            ? i18n.t('podcastProgress.serverUpdateNeeded')
            : i18n.t('podcastProgress.syncPending'),
        );
      }
    } catch {
      /* Durable checkpoints survive offline, page closure and process death. */
    }
  }
  async flushAll(throttle = false) {
    const ids = new Set(this.volatile.keys());
    try {
      for (const key of Object.keys(localStorage))
        if (key.startsWith(this.prefix)) ids.add(key.slice(this.prefix.length));
    } catch {
      /* In-memory checkpoints can still be synchronized. */
    }
    for (const id of ids) {
      if (this.controller.signal.aborted) break;
      if (throttle && Date.now() - (this.lastSent.get(id) || 0) < 10000) continue;
      await this.flush(id);
    }
  }
}

export async function setEpisodeCompleted(
  user: string,
  id: string,
  durationSeconds: number,
  completed: boolean,
): Promise<EpisodeProgress> {
  const prefix = `wildstring:podcast-progress:${user}:`;
  const deviceKey = `wildstring:device:${user}`;
  let device = eventId();
  try {
    device = localStorage.getItem(deviceKey) || device;
    localStorage.setItem(deviceKey, device);
  } catch {
    /* Playback remains available when storage is disabled. */
  }
  const currentResp = await fetch(`/api/v1/podcasts/episodes/${encodeURIComponent(id)}/progress`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Wildstring-Client': 'web',
      'X-Wildstring-Account': user,
    },
  });
  if (!currentResp.ok) throw new Error(`progress_${currentResp.status}`);
  const current: EpisodeProgress = await currentResp.json();
  const duration = Math.max(1, Math.floor(durationSeconds || current.duration_seconds || 1));
  const position = completed ? duration : 0;
  const event: PodcastProgressEvent = completed ? 'ended' : 'stop';
  const sessionId = eventId();
  const saveResp = await fetch(`/api/v1/podcasts/episodes/${encodeURIComponent(id)}/progress`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Wildstring-Client': 'web',
      'X-Wildstring-Account': user,
    },
    body: JSON.stringify({
      session_id: sessionId,
      device_id: device,
      base_version: current.version,
      sequence: 1,
      position_seconds: position,
      duration_seconds: duration,
      event,
      intent: completed ? 'resume' : 'restart',
    }),
  });
  if (!saveResp.ok) throw new Error(`progress_${saveResp.status}`);
  const saved: EpisodeProgress = await saveResp.json();
  try {
    localStorage.setItem(
      prefix + id,
      JSON.stringify({
        remote: saved,
        session_id: sessionId,
        base_version: saved.version,
        sequence: 1,
        position_seconds: saved.position_seconds,
        duration_seconds: saved.duration_seconds,
        event,
        intent: completed ? 'resume' : 'restart',
        dirty: false,
        conflict: false,
      } satisfies EpisodeCheckpoint),
    );
  } catch {
    /* Ignore local storage errors. */
  }
  window.dispatchEvent(new CustomEvent('wildstring:podcast-progress-updated', { detail: saved }));
  window.dispatchEvent(new CustomEvent('wildstring:podcast-progress-manual', { detail: saved }));
  return saved;
}
