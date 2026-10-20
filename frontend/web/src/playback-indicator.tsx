import { useEffect, useState } from 'react';
import './playback-indicator.css';

/** A playback-state indicator; the bars do not represent measured audio levels. */
export function PlaybackIndicator({
  playing,
  buffering,
}: {
  playing: boolean;
  buffering: boolean;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const state = buffering ? 'buffering' : playing ? 'playing' : 'paused';
  const label = buffering ? '缓冲中' : playing ? '正在播放' : '已暂停';
  return (
    <span
      className="playback-indicator"
      role="img"
      aria-label={label}
      data-help={label}
      data-state={state}
      data-animate={state === 'playing' && visible}
    >
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}
