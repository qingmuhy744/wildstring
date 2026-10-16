import { expect, test } from '@playwright/test';
import { login } from './helpers';
const headers = { 'X-Wildstring-Client': 'web' };

test('收藏在响应前反馈，失败回退，阻止重复提交并可重试', async ({ page }) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (t: { title: string }) => t.title === '晴天测试曲',
  );
  await page.request.put(`/api/v1/tracks/${track.id}/favorite`, {
    headers,
    data: { loved: false },
  });
  await page.getByRole('button', { name: /刷新曲库/ }).click();
  const button = page
    .getByRole('table')
    .getByRole('button', { name: '喜欢 晴天测试曲', exact: true });
  await expect(button).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route(`**/api/v1/tracks/${track.id}/favorite`, async (route) => {
    requests++;
    await gate;
    await route.fulfill({ status: 503, json: { detail: 'unavailable' } });
  });
  try {
    await button.click();
    const pending = page
      .getByRole('table')
      .getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true });
    await expect(pending).toHaveAttribute('aria-pressed', 'true');
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(pending).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
    release();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.toast')).toContainText('收藏未保存');
    await page.unroute(`**/api/v1/tracks/${track.id}/favorite`);
    await button.click();
    await expect(
      page.getByRole('table').getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true }),
    ).toHaveAttribute('aria-busy', 'false');
    await page.reload();
    await expect(
      page.getByRole('table').getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  } finally {
    release();
    await page.request.put(`/api/v1/tracks/${track.id}/favorite`, {
      headers,
      data: { loved: false },
    });
  }
});

test('歌单移除即时显示，延迟失败恢复原顺序', async ({ page }, info) => {
  await login(page);
  const items = (await (await page.request.get('/api/v1/tracks')).json()).items;
  let list = await (
    await page.request.post('/api/v1/playlists', {
      headers,
      data: { name: `异步恢复-${info.project.name}`, kind: 'manual' },
    })
  ).json();
  list = await (
    await page.request.post(`/api/v1/playlists/${list.id}/tracks`, {
      headers,
      data: { version: list.version, track_ids: items.map((t: { id: string }) => t.id) },
    })
  ).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole('button', { name: /刷新曲库/ }).click();
    await page
      .getByRole('group', { name: '曲库显示方式' })
      .getByRole('button', { name: '歌单', exact: true })
      .click();
    await page.getByRole('button', { name: `打开歌单 ${list.name}`, exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
    await page.route(`**/api/v1/playlists/${list.id}/tracks/**`, async (route) => {
      await gate;
      await route.fulfill({ status: 503, json: { detail: 'unavailable' } });
    });
    await page.getByRole('button', { name: `歌曲操作 ${items[0].title}`, exact: true }).click();
    await page.getByRole('button', { name: '从歌单移除', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
    await expect(page.locator('.toast')).toContainText('正在移除');
    release();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText(items[0].title);
  } finally {
    release();
    await page.request.delete(`/api/v1/playlists/${list.id}?version=${list.version}`, { headers });
  }
});

test('Last.fm 同步开关响应前更新，失败恢复', async ({ page }, info) => {
  await login(page);
  await page.route('**/api/v1/lastfm', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({
        json: {
          configured: true,
          connected: true,
          username: 'test-listener',
          scrobble: false,
          now_playing: false,
          version: 1,
          queue: {},
        },
      });
    else {
      await gate;
      await route.fulfill({ status: 503, json: {} });
    }
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('account');
    else await page.getByRole('button', { name: '账号设置', exact: true }).click();
    const checkbox = page.getByLabel('同步已听记录', { exact: true });
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
    release();
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByRole('alert')).toContainText('同步设置未保存');
  } finally {
    release();
  }
});

test('管理员网页可保存代理模式，认证地址不回显', async ({ page }, info) => {
  await login(page);
  const original = await (await page.request.get('/api/v1/manage/providers')).json();
  const {
    lastfm_configured: _fm,
    proxy_configured: _proxy,
    environment_proxy_configured: _env,
    ...body
  } = original;
  try {
    if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('manage');
    else await page.getByRole('button', { name: '管理', exact: true }).click();
    await page
      .getByRole('navigation', { name: '管理分类' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await page.getByLabel('联网代理', { exact: true }).selectOption('custom');
    await page
      .getByLabel('HTTP 代理地址', { exact: true })
      .fill('http://fixture:password@127.0.0.1:7890');
    await page.getByRole('button', { name: '保存联网设置', exact: true }).click();
    await expect(page.getByText('联网设置已保存。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('HTTP 代理地址', { exact: true })).toHaveValue('');
    const response = await (await page.request.get('/api/v1/manage/providers')).json();
    expect(response.proxy_mode).toBe('custom');
    expect(response.proxy_configured).toBe(true);
    expect(JSON.stringify(response)).not.toContain('password');
    await page.getByLabel('联网代理', { exact: true }).selectOption('environment');
    await page.getByRole('button', { name: '保存联网设置', exact: true }).click();
    await expect
      .poll(
        async () => (await (await page.request.get('/api/v1/manage/providers')).json()).proxy_mode,
      )
      .toBe('environment');
  } finally {
    const current = await (await page.request.get('/api/v1/manage/providers')).json();
    await page.request.put('/api/v1/manage/providers', {
      headers,
      data: { ...body, version: current.version },
    });
  }
});
