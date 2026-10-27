import { expect, test, type Page } from '@playwright/test';
import { audio, login, section, podcastCatalog } from './helpers';

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

async function openRadio(page: Page) {
  await login(page);
  for (let i = 1; i <= 6; i++) {
    const current = await (
      await page.request.get(`/api/v1/podcasts/episodes/radio-${i}/progress`)
    ).json();
    const reset = await page.request.put(`/api/v1/podcasts/episodes/radio-${i}/progress`, {
      headers: { 'X-Wildstring-Client': 'web' },
      data: {
        session_id: crypto.randomUUID(),
        device_id: 'test-reset',
        base_version: current.version,
        sequence: 1,
        position_seconds: i === 4 ? 25 : i === 3 ? 2 : 0,
        duration_seconds: 25,
        event: i === 4 ? 'ended' : 'play',
      },
    });
    expect(reset.status()).toBe(200);
  }
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await page.locator('.episode-play-btn').first().click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.programme-track')).toHaveCount(3);
  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
}

test('播放缓存设置可保存并在重新打开后保留', async ({ page }) => {
  await login(page);
  await podcastCatalog(page);
  await page.getByRole('button', { name: '⚡ 播放缓存', exact: true }).click();
  await page.getByRole('radio', { name: '允许所有网络', exact: true }).check();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/podcasts/playback-settings') &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const response = await saved;
  expect(await response.json()).toMatchObject({ network_policy: 'any' });
  expect(response.status()).toBe(200);
  await page.getByRole('button', { name: '⚡ 播放缓存', exact: true }).click();
  await expect(page.getByRole('radio', { name: '允许所有网络', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('服务器下载设置可保存重试选项，个人策略另设入口', async ({ page }, info) => {
  await login(page);
  await podcastCatalog(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('.podcast-card-menu-btn').first().click();
    const item = page.locator('.podcast-context-item').filter({ hasText: '服务器下载与存储设置' });
    await item.hover();
    await expect(item).toHaveCSS(
      'color',
      theme === 'light' ? 'rgb(42, 43, 37)' : 'rgb(238, 234, 226)',
    );
    await expect(item).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(230, 231, 220)' : 'rgb(48, 49, 43)',
    );
    const contrast = await item.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value: string) => {
        const rgb = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((n) => n / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: `../../artifacts/podcast-menu-${theme}-${info.project.name}.png`,
      animations: 'disabled',
    });
    await page.getByRole('heading', { name: '电台 · 播客', exact: true }).click();
  }
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await page.getByRole('button', { name: '存储与下载设置…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '下载与存储', exact: true });
  await expect(dialog.getByText('已下载单集', { exact: true })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      path: `../../artifacts/podcast-storage-${theme}-${info.project.name}.png`,
    });
  }
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog).toContainText('个人自动下载请使用节目的「自动下载」');
  await dialog.getByText('下载速度与重试', { exact: true }).click();
  await dialog.getByRole('checkbox', { name: /平缓下载/ }).check();
  await dialog.getByLabel('失败后重试').selectOption('5');
  await dialog.getByLabel('首次重试等待').selectOption('10');
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/settings') && response.request().method() === 'PUT',
  );
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect((await response.json()).podcast).toMatchObject({
    download_policy: 'none',
    retention_policy: 'keep',
    slow_download: true,
    max_retries: 5,
    retry_backoff_base: 10,
  });
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '存储与下载设置…', exact: true }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await dialog.getByText('下载速度与重试', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /平缓下载/ })).toBeChecked();
  await expect(dialog.getByLabel('失败后重试')).toHaveValue('5');
  await expect(dialog.getByLabel('首次重试等待')).toHaveValue('10');
  await dialog.getByRole('button', { name: '关闭下载与存储', exact: true }).click();
});

