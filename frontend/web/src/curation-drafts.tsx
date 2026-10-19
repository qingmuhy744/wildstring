import type { AgentDraft } from './agent-api';
import { useState } from 'react';

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
const valueText = (value: unknown) =>
  Array.isArray(value) ? value.join(' / ') || '（空）' : value == null ? '（空）' : String(value);

export function CurationDraftPreview({
  draft,
  fields,
  onPreviewReady,
}: {
  draft: AgentDraft;
  fields: Record<string, string>;
  onPreviewReady: (ready: boolean) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (draft.kind === 'cover') {
    return (
      <div className="cover-draft-preview" key={`${draft.id}:${draft.version}`}>
        <p>
          歌曲：{String(draft.before?.title || '')} · 来源：{String(draft.before?.provider || '')}
        </p>
        <div className="cover-draft-images">
          {draft.before?.has_cover === true && (
            <figure>
              <img
                src={`/api/v1/tracks/${encodeURIComponent(String(draft.before.track_id))}/cover?size=320`}
                alt="当前封面"
              />
              <figcaption>当前封面（实时）</figcaption>
            </figure>
          )}
          <figure>
            <img
              src={`/api/v1/agent/drafts/${encodeURIComponent(draft.id)}/cover-preview?v=${draft.version}`}
              alt="草案封面快照"
              onLoad={() => {
                setFailed(false);
                onPreviewReady(true);
              }}
              onError={() => {
                setFailed(true);
                onPreviewReady(false);
              }}
            />
            <figcaption>将采用的封面</figcaption>
          </figure>
        </div>
        {failed && <p role="alert">封面快照暂时无法显示，请核对图片后再批准。</p>}
        <p className="muted">
          只采用此草案保存的图片，不修改歌曲标签。图片或歌曲版本变化时会拒绝应用。
        </p>
      </div>
    );
  }
  const items = (draft.payload.items || []) as BatchItem[];
  const before = new Map(
    ((draft.before?.items || []) as BeforeItem[]).map((item) => [item.track_id, item]),
  );
  return (
    <div className="batch-draft-preview">
      <p>{items.length} 首歌曲 · 整批应用，任一版本冲突时整批保留原值。</p>
      {items.map((item) => (
        <details key={item.track_id} open={items.length <= 20}>
          <summary>
            {before.get(item.track_id)?.title || item.track_id} · 信息版本 {item.metadata_version}
          </summary>
          <table className="workspace-diff">
            <thead>
              <tr>
                <th>字段</th>
                <th>当前信息</th>
                <th>建议值</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(item.overrides).map(([field, value]) => (
                <tr key={field}>
                  <th>{fields[field] || field}</th>
                  <td>{valueText(before.get(item.track_id)?.effective[field])}</td>
                  <td>{valueText(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
      <p className="muted">
        请核对专辑版本、曲序与署名。需要调整时可重新生成草案；确认仅保存到应用数据库。
      </p>
    </div>
  );
}
