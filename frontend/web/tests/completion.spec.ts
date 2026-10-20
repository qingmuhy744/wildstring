import { section } from './helpers';
import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { audio, login } from './helpers';
const headers = { 'X-Wildstring-Client': 'web' };

async function allTracks(page: Page) {
  return (await (await page.request.get('/api/v1/tracks')).json()).items;
}
async function persisted(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('wildstring:playback:'));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}
async function downloadFirst(page: Page) {
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await section(page, '离线音乐');
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('已离线保存');
}
async function downloads(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('wildstring-offline-v1', 1);
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise<number>((resolve) => {
      const r = db.transaction('tracks').objectStore('tracks').count();
      r.onsuccess = () => {
        resolve(r.result);
        db.close();
      };
    });
  });
}
async function offline(context: BrowserContext, page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }),
      );
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '没网，也有回响。' })).toBeVisible();
}

test('完整集合超过50首，失败原子保留队列与音频，上限明确', async ({ page }) => {
  await login(page);
  const source = (await allTracks(page))[0];
  const tracks = Array.from({ length: 57 }, (_, i) => ({
    ...source,
    id: `${source.id}-${i}`,
    title: `跨页曲目 ${i + 1}`,
  }));
  let fail = false,
    huge = false;
  await page.route('**/api/v1/tracks?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(50, Number(query.get('limit') || 50));
    if (fail && Number(query.get('limit')) === 200) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        items: tracks.slice(offset, offset + limit),
        total: huge ? 5001 : tracks.length,
        limit,
        offset,
      },
    });
  });
  await page.route('**/api/v1/tracks/*/stream', (route) =>
    route.continue({
      url: route
        .request()
        .url()
        .replace(/\/tracks\/[^/]+\/stream/, `/tracks/${source.id}/stream`),
    }),
  );
  await page.getByRole('button', { name: '刷新曲库' }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await persisted(page))?.tracks.length).toBe(57);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await audio(page);
  fail = true;
  await page.getByRole('button', { name: '播放 跨页曲目 2', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('请求未完成');
  expect((await persisted(page)).tracks.length).toBe(57);
  expect((await audio(page)).source).toBe(before.source);
  fail = false;
  huge = true;
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('最多 5000 首');
  expect((await audio(page)).source).toBe(before.source);
});

test('模式、睡眠与账号播放恢复，恢复时暂停', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '播放模式：顺序播放', exact: true }).click();
  await page.getByRole('button', { name: '播放模式：列表循环', exact: true }).click();
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await persisted(page)).index).toBe(1);
  await expect
    .poll(async () => (await audio(page)).source.includes((await allTracks(page))[1].id))
    .toBe(true);
  const selected = (await persisted(page)).index;
  await page.locator('audio').evaluate((a) => a.dispatchEvent(new Event('ended')));
  await expect.poll(async () => (await persisted(page)).index).toBe(selected);
  await page.getByRole('button', { name: '播放模式：单曲循环', exact: true }).click();
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await persisted(page)).index).not.toBe(selected);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const full = page.getByRole('dialog', { name: '全屏播放' });
  await full.getByRole('button', { name: '睡眠定时设置', exact: true }).click();
  await full.getByLabel('睡眠定时', { exact: true }).selectOption('track');
  await expect
    .poll(async () => await page.locator('audio').evaluate((a: HTMLAudioElement) => a.readyState))
    .toBeGreaterThan(0);
  const beforeSleep = (await persisted(page)).index;
  await page.locator('audio').evaluate((a) => a.dispatchEvent(new Event('ended')));
  await expect.poll(async () => (await persisted(page)).index).toBe(beforeSleep);
  await expect(full.getByLabel('睡眠定时', { exact: true })).toHaveValue('');
  await full.getByRole('button', { name: '播放', exact: true }).click();
  await full.getByRole('button', { name: '暂停', exact: true }).click();
  await full.getByLabel('播放进度', { exact: true }).evaluate((element: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, '3');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await expect.poll(async () => (await audio(page)).time).toBeCloseTo(3, 0);
  expect((await audio(page)).paused).toBe(true);
  await expect(page.getByRole('button', { name: '播放模式：随机播放', exact: true })).toBeVisible();
});