test('单集首次显示服务器已有，切换全部后跨页面和刷新保留选择', async ({ page }) => {
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  const scope = page.getByRole('group', { name: '单集范围' });
  await expect(scope.getByRole('button', { name: '服务器已有 6' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.podcast-episode-row')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '在线单集：还没有下载', exact: true })).toHaveCount(
    0,
  );
  await scope.getByRole('button', { name: '全部单集 7' }).click();
  await expect(page.locator('.podcast-episode-row')).toHaveCount(7);
  await section(page, '全部歌曲');
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await expect(scope.getByRole('button', { name: '全部单集 7' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await expect(page.locator('.podcast-episode-row')).toHaveCount(7);
  await scope.getByRole('button', { name: '服务器已有 6' }).click();
  await expect(page.locator('.podcast-episode-row')).toHaveCount(6);
});

test('单集右键和更多菜单可以立即播放、插入下一集、追加待播', async ({ page }, info) => {
  await openRadio(page);
  await page.getByRole('button', { name: '收起全屏播放' }).click();
  const row = (number: number) =>
    page.locator('.podcast-episode-row').filter({ hasText: `第 ${number} 集` });
  if (info.project.name === 'desktop') await row(2).click({ button: 'right' });
  else
    await row(2)
      .getByRole('button', { name: /更多操作/ })
      .click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    '播放单集',
    '下一集播放',
    '加入待播',
    '保存到服务器',
  ]);
  await menu.getByRole('menuitem', { name: '下一集播放', exact: true }).click();
  await expect(menu).toHaveCount(0);
  expect((await audio(page)).paused).toBe(true);
  expect((await audio(page)).source).toContain('/episodes/radio-6/stream');
  await row(3)
    .getByRole('button', { name: /更多操作/ })
    .click();
  await menu.getByRole('menuitem', { name: '加入待播', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.programme-track').first()).toContainText('第 2 集');
  await expect(page.locator('.programme-track').nth(1)).toContainText('第 3 集');
  await expect(page.locator('.programme-track').first()).toContainText('手动添加');
  await page.getByRole('button', { name: '收起全屏播放' }).click();
  await row(1)
    .getByRole('button', { name: /更多操作/ })
    .click();
  await menu.getByRole('menuitem', { name: '播放单集', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-1/stream');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
});

test('下载管理可切换状态，昼夜配色可读且窄屏不溢出', async ({ page }, info) => {
  await login(page);
  await podcastCatalog(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await page.getByRole('button', { name: '下载管理', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '下载管理', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('当前没有下载任务', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '需重试 0', exact: true }).click();
    await expect(dialog.getByText('没有需要重试的单集', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '已完成 0', exact: true }).click();
    await expect(dialog.getByText('暂无已完成记录', { exact: true })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const contrast = await dialog.evaluate((el) => {
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(el).backgroundColor);
      const text = luminance(getComputedStyle(el.querySelector('p')!).color);
      return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: `../../artifacts/podcast-download-${theme}-${info.project.name}.png`,
    });
    await dialog.getByRole('button', { name: '关闭下载管理' }).press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('真实接口：顺序切换、跳过已听完、偏好恢复，收起界面后仍可续播', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().includes('/api/'))
      failures.push(`${response.status()} ${response.url()} ${response.request().postData()}`);
  });
  await openRadio(page);
  await expect(page.locator('.programme-track').first()).toContainText('第 5 集');
  await expect(page.locator('.programme-track').nth(1)).toContainText('第 3 集');
  await page.getByLabel('播客续播顺序').selectOption('asc');
  await expect(page.locator('.programme-track')).toHaveCount(0);
  await page.getByLabel('播客续播顺序').selectOption('off');
  await expect(page.getByText('听完这一集，让耳朵休息一下。')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.getByLabel('播客续播顺序')).toHaveValue('off');
  await page.getByLabel('播客续播顺序').selectOption('desc');
  await expect(page.locator('.programme-track')).toHaveCount(3);
  await page.getByRole('button', { name: '收起全屏播放' }).click();
  await page.getByRole('button', { name: '下一集', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-5/stream');
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.programme-track').first()).toContainText('第 3 集');
  await page.getByRole('button', { name: '收音机暂停' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('切换接下来播放面板后左侧收音机仍保留', async ({ page }) => {
  await openRadio(page);
  const radio = page.locator('.retro-radio');
  await expect(radio).toBeVisible();
  await page.getByRole('button', { name: '显示接下来播放', exact: true }).click();
  await expect(radio).toBeVisible();
  await page.getByRole('button', { name: '显示接下来播放', exact: true }).click();
  await expect(radio).toBeVisible();
});

test('昼夜主题、真实调谐和音量、时间码跳转、断点进度与屏幕边界', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openRadio(page);
  const tuner = page.getByRole('slider', { name: '收音机调谐进度', exact: true });
  await tuner.fill('6');
  await expect.poll(async () => Math.floor((await audio(page)).time)).toBe(6);
  const volume = page.getByRole('slider', { name: '收音机音量', exact: true });
  await volume.fill('0.35');
  await expect.poll(async () => (await audio(page)).volume).toBeCloseTo(0.35);
  const playbackRate = page.locator('select[aria-label="播放倍速"]:visible').last();
  await playbackRate.selectOption('1.5');
  await expect.poll(async () => (await audio(page)).playbackRate).toBeCloseTo(1.5);
  await page.locator('.newspaper-body .podcast-timecode').first().click();
  await expect.poll(async () => Math.floor((await audio(page)).time)).toBe(5);
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/podcasts/radio-test');
        return (await response.json()).episodes.find((e: { id: string }) => e.id === 'radio-6')
          .position_seconds;
      },
      { timeout: 12000 },
    )
    .toBe(5);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.fullscreen-player')).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(230, 225, 214)' : 'rgb(36, 38, 36)',
    );
    const radio = await page.locator('.retro-radio').boundingBox();
    const paper = await page.locator('.radio-newspaper').boundingBox();
    if (info.project.name === 'desktop') expect(Math.abs(radio!.y - paper!.y)).toBeLessThan(1);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBeTruthy();
    await page.locator('.podcast-stage').evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: `../../artifacts/radio-${theme}-${info.project.name}.png` });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '收音机播放' }).click();
  await expect(page.locator('.retro-vu-window i').first()).toHaveCSS('animation-name', 'none');
  expect(errors).toEqual([]);
});

test('倍速即时生效、切集刷新保留，音乐正常速度且播客偏好不丢失', async ({ page }) => {
  await openRadio(page);
  const fullscreen = page.getByRole('dialog', { name: '播客全屏播放', exact: true });
  const speed = fullscreen.getByLabel('播放倍速', { exact: true });
  for (const value of ['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2']) {
    await speed.selectOption(value);
    await expect.poll(async () => (await audio(page)).playbackRate).toBe(Number(value));
  }
  await speed.selectOption('1.5');
  await fullscreen.getByRole('button', { name: '下一集', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-5/stream');
  await expect.poll(async () => (await audio(page)).playbackRate).toBe(1.5);
  await fullscreen.getByRole('button', { name: '收音机暂停', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(speed).toHaveValue('1.5');
  await expect.poll(async () => (await audio(page)).playbackRate).toBe(1.5);
  expect((await audio(page)).paused).toBe(true);
  await page.getByRole('button', { name: '收起全屏播放' }).click();
  await section(page, '全部歌曲');
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).playbackRate).toBe(1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await page.locator('.episode-play-btn').first().click();
  await expect.poll(async () => (await audio(page)).playbackRate).toBe(1.5);
});

test('跳转边界、按钮中心对齐和报纸自适应宽度', async ({ page }, info) => {
  await openRadio(page);
  const fullscreen = page.getByRole('dialog', { name: '播客全屏播放', exact: true });
  await fullscreen.getByRole('button', { name: '前进30秒', exact: true }).click();
  await expect
    .poll(async () => {
      const state = await audio(page);
      return Math.abs(state.time - (state.duration - 0.05));
    })
    .toBeLessThan(0.1);
  await fullscreen.getByRole('button', { name: '后退15秒', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBe(0);
  await page.mouse.move(0, 0);
  const sizes =
    info.project.name === 'desktop'
      ? [
          { width: 1440, height: 1000 },
          { width: 1280, height: 720 },
          { width: 1024, height: 768 },
        ]
      : [page.viewportSize()!];
  for (const size of sizes) {
    await page.setViewportSize(size);
    const centers = await fullscreen.locator('.podcast-transport > button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return box.y + box.height / 2;
      }),
    );
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    await expect(fullscreen.locator('.retro-antenna')).toHaveCount(0);
    await expect(fullscreen.getByRole('complementary', { name: '节目档案' })).toHaveCount(0);
    const bodyBox = await fullscreen.locator('.newspaper-body').boundingBox();
    const headerBox = await fullscreen.locator('.newspaper-article-header').boundingBox();
    expect(Math.abs(headerBox!.width - bodyBox!.width)).toBeLessThan(1);
    expect(Math.abs(headerBox!.x - bodyBox!.x)).toBeLessThan(1);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    const footer = await fullscreen.locator('.fullscreen-controls').boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(size.height + 1);
    await page.screenshot({ path: `../../artifacts/radio-layout-${size.width}.png` });
  }
});

test('自然播完标记完成并自动接续，手动添加优先且半途单集继续播放', async ({ page }) => {
  await openRadio(page);
  await page.getByRole('button', { name: '收起全屏播放' }).click();
  await page.locator('.episode-title-button').filter({ hasText: '第 3 集' }).click();
  await page.getByRole('button', { name: '加入待播', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.programme-track').first()).toContainText('第 3 集');
  await expect(page.locator('.programme-track').first()).toContainText('手动添加');
  const duration = (await audio(page)).duration;
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .last()
    .fill((duration - 0.2).toFixed(1));
  await page.getByRole('button', { name: '收音机播放' }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-3/stream');
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '收音机暂停' }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/podcasts/radio-test');
      return (await response.json()).episodes.find((e: { id: string }) => e.id === 'radio-6')
        .completed;
    })
    .toBe(true);
});
