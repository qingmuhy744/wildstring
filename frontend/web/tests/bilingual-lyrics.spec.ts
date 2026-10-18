import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { audio, login } from './helpers';

const fixture = process.env.WILDSTRING_LYRIC_FIXTURE
  ? JSON.parse(readFileSync(process.env.WILDSTRING_LYRIC_FIXTURE, 'utf8'))
  : {
      kind: 'synced',
      source: 'fixture',
      lines: [
        {
          time_ms: 0,
          text: 'A synthetic English sentence',
          translation: '这是一句合成中文译文',
          romanization: 'he cheng',
          words: [{ start_ms: 0, end_ms: 2000, text: 'A synthetic English sentence' }],
        },
        { time_ms: 3000, text: 'Another synthetic line', translation: '另一句合成中文译文' },
      ],
    };

test('双语歌词同行展示、可折叠译文和音译且不改变播放位置', async ({ page }, info) => {
  await login(page);
  await page.route('**/api/v1/tracks/*/lyrics', (route) => route.fulfill({ json: fixture }));
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  const before = (await audio(page)).time;
  const index = fixture.lines.findIndex((line: { translation?: string }) => line.translation);
  expect(index).toBeGreaterThanOrEqual(0);
  const row = panel.locator('.lyric-line').nth(index);
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('.lyric-translation')).toHaveText(fixture.lines[index].translation);
  if (fixture.lines[index].words?.length)
    await expect(row.locator('.lyric-word')).toHaveCount(fixture.lines[index].words.length);
  const originalBox = await row.boundingBox();
  expect(originalBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.getByRole('button', { name: '译文', exact: true }).click();
  await expect(row.locator('.lyric-translation')).toHaveCount(0);
  await panel.getByRole('button', { name: '译文', exact: true }).click();
  await expect(row.locator('.lyric-translation')).toBeVisible();
  if (fixture.lines[index].romanization) {
    await expect(row.locator('.lyric-romanization')).toHaveCount(0);
    await panel.getByRole('button', { name: '音译', exact: true }).click();
    await expect(row.locator('.lyric-romanization')).toHaveText(fixture.lines[index].romanization);
  }
  expect((await audio(page)).paused).toBe(true);
  expect((await audio(page)).time).toBeCloseTo(before, 1);
  if (!process.env.WILDSTRING_LYRIC_FIXTURE)
    await page.screenshot({ path: `../../artifacts/bilingual-${info.project.name}.png` });
});

test('确认在线歌词后正在显示的播放器立即更新语言数据', async ({ page }) => {
  test.skip(!!process.env.WILDSTRING_LYRIC_FIXTURE, 'real fixture rendering has its own check');
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (value: { title: string }) => value.title === '晴天测试曲',
  );
  let applied = false;
  await page.route(`**/api/v1/tracks/${track.id}/lyrics`, async (route) => {
    if (applied) await route.fulfill({ json: fixture });
    else await route.continue();
  });
  await page.route(`**/api/v1/manage/tracks/${track.id}/online-lyrics`, (route) =>
    route.fulfill({
      json: {
        jobs: [],
        items: [
          {
            id: 'synthetic-bilingual',
            plugin_id: 'fixture',
            source_url: 'https://example.com',
            lyrics_version: 1,
            file_version: '0'.repeat(64),
            line_count: fixture.lines.length,
            match: {
              title: track.title,
              artists: ['合成艺人'],
              score: 1,
              version_mismatch: false,
              duration_difference_ms: 0,
            },
            normalized: { ...fixture, format: 'krc' },
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/manage/lyric-candidates/synthetic-bilingual/apply', (route) => {
    applied = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(player).toContainText('侧车第一行');
  await player.getByRole('button', { name: '收起全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  await editor.getByRole('button', { name: '歌词', exact: true }).click();
  await editor.getByRole('button', { name: '预览并选择歌词', exact: true }).click();
  await expect(editor.locator('.online-lyrics pre')).toContainText(fixture.lines[0].translation);
  await editor.getByRole('button', { name: '确认使用此歌词', exact: true }).click();
  await expect.poll(() => applied).toBe(true);
  await editor.getByRole('button', { name: '关闭歌曲编辑', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  await expect(player.locator('.lyric-translation').first()).toHaveText(
    fixture.lines[0].translation,
  );
});
