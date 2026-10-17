import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
async function manage(page: Page, mobile: boolean) {
  if (mobile) await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '曲库管理', exact: true })).toBeVisible();
  await expect(page.getByLabel('曲库概览')).toBeVisible();
}
async function tracks(page: Page) {
  return (await (await page.request.get('/api/v1/tracks')).json()).items as {
    id: string;
    title: string;
  }[];
}

test('管理导航、播放持续、曲库命名持久化与部署设置', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  const before = await audio(page);
  await manage(page, info.project.name === 'mobile');
  await expect(page.getByLabel('曲库概览')).toContainText('2');
  expect((await audio(page)).source).toBe(before.source);
  expect((await audio(page)).paused).toBe(false);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(before.time);
  await page.screenshot({ path: `../../artifacts/manage-overview-${info.project.name}.png` });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const original = (await (await page.request.get('/api/v1/manage/overview')).json()).preferences;
  try {
    await page.getByLabel('曲库名称', { exact: true }).fill(`摇滚收藏 ${info.project.name}`);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    await expect(page.getByText('媒体标签写回', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '← 返回音乐', exact: true }).click();
    expect((await audio(page)).source).toBe(before.source);
    await page.reload();
    await expect(page.getByRole('table')).toBeVisible();
    await manage(page, info.project.name === 'mobile');
    await expect(
      page.getByRole('heading', { name: `摇滚收藏 ${info.project.name}`, exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    const current = (await (await page.request.get('/api/v1/manage/overview')).json()).preferences;
    await page.request.put('/api/v1/manage/preferences', {
      headers,
      data: { name: original.name, version: current.version },
    });
  }
});

test('元数据预览、版本冲突、重扫保留、撤销与当前音频连续', async ({ page }, info) => {
  await login(page);
  const track = (await tracks(page)).find((t) => t.title === '夜晚测试曲')!;
  const endpoint = `/api/v1/manage/tracks/${track.id}/metadata`;
  const original = await (await page.request.get(endpoint)).json();
  const edited = `夜晚 · 整理验证 ${info.project.name}`;
  try {
    await page.getByRole('button', { name: '播放 夜晚测试曲', exact: true }).click();
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const before = await audio(page);
    await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
    await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
    await dialog.getByLabel('歌名', { exact: true }).fill(edited);
    await dialog.getByLabel('歌曲艺人', { exact: true }).fill('AC/DC\n野弦整理测试');
    await dialog.getByLabel('曲号', { exact: true }).fill('12');
    await dialog.getByRole('button', { name: '预览修改', exact: true }).click();
    await expect(dialog.getByLabel('元数据修改预览')).toContainText(edited);
    await page.screenshot({ path: `../../artifacts/manage-edit-${info.project.name}.png` });
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('table')).toContainText(edited);
    expect(await audio(page)).toEqual(before);
    // A concurrent edit must not be silently overwritten by an older form.
    await page.getByRole('button', { name: `歌曲操作 ${edited}`, exact: true }).click();
    await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
    await expect(dialog.getByLabel('歌名', { exact: true })).toHaveValue(edited);
    const saved = await (await page.request.get(endpoint)).json();
    await page.request.put(endpoint, {
      headers,
      data: { version: saved.version, overrides: saved.overrides },
    });
    await dialog.getByLabel('歌名', { exact: true }).fill('过期页面的修改');
    await dialog.getByRole('button', { name: '预览修改', exact: true }).click();
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('这首歌的信息已变化');
    await dialog.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(dialog.getByLabel('歌名', { exact: true })).toHaveValue(edited);
    await dialog.getByRole('button', { name: '关闭歌曲编辑', exact: true }).click();
    await manage(page, info.project.name === 'mobile');
    await page.getByLabel('重新读取全部标签').check();
    await page.getByRole('button', { name: '扫描曲库', exact: true }).click();
    const job = page.locator('.management-job').first();
    await expect(job.locator('.job-status')).toHaveText('已完成');
    await job.locator('summary').click();
    await expect(job).toContainText('更新');
    const after = await (await page.request.get(endpoint)).json();
    expect(after.effective.title).toBe(edited);
    expect(after.observed.title).toBe('夜晚测试曲');
    expect(await audio(page)).toEqual(before);
    await page.getByRole('button', { name: '歌曲信息', exact: true }).click();
    await page.getByLabel('搜索待编辑歌曲').fill(edited);
    await page.getByRole('button', { name: '搜索歌曲', exact: true }).click();
    await page.getByRole('button', { name: `编辑 ${edited}`, exact: true }).click();
    await dialog.getByRole('button', { name: '全部使用文件值', exact: true }).click();
    await dialog.getByRole('button', { name: '预览修改', exact: true }).click();
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await (await page.request.get(endpoint)).json()).overrides).toEqual({});
    expect((await tracks(page)).find((t) => t.id === track.id)?.title).toBe('夜晚测试曲');
    expect(await audio(page)).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    const current = await (await page.request.get(endpoint)).json();
    await page.request.put(endpoint, {
      headers,
      data: { version: current.version, overrides: original.overrides },
    });
  }
});

