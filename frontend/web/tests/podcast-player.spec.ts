import { expect, test, type Page } from '@playwright/test';
import { audio, login, section, podcastCatalog, leaveSettings, manageTab } from './helpers';

test.describe.configure({ timeout: 90_000 });

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

async function resetPodcastQueue(page: Page) {
  const current = await (await page.request.get('/api/v1/podcasts/queue')).json();
  const cleared = await page.request.put('/api/v1/podcasts/queue', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { version: current.version, device_id: 'podcast-player-spec', items: [] },
  });
  expect(cleared.ok()).toBeTruthy();
  const prefs = await (await page.request.get('/api/v1/podcasts/queue/preferences')).json();
  const saved = await page.request.put('/api/v1/podcasts/queue/preferences', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: {
      default_action: prefs.default_action,
      auto_limit: prefs.auto_limit,
      auto_continue: true,
      shows: {
        ...prefs.shows,
        'radio-test': {
          action: prefs.shows?.['radio-test']?.action ?? prefs.default_action ?? 'inbox',
          auto_limit: prefs.shows?.['radio-test']?.auto_limit ?? prefs.auto_limit ?? 3,
          order: 'follow',
          skip_completed: true,
          auto_continue: true,
        },
      },
    },
  });
  expect(saved.ok()).toBeTruthy();
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith('wildstring:podcast-order:') ||
        key.startsWith('wildstring:podcast-account:')
      ) {
        localStorage.removeItem(key);
      }
    }
  });
}

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
  await resetPodcastQueue(page);
  await page.reload();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  const queued = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/podcasts/queue') && response.request().method() === 'PUT',
  );
  await page.locator('.episode-play-btn').first().click();
  expect((await queued).ok()).toBeTruthy();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.programme-track')).toHaveCount(3);
  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
}

async function audioDuration(page: Page) {
  let duration = NaN;
  await expect
    .poll(async () => {
      duration = (await audio(page)).duration;
      return Number.isFinite(duration) && duration > 0;
    })
    .toBe(true);
  return duration;
}

