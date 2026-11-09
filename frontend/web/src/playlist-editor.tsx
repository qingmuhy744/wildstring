import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Playlist, type SmartDefinition } from './api';
import { DialogCloseButton } from './dialog-close';
import { useTranslation } from 'react-i18next';

type Row = { field: string; operator: string; value: string; end: string };
const fields: Record<string, { label: string; type: 'text' | 'number' | 'boolean' | 'date' }> = {
  title: { label: 'playlistEditor.fieldTitle', type: 'text' },
  artist: { label: 'playlistEditor.fieldArtist', type: 'text' },
  albumartist: { label: 'playlistEditor.fieldAlbumArtist', type: 'text' },
  album: { label: 'playlistEditor.fieldAlbum', type: 'text' },
  filetype: { label: 'playlistEditor.fieldFormat', type: 'text' },
  duration: { label: 'playlistEditor.fieldDuration', type: 'number' },
  loved: { label: 'playlistEditor.fieldLoved', type: 'boolean' },
  playCount: { label: 'playlistEditor.fieldPlayCount', type: 'number' },
  listened: { label: 'playlistEditor.fieldListened', type: 'number' },
  lastPlayed: { label: 'playlistEditor.fieldLastPlayed', type: 'date' },
  dateAdded: { label: 'playlistEditor.fieldDateAdded', type: 'date' },
  dateLoved: { label: 'playlistEditor.fieldDateLoved', type: 'date' },
};
const operators: Record<string, string> = {
  is: 'playlistEditor.opIs',
  isNot: 'playlistEditor.opIsNot',
  contains: 'playlistEditor.opContains',
  notContains: 'playlistEditor.opNotContains',
  startsWith: 'playlistEditor.opStartsWith',
  endsWith: 'playlistEditor.opEndsWith',
  gt: 'playlistEditor.opGt',
  lt: 'playlistEditor.opLt',
  inTheRange: 'playlistEditor.opInRange',
  inTheLast: 'playlistEditor.opInTheLast',
  notInTheLast: 'playlistEditor.opNotInTheLast',
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
  const { t } = useTranslation();
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
          ? t('playlistEditor.jsonInvalid')
          : reason instanceof ApiError && reason.status === 422
            ? t('playlistEditor.rulesInvalid')
            : reason instanceof ApiError
              ? reason.message
              : t('playlistEditor.saveFailed'),
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
      aria-label={initial ? t('playlistEditor.editTitle') : t('playlistEditor.newTitle')}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form onSubmit={(event) => void save(event)}>
        <div className="editor-heading">
          <div>
            <span className="eyebrow">{t('playlistEditor.eyebrow')}</span>
            <h2>{initial ? t('playlistEditor.editTitle') : t('playlistEditor.createTagline')}</h2>
          </div>
          <DialogCloseButton
            onClick={onClose}
            disabled={saving}
            aria-label={t('playlistEditor.closeAria')}
          />
        </div>
        <label>
          {t('playlistEditor.nameLabel')}
          <input
            autoFocus
            required
            maxLength={100}
            aria-label={t('playlistEditor.nameAria')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t('playlistEditor.kindLabel')}
          <select
            aria-label={t('playlistEditor.kindAria')}
            value={kind}
            disabled={!!initial}
            onChange={(event) => setKind(event.target.value as 'manual' | 'smart')}
          >
            <option value="manual">{t('playlistEditor.kindManualOption')}</option>
            <option value="smart">{t('playlistEditor.kindSmartOption')}</option>
          </select>
        </label>
        {kind === 'smart' && (
          <fieldset className="smart-builder">
            <legend>{t('playlistEditor.rulesLegend')}</legend>
            {!advanced ? (
              <>
                <select
                  aria-label={t('playlistEditor.matchAria')}
                  value={match}
                  onChange={(event) => setMatch(event.target.value as 'all' | 'any')}
                >
                  <option value="all">{t('playlistEditor.matchAll')}</option>
                  <option value="any">{t('playlistEditor.matchAny')}</option>
                </select>
                {rows.map((row, index) => (
                  <div className="rule-row" key={index}>
                    <select
                      aria-label={t('playlistEditor.ruleFieldAria', { index: index + 1 })}
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
                          {t(field.label)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t('playlistEditor.ruleOperatorAria', { index: index + 1 })}
                      value={row.operator}
                      onChange={(event) => update(index, { operator: event.target.value })}
                    >
                      {choices(row.field).map((operator) => (
                        <option key={operator} value={operator}>
                          {t(operators[operator])}
                        </option>
                      ))}
                    </select>
                    {fields[row.field].type === 'boolean' ? (
                      <select
                        aria-label={t('playlistEditor.ruleValueAria', { index: index + 1 })}
                        value={row.value}
                        onChange={(event) => update(index, { value: event.target.value })}
                      >
                        <option value="true">{t('playlistEditor.lovedTrue')}</option>
                        <option value="false">{t('playlistEditor.lovedFalse')}</option>
                      </select>
                    ) : (
                      <input
                        aria-label={t('playlistEditor.ruleValueAria', { index: index + 1 })}
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
                        aria-label={t('playlistEditor.ruleEndAria', { index: index + 1 })}
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
                      aria-label={t('playlistEditor.ruleDeleteAria', { index: index + 1 })}
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
                  {t('playlistEditor.addRule')}
                </button>
                <div className="rule-sort">
                  <label>
                    {t('playlistEditor.sortLabel')}
                    <select
                      aria-label={t('playlistEditor.sortAria')}
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
                          {t(fields[field].label)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('playlistEditor.orderLabel')}
                    <select
                      aria-label={t('playlistEditor.orderAria')}
                      value={order}
                      onChange={(event) => setOrder(event.target.value as 'asc' | 'desc')}
                    >
                      <option value="asc">{t('playlistEditor.orderAsc')}</option>
                      <option value="desc">{t('playlistEditor.orderDesc')}</option>
                    </select>
                  </label>
                  <label>
                    {t('playlistEditor.limitLabel')}
                    <input
                      type="number"
                      aria-label={t('playlistEditor.limitAria')}
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
                  {t('playlistEditor.advancedButton')}
                </button>
              </>
            ) : (
              <>
                <label>
                  {t('playlistEditor.advancedLabel')}
                  <textarea
                    aria-label={t('playlistEditor.advancedAria')}
                    value={json}
                    onChange={(event) => setJson(event.target.value)}
                    rows={12}
                    maxLength={30000}
                    spellCheck={false}
                  />
                </label>
                <p className="muted">{t('playlistEditor.advancedHint')}</p>
              </>
            )}
            <p className="muted">{t('playlistEditor.smartHint')}</p>
          </fieldset>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="editor-footer">
          <button type="button" onClick={onClose} disabled={saving}>
            {t('playlistEditor.cancel')}
          </button>
          <button className="primary" disabled={saving || !name.trim()}>
            {saving ? t('playlistEditor.saving') : t('playlistEditor.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