test('每日推荐、偏好、本地AI回退、预览确认才保存歌单', async ({ page }, info) => {
  await login(page);
  await section(page, '每日推荐 · AI');
  const panel = page.getByLabel('音乐发现', { exact: true });
  await expect(panel.getByRole('button', { name: '播放推荐', exact: true })).toBeEnabled();
  await panel.getByText('推荐偏好', { exact: true }).click();
  const count = panel.getByLabel('每日首数', { exact: true });
  await count.fill((await count.inputValue()) === '5' ? '6' : '5');
  await panel.getByRole('button', { name: '保存推荐偏好', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('偏好已保存');
  const before = (await (await page.request.get('/api/v1/playlists')).json()).total;
  await panel.locator('.ai-discover > summary').click();
  await panel.getByLabel('找歌或生成歌单', { exact: true }).fill('晴天测试曲');
  await panel.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: '当前使用本地检索回退' })).toBeVisible();
  expect((await (await page.request.get('/api/v1/playlists')).json()).total).toBe(before);
  const name = `AI预览确认-${info.project.name}`;
  await panel.getByLabel('候选歌单名称', { exact: true }).fill(name);
  await panel.getByRole('button', { name: '确认保存歌单', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('已保存');
  const list = (await (await page.request.get('/api/v1/playlists')).json()).items.find(
    (l: { name: string }) => l.name === name,
  );
  expect(list.track_count).toBeGreaterThan(0);
  await page.request.delete(`/api/v1/playlists/${list.id}?version=${list.version}`, { headers });
  await page.screenshot({
    path: `../../artifacts/discover-${info.project.name}.png`,
    fullPage: true,
  });
});

test('共享进度显式载入且暂停，版本冲突不会覆盖', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await section(page, '跨设备继续');
  const panel = page.getByLabel('跨设备继续', { exact: true });
  await panel.getByRole('button', { name: '共享当前播放进度' }).click();
  await expect(panel.getByRole('status').first()).toContainText('已共享');
  await panel.getByRole('button', { name: '在本设备继续' }).click();
  await expect(panel.getByRole('status').first()).toContainText('点击播放继续');
  expect((await audio(page)).paused).toBe(true);
  const snapshot = await (await page.request.get('/api/v1/playback/state')).json();
  const concurrent = await page.request.put('/api/v1/playback/state', {
    headers,
    data: {
      ...Object.fromEntries(
        Object.entries(snapshot).filter(([key]) =>
          [
            'version',
            'device_id',
            'track_ids',
            'index',
            'position_ms',
            'mode',
            'playback_state',
          ].includes(key),
        ),
      ),
      device_id: 'other-device',
    },
  });
  expect(concurrent.ok()).toBe(true);
  await panel.getByRole('button', { name: '共享当前播放进度' }).click();
  await expect(panel.getByRole('status').first()).toContainText('其他设备更新');
  expect((await (await page.request.get('/api/v1/playback/state')).json()).device_id).toBe(
    'other-device',
  );
});

