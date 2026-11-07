import { expect, test, type Page } from '@playwright/test';
import { audio, leaveSettings, login, personalSettings, podcastCatalog } from './helpers';

test.describe.configure({ timeout: 90_000 });

test.skip(
  process.env.WILDSTRING_TEST_PODCAST !== '1',
  'Run make test-podcast-web for the local podcast fixture.',
);

const headers = { 'X-Wildstring-Client': 'web' };

type StubWindow = Window & { __radioClicks: number };

/** Replace Web Audio with a counting stub; oscillator starts mark synthesized clicks. */
async function stubAudioContext(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as StubWindow).__radioClicks = 0;
    class StubParam {
      value = 0;
      setValueAtTime() {}
      exponentialRampToValueAtTime() {}
      setTargetAtTime() {}
    }
    class StubNode {
      connect(target: unknown) {
        return target;
      }
    }
    class StubOscillator extends StubNode {
      type = '';
      frequency = new StubParam();
      start() {
        (window as unknown as StubWindow).__radioClicks++;
      }
      stop() {}
    }
    class StubBufferSource extends StubNode {
      buffer: unknown = null;
      start() {}
    }
    class StubAudioContext {
      state = 'running';
      currentTime = 0;
      sampleRate = 44100;
      destination = new StubNode();
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createOscillator() {
        return new StubOscillator();
      }
      createBufferSource() {
        return new StubBufferSource();
      }
      createGain() {
        const node = new StubNode();
        return { gain: new StubParam(), connect: node.connect.bind(node) };
      }
      createBiquadFilter() {
        const node = new StubNode();
        return { type: '', frequency: new StubParam(), connect: node.connect.bind(node) };
      }
      createBuffer(_channels: number, length: number, _rate: number) {
        return { getChannelData: () => new Float32Array(length) };
      }
      createMediaElementSource() {
        return new StubNode();
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: StubAudioContext });
  });
}

const radioClicks = (page: Page) =>
  page.evaluate(() => (window as unknown as StubWindow).__radioClicks);

async function openSettingsPlayback(page: Page) {
  await leaveSettings(page);
  return personalSettings(page, 'playback');
}

async function openRadio(page: Page) {
  await login(page);
  for (let i = 1; i <= 6; i++) {
    const current = await (
      await page.request.get(`/api/v1/podcasts/episodes/radio-${i}/progress`)
    ).json();
    const reset = await page.request.put(`/api/v1/podcasts/episodes/radio-${i}/progress`, {
      headers,
      data: {
        session_id: crypto.randomUUID(),
        device_id: 'radio-click-spec',
        base_version: current.version,
        sequence: 1,
        position_seconds: 0,
        duration_seconds: 25,
        event: 'play',
      },
    });
    expect(reset.status()).toBe(200);
  }
  const queue = await (await page.request.get('/api/v1/podcasts/queue')).json();
  const cleared = await page.request.put('/api/v1/podcasts/queue', {
    headers,
    data: { version: queue.version, device_id: 'radio-click-spec', items: [] },
  });
  expect(cleared.ok()).toBeTruthy();
  await page.reload();
  await podcastCatalog(page);
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  const queued = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/podcasts/queue') && response.request().method() === 'PUT',
  );
  await page.locator('.episode-play-btn').first().click();
  expect((await queued).ok()).toBeTruthy();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '播客全屏播放', exact: true })).toBeVisible();
}

test('收音机按键音效默认关闭，可开关并按账号持久化', async ({ page }) => {
  await stubAudioContext(page);
  await openRadio(page);

  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
  await expect((await audio(page)).paused).toBe(true);
  expect(await radioClicks(page)).toBe(0);

  await page.getByRole('button', { name: '收起全屏播放' }).click();
  const settings = await openSettingsPlayback(page);
  const toggle = settings.getByLabel('收音机按键音效', { exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      path: `../../artifacts/player-audit/radio-click-settings-${theme}-${test.info().project.name}.png`,
    });
  }

  await leaveSettings(page);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '收音机播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(await radioClicks(page)).toBe(1);
  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
  await expect((await audio(page)).paused).toBe(true);
  expect(await radioClicks(page)).toBe(2);

  await page.getByRole('button', { name: '收起全屏播放' }).click();
  const cleared = await openSettingsPlayback(page);
  await cleared.getByLabel('收音机按键音效', { exact: true }).uncheck();

  await leaveSettings(page);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await page.getByRole('button', { name: '收音机播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(await radioClicks(page)).toBe(2);

  await page.reload();
  const persisted = await openSettingsPlayback(page);
  await expect(persisted.getByLabel('收音机按键音效', { exact: true })).not.toBeChecked();
});

test('音乐播放键不触发收音机音效', async ({ page }) => {
  await stubAudioContext(page);
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);

  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '全屏播放', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起全屏播放' }).click();

  const settings = await openSettingsPlayback(page);
  await settings.getByLabel('收音机按键音效', { exact: true }).check();
  await leaveSettings(page);

  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  await expect((await audio(page)).paused).toBe(true);
  await dialog.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  expect(await radioClicks(page)).toBe(0);
});
