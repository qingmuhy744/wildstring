import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const prompt = player.podcastProgressPrompt;
  if (!prompt)
    return player.podcastProgressMessage && player.current?.podcast_id ? (
      <aside className="device-resume-notice" role="status">
        <p>{player.podcastProgressMessage}</p>
        <button onClick={player.reviewPodcastProgress}>
          {t('podcastProgressDialog.chooseResumePosition')}
        </button>
      </aside>
    ) : null;
  return <ProgressPrompt player={player} prompt={prompt} />;
}
function ProgressPrompt({ player, prompt }: { player: Player; prompt: PodcastProgressPrompt }) {
  const { t } = useTranslation();
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
      aria-label={t('podcastProgressDialog.dialogAriaLabel')}
      onCancel={() => player.answerPodcastProgress(null)}
    >
      <header>
        <h2>
          {prompt.conflict
            ? t('podcastProgressDialog.choosePositionTitle')
            : t('podcastProgressDialog.resumePromptTitle')}
        </h2>
        <DialogCloseButton
          aria-label={t('podcastProgressDialog.cancelResume')}
          onClick={() => player.answerPodcastProgress(null)}
        />
      </header>
      <p>{prompt.title}</p>
      <p>
        {t('podcastProgressDialog.syncedTo', { time: time(prompt.remote) })}
        {prompt.conflict
          ? t('podcastProgressDialog.localPosition', { time: time(prompt.local) })
          : ''}
      </p>
      {prompt.conflict && <p className="muted">{t('podcastProgressDialog.conflictHelp')}</p>}
      <footer>
        <button onClick={() => player.answerPodcastProgress('local')}>
          {prompt.conflict
            ? t('podcastProgressDialog.resumeLocal', { time: time(prompt.local) })
            : t('podcastProgressDialog.playFromStart')}
        </button>
        <button className="primary" onClick={() => player.answerPodcastProgress('remote')}>
          {t('podcastProgressDialog.resumeRemote', { time: time(prompt.remote) })}
        </button>
      </footer>
    </dialog>
  );
}
