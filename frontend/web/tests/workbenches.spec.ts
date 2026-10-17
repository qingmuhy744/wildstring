import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
test.use({ actionTimeout: 7000 });
async function manage(page: Page, mobile: boolean) {
  if (mobile) await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '曲库管理', exact: true })).toBeVisible();
}
async function signIn(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
}

test('歌词编辑、播放打点、撤销、毫秒修正、导出与全屏生效', async ({ page }, info) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (track: { title: string }) => track.title === '夜晚测试曲',
  );
  const endpoint = `/api/v1/manage/tracks/${track.id}/lyrics`;
  const original = await (await page.request.get(endpoint)).json();
  try {
    await page.getByRole('button', { name: '播放 夜晚测试曲', exact: true }).click();
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const source = (await audio(page)).source;
    await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
    await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
    await dialog.getByRole('button', { name: '歌词', exact: true }).click();
    await dialog.getByLabel('歌词内容', { exact: true }).fill('第一句测试\n第二句测试\n第三句测试');
    await dialog.getByRole('button', { name: '逐行打点', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '预览歌词', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '播放打点歌曲', exact: true }).click();
    await expect.poll(async () => (await audio(page)).paused).toBe(false);
    const workspace = dialog.getByLabel('逐行打点工作区', { exact: true });
    await workspace.focus();
    await page.keyboard.press('Space');
    await expect(dialog.getByLabel('第 1 句时间（秒）', { exact: true })).not.toHaveValue('');
    await dialog.getByRole('button', { name: '撤销打点', exact: true }).click();
    await expect(dialog.getByLabel('第 1 句时间（秒）', { exact: true })).toHaveValue('');
    // Space also advances from the playback button without activating its pause action.
    await dialog.getByRole('button', { name: '暂停打点歌曲', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(dialog.locator('.lyric-cue')).toContainText('第一句测试');
    expect((await audio(page)).paused).toBe(false);
    await expect(dialog.getByLabel('第 2 句时间（秒）', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '暂停打点歌曲', exact: true }).click();
    for (const [index, seconds] of [
      [1, '0.123'],
      [2, '3.456'],
      [3, '6.789'],
    ] as const)
      await dialog.getByLabel(`第 ${index} 句时间（秒）`, { exact: true }).fill(seconds);
    await page.screenshot({ path: `../../artifacts/lyrics-timing-${info.project.name}.png` });
    await dialog.getByRole('button', { name: '预览歌词', exact: true }).click();
    await expect(dialog.getByLabel('歌词修改预览')).toContainText('第二句测试');
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出 LRC', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('夜晚测试曲.lrc');
    await dialog.getByRole('button', { name: '保存歌词', exact: true }).click();
    await expect(dialog.getByRole('status', { name: '歌词编辑状态' })).toContainText('歌词已保存');
    const stored = await (await page.request.get(`/api/v1/tracks/${track.id}/lyrics`)).json();
    expect(stored.source).toBe('user');
    expect(stored.lines.map((line: { time_ms: number }) => line.time_ms)).toEqual([
      123, 3456, 6789,
    ]);
    expect((await audio(page)).source).toBe(source);
    await dialog.getByRole('button', { name: '关闭歌曲编辑', exact: true }).click();
    await page.getByRole('button', { name: '全屏播放', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '全屏播放', exact: true })).toContainText(
      '第二句测试',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    const current = await (await page.request.get(endpoint)).json();
    await page.request.put(endpoint, {
      headers,
      data: {
        version: current.version,
        file_version: current.file_version,
        text: original.override,
      },
    });
  }
});

