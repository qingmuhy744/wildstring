import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { artist, type Track } from './api';
import { Cover } from './cover';
import './playback-style.css';

export type PlaybackStyle = 'cover' | 'vinyl' | 'cassette';
const KEY = 'wildstring-playback-style';
export const playbackStyles: [PlaybackStyle, string][] = [
  ['cover', '封面'],
  ['vinyl', '黑胶'],
  ['cassette', '磁带'],
];
function valid(value: unknown): value is PlaybackStyle {
  return playbackStyles.some(([style]) => style === value);
}
function savedStyle(): PlaybackStyle {
  try {
    const value = localStorage.getItem(KEY);
    if (valid(value)) return value;
  } catch {
    /* Storage is optional for playback. */
  }
  return 'cover';
}
let selected = savedStyle();

export function usePlaybackStyle() {
  const [style, setStyle] = useState<PlaybackStyle>(() => selected);
  useEffect(() => {
    const changed = () => setStyle(selected);
    const storage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) {
        selected = savedStyle();
        changed();
      }
    };
    window.addEventListener('wildstring:playback-style', changed);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('wildstring:playback-style', changed);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return style;
}

export function PlaybackStyleControl() {
  const style = usePlaybackStyle();
  return (
    <label className="theme-control playback-style-control">
      <span>播放样式</span>
      <select
        aria-label="播放样式"
        value={style}
        onChange={(event) => {
          const value = event.target.value;
          if (!valid(value)) return;
          selected = value;
          try {
            localStorage.setItem(KEY, value);
          } catch {
            /* Keep the in-memory preference. */
          }
          window.dispatchEvent(new Event('wildstring:playback-style'));
        }}
      >
        {playbackStyles.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PlaybackVisual({
  track,
  style,
  playing,
  position,
  duration,
  phase,
  onImage,
  onPreview,
}: {
  track: Track;
  style: PlaybackStyle;
  playing: boolean;
  position: number;
  duration: number;
  phase: MutableRefObject<number>;
  onImage: (image: HTMLImageElement) => void;
  onPreview: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 180);
    return () => clearTimeout(timer);
  }, [track.id]);
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = 0;
    const draw = () => root.current?.style.setProperty('--spin', `${phase.current}deg`);
    const tick = (now: number) => {
      if (last) phase.current = (phase.current + Math.min(now - last, 64) * 0.018) % 360;
      last = now;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      last = 0;
      const active = playing && style !== 'cover' && !document.hidden && !reduced.matches;
      setMotion(active);
      draw();
      if (active) frame = requestAnimationFrame(tick);
    };
    update();
    document.addEventListener('visibilitychange', update);
    reduced.addEventListener('change', update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', update);
      reduced.removeEventListener('change', update);
    };
  }, [playing, style, phase]);
  const progress = duration > 0 ? Math.max(0, Math.min(position / duration, 1)) : 0;
  return (
    <div
      ref={root}
      className={`playback-visual visual-${style}`}
      data-style={style}
      data-moving={motion}
      data-engaged={playing && settled}
      role="img"
      tabIndex={0}
      aria-label="歌曲封面，长按或按回车查看大图"
      title="长按查看大封面"
      style={
        {
          '--left-pack': `${38 - progress * 13}%`,
          '--right-pack': `${25 + progress * 13}%`,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onPreview();
        }
      }}
    >
      <span className="cassette-case" aria-hidden="true">
        <span className="cassette-paper">
          <span className="cassette-brand">野弦 / WILDSTRING</span>
          <strong>{track.title}</strong>
          <span className="cassette-artist">{artist(track)}</span>
        </span>
        <span className="tape-window">
          <span className="tape-pack tape-left" />
          <span className="tape-pack tape-right" />
          <span className="tape-guide" />
          <span className="tape-hub tape-left" />
          <span className="tape-hub tape-right" />
        </span>
        <span className="cassette-apron" />
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={`cassette-screw screw-${index}`} />
        ))}
      </span>
      <span className="visual-platter">
        <Cover
          trackId={track.id}
          title={track.album || track.title}
          size={768}
          className="fullscreen-cover"
          onImage={onImage}
        />
        <span className="record-spindle" aria-hidden="true" />
      </span>
      <span className="record-sheen" aria-hidden="true" />
      <span className="tonearm" aria-hidden="true">
        <span className="tonearm-pivot" />
        <span className="tonearm-head" />
      </span>
    </div>
  );
}
