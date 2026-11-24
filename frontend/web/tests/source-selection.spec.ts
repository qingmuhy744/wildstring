import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { login, manageTab } from './helpers';

const screenshotDir = process.env.WILDSTRING_SCREENSHOT_DIR || '';

async function captureThemes(page: Page, target: Locator, name: string, projectName: string) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await target.screenshot({
      path: path.join(screenshotDir, `${name}-${theme}-${projectName}.png`),
    });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
}

test('单曲在线歌词与元数据匹配支持按来源筛选与关键词检索', async ({ page }, info) => {
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const track = tracks[0];

  const matcherPayloads: Record<string, unknown>[] = [];
  let matcherSearchCount = 0;
  let matcherPollCount = 0;
  await page.route(`**/api/v1/manage/providers/tracks/${track.id}`, async (route) => {
    matcherPollCount += matcherSearchCount > 0 ? 1 : 0;
    const status = matcherSearchCount > 0 && matcherPollCount < 2 ? 'running' : 'completed';
    await route.fulfill({
      json: {
        available_sources: [
          { id: 'qqmusic', name: 'QQ 音乐', kind: 'plugin' },
          { id: 'netease', name: '网易云音乐', kind: 'plugin' },
          { id: 'musicbrainz', name: 'MusicBrainz', kind: 'builtin' },
        ],
        provider_names: {
          qqmusic: 'QQ 音乐',
          netease: '网易云音乐',
          musicbrainz: 'MusicBrainz',
        },
        jobs: matcherSearchCount > 0 ? [{ id: 'matcher-job-1', status }] : [],
        suggestions: [
          {
            id: 's-1',
            provider: 'qqmusic',
            status: 'pending',
            match: { score: 0.98 },
            fields: {
              title: '晴天（录音室版）',
              artists: ['周杰伦'],
              album: '叶惠美',
              release_date: '2003-07-31',
              track_number: 3,
            },
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/manage/providers/query', async (route) => {
    matcherPayloads.push(route.request().postDataJSON());
    matcherSearchCount += 1;
    await route.fulfill({ json: { queued: 1, already_active: 0, total: 1 } });
  });

  const lyricPayloads: Array<Record<string, unknown> | null> = [];
  let lyricQueryTriggered = 0;
  let lyricSourceSet: 'two' | 'one' = 'two';
  await page.route(`**/api/v1/manage/tracks/${track.id}/online-lyrics`, async (route) => {
    if (route.request().method() === 'POST') {
      const raw = route.request().postData();
      lyricPayloads.push(raw ? JSON.parse(raw) : null);
      lyricQueryTriggered += 1;
      await route.fulfill({ json: { id: `job-${lyricQueryTriggered}`, status: 'queued' } });
      return;
    }
    const sources =
      lyricSourceSet === 'two'
        ? [
            { id: 'qqmusic', name: 'QQ 音乐' },
            { id: 'netease', name: '网易云音乐' },
          ]
        : [{ id: 'qqmusic', name: 'QQ 音乐' }];
    await route.fulfill({
      json: {
        sources,
        jobs: lyricQueryTriggered > 0 ? [{ status: 'completed', warnings: [] }] : [],
        items: [
          {
            id: 'cand-1',
            plugin_id: 'qqmusic',
            source_url: 'https://example.com/song',
            lyrics_version: 1,
            file_version: '0'.repeat(64),
            line_count: 1,
            match: {
              title: track.title,
              artists: track.artists,
              score: 0.96,
              version_mismatch: false,
              duration_difference_ms: 0,
            },
            normalized: {
              kind: 'synced',
              format: 'lrc',
              lines: [{ time_ms: 1000, text: '第一句歌词', translation: 'First line' }],
            },
          },
        ],
      },
    });
  });

  await page.getByRole('button', { name: `歌曲操作 ${track.title}`, exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  const matcher = editor.locator('.online-metadata-matcher');

  await matcher.getByRole('button', { name: '查找网络元数据 ↗', exact: true }).click();
  await expect(matcher).toContainText('匹配度 98%');
  await expect(matcher).not.toContainText('匹配度 1%');

  const matcherSources = matcher.getByRole('group', { name: '选择查询来源', exact: true });
  await expect(matcherSources.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await matcherSources.getByRole('button', { name: 'QQ 音乐', exact: true }).click();
  await expect(
    matcherSources.getByRole('button', { name: 'QQ 音乐', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await matcher.getByLabel('歌名', { exact: true }).fill('晴天 自定义');
  await matcher.getByLabel('艺人', { exact: true }).fill('周杰伦');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureThemes(page, matcher, 'online-metadata-matcher', info.project.name);

  await matcher.getByRole('button', { name: '重新联网检索', exact: true }).click();
  await expect.poll(() => matcherPayloads.length).toBe(1);
  expect(matcherPayloads[0]).toEqual({
    track_ids: [track.id],
    interactive: true,
    force: true,
    sources: ['qqmusic'],
    query_title: '晴天 自定义',
    query_artist: '周杰伦',
  });
  await expect(matcher.getByRole('button', { name: '重新联网检索', exact: true })).toBeEnabled();

  await editor.getByRole('button', { name: '歌词', exact: true }).click();
  const lyricsSection = editor.locator('.online-lyrics');
  const lyricSources = lyricsSection.getByRole('group', { name: '选择歌词来源', exact: true });
  await expect(lyricSources.getByRole('button', { name: '全部', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await captureThemes(page, lyricsSection, 'online-lyrics-sources', info.project.name);

  // Selected All omits request body
  await lyricsSection.getByRole('button', { name: '查找联网歌词', exact: true }).click();
  await expect.poll(() => lyricPayloads.length).toBe(1);
  expect(lyricPayloads[0]).toBeNull();

  // Select single source NetEase -> sends { plugin_ids: ['netease'] }
  await lyricSources.getByRole('button', { name: '网易云音乐', exact: true }).click();
  await expect(
    lyricSources.getByRole('button', { name: '网易云音乐', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await lyricsSection.getByRole('button', { name: '查找联网歌词', exact: true }).click();
  await expect.poll(() => lyricPayloads.length).toBe(2);
  expect(lyricPayloads[1]).toEqual({ plugin_ids: ['netease'] });

  // Collapse source bar when fewer than 2 sources exist
  lyricSourceSet = 'one';
  await lyricsSection.getByRole('button', { name: '查找联网歌词', exact: true }).click();
  await expect(lyricSources).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('批量元数据刷新与歌词批扫来源筛选提交与显隐契约', async ({ page }, info) => {
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const track = tracks[0];

  const refreshPayloads: Record<string, unknown>[] = [];
  await page.route('**/api/v1/manage/providers/sources', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: 'qqmusic', name: 'QQ 音乐', kind: 'plugin' },
          { id: 'musicbrainz', name: 'MusicBrainz', kind: 'builtin' },
        ],
      },
    }),
  );
  await page.route('**/api/v1/manage/providers/refresh', async (route) => {
    refreshPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { queued: 1, already_active: 0, total: 1 } });
  });

  await page.getByRole('button', { name: `歌曲操作 ${track.title}`, exact: true }).click();
  await page.getByRole('button', { name: '更新元数据', exact: true }).click();
  const refreshDialog = page.getByRole('dialog', { name: '更新元数据', exact: true });
  const refreshGroup = refreshDialog.getByRole('group', { name: '查询来源', exact: true });
  await expect(refreshGroup.getByLabel('QQ 音乐', { exact: true })).toBeChecked();
  await expect(refreshGroup.getByLabel('MusicBrainz', { exact: true })).toBeChecked();

  // Default all checked omits `sources`
  await refreshDialog.getByRole('button', { name: '开始更新', exact: true }).click();
  await expect.poll(() => refreshPayloads.length).toBe(1);
  expect(refreshPayloads[0]).not.toHaveProperty('sources');
  await refreshDialog.getByRole('button', { name: '完成', exact: true }).click();

  // Reopen and uncheck MusicBrainz -> sends `sources: ['qqmusic']`; unchecking all disables Start
  await page.getByRole('button', { name: `歌曲操作 ${track.title}`, exact: true }).click();
  await page.getByRole('button', { name: '更新元数据', exact: true }).click();
  await refreshGroup.getByLabel('MusicBrainz', { exact: true }).uncheck();
  await captureThemes(page, refreshDialog, 'metadata-refresh-sources', info.project.name);

  await refreshGroup.getByLabel('QQ 音乐', { exact: true }).uncheck();
  await expect(refreshDialog.getByRole('button', { name: '开始更新', exact: true })).toBeDisabled();
  await refreshGroup.getByLabel('QQ 音乐', { exact: true }).check();
  await refreshDialog.getByRole('button', { name: '开始更新', exact: true }).click();
  await expect.poll(() => refreshPayloads.length).toBe(2);
  expect(refreshPayloads[1].sources).toEqual(['qqmusic']);
  await refreshDialog.getByRole('button', { name: '完成', exact: true }).click();

  // Lyric scans source selection
  const scanPreviewPayloads: Record<string, unknown>[] = [];
  await page.route('**/api/v1/manage/lyric-scans/sources', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: 'qqmusic', name: 'QQ 音乐' },
          { id: 'kugou', name: '酷狗音乐' },
        ],
      },
    }),
  );
  await page.route('**/api/v1/manage/lyric-scans/preview', async (route) => {
    scanPreviewPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { total: 1, options: route.request().postDataJSON() } });
  });

  if (info.project.name === 'mobile') {
    await page.getByLabel('浏览方式').selectOption('manage');
  } else {
    await page.getByRole('button', { name: '管理中心', exact: true }).click();
  }
  await manageTab(page, '当前音乐库设置');
  await page.getByRole('button', { name: '打开歌词补全与洗版', exact: true }).click();
  const scanPanel = page.getByRole('region', { name: '歌词补全与洗版', exact: true });
  const scanGroup = scanPanel.getByRole('group', { name: '查询来源', exact: true });
  await expect(scanGroup.getByLabel('QQ 音乐', { exact: true })).toBeChecked();
  await expect(scanGroup.getByLabel('酷狗音乐', { exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await captureThemes(page, scanPanel, 'lyric-scans-sources', info.project.name);

  await scanGroup.getByLabel('酷狗音乐', { exact: true }).uncheck();
  await scanPanel.getByRole('button', { name: '检查扫描范围', exact: true }).click();
  await expect.poll(() => scanPreviewPayloads.length).toBe(1);
  expect(scanPreviewPayloads[0].plugin_ids).toEqual(['qqmusic']);

  await scanGroup.getByLabel('QQ 音乐', { exact: true }).uncheck();
  await expect(scanPanel.getByRole('button', { name: '检查扫描范围', exact: true })).toBeDisabled();
});
