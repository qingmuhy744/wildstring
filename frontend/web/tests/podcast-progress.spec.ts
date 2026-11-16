import { expect, test, type Page } from '@playwright/test';
import { audio, login, podcastCatalog, personalSettings, section } from './helpers';

test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Use make test-podcast-web.');
const path = '/api/v1/podcasts/episodes/radio-6/progress';
async function state(page: Page) {
  return (await page.request.get(path)).json();
}
async function otherDevice(page: Page, position: number) {
  const old = await state(page);
  const response = await page.request.put(path, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: {
      session_id: crypto.randomUUID(),
      device_id: 'second-device',
      base_version: old.version,
      sequence: 1,
      position_seconds: position,
      duration_seconds: 25,
      event: 'play',
    },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
async function episodes(page: Page) {
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
}
async function start(page: Page) {
  await page.locator('.episode-play-btn').first().click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
}
async function local(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith('wildstring:podcast-progress:') && key.endsWith(':radio-6'),
    );
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}

test('播放中定时保存、暂停和主动倒退立即同步，不污染音乐接续', async ({ page }) => {
  await login(page, { automaticSync: true });
  await otherDevice(page, 0);
  const music = await (await page.request.get('/api/v1/playback/state')).json();
  const musicWrites: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/(playback\/state|listening|recommendations\/feedback)(\?|$)/.test(request.url())
    )
      musicWrites.push(request.url());
  });
  await episodes(page);
  await start(page);
  // The synthetic audio is twelve seconds long; slow it down to observe a heartbeat before EOF.
  await page.locator('audio').evaluate((element: HTMLAudioElement) => {
    element.playbackRate = 0.5;
  });
  await expect
    .poll(async () => (await state(page)).position_seconds, { timeout: 17000 })
    .toBeGreaterThanOrEqual(2);
  expect((await local(page))?.event).toBe('progress');
  expect((await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await state(page);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect.poll(async () => (await state(page)).position_seconds).toBe(2);
  const rewind = await state(page);
  expect(rewind.version).toBeGreaterThan(before.version);
  expect(rewind.completed).toBe(false);
  await expect(page.locator('.podcast-episode-row').first()).toContainText('已听至 0:02');
  expect(musicWrites).toEqual([]);
  expect(await (await page.request.get('/api/v1/playback/state')).json()).toEqual(music);
});

test('历史离线记录发生冲突时丢弃并按服务器进度重新播放', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  await page.route('**/podcasts/episodes/*/progress', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('3');
  await expect.poll(async () => (await local(page))?.position_seconds).toBe(3);
  const newer = await otherDevice(page, 8);
  await page.unroute('**/podcasts/episodes/*/progress');
  await page.reload();
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  expect((await local(page)).conflict).toBe(false);
  expect(await state(page)).toEqual(newer);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(8);
  expect((await state(page)).session_id).not.toBe(newer.session_id);
});

test('加入待播和刷新不抢占进度；默认自动接续开始收听', async ({ page }) => {
  await login(page);
  const saved = await otherDevice(page, 7);
  await episodes(page);
  await page
    .locator('.podcast-episode-row')
    .first()
    .getByRole('button', { name: /更多操作/ })
    .click();
  await page.getByRole('menuitem', { name: '加入待播', exact: true }).click();
  await expect(page.getByRole('button', { name: '全屏播放', exact: true })).toBeVisible();
  expect(await state(page)).toEqual(saved);
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  expect((await audio(page)).paused).toBe(true);
  expect(await state(page)).toEqual(saved);
  await episodes(page);
  await page.locator('.episode-play-btn').first().click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(7);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await state(page)).session_id).not.toBe(saved.session_id);
});

