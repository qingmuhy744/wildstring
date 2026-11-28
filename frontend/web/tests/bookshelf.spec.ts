import { expect, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, manageTab, section, test } from './helpers';

const bookClientHeaders = { 'X-Wildstring-Client': 'web' };

async function uploadReaderFixture(page: Page, title: string) {
  const library = await page.request.post('/api/v1/book-libraries', {
    headers: bookClientHeaders,
    data: { name: title },
  });
  expect(library.status()).toBe(201);
  const { id: libraryId } = await library.json();
  const created = await page.request.post('/api/v1/books/upload', {
    headers: bookClientHeaders,
    multipart: {
      library_id: libraryId,
      file: {
        name: `${title}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('第一章\n晨间正文。\n\n第二章\n午后正文。\n\n第三章\n夜间正文。'),
      },
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  return { id, libraryId };
}

async function selectReaderText(page: Page, text: string) {
  const paragraph = page.getByText(text, { exact: true });
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
}

test('从详情点阅读后返回书籍，迟到详情响应不会重开阅读器', async ({ page, isMobile }, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `短篇返回 ${info.project.name} ${Date.now()}`;
  const { id, libraryId } = await uploadReaderFixture(page, title);
  await section(page, '书架');
  await page.getByLabel('书库', { exact: true }).selectOption(libraryId);
  const card = page.locator('.bookshelf-grid').getByRole('button', { name: new RegExp(title) });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/v1/books/${id}`,
    async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    const requested = page.waitForRequest((request) => request.url().endsWith(`/books/${id}`));
    await card.click();
    const old = await requested;
    const aborted = page.waitForEvent('requestfailed', (request) => request === old);
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    const reader = page.getByRole('dialog', { name: title });
    await expect(reader.getByRole('article')).toContainText('晨间正文。');
    await reader.getByRole('button', { name: '返回书籍' }).click();
    release();
    await aborted;
    await expect(reader).toHaveCount(0);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(继续)?阅读$/ })).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/v1/books/${id}`);
        return (await response.json()).progress_status;
      })
      .toBe('in_progress');
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    await expect(card).toBeFocused();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('双载体摘要、对齐与暖纸自定义高亮', async ({ page, isMobile }, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `双载体暖纸复验 ${info.project.name} ${Date.now()}`;
  const source = await mkdtemp(join(tmpdir(), 'wildstring-book-alignment-'));
  try {
    const series = join(source, title);
    await mkdir(series);
    const sample = new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url);
    await copyFile(sample, join(series, '01.mp3'));
    await copyFile(sample, join(series, '02.mp3'));
    const library = await page.request.post('/api/v1/book-libraries', {
      headers: bookClientHeaders,
      data: { name: title, source_roots: [source] },
    });
    expect(library.status()).toBe(201);
    const { id: libraryId } = await library.json();
    expect(
      (
        await page.request.post(`/api/v1/book-libraries/${libraryId}/scan`, {
          headers: bookClientHeaders,
        })
      ).ok(),
    ).toBe(true);
    const listing = await page.request.get(`/api/v1/books?library_id=${libraryId}`);
    const { id } = (await listing.json()).items[0];
    const prefix = `/api/v1/books/${id}`;
    expect(
      (
        await page.request.post(prefix + '/ebook', {
          headers: bookClientHeaders,
          multipart: {
            file: {
              name: `${title}.txt`,
              mimeType: 'text/plain',
              buffer: Buffer.from('第一章\n晨间正文。\n\n第二章\n午后正文。\n\n第三章\n夜间正文。'),
            },
          },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await page.request.patch(prefix + '/audiobook/chapters/1', {
          headers: bookClientHeaders,
          data: { title: '第二章' },
        })
      ).ok(),
    ).toBe(true);
    const basics = { device_id: 'fixture', base_version: 0, sequence: 1 };
    expect(
      (
        await page.request.put(prefix + '/reading-progress', {
          headers: bookClientHeaders,
          data: {
            ...basics,
            session_id: 'fixture-reading-in-progress',
            spine_index: 0,
            block_index: 0,
            char_offset: 0,
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.put(prefix + '/listening-progress', {
          headers: bookClientHeaders,
          data: {
            ...basics,
            session_id: 'fixture-listening-in-progress',
            chapter_index: 1,
            chapter_position_ms: 500,
          },
        })
      ).ok(),
    ).toBe(true);

    await section(page, '书架');
    await page.getByLabel('书库', { exact: true }).selectOption(libraryId);
    const card = page.locator('.bookshelf-grid').getByRole('button', { name: new RegExp(title) });
    await card.click();
    const read = page.getByRole('button', { name: '继续阅读', exact: true });
    await expect(read).toBeVisible();
    await expect(page.getByRole('button', { name: '继续收听', exact: true })).toBeVisible();
    await expect(page.locator('.book-carrier-progress')).toContainText('已听 · 第二章');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({
        path: info.outputPath(`book-detail-${theme}.png`),
        animations: 'disabled',
      });
    }
    await read.click();
    const reader = page.getByRole('dialog', { name: title });
    const hint = reader.locator('.book-align-notice');
    await expect(hint).toContainText('有声书已听到「第二章」');
    await expect(reader.getByRole('article')).toContainText('晨间正文。');
    await expect(hint.getByRole('button', { name: '跳到对应位置' })).toBeEnabled();
    const setPaper = async (theme: '浅色纸张' | '深色纸张') => {
      await reader.getByRole('button', { name: '排版', exact: true }).click();
      await reader.getByRole('button', { name: theme }).click();
      await reader
        .getByRole('group', { name: '排版' })
        .getByRole('button', { name: '关闭' })
        .click();
    };
    await page.screenshot({
      path: info.outputPath('align-reading-light.png'),
      animations: 'disabled',
    });
    await setPaper('深色纸张');
    await page.screenshot({
      path: info.outputPath('align-reading-dark.png'),
      animations: 'disabled',
    });
    await hint.getByRole('button', { name: '忽略' }).click();
    await expect(hint).toHaveCount(0);
    expect((await (await page.request.get(prefix + '/reading-progress')).json()).version).toBe(1);
    await reader.getByRole('button', { name: '返回书籍' }).click();
    await read.click();
    await hint.getByRole('button', { name: '跳到对应位置' }).click();
    await expect(reader.getByRole('article')).toContainText('午后正文。');
    await selectReaderText(page, '午后正文。');
    const toolbar = reader.getByRole('toolbar', { name: '批注' });
    await toolbar.getByLabel('自定义高亮颜色').fill('#3456ab');
    await page.screenshot({
      path: info.outputPath('custom-color-picker.png'),
      animations: 'disabled',
    });
    await toolbar.getByRole('button', { name: '应用自定义颜色' }).click();
    const mark = reader.locator('mark[data-color="#3456ab"]');
    await expect(mark).toHaveText('午后正文。');
    await page.screenshot({
      path: info.outputPath('custom-mark-light.png'),
      animations: 'disabled',
    });
    await setPaper('深色纸张');
    await expect(mark).toHaveCSS('color', 'rgb(232, 227, 217)');
    await page.screenshot({
      path: info.outputPath('custom-mark-dark.png'),
      animations: 'disabled',
    });
    await mark.click();
    await expect(reader.getByLabel('自定义高亮颜色')).toHaveValue('#3456ab');
    await page.screenshot({
      path: info.outputPath('custom-color-editor-dark.png'),
      animations: 'disabled',
    });
    await reader.getByLabel('自定义高亮颜色').fill('#892543');
    await reader.getByRole('button', { name: '保存', exact: true }).click();
    await expect(reader.locator('mark[data-color="#892543"]')).toHaveText('午后正文。');
    await reader.getByRole('button', { name: '下一章' }).click();
    await expect(reader.getByRole('article')).toContainText('夜间正文。');
    await expect
      .poll(
        async () =>
          (await (await page.request.get(prefix + '/reading-progress')).json()).spine_index,
      )
      .toBe(2);
    await reader.getByRole('button', { name: '返回书籍' }).click();
    const audioHint = page.locator('.book-align-notice');
    await expect(audioHint).toContainText('电子书已读到「第三章」');
    const audioTab = page.getByRole('tab', { name: /有声章节/ });
    const ebookTab = page.getByRole('tab', { name: /阅读目录/ });
    await expect(audioTab).toHaveAttribute('aria-selected', 'true');
    await expect(ebookTab).toHaveAttribute('aria-selected', 'false');
    await ebookTab.click();
    await expect(ebookTab).toHaveAttribute('aria-selected', 'true');
    await expect(audioTab).toHaveAttribute('aria-selected', 'false');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const activeStyle = await ebookTab.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, weight: Number(s.fontWeight) };
      });
      const inactiveStyle = await audioTab.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, weight: Number(s.fontWeight) };
      });
      expect(activeStyle.bg).not.toBe(inactiveStyle.bg);
      expect(activeStyle.weight).toBeGreaterThan(inactiveStyle.weight);
      await page.screenshot({
        path: info.outputPath(`align-listening-${theme}.png`),
        animations: 'disabled',
      });
    }
    await audioTab.click();
    await expect(audioTab).toHaveAttribute('aria-selected', 'true');
    await audioHint.getByRole('button', { name: '跳到对应位置' }).click();
    await expect
      .poll(
        async () => (await (await page.request.get(prefix + '/listening-progress')).json()).version,
      )
      .toBeGreaterThan(1);
    const aligned = await (await page.request.get(prefix + '/listening-progress')).json();
    expect(aligned.chapter_index).toBe(1);
    expect(aligned.chapter_position_ms).toBeGreaterThan(500);
    await expect(page.locator('.player .play-button')).toHaveCSS('width', '38px');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({
        path: info.outputPath(`book-transport-${theme}.png`),
        animations: 'disabled',
      });
    }
    const savedReading = await (await page.request.get(prefix + '/reading-progress')).json();
    expect(
      (
        await page.request.put(prefix + '/reading-progress', {
          headers: bookClientHeaders,
          data: {
            ...basics,
            base_version: savedReading.version,
            session_id: 'fixture-finished-reading',
            spine_index: 2,
            block_index: 1,
            char_offset: 5,
            completed: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    await card.click();
    await page.getByRole('button', { name: '重新阅读', exact: true }).click();
    await expect(reader.getByRole('article')).toContainText('晨间正文。');
    await expect
      .poll(async () => {
        const progress = await (await page.request.get(prefix + '/reading-progress')).json();
        return [progress.spine_index, progress.completed];
      })
      .toEqual([0, false]);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('正文、目录和初次阅读进度读取失败各自原位重试', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `阅读重试 ${info.project.name} ${Date.now()}`;
  const { id } = await uploadReaderFixture(page, title);
  const prefix = `/api/v1/books/${id}`;
  const seeded = await page.request.put(`${prefix}/reading-progress`, {
    headers: bookClientHeaders,
    data: {
      session_id: 'reader-retry-fixture',
      device_id: 'reader-retry-other-device',
      base_version: 0,
      sequence: 1,
      spine_index: 1,
      block_index: 0,
      char_offset: 0,
    },
  });
  expect(seeded.status()).toBe(200);
  for (const path of ['/ebook/manifest', '/ebook/chapters/0', '/reading-progress']) {
    await page.route(
      `**${prefix}${path}`,
      (route) => route.fulfill({ status: 503, json: { detail: 'fixture_unavailable' } }),
      { times: 1 },
    );
  }
  await page.goto(`/books/${id}/read`);
  const reader = page.getByRole('dialog', { name: title });
  const retry = (message: string) =>
    reader.locator('.book-reader-alert').filter({ hasText: message });
  const chapter = retry('无法加载本章正文。');
  const contents = retry('无法加载目录。');
  const progress = retry('无法读取阅读进度。');
  await expect(chapter.getByRole('alert')).toBeVisible();
  await expect(contents.getByRole('alert')).toBeVisible();
  await expect(progress.getByRole('alert')).toBeVisible();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-load-errors-light.png') });
  const appearance = reader.getByRole('button', { name: '排版', exact: true });
  await appearance.click();
  await reader.getByRole('button', { name: '深色纸张' }).click();
  await appearance.click();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-load-errors-dark.png') });

  await chapter.getByRole('button', { name: '重试' }).click();
  await expect(reader.getByRole('article')).toContainText('晨间正文。');
  await expect(progress.getByRole('alert')).toBeVisible();
  await contents.getByRole('button', { name: '重试' }).click();
  await expect(reader.getByRole('button', { name: '下一章' })).toBeEnabled();
  await expect(reader.getByRole('article')).toContainText('晨间正文。');

  await progress.getByRole('button', { name: '重试' }).click();
  await expect(reader.getByRole('article')).toContainText('午后正文。');
  await expect(reader.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/books/${id}/read$`));
});

