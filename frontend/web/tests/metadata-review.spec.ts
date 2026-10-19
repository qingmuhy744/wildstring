import { test, expect, type Page } from '@playwright/test';
import { login, section } from './helpers';

async function fixture(page: Page) {
  let version = 1;
  let coverLoaded: (() => void) | undefined;
  const submissions: Record<string, unknown>[] = [];
  let failOnce = false;
  const rows = () =>
    [0, 1].map((i) => ({
      id: `review-${i}`,
      title: `摇滚测试 ${i + 1}`,
      artists: ['测试乐队'],
      album: '现场录音',
      album_id: 'review-album',
      has_cover: false,
      metadata_version: version,
      current: { title: `摇滚测试 ${i + 1}`, genres: [], composers: ['人工作者'] },
      original: { title: `摇滚测试 ${i + 1}`, genres: [], composers: ['原作者'] },
      overrides: { composers: ['人工作者'] },
      suggestions:
        version === 1
          ? [
              {
                id: `candidate-${i}`,
                metadata_version: 1,
                provider: 'musicbrainz',
                source_url: 'https://musicbrainz.org/',
                fields: { genres: ['Rock'], composers: ['建议作者'] },
                candidate_digest: 'a'.repeat(64),
                match: { score: 98 },
                cover_url: 'https://coverartarchive.org/test.jpg',
              },
              {
                id: `stale-${i}`,
                metadata_version: 0,
                provider: 'lastfm',
                source_url: null,
                fields: { genres: ['Old'] },
                candidate_digest: 'b'.repeat(64),
                match: {},
                cover_url: null,
              },
            ]
          : [],
    }));
  await page.route('**/api/v1/agent/metadata-review**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/albums'))
      return route.fulfill({
        json: {
          items: [{ id: 'review-album', title: '现场录音', artists: ['测试乐队'], count: 2 }],
          total: 1,
        },
      });
    if (path.endsWith('/cover'))
      return route.fulfill({
        json: {
          id: 'review-cover',
          kind: 'cover',
          version: 1,
          status: 'pending',
          payload: { targets: rows().map((t) => ({ track_id: t.id, metadata_version: 1 })) },
          preview_digest: 'fixed-preview',
        },
      });
    if (path.endsWith('/accept')) {
      submissions.push(route.request().postDataJSON());
      if (failOnce) {
        failOnce = false;
        return route.abort('failed');
      }
      version++;
      return route.fulfill({
        json: { status: 'applied', draft: { id: 'receipt', status: 'applied' } },
      });
    }
    return route.fulfill({
      json: {
        items: rows(),
        total: 2,
        limit: 500,
        offset: 0,
        album_id: 'review-album',
        provider_names: { musicbrainz: 'MusicBrainz', lastfm: 'Last.fm' },
      },
    });
  });
  await page.route('**/api/v1/agent/drafts/review-cover/cover-preview?*', async (route) => {
    await new Promise<void>((resolve) => {
      coverLoaded = resolve;
    });
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await login(page);
  await section(page, '管理');
  await page.getByRole('button', { name: '批量核对资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量核对资料', exact: true });
  await expect(dialog.getByRole('heading', { name: '摇滚测试 1', exact: true })).toBeVisible();
  return {
    dialog,
    submissions,
    failNext: () => {
      failOnce = true;
    },
    releaseCover: () => coverLoaded?.(),
  };
}

test('专辑并排核对默认保留人工值，失败重试复用同一凭据，仅一次接受', async ({ page }, info) => {
  const { dialog, submissions, failNext } = await fixture(page);
  await expect(dialog.getByRole('checkbox', { name: '采用 风格', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: '采用 作曲', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('row').filter({ hasText: '作曲' })).toContainText('人工作者');
  await dialog.getByRole('checkbox', { name: '选择 摇滚测试 2', exact: true }).uncheck();
  await dialog.getByLabel('候选来源', { exact: true }).selectOption('stale-0');
  await expect(dialog.getByRole('button', { name: '接受选中项', exact: true })).toBeDisabled();
  await dialog.getByLabel('候选来源', { exact: true }).selectOption('candidate-0');
  await dialog.getByText('文件原始值与匹配依据', { exact: true }).click();
  await expect(dialog.getByText('原作者', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/metadata-review-${info.project.name}.png`,
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: `../../artifacts/metadata-review-dark-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  failNext();
  await dialog.getByRole('button', { name: '接受选中项', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: '接受选中项', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已应用 1 首的 1 个字段');
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toEqual(submissions[1]);
  expect(submissions[0].items).toEqual([
    {
      track_id: 'review-0',
      suggestion_id: 'candidate-0',
      metadata_version: 1,
      candidate_digest: 'a'.repeat(64),
      fields: ['genres'],
    },
  ]);
});

test('封面必须显示快照后才能随选中字段整批应用，快捷键遵守相同限制', async ({ page }) => {
  const { dialog, submissions, releaseCover } = await fixture(page);
  await dialog.getByRole('button', { name: '封面对比', exact: true }).click();
  await dialog.getByLabel('将此封面用于本页同专辑歌曲', { exact: false }).check();
  await dialog.getByRole('button', { name: '固定并预览此封面', exact: true }).click();
  await expect(dialog.getByAltText('将采用的固定封面')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '接受选中项', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+Enter');
  expect(submissions).toHaveLength(0);
  releaseCover();
  await expect(dialog.getByRole('button', { name: '接受选中项', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '接受选中项', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已应用 2 首');
  expect(submissions).toHaveLength(1);
  expect(submissions[0].cover_draft_id).toBe('review-cover');
});