test('配置为询问模式时，开始收听弹窗询问并接续', async ({ page }) => {
  await login(page);
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'ask' },
  });
  await page.reload();
  const saved = await otherDevice(page, 7);
  await episodes(page);
  await page
    .locator('.podcast-episode-row')
    .first()
    .getByRole('button', { name: /更多操作/ })
    .click();
  await page.getByRole('menuitem', { name: '加入待播', exact: true }).click();
  await expect(page.getByRole('button', { name: '全屏播放', exact: true })).toBeVisible();
  expect(await state(page)).toEqual(saved);
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  expect((await audio(page)).paused).toBe(true);
  expect(await state(page)).toEqual(saved);
  await episodes(page);
  await page.locator('.episode-play-btn').first().click();
  const dialog = page.getByRole('dialog', { name: '播客单集进度' });
  await expect(dialog).toContainText('继续收听这集？');
  await dialog.getByRole('button', { name: '继续 0:07', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(7);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await state(page)).session_id).not.toBe(saved.session_id);
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
});

test('同一浏览器另一个标签页接手后，原页面主动回听仍能保存', async ({ page, context }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('6');
  await expect.poll(async () => (await state(page)).position_seconds).toBe(6);
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  const first = await state(page);
  const next = await context.newPage();
  await next.goto('/');
  await expect(next.locator('.app-shell')).toBeVisible();
  await next.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(next)).paused).toBe(false);
  await expect.poll(async () => (await audio(next)).time).toBeGreaterThanOrEqual(6);
  // Metadata restoration can emit a late seek checkpoint. Finish it before pausing,
  // then wait for the pause itself, rather than the already-synced play checkpoint.
  await expect
    .poll(() =>
      next.locator('audio').evaluate((element: HTMLAudioElement) => ({
        seeking: element.seeking,
        restored: element.currentTime >= 6,
      })),
    )
    .toEqual({ seeking: false, restored: true });
  await next.getByRole('button', { name: '暂停', exact: true }).click();
  await expect
    .poll(async () => {
      const checkpoint = await local(next);
      return checkpoint?.event === 'pause' && !checkpoint.dirty;
    })
    .toBe(true);
  const second = await state(next);
  expect(second.session_id).not.toBe(first.session_id);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect.poll(async () => (await state(page)).position_seconds).toBe(2);
  expect((await state(page)).version).toBeGreaterThan(second.version);
  expect((await state(page)).session_id).not.toBe(second.session_id);
  await next.close();
});

test('发生设备冲突后继续收听仍保存本机位置，暂停不会覆盖远端', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  const newer = await otherDevice(page, 8);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  await expect
    .poll(async () => (await local(page))?.position_seconds, { timeout: 8000 })
    .toBeGreaterThan(3);
  expect((await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await local(page)).position_seconds).toBeGreaterThan(3);
  expect((await local(page)).dirty).toBe(true);
  expect(await state(page)).toEqual(newer);
});

test('冲突后拖动不接管，显式接管再次 409 只发送一次，之后可成功接管', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  const remote = await otherDevice(page, 8);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  const notice = page.getByRole('status').filter({ hasText: '本机进度暂不同步到服务器' });
  await expect(notice).toBeVisible();
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('4');
  expect(await state(page)).toEqual(remote);
  let writes = 0;
  await page.route('**/podcasts/episodes/radio-6/progress', async (route) => {
    if (route.request().method() === 'PUT') {
      writes++;
      const sameDevice = {
        ...remote,
        device_id: (await local(page)).remote.device_id,
        version: remote.version + 1,
      };
      await route.fulfill({
        status: 409,
        json: { detail: { code: 'podcast_progress_conflict', current: sameDevice } },
      });
    } else await route.continue();
  });
  await notice.getByRole('button', { name: '用本机进度' }).click();
  await expect.poll(() => writes).toBe(1);
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  await page.waitForTimeout(1200);
  expect(writes).toBe(1);
  expect((await local(page)).intent).toBe('resume');
  await page.unroute('**/podcasts/episodes/radio-6/progress');
  // Refresh the observed version through a new real conflict before the next takeover.
  await notice.getByRole('button', { name: '用本机进度' }).click();
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  await notice.getByRole('button', { name: '用本机进度' }).click();
  await expect.poll(async () => (await local(page))?.conflict).toBe(false);
  await expect(notice).toHaveCount(0);
});

