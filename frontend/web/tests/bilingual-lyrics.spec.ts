import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { audio, login, test } from './helpers';

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
  const appliedOffsets: number[] = [];
  await page.route(`**/api/v1/tracks/${track.id}/lyrics`, async (route) => {
    if (applied) await route.fulfill({ json: fixture });
    else await route.continue();
  });
  const previewLines = Array.from({ length: 24 }, (_, index) => ({
    ...fixture.lines[0],
    time_ms: index * 180,
  }));
  await page.route(`**/api/v1/manage/tracks/${track.id}/online-lyrics`, (route) =>
    route.fulfill({
      json: {
        jobs: [],
        items: ['曲库版本', '同名候选', '现场候选', '纯文本候选'].map((title, index) => ({
          id: index ? `synthetic-alternate-${index}` : 'synthetic-bilingual',
          plugin_id: 'fixture',
          source_url: 'https://example.com',
          lyrics_version: 1,
          file_version: '0'.repeat(64),
          line_count: previewLines.length,
          match: {
            title,
            artists: [index ? '另一位艺人' : '合成艺人'],
            score: index ? 0.55 : 1,
            version_mismatch: index === 2,
            duration_difference_ms: index ? 3600 : 0,
          },
          normalized:
            index === 3
              ? { kind: 'plain', format: 'txt', lines: [{ text: '纯文本', time_ms: null }] }
              : { ...fixture, lines: previewLines, format: 'krc' },
        })),
      },
    }),
  );
  await page.route('**/api/v1/manage/lyric-candidates/*/apply', (route) => {
    expect(route.request().url()).toContain('/synthetic-bilingual/apply');
    appliedOffsets.push(route.request().postDataJSON().offset_ms);
    if (appliedOffsets.length === 1) return route.fulfill({ status: 503, json: {} });
    applied = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const player = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(player).toContainText('侧车第一行');
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  await player.getByRole('button', { name: '收起全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  await editor.getByRole('button', { name: '歌词', exact: true }).click();
  const editorBody = editor.locator('.scroll-dialog-body');
  const cards = editor.locator('.lyric-candidate');
  const first = cards.filter({ has: page.getByRole('link', { name: '曲库版本' }) });
  const alternate = cards.filter({ has: page.getByRole('link', { name: '同名候选' }) });
  const firstPreview = first.getByRole('button', { name: '预览歌词', exact: true });
  const beforeOpening = await audio(page);
  // Sample after Playwright has scrolled the button into view, before React expands the preview.
  const scrollFrames = await editorBody.evaluateHandle((node) => ({
    positions: new Promise<number[]>((resolve) => {
      node.addEventListener(
        'click',
        async () => {
          const samples = [node.scrollTop];
          for (let i = 0; i < 18; i += 1) {
            await new Promise(requestAnimationFrame);
            samples.push(node.scrollTop);
          }
          resolve(samples);
        },
        { capture: true, once: true },
      );
    }),
  }));
  await firstPreview.click();
  await expect(first.getByRole('button', { name: '收起预览' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(first.getByRole('list', { name: '预览歌词' })).toContainText(
    fixture.lines[0].translation,
  );
  const [initialTop, ...positions] = await scrollFrames.evaluate((probe) => probe.positions);
  await scrollFrames.dispose();
  expect(positions).toEqual(Array(18).fill(initialTop));
  await expect(alternate).toContainText('匹配 55%');
  await expect(alternate).toContainText('逐字覆盖 100%');
  await expect(alternate).toContainText('需核对版本');
  await alternate.getByRole('button', { name: '预览歌词', exact: true }).click();
  await expect(editor.getByRole('list', { name: '预览歌词' })).toHaveCount(1);
  await expect(alternate.getByRole('list', { name: '预览歌词' })).toBeVisible();
  expect(await audio(page)).toEqual(beforeOpening);
  expect(appliedOffsets).toEqual([]);
  await firstPreview.click();
  const list = first.getByRole('list', { name: '预览歌词' });
  const row = list.getByRole('listitem').nth(18).getByRole('button');
  const auditionScroll = await row.evaluateHandle((button) => ({
    positions: new Promise<[number, number]>((resolve) => {
      button.addEventListener(
        'click',
        () => {
          resolve([
            button.closest('.scroll-dialog-body')!.scrollTop,
            button.closest('[role="list"]')!.scrollTop,
          ]);
        },
        { capture: true, once: true },
      );
    }),
  }));
  await row.click();
  const [outerTop, innerTop] = await auditionScroll.evaluate((probe) => probe.positions);
  await auditionScroll.dispose();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).not.toBe(innerTop);
  expect(await editorBody.evaluate((node) => node.scrollTop)).toBe(outerTop);
  await first.getByRole('button', { name: '暂停', exact: true }).click();
  const offsetControls = first.getByRole('group', { name: '时间偏移', exact: true });
  const offset = offsetControls.getByRole('spinbutton', { name: '时间偏移（毫秒）' });
  await expect(offset).toBeVisible();
  await offset.fill('500');
  await offsetControls.getByRole('button', { name: '复位到 0 偏移' }).click();
  await expect(offset).toHaveValue('0');
  await offsetControls.getByRole('button', { name: '+200ms', exact: true }).click();
  await expect(offset).toHaveValue('200');
  const useLyrics = first.getByRole('button', { name: '使用此歌词', exact: true });
  await useLyrics.click();
  await expect(first.getByRole('status')).toBeVisible();
  await expect(useLyrics).toBeEnabled();
  expect(appliedOffsets).toEqual([200]);
  await useLyrics.click();
  await expect(first.getByRole('status')).toContainText('已保存选中的歌词');
  expect(appliedOffsets).toEqual([200, 200]);
  await expect.poll(() => applied).toBe(true);
  await editor.getByRole('button', { name: '关闭歌曲编辑', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  await expect(player.locator('.lyric-translation').first()).toHaveText(
    fixture.lines[0].translation,
  );
});

test('单曲联网歌词查询保留已有候选，完成后恢复查询', async ({ page }) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (value: { title: string }) => value.title === '晴天测试曲',
  );
  let submitted = false;
  let polls = 0;
  const candidate = {
    id: 'existing-candidate',
    plugin_id: 'fixture',
    source_url: 'https://example.com',
    lyrics_version: 1,
    file_version: '0'.repeat(64),
    line_count: fixture.lines.length,
    match: { title: track.title, artists: ['合成艺人'], score: 1, version_mismatch: false },
    normalized: { ...fixture, format: 'krc' },
  };
  await page.route(`**/api/v1/manage/tracks/${track.id}/online-lyrics`, (route) => {
    if (route.request().method() === 'POST') {
      submitted = true;
      return route.fulfill({ json: {} });
    }
    const status = !submitted ? undefined : polls++ === 0 ? 'running' : 'completed';
    return route.fulfill({
      json: { items: [candidate], jobs: status ? [{ status, warnings: [] }] : [] },
    });
  });
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  await editor.getByRole('button', { name: '歌词', exact: true }).click();
  const panel = editor.locator('.online-lyrics');
  const search = panel.getByRole('button', { name: '查找联网歌词', exact: true });
  await expect(panel).toContainText('合成艺人');
  await expect(search).toBeEnabled();
  await search.click();
  await expect(search).toBeDisabled();
  await expect(panel).toContainText('合成艺人');
  await expect(search).toBeEnabled({ timeout: 10000 });
  await expect(panel).toContainText('合成艺人');
});
