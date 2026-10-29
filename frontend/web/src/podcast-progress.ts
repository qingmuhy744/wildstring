import { eventId } from './api';

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
export function episodeResumeMode(user: string): EpisodeResumeMode {
  try {
    const value = localStorage.getItem(`wildstring:podcast-resume:${user}`);
    return value === 'auto' || value === 'restart' ? value : 'ask';
  } catch {
    return 'ask';
  }
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
  owns(id: string) {
    const record = this.read(id);
    return this.active?.id === id && record?.session_id === this.active.session && !record.conflict;
  }
  leave() {
    this.active = null;
  }
  read(id: string): EpisodeCheckpoint | null {
    if (this.volatile.has(id)) return this.volatile.get(id)!;
    try {
      const record = JSON.parse(localStorage.getItem(this.prefix + id) || 'null');
      return record?.remote?.episode_id === id && Number.isFinite(record.sequence) ? record : null;
    } catch {
      return null;
    }
  }
  private save(id: string, record: EpisodeCheckpoint) {
    try {
      localStorage.setItem(this.prefix + id, JSON.stringify(record));
      this.volatile.delete(id);
    } catch {
      this.volatile.set(id, record);
      this.changed(id, '浏览器无法在本机保存单集进度，请检查存储空间。');
    }
  }
  private async request(id: string, body?: object) {
    const response = await fetch(`/api/v1/podcasts/episodes/${encodeURIComponent(id)}/progress`, {
      method: body ? 'PUT' : 'GET',
      credentials: 'same-origin',
      keepalive: !!body,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(6000)]),
      headers: {
        'Content-Type': 'application/json',
        'X-Wildstring-Client': 'web',
        'X-Wildstring-Account': this.user,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return response;
  }
  async remote(id: string): Promise<EpisodeProgress> {
    const response = await this.request(id);
    if (!response.ok) throw new Error(`progress_${response.status}`);
    return response.json();
  }
  async inspect(id: string) {
    // Upload the last durable checkpoint before making a new, explicit listening session.
    await this.flush(id);
    const local = this.read(id);
    let remote: EpisodeProgress;
    try {
      remote = await this.remote(id);
    } catch (error) {
      if (
        this.controller.signal.aborted ||
        (error instanceof Error && /^progress_/.test(error.message))
      )
        throw error;
      remote = local?.remote || emptyProgress(id);
    }
    const conflict =
      !!local?.dirty &&
      (local.conflict ||
        (local.session_id !== remote.session_id && local.base_version !== remote.version));
    return { remote, local, conflict };
  }
  async begin(id: string, remote: EpisodeProgress, position: number, duration: number) {
    if (this.controller.signal.aborted) return false;
    const session = eventId();
    this.save(id, {
      remote,
      session_id: session,
      base_version: remote.version,
      sequence: 1,
      position_seconds: Math.max(0, Math.floor(position)),
      duration_seconds: Math.max(0, Math.floor(duration)),
      event: 'play',
      dirty: true,
      conflict: false,
    });
    this.active = { id, session };
    await this.flush(id);
    return !this.read(id)?.conflict && !this.controller.signal.aborted;
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
        event,
        dirty: true,
      });
    }
    if (force || Date.now() - (this.lastSent.get(id) || 0) >= 10000) void this.flush(id);
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
    if (!pending?.dirty || pending.conflict) return;
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
      });
      if (this.controller.signal.aborted) return;
      const latest = this.read(id);
      if (!latest || latest.session_id !== pending.session_id) return;
      if (response.status === 409) {
        this.save(id, { ...latest, conflict: true });
        // Continue saving the audible position locally; the conflicted outbox cannot
        // upload again until an explicit choice starts a new listening session.
        this.changed(id, '另一台设备更新了本集进度，本机位置已保留，请选择接续位置。');
      } else if (response.ok) {
        const remote: EpisodeProgress = await response.json();
        if (this.controller.signal.aborted) return;
        const current = this.read(id);
        if (!current || current.session_id !== pending.session_id) return;
        this.save(id, { ...current, remote, dirty: current.sequence > pending.sequence });
        this.changed(id);
        window.dispatchEvent(
          new CustomEvent('wildstring:podcast-progress-updated', { detail: remote }),
        );
      } else if (response.status !== 401) {
        this.changed(
          id,
          response.status === 422
            ? '服务器需要更新才能同步播客进度；本机进度已保存。'
            : '单集进度暂未同步，已保存在本机。',
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