test('已听完点播和菜单从头播放都发送 restart', async ({ page }) => {
  await login(page);
  await episodes(page);
  const requests: { intent?: string; event: string }[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith(path)) requests.push(req.postDataJSON());
  });
  const row = page.locator('.podcast-episode-row').first();
  await row.getByRole('button', { name: /更多操作/ }).click();
  await page.getByRole('menuitem', { name: '标为已听完' }).click();
  await expect.poll(async () => (await state(page)).completed).toBe(true);
  await row.locator('.episode-play-btn').click();
  await expect
    .poll(() => requests.some((body) => body.event === 'play' && body.intent === 'restart'))
    .toBe(true);
  await expect.poll(async () => (await state(page)).completed).toBe(false);
  await row.getByRole('button', { name: /更多操作/ }).click();
  await page.getByRole('menuitem', { name: '从头播放' }).click();
  await expect
    .poll(
      () => requests.filter((body) => body.event === 'play' && body.intent === 'restart').length,
    )
    .toBeGreaterThanOrEqual(2);
});

test('账号续听模式读取、失败不缓存及刷新', async ({ page }) => {
  await login(page);
  const modePath = '/api/v1/podcasts/resume-mode';
  await page.evaluate(() => localStorage.setItem('wildstring:podcast-resume:admin', 'restart'));
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'ask' },
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('wildstring:podcast-resume-account:admin')),
    )
    .toBe('ask');
  await personalSettings(page, 'downloads');
  const select = page.getByLabel('播客单集接续');
  await expect(select).toHaveValue('ask');
  await page.route('**/podcasts/resume-mode', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 500 }) : route.continue(),
  );
  await select.selectOption('restart');
  await expect(page.getByRole('alert')).toContainText('保存失败');
  await expect(select).toHaveValue('ask');
  expect(
    await page.evaluate(() => localStorage.getItem('wildstring:podcast-resume-account:admin')),
  ).toBe('ask');
  await page.unroute('**/podcasts/resume-mode');
  await select.selectOption('auto');
  await expect
    .poll(async () => (await (await page.request.get(modePath)).json()).resume_mode)
    .toBe('auto');
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'ask' },
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(select).toHaveValue('ask');
  await section(page, '电台 · 播客');
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'restart' },
  });
  await personalSettings(page, 'downloads');
  await expect(select).toHaveValue('restart');
  await page.route('**/podcasts/resume-mode', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await personalSettings(page, 'downloads');
  await expect(select).toHaveValue('restart');
  await page.unroute('**/podcasts/resume-mode');
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
});

test('当前会话的同设备冲突仅重试这一次写入', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await expect
    .poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => !element.seeking))
    .toBe(true);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect
    .poll(async () => {
      const record = await local(page);
      return record?.event === 'pause' && !record.dirty;
    })
    .toBe(true);
  const previous = await state(page);
  const device = await page.evaluate(() => localStorage.getItem('wildstring:device:admin'));
  const competing = await page.request.put(path, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: {
      session_id: crypto.randomUUID(),
      device_id: device,
      base_version: previous.version,
      sequence: 1,
      position_seconds: 8,
      duration_seconds: 25,
      event: 'play',
    },
  });
  expect(competing.status()).toBe(200);
  const writes: { sequence: number; position_seconds: number; intent: string }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(path))
      writes.push(request.postDataJSON());
  });
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect.poll(async () => (await state(page)).position_seconds).toBe(2);
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  expect(writes).toHaveLength(2);
  expect(writes.map((write) => write.position_seconds)).toEqual([2, 2]);
  expect(writes.every((write) => write.intent === 'resume')).toBe(true);
  await expect(page.getByRole('button', { name: '用本机进度' })).toHaveCount(0);
});

