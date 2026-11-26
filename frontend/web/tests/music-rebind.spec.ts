import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageTab } from './helpers';

function withLyrics(input: string, output: string, lyrics: string) {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    input,
    '-c:a',
    'copy',
    '-metadata',
    `lyrics=${lyrics}`,
    output,
  ]);
}

test('单曲重绑和批量迁移共用预览，确认后保留原曲目', async ({ page }, info) => {
  test.setTimeout(60_000);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  const headers = { 'X-Wildstring-Client': 'web' };
  const signedIn = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { username: 'admin', password: 'disposable-browser-test-password' },
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto('/');
  const incoming = await mkdtemp(join(tmpdir(), 'wildstring-rebind-web-'));
  const name = `重绑实验-${info.project.name}`;
  const first = join(incoming, 'rebind-single.flac');
  const second = join(incoming, 'rebind-batch.mp3');
  const renamed = join(incoming, 'new-source.flac');
  let libraryId: string | undefined;
  try {
    withLyrics(
      fileURLToPath(new URL('../../../tests/fixtures/audio/silence.flac', import.meta.url)),
      first,
      '[00:00.010]保留这句歌词\n[00:00.120]再保留一句',
    );
    await copyFile(new URL('../../../tests/fixtures/audio/silence.mp3', import.meta.url), second);
    const created = await page.request.post('/api/v1/libraries', {
      headers,
      data: { name, source_roots: [incoming], paused_source_roots: [incoming] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const library = await created.json();
    libraryId = library.id;
    const scoped = { ...headers, 'X-Wildstring-Library': library.id };
    const imported = await page.request.post('/api/v1/manage/jobs', {
      headers: scoped,
      data: { kind: 'import', source_id: library.sources[0].id },
    });
    expect(imported.status(), await imported.text()).toBe(202);
    const importId = (await imported.json()).id;
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`/api/v1/manage/jobs/${importId}`, { headers: scoped })
            ).json()
          ).status,
      )
      .toBe('completed');
    const tracks = (await (await page.request.get('/api/v1/tracks', { headers: scoped })).json())
      .items;
    expect(tracks).toHaveLength(2);
    const track = tracks.find((item: { format: string }) => item.format === 'flac');
    const title = `单曲重绑样本-${info.project.name}`;
    const edit = `/api/v1/manage/tracks/${track.id}/metadata`;
    const metadata = await (await page.request.get(edit, { headers: scoped })).json();
    const savedTitle = await page.request.put(edit, {
      headers: scoped,
      data: { version: metadata.version, overrides: { title } },
    });
    expect(savedTitle.ok(), await savedTitle.text()).toBe(true);
    const original = await (
      await page.request.get(`/api/v1/tracks/${track.id}/file-info`, { headers: scoped })
    ).json();
    withLyrics(first, renamed, '[00:00.010]来源文件里的歌词');
    await unlink(first);
    await appendFile(second, 'Synthetic source edit');
    await page.reload();
    const row = page.getByRole('row').filter({ hasText: title });
    await row.getByRole('button', { name: `歌曲操作 ${title}`, exact: true }).click();
    await page.getByRole('button', { name: '文件属性与路径', exact: true }).click();
    const dialog = page.locator('.track-file-info-dialog');
    await dialog.getByRole('button', { name: '重新绑定来源', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择来源音频', exact: true });
    await picker.getByRole('button', { name: 'new-source.flac', exact: true }).click();
    await expect(dialog.getByText('保留资料后重链', { exact: true })).toBeVisible();
    const applyLink = dialog.getByRole('button', { name: '确认重链', exact: true });
    await expect(applyLink).toBeInViewport({ ratio: 1 });
    await dialog.getByText('查看将保留的标签差异', { exact: true }).click();
    const lyricChange = dialog.getByText('内嵌歌词', { exact: true });
    await expect(lyricChange).toBeVisible();
    await expect(dialog.getByText(/保留这句歌词/)).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await applyLink.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`rebind-single-${theme}.png`) });
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await applyLink.click();
    await expect(dialog.getByText('来源已更新。', { exact: true })).toBeVisible();
    await expect(dialog.getByText('new-source.flac', { exact: true })).toBeVisible();
    expect((await stat(original.absolute_path)).ino).toBe((await stat(renamed)).ino);
    const lyrics = await page.request.get(`/api/v1/tracks/${track.id}/lyrics`, { headers: scoped });
    expect(lyrics.ok()).toBe(true);
    expect((await lyrics.json()).lines.map((line: { text: string }) => line.text)).toEqual([
      '保留这句歌词',
      '再保留一句',
    ]);
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();

    await manageTab(page, '存储与曲库');
    const panel = page.getByRole('region', { name: '音乐库配置', exact: true });
    await panel.locator('.music-library-list button').filter({ hasText: name }).click();
    const storage = panel.getByLabel(`${name}的存储设置`, { exact: true });
    await storage
      .locator('select')
      .filter({ has: page.locator('option[value="hardlink"]') })
      .selectOption('hardlink');
    await storage.getByRole('button', { name: '预览来源重绑', exact: true }).click();
    const review = storage.getByRole('region', { name: '预览来源重绑', exact: true });
    await expect(review.getByText('已经链接 · 1', { exact: true })).toBeVisible();
    await review.getByText('仅更新绑定 · 1', { exact: true }).click();
    await expect(review.getByRole('checkbox')).toBeChecked();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await storage
        .getByRole('button', { name: '应用选中的结果', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`rebind-batch-${theme}.png`) });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await storage.getByRole('button', { name: '应用选中的结果', exact: true }).click();
    await expect(storage.getByText('来源已更新。', { exact: true })).toBeVisible();
    const saved = (await (await page.request.get('/api/v1/libraries')).json()).find(
      (item: { id: string }) => item.id === library.id,
    );
    expect(saved.storage_mode).toBe('hardlink');
    const loaded = await page.request.get(`/api/v1/tracks/${track.id}/file-info`, {
      headers: scoped,
    });
    expect(loaded.ok()).toBe(true);
  } finally {
    try {
      if (libraryId) {
        const libraries = await (await page.request.get('/api/v1/libraries')).json();
        const active = libraries.find((item: { id: string }) => item.id === libraryId);
        if (active) {
          const disabled = await page.request.put(`/api/v1/libraries/${libraryId}`, {
            headers,
            data: {
              name,
              enabled: false,
              version: active.version,
              source_roots: [incoming],
              paused_source_roots: [incoming],
            },
          });
          expect(disabled.ok(), await disabled.text()).toBe(true);
        }
      }
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
  }
});
