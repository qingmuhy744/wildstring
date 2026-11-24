import { expect, test } from '@playwright/test';
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