test('待播列表可从节目列表和详情直接打开', async ({ page }) => {
  await login(page);
  await podcastCatalog(page);
  for (const detail of [false, true]) {
    if (detail) await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await page.getByRole('button', { name: '待播列表', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '待播列表' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    if (await dialog.isVisible())
      await page.locator('.podcasts-modal-backdrop').click({ position: { x: 2, y: 2 } });
    await expect(dialog).toBeHidden();
  }
});

test('播放缓存设置可保存并在重新打开后保留', async ({ page }) => {
  await login(page);
  await podcastCatalog(page);
  await page.locator('.podcasts-more-trigger').click();
  await page.getByRole('button', { name: '播放缓存', exact: true }).click();
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
  await page.locator('.podcasts-more-trigger').click();
  await page.getByRole('button', { name: '播放缓存', exact: true }).click();
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
      theme === 'light' ? 'rgb(42, 43, 37)' : 'rgb(232, 227, 217)',
    );
    await expect(item).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(230, 231, 220)' : 'rgb(52, 48, 42)',
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
    '标为已听完',
    '单集收藏',
    '保存到服务器',
  ]);
  await menu.getByRole('menuitem', { name: '标为已听完', exact: true }).click();
  await expect(row(2)).toHaveClass(/completed/);
  await expect(row(2)).toContainText('✓ 已听完');
  await page.screenshot({
    path: `../../artifacts/podcast-completed-row-${info.project.name}.png`,
  });
  await row(2)
    .getByRole('button', { name: /更多操作/ })
    .click();
  await menu.getByRole('menuitem', { name: '标为未听', exact: true }).click();
  await expect(row(2)).not.toHaveClass(/completed/);
  await row(2)
    .getByRole('button', { name: /更多操作/ })
    .click();
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
  await expect(page.locator('.programme-track')).toHaveCount(5);
  await page.locator('.programme-track').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.programme-track').last()).toBeInViewport();
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
    await manageTab(page, '下载管理');
    const dialog = page.getByRole('region', { name: '下载管理', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('当前没有下载任务', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '需重试 0', exact: true }).click();
    await expect(dialog.getByText('没有需要重试的单集', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '已完成 0', exact: true }).click();
    await expect(dialog.getByText('暂无已完成记录', { exact: true })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
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
      const background = luminance(getComputedStyle(document.documentElement).backgroundColor);
      const text = luminance(getComputedStyle(el.querySelector('p')!).color);
      return (Math.max(background, text) + 0.05) / (Math.min(background, text) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: `../../artifacts/podcast-download-${theme}-${info.project.name}.png`,
    });
    await leaveSettings(page);
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
  const savedOrder = page.waitForResponse(
    (response) =>
      response.url().includes('/podcasts/queue/preferences') &&
      response.request().method() === 'PUT' &&
      (response.request().postData() || '').includes('"order":"off"'),
  );
  await page.getByLabel('播客续播顺序').selectOption('off');
  await expect(page.getByText('已关闭，播完即停')).toBeVisible();
  expect((await savedOrder).ok()).toBeTruthy();
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
  await page.addInitScript(() => {
    AnalyserNode.prototype.getFloatTimeDomainData = function (buffer) {
      const sample = Number(document.documentElement.dataset.meterSample || 0.2);
      const pulse = document.documentElement.dataset.meterPulse === 'true';
      buffer.fill(pulse ? 0.05 : sample);
      if (pulse) buffer[0] = sample;
    };
  });
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
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
  const meter = page.locator('.retro-vu-window');
  const checkScale = async (showMinusTen: boolean) => {
    const { track, ticks, labels } = await meter.evaluate((element) => {
      const track = element.querySelector('.retro-vu-track')!.getBoundingClientRect();
      const marks = [...element.querySelectorAll('.retro-vu-tick')];
      return {
        track: { x: track.x, width: track.width },
        ticks: marks.map((mark) => {
          const box = mark.getBoundingClientRect();
          return { x: box.x + box.width / 2, height: box.height };
        }),
        labels: marks.flatMap((mark) => {
          const label = mark.querySelector('span');
          if (!label || getComputedStyle(label).display === 'none') return [];
          const box = label.getBoundingClientRect();
          return [{ text: label.textContent, x: box.x, right: box.right, y: box.y }];
        }),
      };
    });
    expect(ticks).toHaveLength(5);
    for (const [index, position] of [1 / 3, 2 / 3, 5 / 6, 0.95, 1].entries()) {
      expect(Math.abs(ticks[index].x - track.x - position * track.width)).toBeLessThan(0.5);
      expect(ticks[index].height).toBe(3);
    }
    expect(labels.map((label) => label.text)).toEqual(
      showMinusTen ? ['−40', '−20', '−10', '0'] : ['−40', '−20', '0'],
    );
    for (const [index, label] of labels.entries()) {
      expect(Math.abs(label.y - labels[0].y)).toBeLessThan(0.5);
      if (index) expect(label.x).toBeGreaterThanOrEqual(labels[index - 1].right);
    }
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.fullscreen-player')).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(230, 225, 214)' : 'rgb(38, 34, 31)',
    );
    const radio = await page.locator('.retro-radio').boundingBox();
    const paper = await page.locator('.radio-newspaper').boundingBox();
    if (info.project.name === 'desktop') expect(Math.abs(radio!.y - paper!.y)).toBeLessThan(1);
    const leftScrew = (await page.locator('.screw-left').boundingBox())!;
    const rightScrew = (await page.locator('.screw-right').boundingBox())!;
    expect(Math.abs(leftScrew.y - rightScrew.y)).toBeLessThan(0.5);
    expect(
      Math.abs(
        leftScrew.x - radio!.x - (radio!.x + radio!.width - rightScrew.x - rightScrew.width),
      ),
    ).toBeLessThan(0.5);
    const footnote = page.locator('.retro-footnote');
    const model = (await footnote.getByText('WS-56 · PORTABLE').boundingBox())!;
    expect(model.x - leftScrew.x - leftScrew.width).toBeGreaterThanOrEqual(8);
    const programme = page.getByRole('complementary', { name: '接下来播放', exact: true });
    const order = programme.getByLabel('播客续播顺序');
    await order.focus();
    const toolbar = (await programme.locator('.programme-heading').boundingBox())!;
    const select = (await order.boundingBox())!;
    expect(select.x - toolbar.x).toBeGreaterThanOrEqual(3);
    expect(toolbar.x + toolbar.width - select.x - select.width).toBeGreaterThanOrEqual(3);
    const list = (await programme.locator('.programme-list').boundingBox())!;
    expect(list.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
    expect(list.height).toBeGreaterThan(60);
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBeTruthy();
    await page.locator('.podcast-stage').evaluate((el) => el.scrollTo(0, 0));
    await checkScale(info.project.name === 'desktop');
    await page.screenshot({ path: `../../artifacts/radio-${theme}-${info.project.name}.png` });
  }
  if (info.project.name === 'desktop') {
    for (const width of [320, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await checkScale(false);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
  }
  await meter.evaluate((element) => {
    new MutationObserver(() => {
      const level = Number(element.style.getPropertyValue('--level-current'));
      const peak = Number(element.style.getPropertyValue('--level-peak'));
      if (peak < level) document.documentElement.dataset.meterViolation = 'true';
    }).observe(element, { attributes: true, attributeFilter: ['style'] });
  });
  await page.getByRole('button', { name: '收音机播放' }).click();
  // A steady sample and a brief peak both move the bar and its held marker together.
  await expect(meter).toHaveCSS('--level-current', '0.767');
  await expect(meter).toHaveCSS('--level-peak', '0.767');
  const marker = meter.locator('.retro-vu-track b');
  const track = meter.locator('.retro-vu-track');
  const markerX = await marker.evaluate((el) => el.getBoundingClientRect().x);
  const trackBox = (await track.boundingBox())!;
  expect(Math.abs(markerX - trackBox.x - 0.767 * trackBox.width)).toBeLessThan(1);
  await meter.screenshot({
    path: `../../artifacts/player-audit/radio-meter-${info.project.name}.png`,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '0.8';
    document.documentElement.dataset.meterPulse = 'true';
  });
  await expect(meter).toHaveCSS('--level-current', '0.968');
  await expect(meter).toHaveCSS('--level-peak', '0.968');
  await page.waitForTimeout(200);
  await expect(meter).toHaveCSS('--level-current', '0.968');
  await expect(meter).toHaveCSS('--level-peak', '0.968');
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '0.05';
    document.documentElement.dataset.meterPulse = 'false';
  });
  await page.waitForTimeout(200);
  await expect(meter).toHaveCSS('--level-peak', '0.968');
  await expect
    .poll(async () =>
      Number(await meter.evaluate((el) => el.style.getPropertyValue('--level-current'))),
    )
    .toBeLessThan(0.968);
  await expect
    .poll(async () =>
      Number(await meter.evaluate((el) => el.style.getPropertyValue('--level-peak'))),
    )
    .toBeLessThan(0.968);
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '0.9';
    document.documentElement.dataset.meterPulse = 'true';
  });
  await expect(meter).toHaveCSS('--level-current', '0.985');
  await expect(meter).toHaveCSS('--level-peak', '0.985');
  await page.getByRole('button', { name: '收音机暂停' }).click();
  await expect(meter).toHaveCSS('--level-current', '0.000');
  await expect(meter).toHaveCSS('--level-peak', '0.000');
  await page.getByRole('button', { name: '收音机播放' }).click();
  await expect(meter).toHaveAttribute('data-clipped', 'false');
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '1';
  });
  await expect(meter).toHaveAttribute('data-clipped', 'true');
  await expect(meter).toHaveCSS('--level-peak', '1.000');
  const endX = await marker.evaluate((el) => el.getBoundingClientRect().x);
  expect(Math.abs(endX - trackBox.x - trackBox.width)).toBeLessThan(1);
  expect(await marker.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).toBe(
    'rgb(255, 73, 59)',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '0.1';
  });
  await page.waitForTimeout(200);
  await expect(meter).toHaveCSS('--level-peak', '1.000');
  await expect
    .poll(async () =>
      Number(await meter.evaluate((el) => el.style.getPropertyValue('--level-peak'))),
    )
    .toBeLessThan(1);
  await expect(meter).toHaveAttribute('data-clipped', 'false', { timeout: 3000 });
  expect(await marker.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).toBe(
    'rgb(255, 237, 187)',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.meterSample = '1';
  });
  await expect(meter).toHaveAttribute('data-clipped', 'true');
  await page.locator('audio').evaluate((audio) => audio.dispatchEvent(new Event('waiting')));
  await expect(meter).toHaveCSS('--level-current', '0.000');
  await expect(meter).toHaveCSS('--level-peak', '0.000');
  await expect(meter).toHaveAttribute('data-clipped', 'false');
  await page.locator('audio').evaluate((audio) => audio.dispatchEvent(new Event('playing')));
  await expect(meter).toHaveCSS('--level-current', '1.000');
  await expect(meter).toHaveAttribute('data-clipped', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.retro-vu-window i').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.retro-vu-window')).toHaveCSS('--level-current', '0.000');
  await expect(page.locator('.retro-vu-window')).toHaveCSS('--level-peak', '0.000');
  await expect(meter).toHaveAttribute('data-clipped', 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(meter).toHaveCSS('--level-current', '1.000');
  await expect(meter).toHaveAttribute('data-clipped', 'true');
  await page.locator('audio').evaluate((audio) => audio.dispatchEvent(new Event('error')));
  await expect(meter).toHaveCSS('--level-current', '0.000');
  await expect(meter).toHaveCSS('--level-peak', '0.000');
  await expect(meter).toHaveAttribute('data-clipped', 'false');
  await expect(page.locator('html')).not.toHaveAttribute('data-meter-violation', 'true');
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
  const duration = await audioDuration(page);
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

test('账号级自动续播关闭且无单节目覆盖时生效，保存节目设置保留全局关闭', async ({ page }) => {
  await openRadio(page);
  // Simulate Android turning off account-level auto_continue with no per-show override for radio-test.
  const disabled = await page.request.put('/api/v1/podcasts/queue/preferences', {
    headers: { 'X-Wildstring-Client': 'android' },
    data: {
      default_action: 'inbox',
      auto_limit: 3,
      auto_continue: false,
      shows: {},
    },
  });
  expect(disabled.ok()).toBeTruthy();
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith('wildstring:podcast-order:') ||
        key.startsWith('wildstring:podcast-account:')
      ) {
        localStorage.removeItem(key);
      }
    }
  });
  await page.reload();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.getByLabel('播客续播顺序')).toHaveValue('off');
  await expect(page.getByText('已关闭，播完即停')).toBeVisible();
  await expect(page.locator('.programme-track')).toHaveCount(0);

  // Saving show delivery or show playback preference on Web must preserve account auto_continue=false.
  const putPromise = page.waitForResponse(
    (response) =>
      response.url().includes('/podcasts/queue/preferences') &&
      response.request().method() === 'PUT',
  );
  await page.getByLabel('播客续播顺序').selectOption('asc');
  const putResp = await putPromise;
  expect(putResp.ok()).toBeTruthy();
  const savedPrefs = await putResp.json();
  expect(savedPrefs.auto_continue).toBe(false);
  expect(savedPrefs.shows['radio-test']).toMatchObject({
    order: 'asc',
    auto_continue: true,
  });
});

