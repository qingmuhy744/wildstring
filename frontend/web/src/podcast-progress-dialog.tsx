import { useEffect, useRef } from 'react';
import { DialogCloseButton } from './dialog-close';
import { time } from './api';
import type { Player } from './player';
export interface PodcastProgressPrompt {
  title: string;
  remote: number;
  local: number;
  conflict: boolean;
}
export function PodcastProgressDialog({ player }: { player: Player }) {
  const prompt = player.podcastProgressPrompt;
  if (!prompt)
    return player.podcastProgressMessage && player.current?.podcast_id ? (
      <aside className="device-resume-notice" role="status">
        <p>{player.podcastProgressMessage}</p>
        <button onClick={player.reviewPodcastProgress}>选择接续位置</button>
      </aside>
    ) : null;
  return <ProgressPrompt player={player} prompt={prompt} />;
}
function ProgressPrompt({ player, prompt }: { player: Player; prompt: PodcastProgressPrompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="podcast-progress-dialog"
      aria-label="播客单集进度"
      onCancel={() => player.answerPodcastProgress(null)}
    >
      <header>
        <h2>{prompt.conflict ? '选择本集接续位置' : '继续收听这集？'}</h2>
        <DialogCloseButton
          aria-label="取消接续"
          onClick={() => player.answerPodcastProgress(null)}
        />
      </header>
      <p>{prompt.title}</p>
      <p>
        已同步至 {time(prompt.remote)}
        {prompt.conflict ? ` · 本机听到 ${time(prompt.local)}` : ''}
      </p>
      {prompt.conflict && <p className="muted">两份位置都已保留。选择后从该位置继续收听。</p>}
      <footer>
        <button onClick={() => player.answerPodcastProgress('local')}>
          {prompt.conflict ? `继续本机 ${time(prompt.local)}` : '从头播放'}
        </button>
        <button className="primary" onClick={() => player.answerPodcastProgress('remote')}>
          继续 {time(prompt.remote)}
        </button>
      </footer>
    </dialog>
  );
}
