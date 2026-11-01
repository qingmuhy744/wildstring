import { useEffect, useRef } from 'react';
import { DialogCloseButton } from './dialog-close';
import { Icon } from './icons';
import { renderPodcastDescription } from './podcast-description';
import type { PodcastEpisode, PodcastSummary } from './podcasts';
import './podcast-episode-dialog.css';

export function PodcastEpisodeDialog({
  episode,
  podcast,
  date,
  duration,
  onClose,
  onPlay,
  onQueue,
  onSave,
}: {
  episode: PodcastEpisode;
  podcast: PodcastSummary;
  date: string;
  duration: string;
  onClose: () => void;
  onPlay: () => void;
  onQueue: (next: boolean) => void;
  onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  const extension = new URL(episode.audio_url).pathname.match(
    /\.(mp3|m4a|aac|ogg|opus|flac|wav|webm)$/i,
  )?.[1];
  return (
    <dialog
      ref={dialog}
      className="podcast-episode-dialog"
      aria-labelledby="podcast-episode-heading"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="episode-dialog-header">
        <div className="episode-dialog-identity">
          <div className="episode-dialog-cover" aria-hidden="true">
            {podcast.cover_url ? <img src={podcast.cover_url} alt="" /> : <Icon name="podcast" />}
          </div>
          <div className="episode-dialog-heading">
            <span className="episode-dialog-programme">{podcast.title}</span>
            <h2 id="podcast-episode-heading">{episode.title}</h2>
          </div>
        </div>
        <DialogCloseButton aria-label="关闭详情" onClick={onClose} />
        <div className="episode-dialog-meta">
          {date && <span>{date}发布</span>}
          {duration && <span>时长 {duration}</span>}
          <span className="episode-dialog-availability">
            {episode.download_status === 'downloaded' ? '服务器已有音频' : '在线音频'}
          </span>
        </div>
      </header>
      <section className="episode-dialog-description" aria-label="本集简介" tabIndex={0}>
        <h3>本集简介</h3>
        {renderPodcastDescription(episode.description) || <p>暂无单集简介。</p>}
      </section>
      <footer className="episode-dialog-footer">
        <div className="episode-dialog-playback">
          <button type="button" className="primary" onClick={onPlay}>
            <Icon name="play" />
            播放单集
          </button>
          <button type="button" onClick={() => onQueue(true)}>
            <Icon name="next" />
            下一集播放
          </button>
          <button type="button" onClick={() => onQueue(false)}>
            <Icon name="queue" />
            加入待播
          </button>
        </div>
        <div className="episode-dialog-files">
          <a
            href={`/api/v1/podcasts/episodes/${encodeURIComponent(episode.id)}/stream?download=1`}
            download
            title="将原始音频文件下载到此设备"
          >
            <Icon name="download" />
            {extension ? `下载 ${extension.toUpperCase()}` : '下载音频'}
          </a>
          <span>保存到此设备</span>
          <button type="button" onClick={onSave}>
            {episode.resource_saved ? '取消个人保存' : '保存到服务器'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