test('音乐单曲循环不接管播客结束，跨节目队列播完后按新节目偏好自动接续', async ({ page }) => {
  await openRadio(page);

  const secondDetail = {
    podcast: {
      id: 'radio-second',
      title: '夜间故事测试',
      author: '野弦测试',
      description: '',
      feed_url: 'https://example.invalid/radio-second.xml',
      cover_url: '',
      auto_update: false,
      download_policy: 'none',
      created_at: '2026-01-01T00:00:00Z',
    },
    episodes: [1, 2, 3].map((n) => ({
      id: `radio-${n}`,
      podcast_id: 'radio-second',
      guid: `radio-${n}`,
      title: `夜间第 ${n} 集`,
      description: '',
      audio_url: 'https://example.invalid/audio.mp3',
      duration_seconds: 25,
      pub_date: `2026-02-0${n}T00:00:00Z`,
      episode_number: n,
      season_number: null,
      created_at: '2026-02-01T00:00:00Z',
      download_status: 'downloaded',
      position_seconds: 0,
      completed: false,
    })),
  };

  let remoteQueueState = {
    version: 1,
    device_id: 'test-seed',
    items: [
      { episode_id: 'radio-6', origin: 'manual' },
      { episode_id: 'radio-1', origin: 'manual' },
    ],
  };

  await page.route('**/api/v1/podcasts/radio-second', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(secondDetail),
    });
  });
  await page.route(/\/api\/v1\/podcasts\/episodes\/radio-[123]$/, async (route) => {
    const id = route.request().url().split('/').pop()!;
    const episode = secondDetail.episodes.find((ep) => ep.id === id) ?? secondDetail.episodes[0];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(episode),
    });
  });
  await page.route('**/api/v1/podcasts/queue', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(remoteQueueState),
      });
      return;
    }
    const body = route.request().postDataJSON();
    remoteQueueState = {
      version: remoteQueueState.version + 1,
      device_id: body.device_id ?? 'web',
      items: body.items ?? [],
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(remoteQueueState),
    });
  });
  await page.route('**/api/v1/podcasts/queue/preferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        default_action: 'inbox',
        auto_limit: 3,
        auto_continue: true,
        shows: {
          'radio-test': {
            action: 'inbox',
            auto_limit: 3,
            order: 'follow',
            skip_completed: true,
            auto_continue: true,
          },
          'radio-second': {
            action: 'inbox',
            auto_limit: 3,
            order: 'asc',
            skip_completed: true,
            auto_continue: true,
          },
        },
      }),
    });
  });

  // Enable music repeat_one first, then start podcast playback.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('wildstring-playback')) {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || '{}');
          localStorage.setItem(key, JSON.stringify({ ...parsed, mode: 'repeat_one' }));
        } catch {
          // ignore
        }
      }
    }
  });
  await page.reload();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await page.locator('.episode-play-btn').first().click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
  await expect(page.locator('.programme-track').first()).toContainText('夜间第 1 集');

  // 1. Finishing radio-6 (Show A) must NOT repeat radio-6 despite music repeat_one; it advances to queued radio-1 (Show B).
  const firstDuration = await audioDuration(page);
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .last()
    .fill((firstDuration - 0.2).toFixed(1));
  await page.getByRole('button', { name: '收音机播放' }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-1/stream');
  await expect(page.locator('.programme-track').first()).toContainText('夜间第 2 集');
  await page.getByRole('button', { name: '收音机暂停' }).click();

  // 2. Now on Show B (radio-1) with explicit queue empty after radio-1 finishes: must auto-continue to radio-2 per Show B's 'asc' preference.
  const secondDuration = await audioDuration(page);
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .last()
    .fill((secondDuration - 0.2).toFixed(1));
  await page.getByRole('button', { name: '收音机播放' }).click();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-2/stream');
  await page.getByRole('button', { name: '收音机暂停' }).click();
  expect(remoteQueueState.items).toEqual([]);
});

