import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Playlist, type SmartDefinition } from './api';

type Row = { field: string; operator: string; value: string; end: string };
const fields: Record<string, { label: string; type: 'text' | 'number' | 'boolean' | 'date' }> = {
  title: { label: '歌名', type: 'text' },
  artist: { label: '歌曲艺人', type: 'text' },
  albumartist: { label: '专辑艺人', type: 'text' },
  album: { label: '专辑', type: 'text' },
  filetype: { label: '格式', type: 'text' },
  duration: { label: '歌曲时长（秒）', type: 'number' },
  loved: { label: '喜欢', type: 'boolean' },
  playCount: { label: '播放次数', type: 'number' },
  listened: { label: '累计收听（秒）', type: 'number' },
  lastPlayed: { label: '最近播放', type: 'date' },
  dateAdded: { label: '加入曲库', type: 'date' },
  dateLoved: { label: '收藏时间', type: 'date' },
};
const operators: Record<string, string> = {
  is: '是',
  isNot: '不是',
  contains: '包含',
  notContains: '不包含',
  startsWith: '开头是',
  endsWith: '结尾是',
  gt: '大于',
  lt: '小于',
  inTheRange: '介于',
  inTheLast: '最近几天内',
  notInTheLast: '最近几天未发生',
};
function choices(field: string) {
  switch (fields[field]?.type) {
    case 'boolean':
      return ['is'];
    case 'number':
      return ['gt', 'lt', 'is', 'inTheRange'];
    case 'date':
      return ['inTheLast', 'notInTheLast'];
    default:
      return ['contains', 'is', 'isNot', 'notContains', 'startsWith', 'endsWith'];
  }
}
function rowsFrom(definition: SmartDefinition | null): Row[] | null {
  if (!definition) return [{ field: 'artist', operator: 'contains', value: '', end: '' }];
  const rules = definition.all || definition.any || [];
  const rows: Row[] = [];
  for (const rule of rules) {
    const [operator, payload] = Object.entries(rule)[0] || [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const [field, value] = Object.entries(payload)[0] || [];
    if (!fields[field] || !choices(field).includes(operator)) return null;
    rows.push({
      field,
      operator,
      value: String(Array.isArray(value) ? value[0] : value),
      end: Array.isArray(value) ? String(value[1]) : '',
    });
  }
  return rows;
}
export function PlaylistEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Playlist | null;
  onClose: () => void;
  onSaved: (playlist: Playlist) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState<'manual' | 'smart'>(
    initial?.kind === 'smart' ? 'smart' : 'manual',
  );
  const [rows, setRows] = useState<Row[]>(rowsFrom(initial?.definition || null) || []);
  const [match, setMatch] = useState<'all' | 'any'>(initial?.definition?.any ? 'any' : 'all');
  const [sort, setSort] = useState(initial?.definition?.sort || 'title');
  const [order, setOrder] = useState<'asc' | 'desc'>(initial?.definition?.order || 'asc');
  const [limit, setLimit] = useState(initial?.definition?.limit || 200);
  const [advanced, setAdvanced] = useState(rowsFrom(initial?.definition || null) === null);
  const [json, setJson] = useState(
    JSON.stringify(
      initial?.definition || {
        all: [{ is: { loved: true } }],
        sort: 'playCount',
        order: 'desc',
        limit: 200,
      },
      null,
      2,
    ),
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function definition(): SmartDefinition {
    if (advanced) return JSON.parse(json);
    return {
      [match]: rows.map((row) => {
        const type = fields[row.field].type;
        const value =
          type === 'boolean'
            ? row.value === 'true'
            : type === 'number' || type === 'date'
              ? Number(row.value)
              : row.value;
        return {
          [row.operator]: {
            [row.field]: row.operator === 'inTheRange' ? [value, Number(row.end)] : value,
          },
        };
      }),
      sort,
      order,
      limit,
    };
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = {
        name,
        kind,
        definition: kind === 'smart' ? definition() : null,
        ...(initial ? { version: initial.version } : {}),
      };
      const list = await api<Playlist>(initial ? `/playlists/${initial.id}` : '/playlists', {
        method: initial ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      await onSaved(list);
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? '规则 JSON 格式有误。'
          : reason instanceof ApiError && reason.status === 422
            ? '请检查规则字段、条件和数值。'
            : reason instanceof ApiError
              ? reason.message
              : '歌单未保存，请重试。',
      );
    } finally {
      setSaving(false);
    }
  }
  function update(index: number, change: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
  }
  return (
    <dialog
      ref={dialog}
      className="playlist-editor"
      aria-label={initial ? '编辑歌单' : '新建歌单'}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form onSubmit={(event) => void save(event)}>
        <div className="editor-heading">
          <div>
            <span className="eyebrow">YOUR OWN MIX</span>
            <h2>{initial ? '编辑歌单' : '留住喜欢的声音。'}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭歌单编辑"
          >
            ×
          </button>
        </div>
        <label>
          歌单名称
          <input
            autoFocus
            required
            maxLength={100}
            aria-label="歌单名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          歌单类型
          <select
            aria-label="歌单类型"
            value={kind}
            disabled={!!initial}
            onChange={(event) => setKind(event.target.value as 'manual' | 'smart')}
          >
            <option value="manual">普通歌单 · 自己挑选</option>
            <option value="smart">规则歌单 · 自动筛选</option>
          </select>
        </label>
        {kind === 'smart' && (
          <fieldset className="smart-builder">
            <legend>挑歌规则</legend>
            {!advanced ? (
              <>
                <select
                  aria-label="条件匹配方式"
                  value={match}
                  onChange={(event) => setMatch(event.target.value as 'all' | 'any')}
                >
                  <option value="all">满足以下全部条件</option>
                  <option value="any">满足以下任一条件</option>
                </select>
                {rows.map((row, index) => (
                  <div className="rule-row" key={index}>
                    <select
                      aria-label={`条件 ${index + 1} 字段`}
                      value={row.field}
                      onChange={(event) =>
                        update(index, {
                          field: event.target.value,
                          operator: choices(event.target.value)[0],
                          value: fields[event.target.value].type === 'boolean' ? 'true' : '',
                          end: '',
                        })
                      }
                    >
                      {Object.entries(fields).map(([key, field]) => (
                        <option key={key} value={key}>
                          {field.label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`条件 ${index + 1} 运算`}
                      value={row.operator}
                      onChange={(event) => update(index, { operator: event.target.value })}
                    >
                      {choices(row.field).map((operator) => (
                        <option key={operator} value={operator}>
                          {operators[operator]}
                        </option>
                      ))}
                    </select>
                    {fields[row.field].type === 'boolean' ? (
                      <select
                        aria-label={`条件 ${index + 1} 值`}
                        value={row.value}
                        onChange={(event) => update(index, { value: event.target.value })}
                      >
                        <option value="true">已喜欢</option>
                        <option value="false">未喜欢</option>
                      </select>
                    ) : (
                      <input
                        aria-label={`条件 ${index + 1} 值`}
                        type={fields[row.field].type === 'text' ? 'text' : 'number'}
                        step={fields[row.field].type === 'date' ? '1' : 'any'}
                        min={fields[row.field].type === 'date' ? '1' : undefined}
                        maxLength={256}
                        required
                        value={row.value}
                        onChange={(event) => update(index, { value: event.target.value })}
                        placeholder={row.field === 'filetype' ? 'flac / mp3 / m4a' : undefined}
                      />
                    )}
                    {row.operator === 'inTheRange' && (
                      <input
                        aria-label={`条件 ${index + 1} 上限`}
                        required
                        type="number"
                        value={row.end}
                        onChange={(event) => update(index, { end: event.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      disabled={rows.length <= 1}
                      aria-label={`删除条件 ${index + 1}`}
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={rows.length >= 30}
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      { field: 'title', operator: 'contains', value: '', end: '' },
                    ])
                  }
                >
                  ＋ 添加条件
                </button>
                <div className="rule-sort">
                  <label>
                    排序
                    <select
                      aria-label="规则排序"
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      {[
                        'title',
                        'artist',
                        'album',
                        'duration',
                        'playCount',
                        'listened',
                        'lastPlayed',
                        'dateAdded',
                        'dateLoved',
                      ].map((field) => (
                        <option key={field} value={field}>
                          {fields[field].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    顺序
                    <select
                      aria-label="排序方向"
                      value={order}
                      onChange={(event) => setOrder(event.target.value as 'asc' | 'desc')}
                    >
                      <option value="asc">升序</option>
                      <option value="desc">降序</option>
                    </select>
                  </label>
                  <label>
                    最多首数
                    <input
                      type="number"
                      aria-label="最多首数"
                      min={1}
                      max={5000}
                      value={limit}
                      required
                      onChange={(event) => setLimit(Number(event.target.value))}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setJson(JSON.stringify(definition(), null, 2));
                    setAdvanced(true);
                  }}
                >
                  高级规则 JSON
                </button>
              </>
            ) : (
              <>
                <label>
                  高级规则 JSON
                  <textarea
                    aria-label="高级规则 JSON"
                    value={json}
                    onChange={(event) => setJson(event.target.value)}
                    rows={12}
                    maxLength={30000}
                    spellCheck={false}
                  />
                </label>
                <p className="muted">支持嵌套 all / any；时长单位为秒，日期条件单位为天。</p>
              </>
            )}
            <p className="muted">歌曲按条件自动更新，收藏与收听记录也可参与筛选。</p>
          </fieldset>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-footer">
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="primary" disabled={saving || !name.trim()}>
            {saving ? '保存中…' : '保存歌单'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