test('本机缓存不可写时账号模式仍保存到服务器并更新控件', async ({ page }) => {
  await login(page);
  const modePath = '/api/v1/podcasts/resume-mode';
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
  await personalSettings(page, 'downloads');
  const select = page.getByLabel('播客单集接续');
  await expect(select).toHaveValue('auto');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('wildstring:podcast-resume-account:'))
        throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await select.selectOption('ask');
  await expect
    .poll(async () => (await (await page.request.get(modePath)).json()).resume_mode)
    .toBe('ask');
  await expect(select).toHaveValue('ask');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.request.put(modePath, {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
});

test('进度读取失败仍持久化新会话，联网后首次心跳上报', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  await page.reload();
  await episodes(page);
  let puts = 0;
  await page.route('**/podcasts/episodes/radio-6/progress', (route) => {
    if (route.request().method() === 'PUT') puts++;
    return route.abort('internetdisconnected');
  });
  await start(page);
  const checkpoint = await local(page);
  expect(checkpoint.intent).toBe('resume');
  expect(checkpoint.session_id).toBeTruthy();
  expect(checkpoint.dirty).toBe(true);
  expect(puts).toBe(0);
  await page.unroute('**/podcasts/episodes/radio-6/progress');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  expect((await state(page)).session_id).toBe(checkpoint.session_id);
});

test('离线启动未知版本，联网后按异设备冲突保留本地进度', async ({ page }) => {
  await login(page);
  const remote = await otherDevice(page, 8);
  await episodes(page);
  await page.route('**/podcasts/episodes/radio-6/progress', (route) =>
    route.abort('internetdisconnected'),
  );
  await start(page);
  expect((await local(page)).base_version).toBe(0);
  await page.unroute('**/podcasts/episodes/radio-6/progress');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  await expect(page.getByRole('button', { name: '用本机进度' })).toBeVisible();
  expect(await state(page)).toEqual(remote);
});

test('续听界面桌面与手机浅深主题视觉证据', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  test.setTimeout(90000);
  await login(page);
  await otherDevice(page, 7);
  await episodes(page);
  const shot = async (name: string) => {
    for (const width of [1360, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (name === 'menu') {
        const trigger = page
          .locator('.podcast-episode-row')
          .first()
          .getByRole('button', { name: /更多操作/ });
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        await expect(page.getByRole('menuitem', { name: '从头播放' })).toBeInViewport();
      }
      if (name.startsWith('settings'))
        await page.getByLabel('播客单集接续').scrollIntoViewIfNeeded();
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          localStorage.setItem('wildstring-theme', value);
          window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
        }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.screenshot({
          path: `../../artifacts/resume-${name}-${width}-${theme}.png`,
          animations: 'disabled',
        });
      }
      if (name === 'menu') await page.keyboard.press('Escape');
    }
  };
  await expect(page.locator('.podcast-episode-row').first()).toBeVisible();
  await shot('show');
  await shot('menu');
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'ask' },
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('wildstring:podcast-resume-account:admin')),
    )
    .toBe('ask');
  await page.locator('.episode-play-btn').first().click();
  const dialog = page.getByRole('dialog', { name: '播客单集进度' });
  await expect(dialog).toBeVisible();
  await shot('dialog');
  await dialog.getByRole('button', { name: '继续 0:07' }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await otherDevice(page, 8);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: '用本机进度' })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  await shot('conflict');
  await page.getByRole('button', { name: '用本机进度' }).click();
  await expect(page.getByRole('button', { name: '用本机进度' })).toHaveCount(0);
  await personalSettings(page, 'downloads');
  await expect(page.getByLabel('播客单集接续')).toHaveValue('ask');
  await expect(page.locator('.toast')).toHaveCount(0);
  await shot('settings');
  await page.route('**/podcasts/resume-mode', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 500 }) : route.continue(),
  );
  await page.getByLabel('播客单集接续').selectOption('restart');
  await expect(page.getByRole('alert')).toContainText('保存失败');
  await shot('settings-error');
  await page.unroute('**/podcasts/resume-mode');
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
});

test('历史记录即使撞上同设备 409 也只丢弃，不重试', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  await page.route('**/podcasts/episodes/radio-6/progress', (route) => route.abort());
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('3');
  await expect.poll(async () => (await local(page))?.dirty).toBe(true);
  const old = await state(page);
  const device = await page.evaluate(() => localStorage.getItem('wildstring:device:admin'));
  const newer = await (
    await page.request.put(path, {
      headers: { 'X-Wildstring-Client': 'web' },
      data: {
        session_id: crypto.randomUUID(),
        device_id: device,
        base_version: old.version,
        sequence: 1,
        position_seconds: 8,
        duration_seconds: 25,
        event: 'play',
      },
    })
  ).json();
  await page.unroute('**/podcasts/episodes/radio-6/progress');
  await page.reload();
  await expect.poll(async () => (await local(page))?.dirty).toBe(false);
  expect((await local(page)).conflict).toBe(false);
  expect(await state(page)).toEqual(newer);
});

