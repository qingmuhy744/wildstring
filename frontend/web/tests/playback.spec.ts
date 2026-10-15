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

test('歌曲与专辑切换、真实封面和专辑曲号顺序', async ({ page }) => {
  await login(page);
  const cover = page.getByRole('table').locator('img').first();
  await expect
    .poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '专辑', exact: true })
    .click();
  const album = page.getByRole('button', { name: '打开专辑 合成测试专辑', exact: true });
  await expect(album).toBeVisible();
  await expect(album).toContainText('2 首');
  await expect
    .poll(() => album.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await album.click();
  await expect(page.getByRole('heading', { name: '合成测试专辑', exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('晴天测试曲');
  await page.getByRole('button', { name: '播放专辑', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await expect(page.getByRole('region', { name: '音乐播放器' })).toContainText('晴天测试曲');
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '歌曲', exact: true })
    .click();
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('夜晚测试曲');
  expect((await audio(page)).paused).toBe(false);
});

test('同名 LRC、歌词点击跳转、跟随高亮与切歌后的内嵌歌词', async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(panel).toContainText('同名 LRC · 逐行同步');
  await expect(panel.locator('[aria-current="true"]')).toHaveText('侧车第一行');
  await panel.getByRole('button', { name: '跳转到 0:06：侧车第三行', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(5.9);
  await expect(panel.locator('[aria-current="true"]')).toHaveText('侧车第三行');
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  await panel.locator('.lyric-scroll').hover();
  await page.mouse.wheel(0, 120);
  await expect(panel.getByRole('button', { name: '跟随播放', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '跟随播放', exact: true }).click();
  await expect(panel.getByRole('button', { name: '跟随播放', exact: true })).toBeDisabled();
  await page.screenshot({ path: `../../artifacts/lyrics-${testInfo.project.name}.png` });
  await panel.getByRole('button', { name: '收起全屏播放' }).click();
  await page.getByRole('button', { name: '播放 夜晚测试曲', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(panel).toContainText('内嵌歌词 · 逐行同步');
  await expect(panel.locator('[aria-current="true"]')).toHaveText('内嵌第一行');
  await expect(panel).not.toContainText('侧车第一行');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('纯文本和缺失歌词不阻断播放', async ({ page }) => {
  await login(page);
  await page.route('**/tracks/*/lyrics', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'plain',
        source: 'embedded',
        lines: [{ time_ms: null, text: '纯文本没有虚构时间轴' }],
      }),
    }),
  );
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await page.getByRole('button', { name: '显示歌词', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(panel).toContainText('内嵌歌词 · 纯文本');
  await expect(panel).toContainText('纯文本没有虚构时间轴');
  await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
  await page.unroute('**/tracks/*/lyrics');
  await page.route('**/tracks/*/lyrics', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"kind":"none","source":null,"lines":[]}',
    }),
  );
  await panel.getByRole('button', { name: '重新读取歌词' }).click();
  await expect(panel).toContainText('暂无本地歌词');
  expect((await audio(page)).paused).toBe(false);
});

test('全屏展开收起连续播放、切歌、焦点边界与 Esc 返回', async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.3);
  const before = await audio(page);
  const element = await page.locator('audio').elementHandle();
  const entry = page.getByRole('button', { name: '全屏播放', exact: true });
  await entry.click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize()!;
      return (
        !!box &&
        Math.abs(box.x) < 1 &&
        Math.abs(box.y) < 1 &&
        Math.abs(box.width - viewport.width) < 1 &&
        Math.abs(box.height - viewport.height) < 1
      );
    })
    .toBe(true);
  await expect(dialog.getByRole('button', { name: '收起全屏播放' })).toBeFocused();
  expect(await element!.evaluate((node) => node === document.querySelector('audio'))).toBe(true);
  expect((await audio(page)).source).toBe(before.source);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(before.time);
  expect((await audio(page)).paused).toBe(false);
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const paused = await audio(page);
  await dialog.getByRole('button', { name: '收起全屏播放' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entry).toBeFocused();
  expect((await audio(page)).time).toBeCloseTo(paused.time, 1);
  expect((await audio(page)).paused).toBe(true);
  await entry.click();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '收起全屏播放' })).toBeFocused();
  await dialog.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).not.toBe(before.source);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
    true,
  );
  await expect(dialog).toContainText('同名 LRC · 逐行同步');
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await dialog.getByLabel('播放进度').focus();
  await dialog.getByLabel('播放进度').press('Home');
  for (let step = 0; step < 20; step += 1) await dialog.getByLabel('播放进度').press('ArrowRight');
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(1.9);
  const changed = await audio(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await audio(page)).source).toBe(changed.source);
  expect((await audio(page)).time).toBeCloseTo(changed.time, 1);
  await expect(entry).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  if (testInfo.project.name === 'mobile') {
    await entry.click();
    await page.setViewportSize({ width: 667, height: 375 });
    await expect(dialog.getByRole('button', { name: '收起全屏播放' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});