test('导入任务关闭页面继续处理、持久历史与逐文件错误', async ({ page }, info) => {
  await login(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '导入音乐', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '任务记录', exact: true }).click();
  const job = page.locator('.management-job').first();
  await expect(job.locator('.job-status')).toHaveText('部分失败');
  await job.locator('summary').click();
  await expect(job).toContainText('broken.flac');
  await expect(job).toContainText('文件导入失败');
  await page.screenshot({ path: `../../artifacts/manage-jobs-${info.project.name}.png` });
  expect((await tracks(page)).length).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('自动导入设置、待整理快照、冲突反馈与手机布局', async ({ page }, info) => {
  await login(page);
  const submitted = await (
    await page.request.post('/api/v1/manage/jobs', { headers, data: { kind: 'import' } })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/manage/jobs/${submitted.id}`)).json()).status,
    )
    .not.toMatch(/^(queued|running)$/);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await audio(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '导入与整理', exact: true }).click();
  const original = await (await page.request.get('/api/v1/manage/intake/settings')).json();
  try {
    await page.getByLabel('自动发现并导入新音乐', { exact: true }).check();
    await page.getByLabel('检查间隔（秒）', { exact: true }).fill('15');
    await page.getByLabel('等待文件稳定（秒）', { exact: true }).fill('5');
    await page.getByRole('button', { name: '保存自动导入设置', exact: true }).click();
    await expect(page.getByText('自动导入设置已保存。', { exact: true })).toBeVisible();
    const response = await (await page.request.get('/api/v1/manage/intake/items?limit=100')).json();
    const item = response.items.find(
      (value: { source_path: string }) => value.source_path === `待整理-${info.project.name}.mp3`,
    );
    expect(item.can_approve).toBe(true);
    const row = page.locator('.intake-list > li').filter({ hasText: item.source_path });
    await row.getByRole('button', { name: '补充信息', exact: true }).click();
    const form = row.getByRole('form', { name: '补充导入信息', exact: true });
    await form.getByLabel('歌名', { exact: true }).fill('补充后的歌名');
    await form.getByLabel('歌曲艺人（每行一位）', { exact: true }).fill('野弦测试');
    await form.getByLabel('专辑', { exact: true }).fill('补充后的专辑');
    await page.screenshot({ path: `../../artifacts/intake-review-${info.project.name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Hold the old view while another session invalidates it; the real approval API must reject it.
    await page.route('**/api/v1/manage/intake/items?*', (route) =>
      route.fulfill({ json: { ...response, limit: 20, offset: 0 } }),
    );
    const ignored = await page.request.post(`/api/v1/manage/intake/items/${item.id}/ignore`, {
      headers,
      data: { version: item.version },
    });
    expect(ignored.ok()).toBe(true);
    await form.getByRole('button', { name: '确认信息并继续导入', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await audio(page)).toEqual(before);
    expect((await tracks(page)).length).toBe(2);
    await page.unroute('**/api/v1/manage/intake/items?*');
  } finally {
    const current = await (await page.request.get('/api/v1/manage/intake/settings')).json();
    await page.request.put('/api/v1/manage/intake/settings', {
      headers,
      data: { ...original, version: current.version },
    });
  }
});

test('AI 服务保存、密钥不回显、连接测试与清除密钥', async ({ page }, info) => {
  await login(page);
  await manage(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '管理统一模型连接', exact: true }).click();
  await page.getByText('原有实例连接（兼容配置）', { exact: true }).click();
  const panel = page.getByLabel('AI 服务配置', { exact: true });
  await panel.getByLabel('AI API 地址', { exact: true }).fill('https://model.example.invalid/v1');
  await panel.getByLabel('AI 模型名称', { exact: true }).fill(`browser-model-${info.project.name}`);
  await panel.getByLabel('AI API Key', { exact: true }).fill('disposable-browser-model-key');
  await panel.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('AI 服务配置已保存');
  await expect(panel.getByLabel('AI API Key', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('AI API Key', { exact: true })).toHaveAttribute(
    'placeholder',
    '已保存；留空保留原密钥',
  );
  const read = await page.request.get('/api/v1/manage/ai');
  expect(await read.text()).not.toContain('disposable-browser-model-key');
  // The UI test stubs the provider probe; backend tests validate its bounded transport.
  await page.route('**/api/v1/manage/ai/test', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, model: 'browser-model', scope: 'chat_completion' }),
    }),
  );
  await panel.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('模型响应正常');
  await page.screenshot({ path: `../../artifacts/manage-ai-${info.project.name}.png` });
  await panel.getByLabel('清除已保存的密钥').check();
  await panel.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('AI 服务配置已保存');
  expect((await (await page.request.get('/api/v1/manage/ai')).json()).has_api_key).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
