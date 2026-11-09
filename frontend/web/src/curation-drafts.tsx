import type { AgentDraft } from './agent-api';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface BatchItem {
  track_id: string;
  metadata_version: number;
  overrides: Record<string, unknown>;
}
interface BeforeItem {
  track_id: string;
  title: string;
  effective: Record<string, unknown>;
}
const valueText = (value: unknown, empty = '') =>
  Array.isArray(value) ? value.join(' / ') || empty : value == null ? empty : String(value);

export function CurationDraftPreview({
  draft,
  fields,
  onPreviewReady,
}: {
  draft: AgentDraft;
  fields: Record<string, string>;
  onPreviewReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (draft.kind === 'cover') {
    return (
      <div className="cover-draft-preview" key={`${draft.id}:${draft.version}`}>
        <p>
          {t('curationDrafts.trackInfo', {
            title: String(draft.before?.title || ''),
            provider: String(draft.before?.provider || ''),
          })}
        </p>
        <div className="cover-draft-images">
          {draft.before?.has_cover === true && (
            <figure>
              <img
                src={`/api/v1/tracks/${encodeURIComponent(String(draft.before.track_id))}/cover?size=320`}
                alt={t('curationDrafts.currentCoverAlt')}
              />
              <figcaption>{t('curationDrafts.currentCoverRealtime')}</figcaption>
            </figure>
          )}
          <figure>
            <img
              src={`/api/v1/agent/drafts/${encodeURIComponent(draft.id)}/cover-preview?v=${draft.version}`}
              alt={t('curationDrafts.draftCoverAlt')}
              onLoad={() => {
                setFailed(false);
                onPreviewReady(true);
              }}
              onError={() => {
                setFailed(true);
                onPreviewReady(false);
              }}
            />
            <figcaption>{t('curationDrafts.targetCover')}</figcaption>
          </figure>
        </div>
        {failed && <p role="alert">{t('curationDrafts.coverLoadFailed')}</p>}
        <p className="muted">{t('curationDrafts.coverNote')}</p>
      </div>
    );
  }
  const items = (draft.payload.items || []) as BatchItem[];
  const before = new Map(
    ((draft.before?.items || []) as BeforeItem[]).map((item) => [item.track_id, item]),
  );
  return (
    <div className="batch-draft-preview">
      {typeof draft.payload.cover_draft_id === 'string' && (
        <CurationDraftPreview
          draft={{
            ...draft,
            id: draft.payload.cover_draft_id,
            kind: 'cover',
            payload: draft.payload.cover_snapshot as Record<string, unknown>,
            before: draft.before?.cover as Record<string, unknown>,
          }}
          fields={fields}
          onPreviewReady={onPreviewReady}
        />
      )}
      <p>{t('curationDrafts.batchSummary', { count: items.length })}</p>
      {items.map((item) => (
        <details key={item.track_id} open={items.length <= 20}>
          <summary>
            {t('curationDrafts.itemSummary', {
              title: before.get(item.track_id)?.title || item.track_id,
              version: item.metadata_version,
            })}
          </summary>
          <table className="workspace-diff">
            <thead>
              <tr>
                <th>{t('curationDrafts.field')}</th>
                <th>{t('curationDrafts.currentInfo')}</th>
                <th>{t('curationDrafts.suggestedValue')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(item.overrides).map(([field, value]) => (
                <tr key={field}>
                  <th>{fields[field] || field}</th>
                  <td>
                    {valueText(
                      before.get(item.track_id)?.effective[field],
                      t('curationDrafts.emptyValue'),
                    )}
                  </td>
                  <td>{valueText(value, t('curationDrafts.emptyValue'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
      <p className="muted">{t('curationDrafts.batchNote')}</p>
    </div>
  );
}