test('阅读进度冲突保持正文，显式读取最新位置后恢复保存', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `阅读冲突 ${info.project.name} ${Date.now()}`;
  const { id } = await uploadReaderFixture(page, title);
  const path = `/api/v1/books/${id}/reading-progress`;
  let reads = 0;
  let writes = 0;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'GET') reads++;
    else if (route.request().method() === 'PUT') writes++;
    await route.continue();
  });
  const initialRead = page.waitForResponse((response) => response.url().endsWith(path));
  await page.goto(`/books/${id}/read`);
  expect((await initialRead).ok()).toBe(true);
  const reader = page.getByRole('dialog', { name: title });
  await expect(reader.getByRole('article')).toContainText('晨间正文。');
  const otherDevice = await page.request.put(path, {
    headers: bookClientHeaders,
    data: {
      session_id: 'reader-conflict-fixture',
      device_id: 'reader-conflict-other-device',
      base_version: 0,
      sequence: 1,
      spine_index: 2,
      block_index: 0,
      char_offset: 0,
    },
  });
  expect(otherDevice.status()).toBe(200);
  const serverProgress = await otherDevice.json();
  const conflict = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === 'PUT',
  );
  await reader.getByRole('button', { name: '下一章' }).click();
  expect((await conflict).status()).toBe(409);
  await expect(reader.getByRole('article')).toContainText('午后正文。');
  await expect(reader.getByRole('alert')).toContainText('另一台设备更新了阅读进度');
  await reader.getByRole('button', { name: '分页', exact: true }).click();
  expect(reads).toBe(1);
  expect(writes).toBe(1);
  await page.screenshot({
    scale: 'css',
    path: info.outputPath('reader-progress-conflict-light.png'),
  });
  const appearance = reader.getByRole('button', { name: '排版', exact: true });
  await appearance.click();
  await reader.getByRole('button', { name: '深色纸张' }).click();
  await appearance.click();
  await page.screenshot({
    scale: 'css',
    path: info.outputPath('reader-progress-conflict-dark.png'),
  });

  await reader.getByRole('button', { name: '重新读取服务器进度' }).click();
  await expect(reader.getByRole('alert')).toHaveCount(0);
  await expect(reader.getByRole('article')).toContainText('夜间正文。');
  await expect(reader.getByRole('button', { name: '滚动', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(reads).toBe(2);
  expect(writes).toBe(1);

  const resumed = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === 'PUT',
  );
  await reader.getByRole('button', { name: '上一章' }).click();
  const response = await resumed;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    base_version: serverProgress.version,
    intent: 'resume',
    sequence: 1,
  });
  await expect(reader.getByRole('article')).toContainText('午后正文。');
  expect(await response.json()).toMatchObject({ spine_index: 1, reading_mode: 'scroll' });
});

