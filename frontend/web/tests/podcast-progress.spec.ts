import { expect, test, type Page } from '@playwright/test';
import { audio, login, section } from './helpers';

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
  await section(page, '电台 · 播客');
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

test('离线进度跨刷新保留，旧设备补传不覆盖新设备，用户可选择回听', async ({ page }) => {
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
  expect((await local(page)).dirty).toBe(true);
  const newer = await otherDevice(page, 8);
  await page.unroute('**/podcasts/episodes/*/progress');
  await page.reload();
  await expect.poll(async () => (await local(page))?.conflict).toBe(true);
  expect(await state(page)).toEqual(newer);
  expect((await audio(page)).paused).toBe(true);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '播客单集进度' });
  await expect(dialog).toContainText('已同步至 0:08 · 本机听到 0:03');
  await dialog.getByRole('button', { name: '继续本机 0:03', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await state(page)).position_seconds).toBeLessThan(6);
  expect((await state(page)).version).toBeGreaterThan(newer.version);
  expect((await local(page)).conflict).toBe(false);
});

test('加入待播和刷新不抢占进度；开始收听时才询问并接续', async ({ page }) => {
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
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '播客单集进度' });
  await expect(dialog).toContainText('继续收听这集？');
  await dialog.getByRole('button', { name: '继续 0:07', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(7);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await state(page)).session_id).not.toBe(saved.session_id);
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
  await next
    .getByRole('dialog', { name: '播客单集进度' })
    .getByRole('button', { name: '继续 0:06', exact: true })
    .click();
  await expect.poll(async () => (await audio(next)).paused).toBe(false);
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
