import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, artist, time, type Album, type AlbumPage, type TrackPage } from './api';
import { Brand } from './brand';
import { Cover } from './cover';
import { NowPlaying } from './now-playing';
import { PlayerBar, usePlayer } from './player';
import { Pagination, TrackList } from './track-list';

export function Library({ onLogout }: { onLogout: () => Promise<void> }) {
  const [view, setView] = useState<'tracks' | 'albums'>('tracks');
  const [album, setAlbum] = useState<Album | null>(null);
  const [page, setPage] = useState<TrackPage | null>(null);
  const [albums, setAlbums] = useState<AlbumPage | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [songCount, setSongCount] = useState<number | null>(null);
  const [albumCount, setAlbumCount] = useState<number | null>(null);
  const closePlayer = useCallback(() => setLyricsOpen(false), []);
  const player = usePlayer();
  const albumGrid = view === 'albums' && !album;
  const result = albumGrid ? albums : page;
  const unit = albumGrid ? '张' : '首';

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const parameters = new URLSearchParams({
      q: album ? '' : query,
      limit: album ? '200' : '50',
      offset: String(offset),
    });
    const path = album
      ? `/albums/${encodeURIComponent(album.id)}/tracks`
      : view === 'albums'
        ? '/albums'
        : '/tracks';
    api<TrackPage | AlbumPage>(`${path}?${parameters}`, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (view === 'albums' && !album) {
          setAlbums(response as AlbumPage);
          if (!query) setAlbumCount(response.total);
        } else {
          setPage(response as TrackPage);
          if (!query && !album) setSongCount(response.total);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof ApiError ? reason.message : '无法连接音乐服务，请检查连接。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, offset, revision, view, album]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  function switchView(target: 'tracks' | 'albums') {
    setView(target);
    setAlbum(null);
    setOffset(0);
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setAlbum(null);
    setOffset(0);
    setQuery(draft.trim());
    setRevision((value) => value + 1);
  }
  function toggleQueue() {
    setQueueOpen(!queueOpen);
    setLyricsOpen(false);
  }
  function toggleLyrics() {
    setLyricsOpen(!lyricsOpen);
    setQueueOpen(false);
  }
  function logout() {
    void onLogout().catch(() => setError('退出失败，请重试。'));
  }
  return (
    <>
      <div className="app-shell" inert={lyricsOpen} aria-hidden={lyricsOpen || undefined}>
        <aside className="sidebar">
          <Brand />
          <p className="sidebar-label">你的音乐空间</p>
          <button
            className={`nav-button ${view === 'tracks' ? 'nav-current' : ''}`}
            onClick={() => switchView('tracks')}
          >
            <span>▤</span> 全部歌曲 {songCount !== null && <small>{songCount}</small>}
          </button>
          <button
            className={`nav-button ${view === 'albums' ? 'nav-current' : ''}`}
            onClick={() => switchView('albums')}
          >
            <span>▣</span> 专辑 {albumCount !== null && <small>{albumCount}</small>}
          </button>
          <button
            className={`nav-button ${queueOpen ? 'selected' : ''}`}
            onClick={toggleQueue}
            aria-expanded={queueOpen}
          >
            <span>☷</span> 播放队列 <small>{player.queue.length}</small>
          </button>
          <div className="sidebar-bottom">
            <span className="local-dot" /> 私人曲库 · 原音直放
            <p>
              音乐不设限，
              <br />
              自由有回响。
            </p>
            <button className="text-button" onClick={logout}>
              退出登录 ↗
            </button>
          </div>
        </aside>
        <main className="library">
          <header className="topbar">
            <div>
              <span className="eyebrow">YOUR OWN COLLECTION</span>
              <span className="mobile-brand">野弦 / WILDSTRING</span>
              <button className="mobile-logout text-button" onClick={logout}>
                退出登录
              </button>
            </div>
            <form className="search" onSubmit={search} role="search" autoComplete="off">
              <label className="sr-only" htmlFor="search">
                搜索曲库
              </label>
              <span aria-hidden="true">⌕</span>
              <input
                id="search"
                type="search"
                name="wildstring-library-query"
                autoComplete="off"
                spellCheck={false}
                placeholder="搜索歌曲、艺人、专辑"
                maxLength={256}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="submit" aria-label="搜索">
                ↵
              </button>
            </form>
          </header>
          <section className={`collection-heading ${album ? 'album-heading' : ''}`}>
            <div>
              {album && (
                <button
                  className="back-button text-button"
                  onClick={() => {
                    setAlbum(null);
                    setOffset(0);
                  }}
                >
                  ← 返回专辑
                </button>
              )}
              <p className="eyebrow">
                LIBRARY / {album ? 'ALBUM' : query ? 'SEARCH' : albumGrid ? 'ALBUMS' : 'ALL TRACKS'}
              </p>
              <h1>
                {album?.title ||
                  (query
                    ? '找到喜欢的声音。'
                    : albumGrid
                      ? '一张专辑，一段时光。'
                      : '收藏的声音。')}
              </h1>
              <p className="muted">
                {album
                  ? `${album.artists.join(' / ') || '未知艺人'} · ${time(album.duration_ms / 1000)}`
                  : query
                    ? `“${query}” 的搜索结果`
                    : albumGrid
                      ? '按专辑，重新听一遍收藏。'
                      : '熟悉的旋律，值得再听一遍。'}
              </p>
            </div>
            {album && (
              <Cover
                key={`${album.id}-${revision}`}
                trackId={album.cover_track_id}
                title={album.title}
                size={320}
                className="album-heading-cover"
              />
            )}
            <div className="collection-stat">
              <strong>{result?.total ?? '—'}</strong>
              <span>{albumGrid ? '张专辑' : query && !album ? '首匹配歌曲' : '首曲库收藏'}</span>
            </div>
          </section>
          <div className="library-toolbar">
            <div className="toolbar-actions">
              <div className="view-switch" role="group" aria-label="曲库显示方式">
                <button aria-pressed={view === 'tracks'} onClick={() => switchView('tracks')}>
                  歌曲
                </button>
                <button aria-pressed={view === 'albums'} onClick={() => switchView('albums')}>
                  专辑
                </button>
              </div>
              {!albumGrid && (
                <button
                  className="primary"
                  disabled={loading || !!error || !page?.items.length}
                  onClick={() => page && player.start(page.items, 0)}
                >
                  <span aria-hidden="true">▶ </span>
                  {page && page.total > page.items.length
                    ? '播放本页'
                    : album
                      ? '播放专辑'
                      : '播放全部'}
                </button>
              )}
              {query && !album && (
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft('');
                    setQuery('');
                    setOffset(0);
                  }}
                >
                  清除搜索
                </button>
              )}
            </div>
            <button
              className="text-button"
              onClick={() => setRevision((value) => value + 1)}
              disabled={loading}
            >
              {loading ? '读取中…' : '刷新曲库 ↻'}
            </button>
          </div>
          {error ? (
            <div className="empty" role="alert">
              <h2>暂时无法读取曲库</h2>
              <p>{error}</p>
              <button onClick={() => setRevision((value) => value + 1)}>重新连接</button>
            </div>
          ) : loading ? (
            <div className="empty" role="status">
              正在读取你的音乐…
            </div>
          ) : !result?.items.length ? (
            <div className="empty">
              <span className="empty-symbol">≋</span>
              <h2>{query ? `没有找到匹配的${albumGrid ? '专辑' : '歌曲'}` : '曲库还很安静'}</h2>
              <p>
                {query
                  ? '试试其他标题、艺人或专辑关键词。'
                  : '把音乐目录挂载到服务端，运行 make docker-import，完成后刷新曲库。'}
              </p>
            </div>
          ) : (
            <>
              {albumGrid && albums ? (
                <div className="album-grid" aria-label="专辑列表">
                  {albums.items.map((item) => (
                    <button
                      className="album-card"
                      key={item.id}
                      aria-label={`打开专辑 ${item.title}`}
                      onClick={() => {
                        setAlbum(item);
                        setOffset(0);
                      }}
                    >
                      <Cover
                        key={`${item.id}-${revision}`}
                        trackId={item.cover_track_id}
                        title={item.title}
                        size={320}
                      />
                      <strong>{item.title}</strong>
                      <span>{item.artists.join(' / ') || '未知艺人'}</span>
                      <small>
                        {item.track_count} 首 · {time(item.duration_ms / 1000)}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                page && (
                  <TrackList page={page} player={player} onNotice={setNotice} revision={revision} />
                )
              )}
              <Pagination page={result} onOffset={setOffset} unit={unit} />
            </>
          )}
          <p className="library-note">托管副本播放 · 导入源保持只读</p>
        </main>
        {queueOpen && (
          <aside className="queue-panel" aria-label="播放队列">
            <div className="queue-heading">
              <div>
                <span className="eyebrow">UP NEXT</span>
                <h2>
                  播放队列 <small>{player.queue.length}</small>
                </h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setQueueOpen(false)}
                aria-label="关闭队列"
              >
                ×
              </button>
            </div>
            {player.queue.length ? (
              <ol>
                {player.queue.map((track, i) => (
                  <li key={`${track.id}-${i}`} className={i === player.index ? 'selected' : ''}>
                    <span>{i === player.index ? '♫' : i + 1}</span>
                    <button className="track-title" onClick={() => player.start(player.queue, i)}>
                      <strong>{track.title}</strong>
                      <small>{artist(track)}</small>
                    </button>
                    <button
                      className="icon-button"
                      disabled={i === player.index}
                      onClick={() => player.remove(i)}
                      aria-label={`移除队列第 ${i + 1} 首`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">点击歌曲旁的 ＋ 加入队列，或直接播放曲库。</p>
            )}
          </aside>
        )}
        <PlayerBar
          player={player}
          queueOpen={queueOpen}
          onQueue={toggleQueue}
          onLyrics={toggleLyrics}
          lyricsOpen={lyricsOpen}
        />
        {notice && (
          <p className="toast" role="status">
            {notice}
          </p>
        )}
      </div>
      {lyricsOpen && <NowPlaying player={player} onClose={closePlayer} />}
    </>
  );
}