test('下一次自动保存成功后清除临时保存错误', async ({ page }, info) => {
  await login(page);
  const title = `阅读保存恢复 ${info.project.name} ${Date.now()}`;
  const { id } = await uploadReaderFixture(page, title);
  const path = `/api/v1/books/${id}/reading-progress`;
  let failFirstSave = true;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'PUT' && failFirstSave) {
      failFirstSave = false;
      await route.fulfill({ status: 503, json: { detail: 'fixture_unavailable' } });
    } else {
      await route.continue();
    }
  });
  const initialRead = page.waitForResponse((response) => response.url().endsWith(path));
  await page.goto(`/books/${id}/read`);
  expect((await initialRead).ok()).toBe(true);
  const reader = page.getByRole('dialog', { name: title });
  await expect(reader.getByRole('article')).toContainText('晨间正文。');
  const nextChapter = reader.getByRole('button', { name: '下一章', exact: true });
  await nextChapter.click();
  await expect(reader.getByRole('alert')).toBeVisible();
  await expect(reader.getByRole('article')).toContainText('午后正文。');

  const nextSave = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().method() === 'PUT',
  );
  await nextChapter.click();
  const response = await nextSave;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ spine_index: 2 });
  await expect(reader.getByRole('article')).toContainText('夜间正文。');
  await expect(reader.getByRole('alert')).toHaveCount(0);
});

