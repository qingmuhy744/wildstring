import { useEffect, useRef, useState } from 'react';
import { CurationDraftPreview } from './curation-drafts';
import { api, errorCodeMessage, eventId, type User, type Track } from './api';
import type { AgentConnection, AgentDraft, AgentPage, AgentSchedule, AgentTask } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  StateBadge,
  useWorkspaceResource,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';

const fields: Record<string, string> = {
  title: '歌名',
  artists: '艺人',
  album: '专辑',
  album_artists: '专辑艺人',
  composers: '作曲',
  lyricists: '作词',
  arrangers: '编曲',
  vocalists: '演唱',
  genres: '风格',
  track_number: '曲号',
  disc_number: '碟号',
  release_date: '发行日期',
  artist_credit: '艺人署名',
  album_artist_credit: '专辑艺人署名',
};
const format = (v: unknown) =>
  Array.isArray(v) ? v.join(' / ') : v == null ? '（空）' : String(v);
const issues: Record<string, string> = {
  missing_album: '缺少专辑',
  missing_cover: '缺少封面',
  missing_lyrics: '未读到歌词（纯音乐可能正常）',
  missing_artist: '缺少艺人',
  missing_title: '缺少歌名',
  missing_track_number: '曲序待核对',
  track_number_conflict: '同碟曲序重复',
  track_number_out_of_range: '曲序超过总曲数',
  disc_number_out_of_range: '碟号超过总碟数',
  missing_disc_number: '多碟专辑缺少碟号',
  same_title_versions: '同名歌曲版本待核对',
  possible_duplicate_recording: '同名且时长接近，需核对音频',
  possible_multidisc_split: '多碟专辑可能被拆分',
  metadata_conflict: '信息可能冲突',
  object_version_changed: '歌曲信息已变化，本项已跳过',
};