test('账号模式从头播放时自动续播下一集仍使用 resume', async ({ page }) => {
  await login(page);
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'restart' },
  });
  const prefs = await (await page.request.get('/api/v1/podcasts/queue/preferences')).json();
  await page.request.put('/api/v1/podcasts/queue/preferences', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: {
      ...prefs,
      auto_continue: true,
      shows: {
        ...prefs.shows,
        'radio-test': {
          action: 'queue_last',
          auto_limit: 3,
          order: 'follow',
          skip_completed: false,
          auto_continue: true,
        },
      },
    },
  });
  await page.reload();
  await episodes(page);
  const writes: { id: string; intent: string; event: string }[] = [];
  page.on('request', (req) => {
    const match = req.url().match(/\/podcasts\/episodes\/(radio-\d+)\/progress$/);
    if (match && req.method() === 'PUT') writes.push({ id: match[1], ...req.postDataJSON() });
  });
  await start(page);
  await expect
    .poll(() =>
      writes.some(
        (write) => write.id === 'radio-6' && write.event === 'play' && write.intent === 'restart',
      ),
    )
    .toBe(true);
  await expect.poll(async () => (await audio(page)).duration).toBeGreaterThan(0);
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
    audio.currentTime = audio.duration - 0.05;
  });
  await expect
    .poll(
      () =>
        writes.some(
          (write) => write.id === 'radio-5' && write.event === 'play' && write.intent === 'resume',
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await page.request.put('/api/v1/podcasts/resume-mode', {
    headers: { 'X-Wildstring-Client': 'web' },
    data: { resume_mode: 'auto' },
  });
});

test('页面未刷新时先读取服务器进度再出声', async ({ page }) => {
  await login(page);
  await otherDevice(page, 7);
  await episodes(page);
  let release!: () => void;
  let observed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route('**/podcasts/episodes/radio-6/progress', async (route) => {
    if (route.request().method() === 'GET') {
      observed();
      await waiting;
    }
    await route.continue();
  });
  await page.locator('.episode-play-btn').first().click();
  await seen;
  expect((await audio(page)).paused).toBe(true);
  release();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(7);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
});

test('切回标签页刷新节目并限制 30 秒内重复请求', async ({ page }) => {
  await login(page);
  await episodes(page);
  let requests = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/v1/podcasts/radio-test')) requests++;
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(250);
  expect(requests).toBe(0);
  await page.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 31000;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(250);
  expect(requests).toBe(1);
});

test('冲突后标记已听完显式接管，后续拖动仍保留完成状态', async ({ page }) => {
  await login(page);
  await otherDevice(page, 0);
  await episodes(page);
  await start(page);
  await expect
    .poll(() =>
      page
        .locator('audio')
        .evaluate((element: HTMLAudioElement) => element.readyState >= 1 && !element.seeking),
    )
    .toBe(true);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect
    .poll(async () => {
      const record = await local(page);
      return record?.event === 'pause' && !record.dirty;
    })
    .toBe(true);
  await otherDevice(page, 8);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: '用本机进度' })).toBeVisible();
  await page
    .locator('.podcast-episode-row')
    .first()
    .getByRole('button', { name: /更多操作/ })
    .click();
  await page.getByRole('menuitem', { name: '标为已听完' }).click();
  await expect(page.getByRole('button', { name: '用本机进度' })).toHaveCount(0);
  const marked = await state(page);
  expect(marked.completed).toBe(true);
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('3');
  await expect.poll(async () => (await state(page)).position_seconds).toBe(3);
  expect((await state(page)).session_id).toBe(marked.session_id);
  expect((await state(page)).completed).toBe(true);
});