test('Esc 先关闭阅读面板，退出聚焦原书并丢弃迟到的路由请求', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `退出阅读 ${info.project.name} ${Date.now()}`;
  const { id, libraryId } = await uploadReaderFixture(page, title);
  await section(page, '书架');
  await page.getByRole('combobox', { name: '书库', exact: true }).selectOption(libraryId);
  const card = page.locator('.bookshelf-grid').getByRole('button', { name: new RegExp(title) });
  await card.click();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const reader = page.getByRole('dialog', { name: title });
  await expect(reader.getByRole('article')).toContainText('晨间正文。');
  const search = reader.getByRole('button', { name: '搜索', exact: true });
  await search.click();
  await expect(reader.getByRole('searchbox', { name: '搜索本书' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(reader).toBeVisible();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(search).toBeFocused();

  const appearance = reader.getByRole('button', { name: '排版', exact: true });
  await appearance.click();
  const tools = reader.getByRole('group', { name: '排版' });
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-appearance-light.png') });
  await tools.getByRole('button', { name: '深色纸张' }).click();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-appearance-dark.png') });
  await tools.getByRole('button', { name: '关闭' }).click();
  await expect(appearance).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(reader).not.toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: /^(继续)?阅读$/ })).toBeFocused();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await expect(card).toBeFocused();

  const details = `/api/v1/books/${id}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${details}`, async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    const requested = page.waitForRequest((request) => request.url().endsWith(details));
    await page.evaluate(() => history.forward());
    const oldRequest = await requested;
    const canceled = page.waitForEvent('requestfailed', (request) => request === oldRequest);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/$/);
    release();
    expect((await canceled).failure()?.errorText).toContain('ERR_ABORTED');
    await expect(reader).not.toBeVisible();
    await expect(card).toBeFocused();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('书架进入全屏阅读，分页保留正文与书签，深链接可刷新', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const title = `阅读夹具 ${info.project.name} ${Date.now()}`;
  const library = await page.request.post('/api/v1/book-libraries', {
    headers,
    data: { name: title },
  });
  expect(library.status()).toBe(201);
  const created = await page.request.post('/api/v1/books/upload', {
    headers,
    multipart: {
      library_id: (await library.json()).id,
      file: {
        name: `${title}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('第一章\n这段正文在滚动与分页中均可读。\n第二章\n这里可以放书签。'),
      },
    },
  });
  expect(created.status()).toBe(201);
  const book = (await created.json()).id;
  const checkpoint = await page.request.put(`/api/v1/books/${book}/reading-progress`, {
    headers,
    data: {
      session_id: 'bookshelf-fixture-session',
      device_id: 'bookshelf-fixture',
      base_version: 0,
      sequence: 1,
      spine_index: 0,
      block_index: 1,
      char_offset: 0,
    },
  });
  expect(checkpoint.status()).toBe(200);
  if (info.project.name === 'mobile') {
    await page.getByLabel('浏览方式').selectOption('books');
  } else {
    await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();
  }
  const status = page.getByLabel('阅读状态');
  await status.selectOption('unread');
  await expect(page.getByRole('button', { name: title, exact: false })).toHaveCount(0);
  await status.selectOption('in_progress');
  await expect(page.getByRole('button', { name: title, exact: false })).toBeVisible();
  await status.selectOption('all');
  const resume = page.getByRole('button', { name: `继续阅读《${title}》`, exact: true });
  await expect(resume).toBeVisible();
  await expect(
    page
      .locator('.bookshelf-grid')
      .getByRole('button', { name: new RegExp(title) })
      .locator('small'),
  ).toHaveCSS('font-size', '12px');
  await page.screenshot({ scale: 'css', path: info.outputPath('bookshelf-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('bookshelf-dark.png') });
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`/books/${book}/read$`));
  const reader = page.getByRole('dialog', { name: title });
  await expect(
    reader.getByRole('article').getByText('这段正文在滚动与分页中均可读。'),
  ).toBeVisible();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-light.png') });
  await reader.getByRole('button', { name: '分页', exact: true }).click();
  await reader.getByRole('button', { name: '排版', exact: true }).click();
  await reader.getByRole('button', { name: '深色纸张', exact: true }).click();
  await reader.getByRole('button', { name: '排版', exact: true }).click();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-dark.png') });
  await expect(
    reader.getByRole('article').getByText('这段正文在滚动与分页中均可读。'),
  ).toBeVisible();
  await reader.getByRole('button', { name: '笔记', exact: true }).click();
  await reader.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(reader.getByText('书签', { exact: true })).toBeVisible();
  await expect(reader.locator('.bookshelf-note-list')).toContainText('这段正文');
  await reader.getByRole('button', { name: /^笔记/ }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/books/${book}/reading-progress`);
      return (await response.json()).reading_mode;
    })
    .toBe('paginated');
  await page.reload();
  await expect(reader.getByRole('button', { name: '分页', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    reader.getByRole('article').getByText('这段正文在滚动与分页中均可读。'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(reader).toBeHidden();

  // Visiting a stale/deleted book deep-link redirects back to '/' cleanly instead of trapping the user with a retry error.
  await page.goto('/books/nonexistent-book-id/read');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('原链接指向的书籍已不存在，已为你返回书架列表。')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('原链接指向的书籍已不存在，已为你返回书架列表。')).toHaveCount(0);
});

test('阅读位置在滚动、分页和视口重排之间保留到字符', async ({ page }, info) => {
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const title = `重排夹具 ${info.project.name} ${Date.now()}`;
  const beginning = '这是用来跨行重排的合成文字。'.repeat(150);
  const marker = '窗边📚的灯还亮着';
  const tail = '继续阅读时还会显示正文。'.repeat(160);
  const anchor = { spine_index: 0, block_index: 1, char_offset: [...beginning].length };
  const library = await page.request.post('/api/v1/book-libraries', {
    headers,
    data: { name: title },
  });
  expect(library.status()).toBe(201);
  const created = await page.request.post('/api/v1/books/upload', {
    headers,
    multipart: {
      library_id: (await library.json()).id,
      file: {
        name: `${title}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(`第一章\n${beginning}${marker}${tail}`),
      },
    },
  });
  expect(created.status()).toBe(201);
  const book = (await created.json()).id;
  const progress = `/api/v1/books/${book}/reading-progress`;
  const saved = await page.request.put(progress, {
    headers,
    data: {
      ...anchor,
      session_id: 'bookshelf-reflow-fixture',
      device_id: 'central',
      base_version: 0,
      sequence: 1,
    },
  });
  expect(saved.status()).toBe(200);
  await page.goto(`/books/${book}/read`);
  const reader = page.getByRole('dialog', { name: title });
  const paragraph = reader.getByRole('article').getByText(marker, { exact: false });
  async function markerVisible() {
    await expect
      .poll(() =>
        paragraph.evaluate((block, text) => {
          const node = block.firstChild!;
          const offset = node.textContent!.indexOf(text);
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const glyph = range.getBoundingClientRect();
          const viewport = block.closest('[tabindex="0"]')!.getBoundingClientRect();
          return (
            glyph.right > viewport.left &&
            glyph.left < viewport.right &&
            glyph.bottom > viewport.top &&
            glyph.top < viewport.bottom
          );
        }, marker),
      )
      .toBe(true);
  }
  await markerVisible();
  await reader.getByRole('button', { name: '分页', exact: true }).click();
  await markerVisible();
  await reader.getByRole('button', { name: '排版', exact: true }).click();
  await reader.getByRole('combobox', { name: '字体' }).selectOption('sans-serif');
  await reader.getByRole('slider', { name: '字号' }).press('End');
  await reader.getByRole('slider', { name: '行距' }).press('End');
  await reader.getByRole('button', { name: '排版', exact: true }).click();
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 360, height: 740 } : { width: 1024, height: 780 },
  );
  await markerVisible();
  await reader.getByRole('button', { name: '滚动', exact: true }).click();
  await markerVisible();

  await reader.getByRole('button', { name: '笔记', exact: true }).click();
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/bookmarks') && r.request().method() === 'POST',
  );
  await reader.getByRole('button', { name: '添加书签', exact: true }).click();
  expect(await (await response).json()).toMatchObject(anchor);
  await expect
    .poll(async () => await (await page.request.get(progress)).json())
    .toMatchObject({ ...anchor, reading_mode: 'scroll' });
});

test('书库管理提供跨卷失败、导出反馈和访问受限说明', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const name = `存储边界 ${info.project.name} ${Date.now()}`;
  const library = await page.request.post('/api/v1/book-libraries', { headers, data: { name } });
  expect(library.status()).toBe(201);
  const id = (await library.json()).id;

  async function openShelf() {
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('books');
    else await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();
  }

  let release: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    /\/api\/v1\/books\?limit=100$/,
    async (route) => {
      await hold;
      await route.continue();
    },
    { times: 1 },
  );
  await openShelf();
  await expect(page.getByText('正在加载…', { exact: true })).toBeVisible();
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-loading.png') });
  release!();
  await page.getByLabel('书库', { exact: true }).selectOption(id);
  await expect(page.getByText('没有匹配的书籍')).toBeVisible();
  await expect(page.getByRole('button', { name: '扫描来源' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '迁移书库存储' })).toHaveCount(0);

  // Foreground bookshelf provides one-step direct ebook upload without any hardlink/library setup UI.
  const directTitle = `直传书目-${info.project.name}-${Date.now()}`;
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '上传电子书', exact: true }).click(),
  ]);
  await chooser.setFiles({
    name: `${directTitle}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('第一章\n选完文件立即直传。'),
  });
  await expect(page.getByRole('heading', { name: directTitle })).toBeVisible();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await expect(page.getByRole('button', { name: directTitle, exact: false })).toBeVisible();

  // Heavy library governance, storage migration and portable manifest export live in Management Center -> Bookshelf.
  await manageTab(page, '书库与存储');
  const panel = page.getByRole('region', { name: '书库与存储配置', exact: true });
  await panel.getByRole('button', { name, exact: false }).click();
  await page.route(`**/api/v1/book-libraries/${id}/migrations`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 422, json: { detail: 'hardlink_cross_device' } });
  });
  await expect(panel.getByText('/audiobooks/source', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: '迁移书库存储', exact: true }).click();
  const error = panel.getByRole('alert');
  await expect(error).toContainText('同一挂载卷');
  await expect(error).toContainText('两个独立 bind mount');
  await expect(error).toBeInViewport();
  await error.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-cross-mount.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-cross-mount-dark.png') });
  await panel.getByRole('button', { name: '导出便携元数据', exact: true }).click();
  await expect(panel.getByText('已导出 1 份清单')).toBeVisible();

  const trace = 'e1234567890abcdef1234567890abcde';
  await page.route(`**/api/v1/book-libraries/${id}/scan`, (route) =>
    route.fulfill({
      status: 409,
      headers: { 'X-Wildstring-Trace-Id': trace },
      json: { detail: 'scan_busy' },
    }),
  );
  await panel.getByRole('button', { name: '扫描来源', exact: true }).click();
  await expect(panel.getByText('书库正在扫描，完成后重试。', { exact: false })).toContainText(
    trace,
  );
  let status = 'running';
  await page.route(`**/api/v1/book-libraries/${id}/scans`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'test-job',
            status,
            scanned_files: 8,
            added_books: 2,
            updated_books: 1,
          },
        ],
      },
    }),
  );
  const running = panel.getByText('正在扫描 · 已扫描 8 个文件', { exact: false });
  await expect(running).toBeVisible();
  await running.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({
      scale: 'css',
      path: info.outputPath(`alpha3-scan-progress-${theme}.png`),
    });
  }
  for (const [next, label] of [
    ['completed_with_errors', '部分文件扫描失败'],
    ['failed', '扫描失败'],
    ['completed', '扫描完成'],
  ]) {
    status = next;
    await expect(panel.getByText(`${label} · 已扫描 8 个文件`, { exact: false })).toBeVisible({
      timeout: 7000,
    });
  }

  await manageTab(page, '元数据来源');
  const sourcesPanel = page.getByRole('region', { name: '元数据来源', exact: true });
  await expect(sourcesPanel.getByRole('checkbox', { name: 'Apple iTunes' })).toBeChecked();
  await expect(sourcesPanel.getByRole('checkbox', { name: 'Open Library' })).toBeChecked();
  await expect(sourcesPanel.getByRole('checkbox', { name: 'Google Books' })).not.toBeChecked();

  const credentials = {
    username: `shelf-${info.project.name}-${Date.now()}`,
    password: 'disposable-bookshelf-visitor',
  };
  const visitor = await page.request.post('/api/v1/manage/users', {
    headers,
    data: { ...credentials, library_ids: [] },
  });
  expect(visitor.status()).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  expect(
    (await page.request.post('/api/v1/auth/login', { headers, data: credentials })).status(),
  ).toBe(200);
  await page.reload();
  await openShelf();
  await expect(page.getByText('当前账号没有可访问的书库，请联系所有者授权。')).toBeVisible();
  await expect(page.getByRole('button', { name: '上传电子书', exact: true })).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-restricted.png') });
});