function DraftDetail({
  draft,
  user,
  onUpdated,
  onApplied,
}: {
  draft: AgentDraft;
  user: User;
  onUpdated: (value: AgentDraft) => void;
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [coverReady, setCoverReady] = useState(false),
    [name, setName] = useState(draft.title),
    [values, setValues] = useState<Record<string, string>>({}),
    [tracks, setTracks] = useState<Track[]>([]);
  const original = useWorkspaceResource<{ effective: Record<string, unknown> }>(
    draft.kind === 'metadata' && user.role === 'admin'
      ? `/manage/tracks/${encodeURIComponent(String(draft.payload.track_id))}/metadata`
      : null,
  );
  const idempotency = useRef(eventId());
  useEffect(() => {
    setName(String(draft.payload.name || draft.title));
    setValues(
      Object.fromEntries(
        Object.entries((draft.payload.overrides || {}) as Record<string, unknown>).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join('\n') : v == null ? '' : String(v),
        ]),
      ),
    );
    setEditing(false);
    setCoverReady(false);
    setError('');
    idempotency.current = eventId();
  }, [draft.id, draft.version]);
  useEffect(() => {
    const controller = new AbortController();
    setTracks([]);
    if (draft.kind === 'playlist') {
      const ids = [
        ...new Set([
          ...(Array.isArray(draft.payload.track_ids) ? (draft.payload.track_ids as string[]) : []),
          ...(Array.isArray(draft.before?.track_ids) ? (draft.before.track_ids as string[]) : []),
        ]),
      ];
      void Promise.all(
        ids.map((id) =>
          api<Track>(`/tracks/${encodeURIComponent(id)}`, { signal: controller.signal }),
        ),
      )
        .then((items) => {
          if (!controller.signal.aborted) setTracks(items);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(errorText(reason));
        });
    }
    return () => controller.abort();
  }, [draft.id, draft.version]);
  async function action(kind: 'approve' | 'apply' | 'reject' | 'edit') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let payload = draft.payload;
      if (kind === 'edit') {
        if (draft.kind === 'playlist') payload = { ...payload, name };
        else
          payload = {
            ...payload,
            overrides: Object.fromEntries(
              Object.entries(values).map(([key, value]) => {
                const prior = (draft.payload.overrides as Record<string, unknown>)[key];
                return [
                  key,
                  Array.isArray(prior)
                    ? value
                        .split('\n')
                        .map((v) => v.trim())
                        .filter(Boolean)
                    : typeof prior === 'number'
                      ? Number(value)
                      : value || null,
                ];
              }),
            ),
          };
      }
      const result = await api<AgentDraft>(
        `/agent/drafts/${draft.id}${kind === 'edit' ? '' : `/${kind}`}`,
        {
          method: kind === 'edit' ? 'PATCH' : 'POST',
          body: JSON.stringify({
            version: draft.version,
            ...(kind === 'approve' && draft.preview_digest
              ? { preview_digest: draft.preview_digest }
              : {}),
            ...(kind === 'apply' ? { idempotency_key: idempotency.current } : {}),
            ...(kind === 'edit'
              ? { payload, title: draft.kind === 'playlist' ? name : draft.title }
              : {}),
          }),
        },
      );
      onUpdated(result);
      if (kind === 'apply') onApplied();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const permitted = draft.kind === 'playlist' || user.role === 'admin';
  return (
    <article className="workspace-card" aria-label="草案详情">
      <div className="workspace-card-head">
        <div>
          <h2>{draft.title}</h2>
          <small>
            {
              {
                playlist: '歌单草案',
                metadata: '歌曲信息草案',
                intake: '导入整理草案',
                lyrics: '歌词选用草案',
                cover: '封面选用草案',
                metadata_batch: '专辑批量修改草案',
              }[draft.kind]
            }{' '}
            · 版本 {draft.version} · {localDate(draft.updated_at)}
          </small>
        </div>
        <StateBadge state={draft.status} />
      </div>
      <WorkspaceNotice error={error} />
      <p className="muted">
        {draft.status === 'applied'
          ? '此版本已应用。'
          : draft.status === 'approved'
            ? '当前版本已批准，仍需点击应用才会修改。'
            : '核对具体内容和来源后再批准；批准不会自动应用。'}
      </p>
      {draft.kind === 'playlist' ? (
        <>
          <p>
            {String(draft.payload.name || draft.title)} ·{' '}
            {Array.isArray(draft.payload.track_ids) ? draft.payload.track_ids.length : 0} 首
          </p>
          {editing && (
            <label>
              草案歌单名称
              <input
                aria-label="草案歌单名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </label>
          )}
          {draft.before?.name != null && (
            <p className="muted">
              现有歌单：{String(draft.before.name)} ·{' '}
              {Array.isArray(draft.before.track_ids) ? draft.before.track_ids.length : 0} 首 →{' '}
              {String(draft.payload.name || draft.title)} ·{' '}
              {Array.isArray(draft.payload.track_ids) ? draft.payload.track_ids.length : 0} 首
            </p>
          )}
          {Array.isArray(draft.before?.track_ids) &&
            tracks.some(
              (track) =>
                (draft.before!.track_ids as string[]).includes(track.id) &&
                !(draft.payload.track_ids as string[]).includes(track.id),
            ) && (
              <details open>
                <summary>将移出的歌曲</summary>
                <ul>
                  {tracks
                    .filter(
                      (track) =>
                        (draft.before!.track_ids as string[]).includes(track.id) &&
                        !(draft.payload.track_ids as string[]).includes(track.id),
                    )
                    .map((track) => (
                      <li key={track.id}>
                        {track.title} · {track.artists.join(' / ')}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          <ol className="draft-track-list">
            {tracks
              .filter((track) => ((draft.payload.track_ids as string[]) || []).includes(track.id))
              .map((track) => (
                <li key={track.id}>
                  <strong>{track.title}</strong>
                  <span>
                    {track.artists.join(' / ')} · {track.album || '未知专辑'}
                  </span>
                </li>
              ))}
          </ol>
        </>
      ) : draft.kind === 'cover' || draft.kind === 'metadata_batch' ? (
        <CurationDraftPreview
          key={`${draft.id}:${draft.version}`}
          draft={draft}
          fields={fields}
          onPreviewReady={setCoverReady}
        />
      ) : draft.kind === 'lyrics' ? (
        <div>
          <p>歌曲：{String(draft.before?.title || draft.before?.track_id || '')}</p>
          <p>
            来源：{String(draft.before?.provider || '')} · 偏移{' '}
            {Number(draft.payload.offset_ms || 0)} ms
          </p>
          <p>
            当前：{String((draft.before?.current_quality as { label?: string })?.label || '')} →
            候选：{String((draft.before?.candidate_quality as { label?: string })?.label || '')}
          </p>
          <p>匹配依据：{JSON.stringify(draft.before?.match)}</p>
          <div className="workspace-diff">
            <strong>当前歌词预览</strong>
            <pre>
              {((draft.before?.current_lines as { text: string }[]) || [])
                .map((line) => line.text)
                .join('\n')}
            </pre>
            <strong>候选歌词预览</strong>
            <pre>
              {((draft.before?.candidate_lines as { text: string; translation?: string }[]) || [])
                .map((line) => [line.text, line.translation].filter(Boolean).join(' / '))
                .join('\n')}
            </pre>
          </div>
          <p className="muted">
            请核对版本、时间轴和歌词内容。批准后应用此候选，保留原始格式和双语时间轴。
          </p>
        </div>
      ) : (
        <table className="workspace-diff">
          <thead>
            <tr>
              <th>字段</th>
              <th>当前信息</th>
              <th>建议值</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries((draft.payload.overrides || {}) as Record<string, unknown>).map(
              ([key, value]) => (
                <tr key={key}>
                  <th>{fields[key] || key}</th>
                  <td>
                    {draft.before
                      ? format(draft.before[key])
                      : original.value
                        ? format(original.value.effective[key])
                        : '读取当前信息中…'}
                  </td>
                  <td>
                    {editing ? (
                      <textarea
                        aria-label={`草案 ${fields[key] || key}`}
                        value={values[key] || ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      />
                    ) : (
                      format(value)
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {draft.kind === 'intake' && (
        <p className="muted">
          来源：{String(draft.before?.source_path || '')}
          。应用后安排复制到托管曲库，导入源保持不变。
        </p>
      )}
      <h3>来源与依据</h3>
      {draft.evidence.length ? (
        <ul className="draft-evidence">
          {draft.evidence.map((item, index) => (
            <li key={index}>
              <strong>{item.source}</strong>
              <p>{item.summary}</p>
              {item.url && /^https?:\/\//.test(item.url) && (
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  查看来源 ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">未附外部来源，请根据曲库信息核对。</p>
      )}
      <DiagnosticId id={draft.trace_id} />
      {draft.status !== 'applied' && draft.status !== 'rejected' && (
        <div className="workspace-actions">
          {editing ? (
            <>
              <button className="primary" disabled={busy} onClick={() => void action('edit')}>
                保存并重新确认
              </button>
              <button disabled={busy} onClick={() => setEditing(false)}>
                取消修改
              </button>
            </>
          ) : (
            <>
              <button
                disabled={
                  busy || !permitted || ['lyrics', 'cover', 'metadata_batch'].includes(draft.kind)
                }
                onClick={() => setEditing(true)}
              >
                修改草案
              </button>
              {draft.status === 'pending' && (
                <button
                  className="primary"
                  disabled={busy || !permitted || (draft.kind === 'cover' && !coverReady)}
                  onClick={() => void action('approve')}
                >
                  批准当前版本
                </button>
              )}
              {draft.status === 'approved' && (
                <button
                  className="primary"
                  disabled={busy || !permitted || (draft.kind === 'cover' && !coverReady)}
                  onClick={() => void action('apply')}
                >
                  {busy ? '应用中…' : '应用已批准草案'}
                </button>
              )}
              <button disabled={busy} onClick={() => void action('reject')}>
                拒绝草案
              </button>
            </>
          )}
        </div>
      )}
      {!permitted && <p className="muted">共享歌曲信息的修改需要管理员。</p>}
      {draft.result && (
        <p role="status">
          应用结果：
          {draft.result.playlist_id
            ? '歌单已保存。'
            : draft.result.track_id
              ? '歌曲信息已更新。'
              : '结果已记录。'}
        </p>
      )}
    </article>
  );
}
export function Drafts({
  user,
  selectedId,
  onChanged,
}: {
  user: User;
  selectedId?: string;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState('pending'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<AgentDraft | null>(null),
    [error, setError] = useState('');
  const list = useWorkspaceResource<AgentPage<AgentDraft>>(
    `/agent/drafts?limit=20&offset=${offset}${filter ? `&status=${filter}` : ''}`,
  );
  useEffect(() => {
    if (!selectedId) return;
    const c = new AbortController();
    void api<AgentDraft>(`/agent/drafts/${encodeURIComponent(selectedId)}`, { signal: c.signal })
      .then(setSelected)
      .catch((reason) => {
        if (!c.signal.aborted) setError(errorText(reason));
      });
    return () => c.abort();
  }, [selectedId]);
  return (
    <section className="workspace-page" aria-label="草案工作台">
      <WorkspaceHeader
        eyebrow="REVIEW BEFORE CHANGE"
        title="好想法，先看一眼。"
        description="所有修改先成为草案。核对、批准、应用，各自留下记录。"
      >
        <RefreshWorkspace busy={list.loading} onClick={() => void list.reload()} />
      </WorkspaceHeader>
      <WorkspaceNotice error={error || list.error} unavailable={list.unsupported} />
      <div className="workspace-tabs">
        {[
          ['pending', '待确认'],
          ['approved', '待应用'],
          ['applied', '已应用'],
          ['rejected', '已拒绝'],
          ['', '全部'],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
              setOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <button className="text-button" onClick={() => setSelected(null)}>
            ← 返回草案列表
          </button>
          <DraftDetail
            key={selected.id}
            draft={selected}
            user={user}
            onUpdated={(value) => {
              setSelected(value);
              void list.reload();
            }}
            onApplied={onChanged}
          />
        </>
      )}
      {!selected && (
        <div className="workspace-card">
          {list.value?.items.map((draft) => (
            <div className="workspace-row" key={draft.id}>
              <div className="workspace-row-main">
                <strong>{draft.title}</strong>
                <small>
                  {
                    {
                      playlist: '歌单',
                      metadata: '歌曲信息',
                      intake: '导入整理',
                      lyrics: '歌词选用',
                      cover: '封面选用',
                      metadata_batch: '专辑批量修改',
                    }[draft.kind]
                  }{' '}
                  · {localDate(draft.updated_at)}
                </small>
              </div>
              <StateBadge state={draft.status} />
              <button aria-label={`查看草案 ${draft.title}`} onClick={() => setSelected(draft)}>
                查看差异
              </button>
            </div>
          ))}
          {!list.value?.items.length && !list.unsupported && (
            <p className="workspace-empty">
              {list.loading ? '正在读取草案…' : '这个分类下还没有草案。'}
            </p>
          )}
          <WorkspacePagination
            offset={offset}
            total={list.value?.total || 0}
            onOffset={setOffset}
          />
        </div>
      )}
    </section>
  );
}
export function WorkspacePagination({
  offset,
  total,
  onOffset,
}: {
  offset: number;
  total: number;
  onOffset: (n: number) => void;
}) {
  return total > 20 ? (
    <div className="workspace-inline">
      <button disabled={!offset} onClick={() => onOffset(Math.max(0, offset - 20))}>
        上一页
      </button>
      <span className="muted">
        {offset + 1}–{Math.min(offset + 20, total)} / {total}
      </span>
      <button disabled={offset + 20 >= total} onClick={() => onOffset(offset + 20)}>
        下一页
      </button>
    </div>
  ) : null;
}

export function AgentTasks({
  selectedId,
  onDraft,
}: {
  selectedId?: string;
  onDraft?: (id: string) => void;
}) {
  const [editingSchedule, setEditingSchedule] = useState<AgentSchedule | null>(null);
  const [tab, setTab] = useState('tasks'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(selectedId || null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [maxTracks, setMaxTracks] = useState(500),
    [useAI, setUseAI] = useState(false),
    [connection, setConnection] = useState(''),
    [maxCalls, setMaxCalls] = useState(4),
    [scheduleName, setScheduleName] = useState('每日曲库巡检'),
    [hours, setHours] = useState(24),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    );
  const tasks = useWorkspaceResource<AgentPage<AgentTask>>(
      `/agent/tasks?limit=20&offset=${offset}`,
      5000,
    ),
    schedules = useWorkspaceResource<AgentPage<AgentSchedule>>('/agent/schedules?limit=100'),
    connections = useWorkspaceResource<AgentPage<AgentConnection>>('/agent/connections'),
    detail = useWorkspaceResource<AgentTask>(
      selected ? `/agent/tasks/${encodeURIComponent(selected)}` : null,
      5000,
    );
  useEffect(() => setSelected(selectedId || null), [selectedId]);
  async function perform(path: string, method: string, body: unknown, message: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, { method, body: body ? JSON.stringify(body) : undefined });
      setNotice(message);
      await Promise.all([tasks.reload(), schedules.reload(), detail.reload()]);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const params = {
    max_tracks: maxTracks,
    max_calls: useAI ? maxCalls : 0,
    use_ai: useAI,
    ...(useAI ? { connection_id: connection } : {}),
  };
  const availableConnections = (connections.value?.items || []).filter(
    (c) => c.enabled && (tab === 'tasks' || c.background_allowed),
  );
  const selectedConnectionAvailable = availableConnections.some((c) => c.id === connection);
  const item = detail.value;
  const stageName = (stage: string, status: string) =>
    stage === 'completed' && status !== 'succeeded'
      ? '处理结束，未全部完成'
      : (
          {
            rules: '检查本地信息',
            model_call: '正在分析依据',
            analysis_complete: '分析完成',
            completed: '处理结束',
            queued: '等待开始',
            paused_authorization: '等待重新授权',
            paused_budget: '等待预算调整',
          } as Record<string, string>
        )[stage] || '检查中';
  return (
    <section className="workspace-page" aria-label="巡检与任务">
      <WorkspaceHeader
        eyebrow="KEEP YOUR COLLECTION IN TUNE"
        title="整理音乐，留住秩序。"
        description="巡检只检查和生成草案。任务在服务端继续，关闭网页后可回来查看。"
      >
        <RefreshWorkspace
          busy={tasks.loading}
          onClick={() => {
            void tasks.reload();
            void detail.reload();
            void schedules.reload();
          }}
        />
      </WorkspaceHeader>
      <WorkspaceNotice
        error={error || tasks.error || schedules.error || detail.error}
        notice={notice}
        unavailable={tasks.unsupported}
      />
      <div className="workspace-tabs">
        <button
          aria-pressed={tab === 'tasks'}
          onClick={() => {
            setTab('tasks');
            setEditingSchedule(null);
          }}
        >
          任务
        </button>
        <button aria-pressed={tab === 'schedules'} onClick={() => setTab('schedules')}>
          定时巡检
        </button>
      </div>
      {!tasks.unsupported && (
        <>
          <form
            id="inspection-form"
            className="workspace-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (useAI && !selectedConnectionAvailable) return;
              void perform(
                tab === 'tasks'
                  ? '/agent/tasks'
                  : editingSchedule
                    ? `/agent/schedules/${editingSchedule.id}`
                    : '/agent/schedules',
                tab === 'schedules' && editingSchedule ? 'PATCH' : 'POST',
                tab === 'tasks'
                  ? params
                  : {
                      name: scheduleName,
                      enabled: editingSchedule?.enabled || false,
                      interval_hours: hours,
                      timezone,
                      parameters: { ...(editingSchedule?.parameters || {}), ...params },
                      ...(editingSchedule ? { version: editingSchedule.version } : {}),
                    },
                tab === 'tasks'
                  ? '巡检已提交，可在任务中查看进度。'
                  : editingSchedule
                    ? '计划修改已保存。'
                    : '计划已保存，默认关闭；请确认后开启。',
              ).then((success) => {
                if (success) setEditingSchedule(null);
              });
            }}
          >
            <h2>
              {tab === 'tasks' ? '开始一次巡检' : editingSchedule ? '编辑巡检计划' : '添加巡检计划'}
            </h2>
            <div className="workspace-form">
              {tab === 'schedules' && (
                <>
                  <label>
                    计划名称
                    <input
                      required
                      maxLength={100}
                      value={scheduleName}
                      onChange={(e) => setScheduleName(e.target.value)}
                    />
                  </label>
                  <label>
                    每隔（小时）
                    <input
                      required
                      type="number"
                      min={1}
                      max={720}
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    时区
                    <input
                      required
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                    />
                  </label>
                </>
              )}
              <label>
                最多检查歌曲
                <input
                  aria-label="巡检歌曲上限"
                  required
                  type="number"
                  min={1}
                  max={5000}
                  value={maxTracks}
                  onChange={(e) => setMaxTracks(Number(e.target.value))}
                />
              </label>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={useAI}
                  onChange={(e) => setUseAI(e.target.checked)}
                />
                使用 AI 辅助巡检
              </label>
              {useAI && (
                <>
                  <label>
                    {tab === 'tasks' ? '本次巡检模型' : '定时巡检模型'}
                    <select
                      aria-label="巡检模型连接"
                      required
                      value={selectedConnectionAvailable ? connection : ''}
                      onChange={(e) => setConnection(e.target.value)}
                    >
                      <option value="">请选择 AI 连接</option>
                      {availableConnections.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name} · {c.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!selectedConnectionAvailable && !connections.loading && (
                    <p role="status">
                      {availableConnections.length
                        ? '请选择用于本次巡检的 AI 连接。'
                        : tab === 'tasks'
                          ? '没有可用的 AI 连接。请先在「AI 连接」添加并启用连接。'
                          : '没有可用于定时巡检的连接。请在「AI 连接」添加或编辑连接，开启「允许自动巡检使用」。'}
                    </p>
                  )}
                  <label>
                    模型调用上限
                    <input
                      required
                      type="number"
                      min={1}
                      max={100}
                      value={maxCalls}
                      onChange={(e) => setMaxCalls(Number(e.target.value))}
                    />
                  </label>
                </>
              )}
              <div className="span-all workspace-inline">
                <button
                  className="primary"
                  disabled={busy || (useAI && !selectedConnectionAvailable)}
                >
                  {busy
                    ? '正在提交…'
                    : tab === 'tasks'
                      ? useAI
                        ? '提交 AI 辅助巡检'
                        : '提交规则巡检'
                      : editingSchedule
                        ? '保存计划修改'
                        : '保存关闭的计划'}
                </button>
                {editingSchedule && (
                  <button type="button" disabled={busy} onClick={() => setEditingSchedule(null)}>
                    取消编辑
                  </button>
                )}
                <span className="muted">
                  {useAI
                    ? tab === 'tasks'
                      ? '提交仅授权本次 AI 巡检，可能产生模型费用，受调用上限与每日预算约束。结果先生成草案。'
                      : '定时巡检仅使用已授权自动使用的连接，受每日预算约束。结果先生成草案。'
                    : '本地规则不调用模型。'}
                </span>
              </div>
            </div>
          </form>
          {tab === 'tasks' ? (
            <>
              <div className="workspace-card">
                {tasks.value?.items.map((task) => (
                  <div className="workspace-row" key={task.id}>
                    <div className="workspace-row-main">
                      <strong>{task.parameters.use_ai ? 'AI 辅助巡检' : '曲库规则巡检'}</strong>
                      <small>
                        {localDate(task.created_at)} · {stageName(task.stage, task.status)}
                      </small>
                    </div>
                    <StateBadge state={task.status} />
                    <button onClick={() => setSelected(task.id)}>查看任务</button>
                  </div>
                ))}
                {!tasks.value?.items.length && <p className="workspace-empty">尚无巡检任务。</p>}
                <WorkspacePagination
                  total={tasks.value?.total || 0}
                  offset={offset}
                  onOffset={setOffset}
                />
              </div>
              {item && (
                <article className="workspace-card" aria-label="巡检任务详情">
                  <div className="workspace-card-head">
                    <div>
                      <h2>巡检结果</h2>
                      <small>
                        任务 {item.id} · {stageName(item.stage, item.status)}
                      </small>
                    </div>
                    <StateBadge state={item.status} />
                  </div>
                  <p>
                    {Object.entries(item.counts)
                      .map(
                        ([k, v]) =>
                          `${({ processed: '已检查', total: '总计', issues: '本地问题', failed: '曲目失败', drafts: '草案', skipped: '跳过', calls: '模型调用' } as Record<string, string>)[k] || k} ${v}`,
                      )
                      .join(' · ')}
                  </p>
                  {item.error_code && <p role="status">{errorCodeMessage(item.error_code)}</p>}
                  <DiagnosticId id={item.trace_id} />
                  <div className="workspace-actions">
                    {['queued', 'running', 'retry_wait'].includes(item.status) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            `/agent/tasks/${item.id}/cancel`,
                            'POST',
                            {},
                            '已请求停止；正在执行的步骤结束后确认。',
                          )
                        }
                      >
                        请求取消
                      </button>
                    )}
                    {[
                      'paused_authorization',
                      'paused_budget',
                      'failed',
                      'interrupted',
                      'partial',
                    ].includes(item.status) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            `/agent/tasks/${item.id}/resume`,
                            'POST',
                            {},
                            '已提交恢复，将从保存的位置继续。',
                          )
                        }
                      >
                        从进度恢复
                      </button>
                    )}
                  </div>
                  {item.results?.map((result, index) => (
                    <div className="workspace-row" key={result.track_id || `analysis-${index}`}>
                      <div className="workspace-row-main">
                        <strong>
                          {result.analysis
                            ? result.ai_skipped
                              ? '规则检查说明'
                              : 'AI 分析结果'
                            : result.title || '无法读取的歌曲'}
                        </strong>
                        {result.analysis ? (
                          <p>{result.analysis}</p>
                        ) : (
                          <small>
                            {result.error_code
                              ? '此项检查未完成，请查看诊断编号。'
                              : (result.issues || [])
                                  .map((issue) => issues[issue] || issue)
                                  .join(' · ') || '未发现规则问题'}
                          </small>
                        )}
                        {result.findings?.map((finding) => (
                          <p className="muted" key={finding.code}>
                            {finding.summary}
                          </p>
                        ))}
                        {result.draft_ids?.map((id) => (
                          <button key={id} onClick={() => onDraft?.(id)}>
                            查看待确认草案
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </article>
              )}
            </>
          ) : (
            <div className="workspace-card">
              {schedules.value?.items.map((schedule) => (
                <div className="workspace-row" key={schedule.id}>
                  <div className="workspace-row-main">
                    <strong>{schedule.name}</strong>
                    <small>
                      每 {schedule.interval_hours} 小时 · {schedule.timezone} · 下次{' '}
                      {localDate(schedule.next_run_at)}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditingSchedule(schedule);
                      setScheduleName(schedule.name);
                      setHours(schedule.interval_hours);
                      setTimezone(schedule.timezone);
                      setMaxTracks(Number(schedule.parameters.max_tracks) || 500);
                      setUseAI(Boolean(schedule.parameters.use_ai));
                      setMaxCalls(Number(schedule.parameters.max_calls) || 4);
                      setConnection(String(schedule.parameters.connection_id || ''));
                      document
                        .getElementById('inspection-form')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    编辑计划
                  </button>
                  <button
                    disabled={busy}
                    aria-pressed={schedule.enabled}
                    onClick={() =>
                      void perform(
                        `/agent/schedules/${schedule.id}`,
                        'PATCH',
                        {
                          name: schedule.name,
                          interval_hours: schedule.interval_hours,
                          timezone: schedule.timezone,
                          parameters: schedule.parameters,
                          version: schedule.version,
                          enabled: !schedule.enabled,
                        },
                        schedule.enabled ? '计划已关闭。' : '计划已开启。',
                      )
                    }
                  >
                    {schedule.enabled ? '关闭计划' : '开启计划'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`删除计划“${schedule.name}”？历史任务会保留。`))
                        void perform(
                          `/agent/schedules/${schedule.id}`,
                          'DELETE',
                          null,
                          '计划已删除。',
                        );
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
              {!schedules.value?.items.length && (
                <p className="workspace-empty">尚无定时巡检，计划添加后默认关闭。</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
