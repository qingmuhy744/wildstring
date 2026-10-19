import { expect, test } from '@playwright/test';
import { login, section } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };

test('真实批量草案逐曲展示差异，接受一次保存整批', async ({ page }, info) => {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const originals = await Promise.all(
    tracks
      .slice(0, 2)
      .map(async (track: { id: string }) =>
        (await page.request.get(`/api/v1/manage/tracks/${track.id}/metadata`)).json(),
      ),
  );
  const response = await page.request.post('/api/v1/agent/drafts', {
    headers,
    data: {
      kind: 'metadata_batch',
      title: '专辑逐曲核对',
      payload: {
        items: originals.map((record) => ({
          track_id: record.track_id,
          metadata_version: record.version,
          overrides: { composers: ['合成核对作曲者'] },
        })),
      },
    },
  });
  expect(response.ok()).toBe(true);
  const draft = await response.json();
  expect(draft.before.items).toHaveLength(2);
  try {
    await section(page, '待确认草案');
    await page.getByRole('button', { name: '查看草案 专辑逐曲核对', exact: true }).click();
    const detail = page.getByRole('article', { name: '草案详情' });
    await expect(detail).toContainText('2 首歌曲 · 整批应用');
    for (const original of originals) await expect(detail).toContainText(original.effective.title);
    await expect(detail.getByRole('table')).toHaveCount(2);
    await page.screenshot({
      path: `../../artifacts/mcp-batch-${info.project.name}.png`,
      fullPage: true,
    });
    await detail.getByRole('button', { name: '接受并应用', exact: true }).click();
    await expect(detail).toContainText('此版本已应用');
    for (const original of originals) {
      const current = await (
        await page.request.get(`/api/v1/manage/tracks/${original.track_id}/metadata`)
      ).json();
      expect(current.effective.composers).toEqual(['合成核对作曲者']);
    }
  } finally {
    for (const original of originals) {
      const endpoint = `/api/v1/manage/tracks/${original.track_id}/metadata`;
      const current = await (await page.request.get(endpoint)).json();
      const restored = await page.request.put(endpoint, {
        headers,
        data: { version: current.version, overrides: original.overrides },
      });
      expect(restored.ok()).toBe(true);
    }
  }
});

test('封面草案展示快照，图片失败不能批准，恢复后可批准', async ({ page }, info) => {
  const draft = {
    id: 'fixed-cover',
    kind: 'cover',
    title: '封面核对',
    payload: { suggestion_id: 'candidate', image_sha256: 'a'.repeat(64) },
    before: { title: '合成摇滚曲', provider: '合成来源', has_cover: false },
    evidence: [],
    status: 'pending',
    version: 1,
    updated_at: '2026-10-19T08:00:00Z',
  };
  let validImage = false,
    approvals = 0;
  await page.route('**/api/v1/agent/drafts?*', (route) =>
    route.fulfill({ json: { items: [draft], total: 1, limit: 100, offset: 0 } }),
  );
  await page.route('**/api/v1/agent/drafts/fixed-cover/accept', (route) => {
    approvals++;
    draft.status = 'applied';
    return route.fulfill({ json: draft });
  });
  await page.route('**/api/v1/agent/drafts/fixed-cover/cover-preview?*', (route) =>
    validImage
      ? route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ab4427"/></svg>',
        })
      : route.fulfill({ status: 409, json: { detail: 'cover_snapshot_unavailable' } }),
  );
  await login(page);
  await section(page, '待确认草案');
  await page.getByRole('button', { name: '查看草案 封面核对', exact: true }).click();
  const detail = page.getByRole('article', { name: '草案详情' });
  await expect(detail.getByRole('alert')).toContainText('无法显示');
  await expect(detail.getByRole('button', { name: '接受并应用', exact: true })).toBeDisabled();
  expect(approvals).toBe(0);
  validImage = true;
  await page.reload();
  await section(page, '待确认草案');
  await page.getByRole('button', { name: '查看草案 封面核对', exact: true }).click();
  await expect(detail.getByRole('img', { name: '草案封面快照' })).toBeVisible();
  await expect(detail.getByRole('button', { name: '接受并应用', exact: true })).toBeEnabled();
  await detail.getByRole('img', { name: '草案封面快照' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `../../artifacts/mcp-cover-${info.project.name}.png`,
  });
  await detail.getByRole('button', { name: '接受并应用', exact: true }).click();
  await expect(detail).toContainText('此版本已应用');
  expect(approvals).toBe(1);
});