test('完整离线下载、断网刷新静态壳、Blob播放、删除及退出清理', async ({ page, context }, info) => {
  await login(page);
  await downloadFirst(page);
  expect(await downloads(page)).toBe(1);
  await offline(context, page);
  await page.getByRole('button', { name: '离线播放 晴天测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source.startsWith('blob:')).toBe(true);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.screenshot({
    path: `../../artifacts/offline-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '删除离线 晴天测试曲', exact: true }).click();
  await expect.poll(() => downloads(page)).toBe(0);
  const logout = page
    .getByRole('button', { name: /退出登录/ })
    .filter({ visible: true })
    .first();
  await logout.click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((k) => k.startsWith('wildstring:playback:')),
    ),
  ).toBe(false);
  await context.setOffline(false);
});

test('在线撤权清离线内容，迟到下载不能在同账号重登后复活', async ({ page }) => {
  await login(page);
  await downloadFirst(page);
  await page.route('**/api/v1/tracks/*/stream', (route) =>
    route.request().method() === 'HEAD' ? route.fulfill({ status: 503 }) : route.continue(),
  );
  await page.getByRole('button', { name: '离线播放 晴天测试曲', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法校验离线副本');
  expect(await downloads(page)).toBe(1);
  await page.unroute('**/api/v1/tracks/*/stream');
  await page.route('**/api/v1/tracks/*/stream', (route) =>
    route.request().method() === 'HEAD' ? route.fulfill({ status: 403 }) : route.continue(),
  );
  await page.getByRole('button', { name: '离线播放 晴天测试曲', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
  expect(await downloads(page)).toBe(0);
  await page.unroute('**/api/v1/tracks/*/stream');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  const source = (await allTracks(page))[0];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(`**/api/v1/tracks/${source.id}/stream`, async (route) => {
    await gate;
    try {
      await route.continue();
    } catch {
      /* aborted on logout */
    }
  });
  await page.getByRole('button', { name: `歌曲操作 ${source.title}`, exact: true }).click();
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await expect.poll(() => downloads(page)).toBe(1);
  await page
    .getByRole('button', { name: /退出登录/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  release();
  await page.waitForTimeout(350);
  expect(await downloads(page)).toBe(0);
});

test('离线暂停、Range续传、容量失败与重试', async ({ page }) => {
  await login(page);
  await downloadFirst(page);
  const source = (await allTracks(page)).find((t: { title: string }) => t.title === '晴天测试曲');
  const half = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('wildstring-offline-v1', 1);
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise<number>((resolve) => {
      const tx = db.transaction('tracks', 'readwrite'),
        store = tx.objectStore('tracks');
      const r = store.getAll();
      let bytes = 0;
      r.onsuccess = () => {
        const item = r.result[0];
        bytes = Math.floor(item.bytes / 2);
        item.bytes = bytes;
        item.blob = item.blob.slice(0, bytes);
        item.state = 'paused';
        store.put(item);
      };
      tx.oncomplete = () => {
        db.close();
        window.dispatchEvent(new Event('wildstring:offline-updated'));
        resolve(bytes);
      };
    });
  });
  const ranged = page.waitForRequest(
    (r) =>
      r.url().includes(`/tracks/${source.id}/stream`) && r.headers().range === `bytes=${half}-`,
  );
  await page.getByRole('button', { name: '继续下载', exact: true }).click();
  await ranged;
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('已离线保存');
  await page.getByRole('button', { name: '删除离线 晴天测试曲', exact: true }).click();
  await expect.poll(() => downloads(page)).toBe(0);
  await section(page, '全部歌曲');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(`**/api/v1/tracks/${source.id}/stream`, async (route) => {
    await gate;
    try {
      await route.continue();
    } catch {
      /* canceled */
    }
  });
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '保存离线', exact: true }).click();
  await section(page, '离线音乐');
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('下载中');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  release();
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('已暂停');
  await page.unroute(`**/api/v1/tracks/${source.id}/stream`);
  await page.evaluate(() => localStorage.setItem('wildstring:offline-limit', '100'));
  await page.route(`**/api/v1/tracks/${source.id}/stream`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-length': '104857601', 'content-type': 'audio/mpeg' },
      body: 'too large',
    }),
  );
  await page.getByRole('button', { name: '继续下载', exact: true }).click();
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('达到离线容量上限');
  await page.unroute(`**/api/v1/tracks/${source.id}/stream`);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByLabel('离线音乐', { exact: true })).toContainText('已离线保存');
});

test('并行推荐反馈失败只恢复失败曲目', async ({ page }) => {
  await login(page);
  await section(page, '每日推荐 · AI');
  const panel = page.getByLabel('音乐发现', { exact: true });
  await expect(panel.locator('.discovery-track')).toHaveCount(2);
  const titles = await panel.locator('.discovery-track strong').allTextContents();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  await page.route('**/api/v1/recommendations/feedback', async (route) => {
    if (first) {
      first = false;
      await gate;
      await route.fulfill({ status: 503, json: {} });
    } else await route.fulfill({ status: 204 });
  });
  await panel.getByLabel(`${titles[0]}的更多操作`, { exact: true }).click();
  await page.getByRole('menuitem', { name: '不感兴趣', exact: true }).click();
  await panel.getByLabel(`${titles[1]}的更多操作`, { exact: true }).click();
  await page.getByRole('menuitem', { name: '不感兴趣', exact: true }).click();
  release();
  await expect(panel.locator('.discovery-track')).toHaveCount(1);
  await expect(panel.locator('.discovery-track')).toContainText(titles[0]);
  await expect(panel.locator('.discovery-track')).not.toContainText(titles[1]);
});

test('睡眠分钟截止会暂停，可取消与重新设置', async ({ page }) => {
  await page.clock.install();
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const full = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await full.getByRole('button', { name: '睡眠定时设置', exact: true }).click();
  await full.getByLabel('睡眠定时', { exact: true }).selectOption('15');
  await page.clock.fastForward(15 * 60 * 1000 + 1000);
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
  await full.getByRole('button', { name: '睡眠定时设置', exact: true }).click();
  await full.getByLabel('睡眠定时', { exact: true }).selectOption('30');
  await full.getByRole('button', { name: '睡眠定时设置', exact: true }).click();
  await full.getByLabel('睡眠定时', { exact: true }).selectOption('');
  await expect(full.getByRole('button', { name: '睡眠定时设置', exact: true })).toHaveAttribute(
    'title',
    '睡眠定时',
  );
});

test('网卡在线但服务不可达仍可离线重开及播放，5xx不绕过', async ({ page }) => {
  await login(page);
  await downloadFirst(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.route('**/api/**', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('heading', { name: '没网，也有回响。' })).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.getByRole('button', { name: '离线播放 晴天测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source.startsWith('blob:')).toBe(true);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.unroute('**/api/**');
  await page.route('**/api/v1/auth/status', (route) => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByRole('heading', { name: '稍等，连接一下。' })).toBeVisible();
});

test('局域网HTTP缺少randomUUID时仍可播放和记录反馈', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }),
  );
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await persisted(page)).index).toBe(1);
  await section(page, '跨设备继续');
  await page.getByRole('button', { name: '共享当前播放进度' }).click();
  await expect(page.getByLabel('跨设备继续', { exact: true }).getByRole('status')).toContainText(
    '已共享',
  );
});

test('服务不可达且网卡在线仍可本机退出，重连后撤销旧会话', async ({ page }) => {
  await login(page);
  await downloadFirst(page);
  await page.route('**/api/v1/auth/logout', (route) => route.abort('failed'));
  await page
    .getByRole('button', { name: /退出登录/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('本机已退出');
  expect(await downloads(page)).toBe(0);
  expect((await (await page.request.get('/api/v1/auth/status')).json()).authenticated).toBe(true);
  await page.unroute('**/api/v1/auth/logout');
  await page.reload();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible();
  expect((await (await page.request.get('/api/v1/auth/status')).json()).authenticated).toBe(false);
});

test('注销网络黑洞2秒后清本机，迟到清cookie不覆盖重新登录', async ({ page }) => {
  await login(page);
  await downloadFirst(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/api/v1/auth/logout', async (route) => {
    requests++;
    await gate;
    try {
      await route.fulfill({
        status: 204,
        headers: {
          'set-cookie': 'wildstring_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
        },
      });
    } catch {
      /* The completed abort rejects late responses. */
    }
  });
  const logout = page
    .getByRole('button', { name: /退出登录/ })
    .filter({ visible: true })
    .first();
  const started = Date.now();
  await logout.click();
  await logout.click();
  await expect(page.getByRole('button', { name: '进入曲库' })).toBeVisible({ timeout: 5000 });
  expect(Date.now() - started).toBeLessThan(4500);
  expect(requests).toBe(1);
  expect(await downloads(page)).toBe(0);
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
  release();
  await page.waitForTimeout(100);
  expect((await (await page.request.get('/api/v1/auth/status')).json()).authenticated).toBe(true);
});
