import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(3);
}

async function audio(page: Page) {
  return page.locator('audio').evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    time: element.currentTime,
    duration: element.duration,
    volume: element.volume,
    source: element.currentSrc,
    ended: element.ended,
  }));
}

test('登录、中文搜索、空结果与退出', async ({ page }) => {
  await login(page);
  await page.getByLabel('搜索曲库').fill('晴天');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放 晴天测试曲', exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await page.getByLabel('搜索曲库').fill('不存在的歌');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('没有找到匹配的歌曲')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  // Desktop sidebar and mobile header both expose logout.
  await page.getByRole('button', { name: '退出登录' }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
});

test('真实播放、暂停、Range 跳转、切歌与队列', async ({ page }, testInfo) => {
  await login(page);
  const range = page.waitForResponse(
    (response) => response.url().includes('/stream') && response.status() === 206,
  );
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await range;
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await audio(page)).paused).toBe(true);
  await page.getByLabel('播放进度').focus();
  await page.getByLabel('播放进度').press('Home');
  for (let step = 0; step < 50; step += 1) await page.getByLabel('播放进度').press('ArrowRight');
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(4.8);
  if (testInfo.project.name === 'desktop') {
    await page.getByLabel('音量', { exact: true }).focus();
    await page.getByLabel('音量', { exact: true }).press('Home');
    for (let step = 0; step < 30; step += 1)
      await page.getByLabel('音量', { exact: true }).press('ArrowRight');
    expect((await audio(page)).volume).toBeCloseTo(0.3);
  }
  const previous = (await audio(page)).source;
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).not.toBe(previous);
  await page.getByRole('button', { name: '上一首', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toBe(previous);
  await page.getByRole('button', { name: '将 晴天测试曲 加入队列', exact: true }).click();
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  await expect(
    page.getByRole('complementary', { name: '播放队列' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.getByRole('button', { name: '移除队列第 3 首', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: '播放队列' }).getByRole('listitem'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: '关闭队列' }).click();
  await page.getByLabel('播放进度').focus();
  await page.getByLabel('播放进度').press('End');
  await expect.poll(async () => (await audio(page)).source).not.toBe(previous);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../artifacts/playback-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('不支持的音频明确提示并可重试', async ({ page }) => {
  await login(page);
  await page.route('**/tracks/*/stream', async (route) => {
    if (route.request().method() === 'HEAD') await route.continue();
    else
      await route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        body: 'invalid audio fixture',
      });
  });
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('浏览器无法解码');
  await page.unroute('**/tracks/*/stream');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('串流遇到会话失效会返回登录页', async ({ page }) => {
  await login(page);
  await page.route('**/tracks/*/stream', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"detail":"authentication_required"}',
    }),
  );
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
});