test('管理员建号和重置、普通用户权限与自行改密', async ({ page }, info) => {
  await login(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '用户', exact: true }).click();
  const username = `listener-${info.project.name}`;
  const create = page.getByRole('form', { name: '创建账号', exact: true });
  await create.getByLabel('用户名', { exact: true }).fill(username);
  await create.getByLabel('初始密码', { exact: true }).fill('first-test-password');
  await create.getByLabel('确认初始密码', { exact: true }).fill('first-test-password');
  await create.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByLabel('用户管理', { exact: true }).getByRole('status')).toContainText(
    '账号已创建',
  );
  await page.getByRole('button', { name: `重置密码 · ${username}`, exact: true }).click();
  const reset = page.getByRole('form', { name: `重置 ${username} 的密码`, exact: true });
  await reset.getByLabel('重置密码', { exact: true }).fill('reset-test-password');
  await reset.getByLabel('确认重置密码', { exact: true }).fill('reset-test-password');
  await reset.getByRole('button', { name: '确认重置密码', exact: true }).click();
  await expect(page.getByLabel('用户管理', { exact: true }).getByRole('status')).toContainText(
    '密码已重置',
  );
  await page.screenshot({ path: `../../artifacts/users-${info.project.name}.png` });
  await page.request.post('/api/v1/auth/logout', { headers });
  await signIn(page, username, 'reset-test-password');
  await expect(page.getByRole('button', { name: '管理', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/v1/manage/users')).status()).toBe(403);
  await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑歌曲信息', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('account');
  else await page.getByRole('button', { name: '账号设置', exact: true }).click();
  const account = page.getByRole('dialog', { name: '账号设置', exact: true });
  await account.getByLabel('当前密码', { exact: true }).fill('reset-test-password');
  await account.getByLabel('新密码', { exact: true }).fill('self-test-password');
  await account.getByLabel('确认新密码', { exact: true }).fill('self-test-password');
  await account.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('密码已修改');
  await signIn(page, username, 'self-test-password');
  await expect(page.getByRole('table')).toBeVisible();
});

test('域名白名单提醒、启用、拦截与关闭', async ({ page }, info) => {
  await login(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const form = page.getByRole('form', { name: '域名白名单设置', exact: true });
  await expect(form).toContainText('只能直接修改数据库关闭白名单');
  const original = await (await page.request.get('/api/v1/manage/access')).json();
  try {
    await form.getByLabel('允许访问的域名或 IP', { exact: true }).fill('127.0.0.1\nmusic.example');
    await form.getByLabel('启用域名白名单', { exact: true }).check();
    await form.getByRole('button', { name: '保存域名白名单', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('已保存并生效');
    expect(
      (
        await page.request.get('/api/v1/auth/status', {
          headers: { Host: 'evil.example', 'X-Forwarded-Host': 'music.example' },
        })
      ).status(),
    ).toBe(400);
    await page.screenshot({ path: `../../artifacts/host-settings-${info.project.name}.png` });
    await form.getByLabel('启用域名白名单', { exact: true }).uncheck();
    await form.getByRole('button', { name: '保存域名白名单', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('已保存并生效');
  } finally {
    const current = await (await page.request.get('/api/v1/manage/access')).json();
    await page.request.put('/api/v1/manage/access', {
      headers,
      data: { ...original, version: current.version },
    });
  }
});

test('系统明暗实时切换、手动优先和记忆', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: `../../artifacts/theme-dark-${info.project.name}.png` });
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('account');
  const theme = page.getByLabel('外观模式', { exact: true }).last();
  await theme.selectOption('light');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: `../../artifacts/theme-light-${info.project.name}.png` });
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('account');
  await page.getByLabel('外观模式', { exact: true }).last().selectOption('system');
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('全屏毛玻璃来自封面颜色、切歌更新及无封面回退', async ({ page }, info) => {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items as {
    id: string;
    title: string;
  }[];
  await page.route('**/tracks/*/cover?size=768', (route) => {
    const red = route.request().url().includes(tracks[0].id);
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${red ? '#bd2828' : '#286abd'}"/></svg>`,
    });
  });
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全屏播放', exact: true });
  await expect
    .poll(async () => dialog.evaluate((node) => node.style.getPropertyValue('--cover-primary')))
    .toBe('rgb(189 40 40)');
  await page.screenshot({ path: `../../artifacts/album-red-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '下一首', exact: true }).click();
  await expect
    .poll(async () => dialog.evaluate((node) => node.style.getPropertyValue('--cover-primary')))
    .toBe('rgb(40 106 189)');
  await page.screenshot({ path: `../../artifacts/album-blue-${info.project.name}.png` });
  await page.unroute('**/tracks/*/cover?size=768');
  await page.route('**/tracks/*/cover?size=768', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await dialog.getByRole('button', { name: '上一首', exact: true }).click();
  await expect(dialog.locator('.fullscreen-cover img')).toHaveCount(0);
  await expect
    .poll(async () => dialog.evaluate((node) => node.style.getPropertyValue('--cover-primary')))
    .toBe('#35373f');
});

test('转码设置可保存、刷新和清理，旧版本不会覆盖', async ({ page }, info) => {
  await login(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const endpoint = '/api/v1/manage/transcoding';
  const original = await (await page.request.get(endpoint)).json();
  const form = page.getByRole('form', { name: 'AAC 转码设置', exact: true });
  try {
    await form.getByLabel('保留天数（自上次使用）').fill('3');
    await form.getByLabel('缓存上限（MiB）').fill('512');
    await form.getByLabel('同时转码任务数').fill('1');
    await form.getByRole('button', { name: '保存转码设置' }).click();
    await expect(form.getByRole('status')).toHaveText('转码缓存设置已保存。');
    const current = await (await page.request.get(endpoint)).json();
    expect(current.retention_days).toBe(3);
    expect(current.max_size_mb).toBe(512);
    const stale = await page.request.put(endpoint, {
      headers,
      data: {
        version: original.version,
        retention_days: 5,
        max_size_mb: 512,
        max_concurrent: 1,
      },
    });
    expect(stale.status()).toBe(409);
    await form.getByRole('button', { name: '清理转码缓存' }).click();
    await expect(form.getByRole('status')).toContainText('转码缓存已清空');
    await form.getByRole('button', { name: '刷新缓存用量' }).click();
    await expect(form).toContainText('0.0 MiB');
  } finally {
    const current = await (await page.request.get(endpoint)).json();
    await page.request.put(endpoint, {
      headers,
      data: {
        version: current.version,
        retention_days: original.retention_days,
        max_size_mb: original.max_size_mb,
        max_concurrent: original.max_concurrent,
      },
    });
  }
});

test('整段歌词保留间奏空行，空格切句且长按和时间输入不误打点', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  await dialog.getByRole('button', { name: '歌词', exact: true }).click();
  const text = [
    '第一段歌词',
    '',
    ...Array.from({ length: 30 }, (_, i) => `整段歌词第 ${i + 3} 行`),
  ];
  await dialog.getByLabel('歌词内容', { exact: true }).fill(text.join('\n'));
  await dialog.getByRole('button', { name: '逐行打点', exact: true }).click();
  await expect(dialog.locator('.lyric-timing-lines > li')).toHaveCount(32);
  await dialog.getByRole('button', { name: '播放打点歌曲', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '下一句（空格）', exact: true })).toBeEnabled();
  const workspace = dialog.getByLabel('逐行打点工作区', { exact: true });
  await workspace.focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByLabel('第 1 句时间（秒）', { exact: true })).not.toHaveValue('');
  await workspace.dispatchEvent('keydown', { key: ' ', code: 'Space', repeat: true });
  await expect(dialog.getByLabel('第 2 句时间（秒）', { exact: true })).toHaveValue('');
  await dialog.getByLabel('第 1 句时间（秒）', { exact: true }).press('Space');
  await expect(dialog.getByLabel('第 2 句时间（秒）', { exact: true })).toHaveValue('');
  await workspace.focus();
  await page.keyboard.press('Space');
  await expect(dialog.getByLabel('第 2 句时间（秒）', { exact: true })).not.toHaveValue('');
  await expect(dialog.locator('.lyric-cue')).toContainText('整段歌词第 3 行');
  expect((await audio(page)).paused).toBe(false);
});
