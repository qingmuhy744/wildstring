import { expect, test } from '@playwright/test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login } from './helpers';

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
    await page.getByLabel('浏览方式').selectOption('podcasts');
  } else {
    await page.getByRole('button', { name: /电台/ }).first().click();
  }
  await page.getByRole('button', { name: '书架', exact: true }).click();
  const status = page.getByLabel('阅读状态');
  await status.selectOption('unread');
  await expect(page.getByRole('button', { name: title, exact: false })).toHaveCount(0);
  await status.selectOption('in_progress');
  await expect(page.getByRole('button', { name: title, exact: false })).toBeVisible();
  await status.selectOption('all');
  const resume = page.getByRole('button', { name: `继续阅读《${title}》`, exact: true });
  await expect(resume).toBeVisible();
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
  await reader.getByRole('button', { name: '深色纸张', exact: true }).click();
  await page.screenshot({ scale: 'css', path: info.outputPath('reader-dark.png') });
  await expect(
    reader.getByRole('article').getByText('这段正文在滚动与分页中均可读。'),
  ).toBeVisible();
  await reader.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(reader.getByText('书签', { exact: true })).toBeVisible();
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
  await reader.getByRole('combobox', { name: '字体' }).selectOption('sans-serif');
  await reader.getByRole('slider', { name: '字号' }).press('End');
  await reader.getByRole('slider', { name: '行距' }).press('End');
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 360, height: 740 } : { width: 1024, height: 780 },
  );
  await markerVisible();
  await reader.getByRole('button', { name: '滚动', exact: true }).click();
  await markerVisible();

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
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('podcasts');
    else await page.getByRole('button', { name: /电台/ }).first().click();
    await page.getByRole('button', { name: '书架', exact: true }).click();
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
  await page.getByRole('button', { name: '管理书库' }).click();
  await page.getByText('迁移书库存储', { exact: true }).first().click();
  await page.route(`**/api/v1/book-libraries/${id}/migrations`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 422, json: { detail: 'hardlink_cross_device' } });
  });
  await page.getByRole('button', { name: '迁移书库存储', exact: true }).click();
  const error = page.getByRole('alert');
  await expect(error).toContainText('同一挂载卷');
  await expect(error).toBeInViewport();
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-cross-mount.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ scale: 'css', path: info.outputPath('storage-cross-mount-dark.png') });
  await page.getByRole('button', { name: '导出便携元数据' }).click();
  await expect(page.getByText('已导出 0 份清单')).toBeVisible();

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
  await expect(page.getByRole('button', { name: '管理书库' })).toHaveCount(0);
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
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('podcasts');
    else await page.getByRole('button', { name: /电台/ }).first().click();
    await page.getByRole('button', { name: '书架', exact: true }).click();
    await page.getByLabel('书库', { exact: true }).selectOption(id);
    await page.getByRole('button', { name: book.title, exact: false }).click();
    await page.getByRole('button', { name: '收听', exact: true }).click();
    await page.getByText('校对章节标题', { exact: true }).click();
    await page.getByRole('textbox', { name: '章节标题' }).fill('校订后的第一章');
    const headings = page.locator('.book-audio');
    await headings.getByRole('button', { name: '保存', exact: true }).click();
    await expect(headings.getByRole('combobox', { name: '目录' })).toContainText('校订后的第一章');
    const file = join(managed_root, book.id, '.wildstring', 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    expect(manifest.audiobook.chapters[0].title).toBe('校订后的第一章');
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
