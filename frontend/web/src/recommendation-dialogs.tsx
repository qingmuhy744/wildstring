import { useEffect, useRef, useState } from 'react';
import { api, artist, type Lyrics, type Playlist, type Track } from './api';
import { DialogCloseButton } from './dialog-close';

export function RecommendationPlaylistDialog({
  tracks,
  playlists,
  onSaved,
  onClose,
}: {
  tracks: Track[];
  playlists: Playlist[];
  onSaved: (playlist: Playlist) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const created = useRef<Playlist | null>(null);
  const [target, setTarget] = useState(playlists[0]?.id || 'new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      let list: Playlist;
      if (created.current) list = await api<Playlist>(`/playlists/${created.current.id}`);
      else if (target === 'new') {
        list = await api<Playlist>('/playlists', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), kind: 'manual' }),
        });
        created.current = list;
      } else list = await api<Playlist>(`/playlists/${target}`);
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ version: list.version, track_ids: tracks.map((track) => track.id) }),
      });
      onSaved(updated);
      onClose();
    } catch (reason) {
      setError(
        `${created.current ? '歌单已创建，曲目尚未确认加入。' : ''}${reason instanceof Error ? reason.message : '保存失败，请重试。'}`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="recommendation-dialog"
      aria-label="加入歌单"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="editor-heading">
          <h2>加入歌单</h2>
          <DialogCloseButton aria-label="关闭加入歌单" onClick={onClose} disabled={busy} />
        </div>
        <p className="muted">已选 {tracks.length} 首 · 按推荐中的顺序保存</p>
        <label>
          目标歌单
          <select
            value={target}
            disabled={busy || !!created.current}
            onChange={(event) => setTarget(event.target.value)}
          >
            {playlists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
            <option value="new">新建歌单…</option>
          </select>
        </label>
        {target === 'new' && (
          <label>
            歌单名称
            <input
              value={name}
              maxLength={120}
              disabled={busy || !!created.current}
              onChange={(event) => setName(event.target.value)}
              placeholder="给这次挑选起个名字"
              required
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar-actions">
          <button type="submit" disabled={busy || (target === 'new' && !name.trim())}>
            {busy ? '正在加入…' : '确认加入'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function RecommendationLyricsDialog({
  track,
  onClose,
}: {
  track: Track;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void api<Lyrics>(`/tracks/${track.id}/lyrics`, { signal: controller.signal })
      .then(setLyrics)
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '歌词暂时无法读取');
      });
    return () => controller.abort();
  }, [track.id]);
  return (
    <dialog
      ref={dialog}
      className="recommendation-dialog"
      aria-label={`歌词 · ${track.title}`}
      onCancel={onClose}
    >
      <div className="editor-heading">
        <h2>{track.title}</h2>
        <DialogCloseButton aria-label="关闭歌词预览" onClick={onClose} />
      </div>
      <p className="muted">{artist(track)} · 歌词预览</p>
      <div className="recommendation-lyrics">
        {error ? (
          <p role="alert">{error}</p>
        ) : !lyrics ? (
          <p role="status">正在读取歌词…</p>
        ) : !lyrics.lines.length ? (
          <p>这首歌还没有歌词。</p>
        ) : (
          lyrics.lines.map((line, index) => (
            <p key={index}>
              {line.text}
              {line.translation && <small>{line.translation}</small>}
            </p>
          ))
        )}
      </div>
    </dialog>
  );
}
