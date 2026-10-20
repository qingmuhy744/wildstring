import { expect, test } from '@playwright/test';
import { audio, login, section } from './helpers';

test('默认询问，确认后暂停恢复，不回写；播放后暂停自动保存', async ({ page }) => {
  let state = {
    version: 0,
    device_id: '',
    track_ids: [] as string[],
    index: 0,
    position_ms: 0,
    mode: 'sequential',
    updated_at: null as string | null,
    playback_state: 'unknown',
    paused_at: null as string | null,
    handoff_supported: true,
    handoff_eligible: false,
  };
  const writes: (typeof state)[] = [];
  await page.route('**/api/v1/playback/state', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.version !== state.version)
        return route.fulfill({ status: 409, json: { detail: 'playback_version_conflict' } });
      const paused = body.playback_state === 'paused';
      state = {
        ...state,
        ...body,
        version: state.version + 1,
        updated_at: new Date().toISOString(),
        paused_at: paused ? new Date().toISOString() : null,
        handoff_eligible: paused,
      };
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
    playback_state: 'paused',
    paused_at: new Date().toISOString(),
    handoff_eligible: true,
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
  expect(writes.some((value) => value.playback_state === 'playing')).toBe(true);
  expect(writes.at(-1)?.playback_state).toBe('paused');
});

test('接续可关闭或自动恢复，同一版本不重复弹窗', async ({ page }, info) => {
  let state = {
    version: 0,
    device_id: 'another',
    track_ids: [] as string[],
    index: 0,
    position_ms: 1000,
    mode: 'repeat_all',
    updated_at: null as string | null,
    playback_state: 'paused',
    paused_at: new Date().toISOString(),
    handoff_supported: true,
    handoff_eligible: true,
  };
  await page.route('**/api/v1/playback/state', (route) => route.fulfill({ json: state }));
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  state = { ...state, version: 20, track_ids: tracks.map((track: { id: string }) => track.id) };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const dialog = page.getByRole('region', { name: '跨设备接续', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '暂不', exact: true }).click();
  state = { ...state, version: 21, position_ms: 1500, paused_at: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
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
  state = { ...state, version: 22, position_ms: 2000, paused_at: new Date().toISOString() };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog).toHaveCount(0);
  await mode.selectOption('auto');
  await expect.poll(async () => (await audio(page)).time).toBeCloseTo(2, 1);
  expect((await audio(page)).paused).toBe(true);
  await expect(dialog).toHaveCount(0);
});

test('只提示近期暂停，同一次暂停跨刷新不重复；播放中、过期和旧协议不提示', async ({ page }) => {
  let state: any = {
    version: 0,
    device_id: 'peer',
    track_ids: [],
    index: 0,
    position_ms: 1000,
    mode: 'sequential',
    updated_at: null,
    playback_state: 'unknown',
    paused_at: null,
    handoff_supported: true,
    handoff_eligible: false,
  };
  await page.route('**/api/v1/playback/state', (route) => route.fulfill({ json: state }));
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const ids = tracks.map((track: { id: string }) => track.id);
  const notice = page.getByRole('region', { name: '跨设备接续', exact: true });
  const check = async () => {
    const response = page.waitForResponse((r) => r.url().endsWith('/api/v1/playback/state'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    await page.waitForTimeout(100);
  };
  for (const change of [
    { playback_state: 'playing', handoff_eligible: false },
    { playback_state: 'ended', handoff_eligible: false },
    { playback_state: 'paused', handoff_eligible: false, paused_at: '2000-01-01T00:00:00Z' },
    { playback_state: 'unknown', handoff_eligible: false, paused_at: null },
  ]) {
    state = { ...state, ...change, track_ids: ids, version: state.version + 1 };
    await check();
    await expect(notice).toHaveCount(0);
  }
  state = {
    ...state,
    version: 20,
    playback_state: 'paused',
    paused_at: new Date().toISOString(),
    handoff_eligible: true,
  };
  await check();
  await expect(notice).toBeVisible();
  // Seeing the offer is persisted, so reopening the app does not ask again.
  await page.reload();
  await check();
  await expect(notice).toHaveCount(0);
  state = { ...state, version: 21, position_ms: 1500 };
  await check();
  await expect(notice).toHaveCount(0);
});

test('其他设备恢复播放后撤回提示，过时的载入操作不覆盖本机队列', async ({ page }) => {
  let state: any = {
    version: 0,
    device_id: 'peer',
    track_ids: [],
    index: 0,
    position_ms: 1000,
    mode: 'sequential',
    updated_at: null,
    playback_state: 'unknown',
    paused_at: null,
    handoff_supported: true,
    handoff_eligible: false,
  };
  let writes = 0;
  await page.route('**/api/v1/playback/state', (route) => {
    if (route.request().method() === 'PUT') writes++;
    return route.fulfill({ json: state });
  });
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  state = {
    ...state,
    version: 10,
    track_ids: tracks.map((track: { id: string }) => track.id),
    playback_state: 'paused',
    paused_at: new Date().toISOString(),
    handoff_eligible: true,
  };
  const notice = page.getByRole('region', { name: '跨设备接续', exact: true });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notice).toBeVisible();
  state = {
    ...state,
    version: 11,
    playback_state: 'playing',
    handoff_eligible: false,
    paused_at: null,
  };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notice).toHaveCount(0);
  state = {
    ...state,
    version: 12,
    playback_state: 'paused',
    handoff_eligible: true,
    paused_at: new Date().toISOString(),
  };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(notice).toBeVisible();
  state = {
    ...state,
    version: 13,
    playback_state: 'playing',
    handoff_eligible: false,
    paused_at: null,
  };
  await notice.getByRole('button', { name: '载入进度', exact: true }).click();
  await expect(notice).toHaveCount(0);
  expect((await audio(page)).paused).toBe(true);
  expect(writes).toBe(0);
});

test('旧服务端不误弹，仍能手动载入并使用旧协议保存暂停进度', async ({ page }) => {
  let state: any = {
    version: 0,
    device_id: 'legacy-peer',
    track_ids: [],
    index: 0,
    position_ms: 3000,
    mode: 'sequential',
    updated_at: '2000-01-01T00:00:00Z',
  };
  const writes: any[] = [];
  let upgraded = false;
  await page.route('**/api/v1/playback/state', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (upgraded) expect(body.playback_state).toBe('paused');
      else expect(body).not.toHaveProperty('playback_state');
      state = { ...body, version: state.version + 1, updated_at: new Date().toISOString() };
    }
    return route.fulfill({ json: state });
  });
  await login(page, { automaticSync: true });
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  state = { ...state, version: 8, track_ids: tracks.map((track: { id: string }) => track.id) };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('region', { name: '跨设备接续', exact: true })).toHaveCount(0);
  await section(page, '跨设备继续');
  await page.getByRole('button', { name: '在本设备继续', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeCloseTo(3, 1);
  expect((await audio(page)).paused).toBe(true);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => writes.length).toBeGreaterThan(1);
  expect(writes.every((body) => !('playback_state' in body))).toBe(true);
  upgraded = true;
  state = { ...state, handoff_supported: true };
  await page.getByRole('button', { name: '读取最新进度', exact: true }).click();
  await expect(page.getByRole('button', { name: '共享当前播放进度', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '共享当前播放进度', exact: true }).click();
  await expect.poll(() => writes.at(-1)?.playback_state).toBe('paused');
});