test('单集行快捷待播切换、统一待播列表一键播放及底栏队列续播预览', async ({ page }, info) => {
  await login(page);
  await podcastCatalog(page);
  // Clear remote queue and add radio-4 to inbox for testing unified pending list
  const headers = { 'X-Wildstring-Client': 'web' };
  const currentQueue = await (await page.request.get('/api/v1/podcasts/queue')).json();
  const clearResp = await page.request.put('/api/v1/podcasts/queue', {
    headers,
    data: { version: currentQueue.version, device_id: 'test-reset', items: [] },
  });
  expect(clearResp.ok()).toBeTruthy();
  const inboxResp = await page.request.put('/api/v1/podcasts/inbox/items/radio-4', {
    headers,
  });
  expect(inboxResp.ok()).toBeTruthy();

  await page.reload();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  await expect(page.locator('.podcast-meta-card').getByLabel('新集自动待播')).toBeVisible();
  await page.getByRole('button', { name: /全部单集/ }).click();

  const row = (number: number) =>
    page.locator('.podcast-episode-row').filter({ hasText: `第 ${number} 集` });

  // 1. Quick inline "+ 待播" on episode rows (also adopts onto idle player so Play is enabled)
  await row(6).getByRole('button', { name: '+ 待播', exact: true }).click();
  await expect(row(6).getByRole('button', { name: '✓ 已待播', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('.player').getByRole('button', { name: '播放', exact: true }),
  ).toBeEnabled();
  await row(5).getByRole('button', { name: '+ 待播', exact: true }).click();
  await expect(row(5).getByRole('button', { name: '✓ 已待播', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '▶ 播放待播 (2)', exact: true })).toBeVisible();

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await page.screenshot({
      path: `../../artifacts/podcast-inline-queue-${theme}-${info.project.name}.png`,
    });
  }

  // 2. Clicking "✓ 已待播" removes the episode from the queue
  await row(5).getByRole('button', { name: '✓ 已待播', exact: true }).click();
  await expect(row(5).getByRole('button', { name: '+ 待播', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '▶ 播放待播 (1)', exact: true })).toBeVisible();

  // 3. Open unified "待播列表" dialog: shows unified "待播单集" (queue + inbox) & "新集自动加入待播"
  await page.getByRole('button', { name: '待播列表', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '待播列表' });
  const pendingRegion = dialog.getByRole('region', { name: '待播单集' });
  await expect(pendingRegion.locator('.podcast-inbox-item strong')).toHaveText([
    '第 6 集',
    '第 4 集',
  ]);
  await expect(dialog.getByRole('button', { name: '▶ 播放全部', exact: true })).toBeVisible();

  // Reorder "第 4 集" above "第 6 集", reopen dialog, and verify manual order does not snap back to added_at
  const reorderSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/podcasts/queue') && response.request().method() === 'PUT',
  );
  await pendingRegion.getByRole('button', { name: /上移.*第 4 集/ }).click();
  await reorderSave;
  await expect(pendingRegion.locator('.podcast-inbox-item strong')).toHaveText([
    '第 4 集',
    '第 6 集',
  ]);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '待播列表', exact: true }).click();
  await expect(pendingRegion.locator('.podcast-inbox-item strong')).toHaveText([
    '第 4 集',
    '第 6 集',
  ]);
  const restoreSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/podcasts/queue') && response.request().method() === 'PUT',
  );
  await pendingRegion.getByRole('button', { name: /上移.*第 6 集/ }).click();
  await restoreSave;
  await expect(pendingRegion.locator('.podcast-inbox-item strong')).toHaveText([
    '第 6 集',
    '第 4 集',
  ]);

  await dialog.getByRole('tab', { name: /新集自动加入待播/ }).click();
  const deliveryRegion = dialog.getByRole('region', { name: '新集自动加入待播' });
  await expect(deliveryRegion).toBeVisible();
  await expect(deliveryRegion.getByLabel('午后广播测试新集自动待播')).toBeVisible();
  await deliveryRegion.getByLabel('午后广播测试新集自动待播').selectOption('ignore');
  await expect(deliveryRegion.getByLabel('午后广播测试新集自动待播')).toHaveValue('ignore');
  await dialog.getByRole('tab', { name: /待播单集/ }).click();
  await dialog.screenshot({
    path: `../../artifacts/podcast-inbox-dialog-${info.project.name}.png`,
  });

  // Start playing all pending episodes via "▶ 播放全部" (also verify bottom bar hides the lyrics/detail toggle button for podcasts)
  await dialog.getByRole('button', { name: '▶ 播放全部', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await audio(page)).source).toContain('/episodes/radio-6/stream');
  await expect(page.locator('.lyrics-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();

  // 4. Open bottom-right QueuePanel: shows manual queue + 自动续播 preview
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  const queuePanel = page.getByRole('complementary', { name: '播放队列', exact: true });
  await expect(queuePanel).toBeVisible();
  await expect(queuePanel.getByRole('group', { name: '自动续播' })).toBeVisible();
  await queuePanel.screenshot({
    path: `../../artifacts/podcast-queue-panel-${info.project.name}.png`,
  });
  await queuePanel.getByRole('button', { name: '关闭队列', exact: true }).click();
});
