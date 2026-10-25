import { eventId, type Track } from './api';

type Report = {
  session_id: string;
  track_id: string;
  listened_ms: number;
  started_at: number;
  state: 'playing' | 'paused' | 'ended';
};
type Session = Report & { clock: number; position: number; playing: boolean; lastSent: number };

export class ListeningTracker {
  private session: Session | null = null;
  private pending = new Map<string, Report>();
  private sending = new Set<string>();

  start(track: Track, audio: HTMLAudioElement) {
    this.finish(audio);
    if (track.id.startsWith('podcast_ep_')) {
      this.session = null;
      return;
    }
    this.session = {
      session_id: eventId(),
      track_id: track.id,
      listened_ms: 0,
      started_at: Date.now() / 1000,
      state: 'paused',
      clock: performance.now(),
      position: 0,
      playing: false,
      lastSent: 0,
    };
    this.report();
  }
  sample(audio: HTMLAudioElement) {
    const session = this.session;
    if (!session) return;
    const clock = performance.now(),
      elapsed = Math.max(0, clock - session.clock);
    const advance = (audio.currentTime - session.position) * 1000;
    const rate = audio.playbackRate > 0 ? audio.playbackRate : 1;
    // Seeking, buffering and paused wall time never become listening time.
    if (
      session.playing &&
      !audio.seeking &&
      audio.readyState >= 2 &&
      advance >= 0 &&
      advance <= elapsed * rate * 1.75 + 250
    )
      session.listened_ms += Math.min(elapsed, advance / rate);
    session.clock = clock;
    session.position = audio.currentTime;
    if (session.listened_ms - session.lastSent >= 5000) this.report();
  }
  playing(audio: HTMLAudioElement, playing: boolean) {
    this.sample(audio);
    if (this.session) this.session.playing = playing;
    if (!playing) this.report();
  }
  beforeSeek(audio: HTMLAudioElement) {
    this.playing(audio, false);
  }
  afterSeek(audio: HTMLAudioElement) {
    if (!this.session) return;
    this.session.clock = performance.now();
    this.session.position = audio.currentTime;
    this.session.playing = !audio.paused && audio.readyState >= 2;
  }
  report() {
    const session = this.session;
    if (session) {
      const payload = {
        session_id: session.session_id,
        track_id: session.track_id,
        listened_ms: Math.floor(session.listened_ms),
        started_at: session.started_at,
        state: session.playing ? ('playing' as const) : ('paused' as const),
      };
      this.pending.set(session.session_id, payload);
      session.lastSent = session.listened_ms;
    }
    void this.flush();
  }
  async flush() {
    await Promise.all(
      [...this.pending.values()].map(async (payload) => {
        if (this.sending.has(payload.session_id)) return;
        this.sending.add(payload.session_id);
        try {
          const response = await fetch('/api/v1/listening', {
            method: 'POST',
            credentials: 'same-origin',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', 'X-Wildstring-Client': 'web' },
            body: JSON.stringify(payload),
          });
          if (response.ok) {
            if (this.pending.get(payload.session_id) === payload)
              this.pending.delete(payload.session_id);
            if (payload.listened_ms > 0 && payload.state === 'paused')
              window.dispatchEvent(new Event('wildstring:listening-updated'));
          }
        } catch {
          /* Retry the same cumulative report; the server deduplicates it. */
        } finally {
          this.sending.delete(payload.session_id);
        }
      }),
    );
  }
  finish(audio: HTMLAudioElement) {
    this.playing(audio, false);
  }
}
