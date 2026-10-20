import { test, expect, type Page } from '@playwright/test';
import { login, section } from './helpers';

async function fixture(page: Page, options: { large?: boolean; multiple?: boolean } = {}) {
  let version = 1;
  let coverLoaded: (() => void) | undefined;
  const submissions: Record<string, unknown>[] = [];
  let failOnce = false;
  let failRejection = false;
  const rejections: Record<string, unknown>[] = [];
  const rejected = new Set<string>();
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
                fields: {
                  genres: ['Rock'],
                  composers: ['建议作者'],
                  ...(options.multiple ? { album: '原始专辑', release_date: '2011-03-24' } : {}),
                  ...(options.large ? { description: '用于核对滚动的长资料。'.repeat(120) } : {}),
                },
                duplicate_count: 2,
                candidate_digest: 'a'.repeat(64),
                match: { score: 98 },
                cover_url: 'https://coverartarchive.org/test.jpg',
              },
              ...(options.multiple
                ? [
                    {
                      id: `alternate-${i}`,
                      metadata_version: 1,
                      provider: 'musicbrainz',
                      source_url: 'https://musicbrainz.org/',
                      fields: { album: '演唱会现场版', release_date: '2022-01-01' },
                      candidate_digest: 'c'.repeat(64),
                      match: { score: 0.67 },
                      cover_url: null,
                    },
                  ]
                : []),
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
            ].filter((candidate) => !rejected.has(candidate.id))
          : [],
    }));
  await page.route('**/api/v1/agent/metadata-review**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/albums'))
      return route.fulfill({
        json: {
          items: Array.from({ length: options.large ? 60 : 1 }, (_, i) => ({
            id: i ? `album-${i}` : 'review-album',
            title: i ? `滚动专辑 ${i}` : '现场录音',
            artists: ['测试乐队'],
            count: 2,
          })),
          total: options.large ? 60 : 1,
        },
      });
    if (path.endsWith('/reject')) {
      const body = route.request().postDataJSON();
      rejections.push(body);
      if (failRejection) {
        failRejection = false;
        return route.abort('failed');
      }
      rejected.add(body.suggestion_id);
      return route.fulfill({
        json: { status: 'ignored', ignored_count: 2, already_ignored: false },
      });
    }
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
    rejections,
    failRejectNext: () => {
      failRejection = true;
    },
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
  await dialog.getByRole('button', { name: '选择歌曲（已选 2 首）', exact: true }).click();
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

test('跳过只切换歌曲，拒绝当前候选不应用资料且失败可以安全重试', async ({ page }) => {
  const { dialog, submissions, rejections, failRejectNext } = await fixture(page, {
    multiple: true,
  });
  await dialog.getByRole('button', { name: '本次跳过 / 下一首', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '摇滚测试 2', exact: true })).toBeVisible();
  expect(rejections).toHaveLength(0);
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click();
  const reject = dialog.getByRole('button', { name: '拒绝当前建议', exact: true });
  await expect(reject).toBeEnabled();
  failRejectNext();
  await reject.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await reject.click();
  await expect(dialog.getByRole('status')).toContainText('已拒绝当前候选');
  expect(rejections).toHaveLength(2);
  expect(rejections[0]).toEqual(rejections[1]);
  expect(rejections[0]).toEqual({
    track_id: 'review-1',
    suggestion_id: 'candidate-1',
    metadata_version: 1,
    candidate_digest: 'a'.repeat(64),
  });
  expect(submissions).toHaveLength(0);
  await expect(dialog.getByLabel('候选来源', { exact: true })).toHaveValue('alternate-1');
  await expect(dialog.getByRole('button', { name: '接受选中项', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('option').filter({ hasText: '演唱会现场版' })).toHaveCount(1);
  await expect(dialog.getByRole('option').filter({ hasText: '原始专辑' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '本次跳过 / 下一首', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveCount(0);
});

test('候选标注专辑日期匹配度，左右滚动保持标题操作区和背景位置', async ({ page }, info) => {
  const { dialog } = await fixture(page, { large: true, multiple: true });
  const main = dialog.locator('.review-layout main');
  const aside = dialog.locator('.review-layout aside ul');
  const heading = dialog.locator('.review-heading');
  const footer = dialog.locator('.review-actions');
  const headerBefore = await heading.boundingBox();
  const footerBefore = await footer.boundingBox();
  const pageBefore = await page.evaluate(() => scrollY);
  await expect(
    dialog.getByRole('option').filter({ hasText: '原始专辑 · 2011-03-24 · 匹配度 98%' }),
  ).toHaveCount(1);
  await expect(
    dialog.getByRole('option').filter({ hasText: '演唱会现场版 · 2022-01-01 · 匹配度 67%' }),
  ).toHaveCount(1);
  await expect(dialog.getByText('已合并 2 条相同候选记录；不同发行版本仍分别保留。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '选择歌曲（已选 2 首）' })).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/metadata-review-candidates-${info.project.name}.png`,
  });
  await main.hover();
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(50);
  const mainPosition = await main.evaluate((node) => node.scrollTop);
  if (info.project.name === 'desktop') {
    await aside.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => aside.evaluate((node) => node.scrollTop)).toBeGreaterThan(50);
    expect(await main.evaluate((node) => node.scrollTop)).toBe(mainPosition);
  }
  expect(await dialog.evaluate((node) => node.scrollTop)).toBe(0);
  expect(await page.evaluate(() => scrollY)).toBe(pageBefore);
  const headerAfter = await heading.boundingBox();
  const footerAfter = await footer.boundingBox();
  expect(Math.abs(headerAfter!.y - headerBefore!.y)).toBeLessThan(1);
  expect(Math.abs(footerAfter!.y - footerBefore!.y)).toBeLessThan(1);
  await expect(dialog.getByRole('button', { name: '关闭批量核对' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '拒绝当前建议', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../artifacts/metadata-review-scroll-${info.project.name}.png`,
    fullPage: false,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: `../../artifacts/metadata-review-scroll-dark-${info.project.name}.png`,
    fullPage: false,
  });
  await dialog.getByRole('button', { name: '关闭批量核对' }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe('hidden');
});