test('校对有声书章节标题后立即写入侧车', async ({ page }, info) => {
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const source = await mkdtemp(join(tmpdir(), 'wildstring-book-audio-'));
  try {
    await copyFile(
      new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url),
      join(source, 'fixture.mp3'),
    );
    const library = await page.request.post('/api/v1/book-libraries', {
      headers,
      data: { name: `章节校对 ${info.project.name} ${Date.now()}`, source_roots: [source] },
    });
    expect(library.status()).toBe(201);
    const { id, managed_root } = await library.json();
    const scan = await page.request.post(`/api/v1/book-libraries/${id}/scan`, { headers });
    expect(scan.status()).toBe(200);
    const [book] = (await (await page.request.get(`/api/v1/books?library_id=${id}`)).json()).items;
    expect(book.has_audiobook).toBe(true);
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('books');
    else await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();
    await page.getByLabel('书库', { exact: true }).selectOption(id);
    await page.getByRole('button', { name: book.title, exact: false }).click();
    const chapters = page.locator('.book-detail-chapter-list');
    await chapters
      .getByRole('button', { name: /^校对章节标题/ })
      .first()
      .click();
    await page.getByRole('textbox', { name: '章节标题' }).fill('校订后的第一章');
    await chapters.getByRole('button', { name: '保存', exact: true }).click();
    await expect(chapters).toContainText('校订后的第一章');
    const file = join(managed_root, book.id, '.wildstring', 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    expect(manifest.audiobook.chapters[0].title).toBe('校订后的第一章');
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('批注高亮渲染与删除、切页续听有声书以及受限书库成员授权', async ({ page }, info) => {
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const title = `批注与续听 ${info.project.name} ${Date.now()}`;
  const source = await mkdtemp(join(tmpdir(), 'wildstring-book-full-'));
  try {
    await copyFile(
      new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url),
      join(source, 'chapter1.mp3'),
    );
    const library = await page.request.post('/api/v1/book-libraries', {
      headers,
      data: { name: title, source_roots: [source], default_access: 'restricted' },
    });
    expect(library.status()).toBe(201);
    const lib = await library.json();
    expect(
      (await page.request.post(`/api/v1/book-libraries/${lib.id}/scan`, { headers })).status(),
    ).toBe(200);
    const uploaded = await page.request.post('/api/v1/books/upload', {
      headers,
      multipart: {
        library_id: lib.id,
        file: {
          name: `${title}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from('第一章\n这是一段用于高亮批注测试的文字内容。'),
        },
      },
    });
    expect(uploaded.status()).toBe(201);
    const ebookId = (await uploaded.json()).id;
    const ann = await page.request.post(`/api/v1/books/${ebookId}/annotations`, {
      headers,
      data: {
        spine_index: 0,
        start_block_index: 1,
        start_char_offset: 0,
        end_block_index: 1,
        end_char_offset: 4,
        selected_text: '这是一段',
        color: 'terracotta',
      },
    });
    expect(ann.status()).toBe(201);

    await page.goto(`/books/${ebookId}/read`);
    const reader = page.getByRole('dialog', { name: title });
    const mark = reader.locator('mark[data-color="terracotta"]');
    await expect(mark).toHaveText('这是一段');
    await reader.getByRole('button', { name: '笔记 (1)', exact: true }).click();
    await reader.getByRole('button', { name: '写批注 这是一段', exact: true }).click();
    await reader.getByRole('textbox', { name: '批注想法', exact: true }).fill('关键段落批注');
    await reader.getByRole('button', { name: '保存', exact: true }).click();
    await expect(reader.getByText('关键段落批注', { exact: true })).toBeVisible();
    await page.screenshot({ scale: 'css', path: info.outputPath('reader-notes-light.png') });
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/v1/books/${ebookId}/annotations`);
        return (await res.json()).items[0]?.note;
      })
      .toBe('关键段落批注');
    await reader.getByRole('button', { name: '删除 这是一段' }).click();
    await expect(mark).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '返回书架', exact: true }).click();

    // Start audiobook and switch away to Tracks -> persistent dock remains visible.
    const audioBook = (
      await (await page.request.get(`/api/v1/books?library_id=${lib.id}`)).json()
    ).items.find((item: { id: string; has_audiobook: boolean }) => item.has_audiobook);
    await page.getByLabel('书库', { exact: true }).selectOption(lib.id);
    await page.getByRole('button', { name: audioBook.title, exact: false }).click();
    const editToggle = page.getByRole('button', { name: '整理与编辑', exact: true });
    await expect(editToggle).toHaveAttribute('aria-expanded', 'false');
    await editToggle.click();
    await expect(editToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('textbox', { name: '书名' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Apple iTunes' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Open Library' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Google Books' })).toHaveCount(0);
    await page.getByRole('button', { name: '收听', exact: true }).click();
    const playerBar = page.getByRole('region', { name: '音乐播放器', exact: true });
    await expect(playerBar).toContainText(audioBook.title);
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('tracks');
    else await page.locator('.sidebar').getByRole('button', { name: '歌曲' }).first().click();
    await expect(playerBar).toContainText(audioBook.title);
    await expect(page.locator('.book-audio-dock')).toHaveCount(0);
    await playerBar.getByRole('button', { name: audioBook.title, exact: true }).first().click();
    await expect(page.getByRole('heading', { name: audioBook.title })).toBeVisible();
    await playerBar.getByRole('button', { name: '结束听书', exact: true }).click();
    await expect(playerBar).not.toContainText(audioBook.title);

    // Owner grants member access in Management UI and member sees restricted book.
    const visitorCreds = {
      username: `member-${info.project.name}-${Date.now()}`,
      password: 'disposable-member-password',
    };
    const userRes = await page.request.post('/api/v1/manage/users', {
      headers,
      data: { ...visitorCreds, library_ids: [] },
    });
    expect(userRes.status()).toBe(201);
    await manageTab(page, '书库与存储');
    const panel = page.getByRole('region', { name: '书库与存储配置', exact: true });
    await panel.getByRole('button', { name: title, exact: false }).click();
    const memberCheck = panel.getByLabel(visitorCreds.username);
    await memberCheck.scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(`/book-libraries/${lib.id}/access/`) &&
          res.request().method() === 'PUT' &&
          res.status() === 200,
      ),
      memberCheck.check(),
    ]);

    await page.request.post('/api/v1/auth/logout', { headers });
    expect(
      (await page.request.post('/api/v1/auth/login', { headers, data: visitorCreds })).status(),
    ).toBe(200);
    await page.reload();
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('books');
    else await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();
    await expect(page.getByRole('button', { name: title, exact: false })).toBeVisible();
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('有声书延迟读取进度时不覆盖原章节与倍速', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  const headers = { 'X-Wildstring-Client': 'web' };
  const title = `续听竞态 ${info.project.name} ${Date.now()}`;
  const source = await mkdtemp(join(tmpdir(), 'wildstring-book-audio-race-'));
  try {
    await copyFile(
      new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url),
      join(source, '01.mp3'),
    );
    await copyFile(
      new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url),
      join(source, '02.mp3'),
    );
    const library = await page.request.post('/api/v1/book-libraries', {
      headers,
      data: { name: title, source_roots: [source] },
    });
    expect(library.status()).toBe(201);
    const lib = await library.json();
    expect(
      (await page.request.post(`/api/v1/book-libraries/${lib.id}/scan`, { headers })).status(),
    ).toBe(200);
    const [audioBook] = (
      await (await page.request.get(`/api/v1/books?library_id=${lib.id}`)).json()
    ).items;
    expect(audioBook.has_audiobook).toBe(true);
    expect(audioBook.has_ebook).toBe(false);

    const chapterTitles = [
      '录音档案里尚未寄出的长信｜暮色降临前我们沿着海岸慢慢散步，街灯亮起来后再回去听唱片',
      'An exceptionally long title for the recording from the archive that follows every streetlight and the last train heading home',
    ];
    await page.route(`**/api/v1/books/${audioBook.id}/audiobook`, async (route) => {
      const response = await route.fetch();
      const manifest: { chapters: { title: string }[] } = await response.json();
      for (const [index, chapter] of manifest.chapters.entries()) {
        chapter.title = chapterTitles[index];
      }
      await route.fulfill({ response, json: manifest });
    });

    const progressPath = `/api/v1/books/${audioBook.id}/listening-progress`;
    const seeded = await page.request.put(progressPath, {
      headers,
      data: {
        session_id: 'audio-race-seed-0001',
        device_id: 'seed',
        base_version: 0,
        sequence: 1,
        chapter_index: 1,
        chapter_position_ms: 500,
        playback_rate: 1.25,
      },
    });
    expect(seeded.status()).toBe(200);

    await page.route(`**${progressPath}`, async (route) => {
      if (route.request().method() === 'GET') {
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      await route.continue();
    });

    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('books');
    else await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();
    await page.getByLabel('书库', { exact: true }).selectOption(lib.id);
    await page
      .locator('.bookshelf-grid')
      .getByRole('button', { name: audioBook.title, exact: false })
      .click();
    for (const title of chapterTitles)
      await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);

    await page.getByRole('button', { name: '继续收听', exact: true }).click();
    const audioEl = page.locator(`audio[src*="/api/v1/books/${audioBook.id}/audiobook/files/"]`);
    await expect(audioEl).toHaveAttribute('src', new RegExp(`/files/1/stream$`));
    await expect
      .poll(() => audioEl.evaluate((node: HTMLAudioElement) => node.playbackRate))
      .toBe(1.25);
    await expect.poll(() => audioEl.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false);

    const playerBar = page.getByRole('region', { name: '音乐播放器', exact: true });
    const slider = playerBar.getByRole('slider', { name: '播放进度' });
    await expect(slider).toHaveAttribute('aria-valuetext', /已播 \d+:\d+，总时长 \d+:\d+/);
    if (info.project.name === 'mobile') {
      const more = playerBar.getByRole('button', { name: '更多听书控制' });
      const controls = playerBar.getByRole('group', { name: '更多听书控制' });
      await more.tap();
      await expect(controls).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(controls).toBeHidden();
      await more.focus();
      await page.keyboard.press('Enter');
      const rate = controls.getByRole('combobox', { name: '播放倍速' });
      const timer = controls.getByRole('combobox', { name: '睡眠定时' });
      await expect(rate).toBeFocused();
      await rate.selectOption('1.5');
      await page.keyboard.press('Tab');
      await expect(timer).toBeFocused();
      await timer.selectOption('15');
      await expect
        .poll(() => audioEl.evaluate((node: HTMLAudioElement) => node.playbackRate))
        .toBe(1.5);
      await page.screenshot({
        scale: 'css',
        path: info.outputPath('audiobook-controls-light.png'),
      });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ scale: 'css', path: info.outputPath('audiobook-controls-dark.png') });
      await page.keyboard.press('Escape');
      await expect(controls).not.toBeVisible();
      await expect(more).toBeFocused();
      await more.tap();
      await expect(timer).toHaveValue('15');
      await timer.selectOption('0');
      await more.tap();
      await expect(controls).not.toBeVisible();
    } else {
      await playerBar.getByRole('combobox', { name: '播放倍速' }).selectOption('1.5');
      await playerBar.getByRole('button', { name: '睡眠定时设置' }).click();
      const timer = playerBar.getByRole('combobox', { name: '睡眠定时' });
      await expect(timer).toBeVisible();
      await page.screenshot({
        scale: 'css',
        path: info.outputPath('audiobook-controls-light.png'),
      });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ scale: 'css', path: info.outputPath('audiobook-controls-dark.png') });
      await timer.selectOption('15');
    }
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith(progressPath) && res.request().method() === 'PUT',
      ),
      playerBar.getByRole('button', { name: '结束听书', exact: true }).click(),
    ]);
    expect(saveResponse.status()).toBe(200);
    const saved = await (await page.request.get(progressPath)).json();
    expect(saved.chapter_index).toBe(1);
    expect(saved.playback_rate).toBe(1.5);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test('书架支持超过 100 本书的分页加载与服务端搜索筛选', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);

  const pageOneBooks = Array.from({ length: 100 }, (_, i) => ({
    id: `paged-book-${i + 1}`,
    library_id: 'paged-lib',
    title: `馆藏样本 ${String(i + 1).padStart(3, '0')}`,
    subtitle: null,
    authors: ['馆藏作者'],
    has_cover: false,
    has_ebook: true,
    has_audiobook: false,
    progress_status: 'unread' as const,
    resume_kind: null,
  }));
  const book101 = {
    id: 'paged-book-101',
    library_id: 'paged-lib',
    title: '第101本长篇小说',
    subtitle: '末页检索目标',
    authors: ['远方作者'],
    has_cover: false,
    has_ebook: true,
    has_audiobook: false,
    progress_status: 'unread' as const,
    resume_kind: null,
  };

  await page.route('**/api/v1/books?**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') || '';
    const offset = Number(url.searchParams.get('offset') || '0');
    if (q === '第101本') {
      await route.fulfill({ json: { items: [book101], total: 1, has_more: false } });
      return;
    }
    if (offset >= 100) {
      await route.fulfill({ json: { items: [book101], total: 101, has_more: false } });
      return;
    }
    await route.fulfill({ json: { items: pageOneBooks, total: 101, has_more: true } });
  });

  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('books');
  else await page.locator('.sidebar').getByRole('button', { name: '书架', exact: true }).click();

  const loadMore = page.getByRole('button', { name: '加载更多', exact: true });
  await expect(loadMore).toBeVisible();
  await loadMore.scrollIntoViewIfNeeded();
  await page.screenshot({ scale: 'css', path: info.outputPath('bookshelf-pagination-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('bookshelf-pagination-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  await loadMore.click();
  await expect(page.getByRole('button', { name: '第101本长篇小说', exact: false })).toBeVisible();
  await expect(loadMore).toHaveCount(0);

  await page.getByRole('searchbox', { name: '查找书籍', exact: true }).fill('第101本');
  await expect(page.getByRole('button', { name: '第101本长篇小说', exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '馆藏样本 001', exact: false })).toHaveCount(0);
});

test('详情编辑保留署名和系列，目录只显示语义标题', async ({ page, isMobile }, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const series = `风雪来信 ${info.project.name} ${Date.now()}`;
  const titles = [`${series} 第二卷`, `${series} 第一卷`];
  for (const [offset, title] of titles.entries()) {
    const response = await page.request.post('/api/v1/books/upload', {
      headers: bookClientHeaders,
      multipart: {
        file: {
          name: `${title}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from(
            '卷首文字\n第一季\n第一卷\n第一章\n第五个故事，重新回到西沙。\n' + '正文'.repeat(6200),
          ),
        },
      },
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    expect(
      (
        await page.request.patch(`/api/v1/books/${id}/metadata`, {
          headers: bookClientHeaders,
          data: {
            authors: ['林雨'],
            narrators: ['许舟'],
            series_name: series,
            series_index: 2 - offset,
            description: '沿途寄出的信。',
            publisher: '青山出版社',
          },
        })
      ).ok(),
    ).toBeTruthy();
  }
  await section(page, '书架');
  await page.getByRole('button', { name: titles[0] }).click();
  await expect(page.getByText('作者 · 林雨')).toBeVisible();
  await expect(page.getByText('演播 · 许舟')).toBeVisible();
  await page.getByText('简介', { exact: true }).click();
  await expect(page.getByText('沿途寄出的信。')).toBeVisible();
  await page.locator('.book-detail-information summary').filter({ hasText: series }).click();
  const seriesButtons = page.locator('.book-series-list button');
  await expect(seriesButtons).toHaveText([`${titles[1]} · 第 1 卷`, `${titles[0]} · 第 2 卷`]);
  await expect(page.locator('.book-detail-chapter-play')).toHaveText([
    '第一季',
    '第一卷',
    '第一章',
  ]);
  await expect(page.getByRole('button', { name: '第一卷', exact: true })).toHaveAttribute(
    'data-level',
    '2',
  );
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ scale: 'css', path: info.outputPath(`alpha3-metadata-${theme}.png`) });
    await page
      .locator('.book-chapters-section')
      .evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ scale: 'css', path: info.outputPath(`alpha3-contents-${theme}.png`) });
    await page.getByRole('heading', { name: titles[0], exact: true }).scrollIntoViewIfNeeded();
  }
  await page.getByRole('button', { name: '整理与编辑' }).click();
  await expect(page.getByRole('textbox', { name: '出版社' })).not.toBeVisible();
  await page.getByText('更多信息', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '出版社' })).toHaveValue('青山出版社');
  await page.getByRole('textbox', { name: '演播', exact: true }).fill('南北');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.getByRole('textbox', { name: '演播', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      scale: 'css',
      path: info.outputPath(`alpha3-metadata-edit-${theme}.png`),
    });
  }
  await page.locator('.book-edit-panel form').first().getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('演播 · 南北')).toBeVisible();
  await seriesButtons.first().click();
  await expect(page.getByRole('heading', { name: titles[1], exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第一卷', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('第一卷', { exact: true }).first()).toBeVisible();
});

test('书目快捷操作与书库删除走独立确认和个人进度', async ({ page, isMobile }, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const title = `管理回归 ${info.project.name} ${Date.now()}`;
  const { id, libraryId } = await uploadReaderFixture(page, title);
  await section(page, '书架');
  await page.getByLabel('书库', { exact: true }).selectOption(libraryId);
  const card = page
    .locator('.bookshelf-grid li')
    .filter({ has: page.locator(`[data-book-id="${id}"]`) });
  const actions = card.getByRole('button', { name: '书目操作' });
  await actions.click();
  await page.screenshot({ scale: 'css', path: info.outputPath('management-card-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('management-card-dark.png') });
  await card.getByRole('button', { name: '标记为已完成' }).click();
  await expect(card.getByRole('button').first()).toContainText('已完成');
  await actions.click();
  await card.getByRole('button', { name: '从继续阅读/收听中移除' }).click();
  await expect(card.getByRole('button').first()).toContainText('未开始');

  await card.locator('[data-book-id]').click();
  await page.getByRole('button', { name: '整理与编辑' }).click();
  const manage = page.locator('.book-edit-panel');
  const menu = manage.getByRole('button', { name: '书目操作' });
  await menu.click();
  const rescan = page.waitForResponse((response) => response.url().endsWith(`/books/${id}/rescan`));
  await manage.getByRole('button', { name: '重新扫描' }).click();
  expect((await rescan).status()).toBe(200);
  await menu.click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('保留导入源文件');
    await dialog.dismiss();
  });
  await manage.getByRole('button', { name: '删除书目' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await menu.click();
  page.once('dialog', (dialog) => dialog.accept());
  const deleted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/books/${id}`) && response.request().method() === 'DELETE',
  );
  await manage.getByRole('button', { name: '删除书目' }).click();
  expect((await deleted).status()).toBe(204);
  await expect(page.getByRole('heading', { name: title })).toHaveCount(0);
  await expect(card).toHaveCount(0);
  expect((await page.request.get(`/api/v1/books/${id}`)).status()).toBe(404);
  await manageTab(page, '书库与存储');
  const library = page.getByRole('region', { name: '书库与存储配置' });
  await library.getByRole('button', { name: title, exact: false }).click();
  await library.getByText('书库操作', { exact: true }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('导入源文件会保留');
    await dialog.accept();
  });
  await library.getByRole('button', { name: '删除书库', exact: true }).click();
  await expect(library.getByRole('button', { name: title, exact: false })).toHaveCount(0);
});

test('书架导入治理：配置、待确认文件和单书快捷处置', async ({ page, isMobile }, info) => {
  test.setTimeout(60000);
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const source = await mkdtemp(join(tmpdir(), 'wildstring-book-intake-'));
  const name = `扫描治理 ${info.project.name} ${Date.now()}`;
  const evidence = fileURLToPath(new URL('../../../artifacts/bookshelf-phase1/', import.meta.url));
  const headers = bookClientHeaders;
  const title = '潮汐档案';
  const long = '这是一份保留原文供管理员对照的长文件名_扫描后可以编辑简介再保存.txt';
  const note = '[b]一次沿海声音的采集记录。[/b]\n\n仅供试听，请在 24 小时内删除。';
  try {
    const first = join(source, title);
    const second = join(source, '北岸手记');
    await mkdir(first);
    await mkdir(second);
    const sample = new URL('../../../tests/fixtures/audio/playback.mp3', import.meta.url);
    await Promise.all([
      copyFile(sample, join(first, '01.mp3')),
      copyFile(sample, join(second, '01.mp3')),
      writeFile(join(first, 'metadata.json'), JSON.stringify({ title })),
      writeFile(join(second, 'metadata.json'), JSON.stringify({ title: '北岸手记' })),
      writeFile(join(first, long), note),
      writeFile(join(first, '短篇.txt'), '这份短篇需要由管理员确认后入库。'),
      writeFile(join(first, '临时备注.txt'), '本书的一条待忽略备注。'),
      writeFile(join(first, 'Release.txt'), '第一份同类发行说明。'),
      writeFile(join(second, 'RELEASE.TXT'), '第二份同类发行说明。'),
      writeFile(join(second, '不要导入.nfo.txt'), '第一章\n匹配规则，即使带章节标题也应跳过。'),
      mkdir(evidence, { recursive: true }),
    ]);

    const created = await page.request.post('/api/v1/book-libraries', {
      headers,
      data: { name, source_roots: [source], paused_source_roots: [source] },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const base = `/api/v1/book-libraries/${id}`;

    async function capture(view: string, selector: string) {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((value) => {
          localStorage.setItem('wildstring-theme', value);
          window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
        }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page
          .locator(selector)
          .first()
          .evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
        if (isMobile && view === 'queue') {
          await page.getByRole('button', { name: '保存简介' }).evaluate((element) => {
            element.scrollIntoView({ block: 'end', behavior: 'instant' });
          });
        }
        await page.screenshot({
          path: join(evidence, `${info.project.name}-${theme}-${view}.png`),
          scale: 'css',
          animations: 'disabled',
        });
      }
    }

    await manageTab(page, '书库与存储');
    const panel = page.getByRole('region', { name: '书库与存储配置', exact: true });
    await panel.getByRole('button', { name, exact: false }).click();
    const mode = panel.getByLabel('外部侧车兼容');
    const rules = panel.getByLabel('扫描忽略规则');
    await mode.selectOption('off');
    await rules.fill('*.nfo.txt');
    const save = () =>
      Promise.all([
        page.waitForResponse((res) => res.url().endsWith(base) && res.request().method() === 'PUT'),
        panel.getByRole('button', { name: '保存书库' }).click(),
      ]);
    const [off] = await save();
    expect((await off.json()).external_metadata_mode).toBe('off');
    expect((await off.json()).ignore_patterns).toEqual(['*.nfo.txt']);
    await mode.selectOption('sanitized');
    const [sanitized] = await save();
    expect((await sanitized.json()).external_metadata_mode).toBe('sanitized');
    await capture('policy', '.music-library-manager form');

    const queue = panel.getByRole('region', { name: /^待确认文件/ });
    await expect(queue.getByText('此状态下没有文件')).toBeVisible();
    await Promise.all([
      page.waitForResponse((res) => res.url().endsWith(`${base}/scan`) && res.status() === 200),
      panel.getByRole('button', { name: '扫描来源', exact: true }).click(),
    ]);
    await expect(queue.getByRole('heading')).toHaveText('待确认文件（5 项待处理）');
    const longFile = queue.locator('details').filter({ hasText: long });
    await longFile.locator('summary').click();
    await expect(longFile.getByText('一次沿海声音的采集记录。', { exact: true })).toBeVisible();
    await longFile.getByRole('button', { name: '原文', exact: true }).click();
    await expect(longFile.getByText(/24 小时内删除/)).toBeVisible();
    await longFile.getByRole('button', { name: '清洗预览' }).click();
    await longFile.getByRole('button', { name: '吸收为简介' }).click();
    await longFile.getByLabel('简介', { exact: true }).fill('管理员编辑后的沿海采集记录。');
    await capture('queue', '.book-intake');
    await longFile.getByRole('button', { name: '保存简介' }).click();
    await expect(longFile).toHaveCount(0);

    const release = queue.locator('details').filter({ hasText: `${title}/Release.txt` });
    await release.locator('summary').click();
    await release.getByRole('button', { name: '忽略所有同名文件' }).click();
    await expect(queue.getByRole('heading')).toHaveText('待确认文件（2 项待处理）');
    await expect(rules).toHaveValue('*.nfo.txt\nRelease.txt');
    await queue.getByLabel('状态').selectOption('ignored');
    await expect(queue.locator('details')).toHaveCount(2);
    await expect(queue.getByText('北岸手记/RELEASE.TXT', { exact: true })).toBeVisible();

    let releaseQueue!: () => void;
    const held = new Promise<void>((resolve) => (releaseQueue = resolve));
    await page.route(
      `**${base}/skipped-files?*`,
      async (route) => {
        await held;
        await route.fulfill({ status: 503, json: { detail: 'book_scan_file_unavailable' } });
      },
      { times: 1 },
    );
    try {
      await queue.getByLabel('状态').selectOption('pending');
      await expect(queue.getByRole('status')).toHaveText('正在加载…');
    } finally {
      releaseQueue();
    }
    await expect(queue.getByRole('alert')).toContainText('有来源文件无法读取');
    await queue.getByRole('button', { name: '重试' }).click();
    await expect(queue.locator('details')).toHaveCount(2);

    await section(page, '书架');
    await page.getByLabel('书库', { exact: true }).selectOption(id);
    await page
      .locator('.bookshelf-grid')
      .getByRole('button', { name: new RegExp(title) })
      .click();
    const detail = page.locator('.book-detail');
    const accordion = detail.locator('.book-intake-detail');
    await accordion.locator(':scope > summary').click();
    const ebook = accordion.locator('details').filter({ hasText: '短篇.txt' });
    await ebook.locator('summary').click();
    await ebook.getByRole('button', { name: '作为电子书导入' }).click();
    await expect(ebook.getByLabel('目标书目')).toHaveValue(/.+/);
    await capture('detail', '.book-intake-detail');
    await ebook.getByRole('button', { name: '确认导入' }).click();
    await expect(detail.getByRole('button', { name: '阅读', exact: true })).toBeVisible();
    const temporary = accordion.locator('details').filter({ hasText: '临时备注.txt' });
    await temporary.locator('summary').click();
    await temporary.getByRole('button', { name: '忽略', exact: true }).click();
    await expect(accordion).toHaveCount(0);
    await detail
      .locator('summary')
      .filter({ hasText: /^简介$/ })
      .click();
    await expect(detail.getByText('管理员编辑后的沿海采集记录。', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(page.getByRole('article')).toContainText('这份短篇需要由管理员确认后入库。');
    await page.getByRole('button', { name: '返回书籍' }).click();
    await page.getByRole('button', { name: '返回书架', exact: true }).click();
    await page
      .locator('.bookshelf-grid')
      .getByRole('button', { name: /北岸手记/ })
      .click();
    await expect(detail.getByRole('heading', { name: '北岸手记' })).toBeVisible();
    await expect(detail.locator('.book-intake-detail')).toHaveCount(0);
    await writeFile(join(second, '权限备注.txt'), '仅管理员能查看的待处理备注。');
    expect((await page.request.post(`${base}/scan`, { headers })).ok()).toBeTruthy();
    const credentials = {
      username: `intake-${info.project.name}-${Date.now()}`,
      password: 'disposable-intake-listener-password',
    };
    const visitor = await page.request.post('/api/v1/manage/users', {
      headers,
      data: { ...credentials, profile: 'listener', library_ids: [] },
    });
    expect(visitor.status(), await visitor.text()).toBe(201);
    expect(
      (
        await page.request.put(`${base}/access/${(await visitor.json()).id}`, {
          headers,
          data: { granted: true },
        })
      ).status(),
    ).toBe(200);
    await page.request.post('/api/v1/auth/logout', { headers });
    expect(
      (await page.request.post('/api/v1/auth/login', { headers, data: credentials })).status(),
    ).toBe(200);
    await page.reload();
    await section(page, '书架');
    await page.getByLabel('书库', { exact: true }).selectOption(id);
    await page
      .locator('.bookshelf-grid')
      .getByRole('button', { name: /北岸手记/ })
      .click();
    await expect(detail.getByRole('heading', { name: '北岸手记' })).toBeVisible();
    await expect(detail.locator('.book-intake-detail')).toHaveCount(0);
    expect((await page.request.get(`${base}/skipped-files`, { headers })).status()).toBe(403);
    expect(await readFile(join(first, long), 'utf8')).toBe(note);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
