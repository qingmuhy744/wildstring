import { expect, test } from '@playwright/test';
import { audio, login } from './helpers';

test('默认询问，确认后暂停恢复，不回写；播放后暂停自动保存', async ({ page }) => {
  let state = {
    version: 0,
    device_id: '',
    track_ids: [] as string[],
    index: 0,
    position_ms: 0,
    mode: 'sequential',
    updated_at: null as string | null,
  };
  const writes: (typeof state)[] = [];
  await page.route('**/api/v1/playback/state', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.version !== state.version)
        return route.fulfill({ status: 409, json: { detail: 'playback_version_conflict' } });
      state = { ...body, version: state.version + 1, updated_at: new Date().toISOString() };
    }
    return route.fulfill({ json: state });
  });
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  state = {
    ...state,
    version: 7,
    device_id: 'another-device',
    track_ids: tracks.map((track: { id: string }) => track.id),
    position_ms: 3000,
  };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const dialog = page.getByRole('region', { name: '跨设备接续', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.getByRole('searchbox').fill('提示出现时仍能搜索');
  await expect(page.getByRole('searchbox')).toBeFocused();
  expect(writes).toHaveLength(0);
  await dialog.getByRole('button', { name: '载入进度', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await audio(page)).time).toBeCloseTo(3, 1);
  expect((await audio(page)).paused).toBe(true);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  await page.locator('audio').evaluate((element: HTMLAudioElement) => {
    element.currentTime = 5;
  });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => writes.at(-1)?.position_ms || 0).toBeGreaterThanOrEqual(4900);
  expect(writes.at(-1)?.track_ids).toEqual(state.track_ids);
});

test('接续可关闭或自动恢复，同一版本不重复弹窗', async ({ page }, info) => {
  let state = {
    version: 0,
    device_id: 'another',
    track_ids: [] as string[],
    index: 0,
    position_ms: 1000,
    mode: 'repeat_all',
    updated_at: null,
  };
  await page.route('**/api/v1/playback/state', (route) => route.fulfill({ json: state }));
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  state = { ...state, version: 20, track_ids: tracks.map((track: { id: string }) => track.id) };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const dialog = page.getByRole('region', { name: '跨设备接续', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '暂不', exact: true }).click();
  state = { ...state, version: 21, position_ms: 1500 };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '暂不', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog).toHaveCount(0);
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('devices');
  else {
    await page.locator('.sidebar').getByText('更多音乐', { exact: true }).click();
    await page.getByRole('button', { name: '跨设备继续', exact: true }).click();
  }
  const mode = page.getByLabel('跨设备接续方式', { exact: true });
  await expect(mode).toHaveValue('ask');
  await mode.selectOption('off');
  state = { ...state, version: 22, position_ms: 2000 };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog).toHaveCount(0);
  await mode.selectOption('auto');
  await expect.poll(async () => (await audio(page)).time).toBeCloseTo(2, 1);
  expect((await audio(page)).paused).toBe(true);
  await expect(dialog).toHaveCount(0);
});
