import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login, manageTab, section } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
let cleanupAction: (() => Promise<void>) | null = null;
test.afterEach(async () => {
  const cleanup = cleanupAction;
  cleanupAction = null;
  if (cleanup) await cleanup();
});

test('真实后台歌词洗版：范围、频率设置、确认与恢复，保留原歌曲', async ({ page }, info) => {
  test.setTimeout(60_000);
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const track = tracks[0];
  const editorUrl = `/api/v1/manage/tracks/${track.id}/lyrics`;
  const lockUrl = `/api/v1/manage/tracks/${track.id}/lyric-lock`;
  const original = await (await page.request.get(editorUrl)).json();
  const pluginId = `lyric-${info.project.name}`;
  const zip = execFileSync(
    'backend/.venv/bin/python',
    [
      '-c',
      `
import io,json,zipfile,sys
t=json.load(sys.stdin); b=io.BytesIO()
detail={'id':'song','title':t['title'],'artists':t['artists'],'duration_ms':t['duration_ms'],'fields':{'title':t['title'],'artists':t['artists']},'source_url':'https://example.com/song'}
lyrics={'kind':'synced','format':'krc','lines':[{'time_ms':1000,'text':'Synthetic lyric','words':[{'start_ms':1000,'end_ms':2000,'text':'Synthetic lyric'}]}],'layers':{'translation':[{'time_ms':1000,'text':'合成中文译文'}]}}
adapter='class Plugin:\\n def search(self,c,q): return '+repr([detail])+'\\n def metadata(self,c,v): return '+repr([detail])+'\\n def lyrics(self,c,v): return '+repr({'original':'synthetic','normalized':lyrics})+'\\n'
with zipfile.ZipFile(b,'w') as z:
 z.writestr('manifest.json',json.dumps({'id':t['plugin_id'],'name':'洗版合成来源','version':'1.0.0','api_version':2,'request_pacing':True,'license':'GPL-3.0-only','upstream':'https://example.com','settings':[]}))
 z.writestr('adapter.py',adapter.replace('\\\\n','\\n'))
sys.stdout.buffer.write(b.getvalue())
`,
    ],
    { cwd: '../..', input: JSON.stringify({ ...track, plugin_id: pluginId }) },
  );
  const pluginUrl = `/api/v1/manage/source-plugins/${pluginId}`;
  expect(
    (
      await page.request.post('/api/v1/manage/source-plugins/import', {
        headers: { ...headers, 'Content-Type': 'application/zip' },
        data: zip,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.put(pluginUrl, {
        headers,
        data: { version: 1, enabled: true, priority: 0 },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.put(editorUrl, {
        headers,
        data: {
          version: original.version,
          file_version: original.file_version,
          text: 'Synthetic baseline',
        },
      })
    ).ok(),
  ).toBe(true);
  let releaseDefaults!: () => void;
  const defaultsReady = new Promise<void>((resolve) => {
    releaseDefaults = resolve;
  });
  await page.route('**/api/v1/manage/lyric-scan-settings', async (route) => {
    if (route.request().method() === 'GET') await defaultsReady;
    await route.continue();
  });
  cleanupAction = async () => {
    releaseDefaults();
    const lock = await (await page.request.get(lockUrl)).json();
    if (lock.locked) {
      await page.request.put(lockUrl, { headers, data: { ...lock, locked: false } });
    }
    const current = await (await page.request.get(editorUrl)).json();
    const restored = await page.request.put(editorUrl, {
      headers,
      data: {
        version: current.version,
        file_version: current.file_version,
        text: original.override,
      },
    });
    expect(restored.ok()).toBe(true);
    const config = (
      await (await page.request.get('/api/v1/manage/source-plugins')).json()
    ).items.find((v: { id: string }) => v.id === pluginId);
    await page.request.put(pluginUrl, {
      headers,
      data: { version: config.version, enabled: false },
    });
    await page.request.delete(`${pluginUrl}?version=${config.version + 1}`, { headers });
    const defaults = await (await page.request.get('/api/v1/manage/lyric-scan-settings')).json();
    await page.request.put('/api/v1/manage/lyric-scan-settings', {
      headers,
      data: { ...defaults, low_seconds: 10 },
    });
  };

  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理中心', exact: true }).click();
  await manageTab(page, '当前音乐库设置');
  await page.getByRole('button', { name: '打开歌词补全与洗版', exact: true }).click();
  const panel = page.getByRole('region', { name: '歌词补全与洗版', exact: true });
  const rate = panel.getByRole('combobox', { name: '请求频率', exact: true });
  await expect(rate).toBeDisabled();
  releaseDefaults();
  await expect(rate).toBeEnabled();
  await expect(panel.getByRole('combobox', { name: '请求频率', exact: true })).toHaveValue('low');
  await panel.getByRole('combobox', { name: '请求频率', exact: true }).selectOption('custom');
  await panel.getByLabel('来源请求最短间隔（秒）').fill('3');
  await panel.getByRole('button', { name: '检查扫描范围', exact: true }).click();
  await expect(panel).toContainText('本次范围：2 首');
  await panel.getByRole('button', { name: '开始后台扫描', exact: true }).click();
  await expect(panel.getByRole('heading', { name: /扫描结束/ })).toBeVisible({ timeout: 25_000 });
  const row = panel.locator('.lyric-scan-items>li').filter({ hasText: track.title });
  await expect(row).toContainText('静态歌词 → 双语逐字动态');
  await expect(row).toContainText('可升级');
  const candidates = row.getByRole('button', { name: '查看歌词候选', exact: true });
  await candidates.click();
  const songCandidates = row.getByRole('region', { name: `${track.title}的歌词候选` });
  const skip = songCandidates.getByRole('checkbox', { name: '批量更新时跳过此曲', exact: true });
  const selectTrack = row.getByRole('checkbox', { name: `选择 ${track.title}`, exact: true });
  await expect(skip).not.toBeChecked();
  const checkbox = (await skip.boundingBox())!;
  const skipText = (await songCandidates
    .getByText('批量更新时跳过此曲', { exact: true })
    .boundingBox())!;
  expect(skipText.x).toBeGreaterThanOrEqual(checkbox.x + checkbox.width);
  await selectTrack.check();
  await skip.click();
  await expect(skip).toBeChecked();
  await expect(selectTrack).toBeDisabled();
  await expect(selectTrack).not.toBeChecked();
  await expect(panel.getByRole('button', { name: '选择本页可升级', exact: true })).toBeDisabled();
  const lock = await page.request.get(lockUrl);
  expect((await lock.json()).locked).toBe(true);
  const candidate = songCandidates
    .locator('.lyric-candidate')
    .filter({ hasText: pluginId })
    .first();
  await candidate.getByRole('button', { name: '预览歌词', exact: true }).click();
  await expect(candidate.getByRole('list', { name: '预览歌词', exact: true })).toContainText(
    '合成中文译文',
  );
  const field = (await candidate
    .getByRole('spinbutton', { name: '时间偏移（毫秒）' })
    .boundingBox())!;
  const unit = (await candidate.getByText('ms', { exact: true }).boundingBox())!;
  expect(unit.x).toBeGreaterThanOrEqual(field.x + field.width);
  expect(unit.y + unit.height / 2).toBeGreaterThan(field.y);
  expect(unit.y + unit.height / 2).toBeLessThan(field.y + field.height);
  await skip.click();
  await expect(skip).not.toBeChecked();
  await expect(selectTrack).toBeEnabled();
  await row.getByRole('button', { name: '收起歌词候选', exact: true }).click();
  await expect(songCandidates).toBeHidden();
  const before = await (await page.request.get(`/api/v1/tracks/${track.id}/lyrics`)).json();
  expect(before.source).toBe('user');
  await selectTrack.check();
  await panel.getByRole('button', { name: '确认选中歌词（1）', exact: true }).click();
  await panel
    .getByRole('group', { name: '确认歌词操作' })
    .getByRole('button', { name: '确定', exact: true })
    .click();
  await expect(row).toContainText('已启用');
  const playing = await (await page.request.get(`/api/v1/tracks/${track.id}/lyrics`)).json();
  expect(playing.lines[0].translation).toBe('合成中文译文');
  await page.screenshot({
    path: `../../artifacts/lyric-scans-${info.project.name}.png`,
    fullPage: false,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.getByRole('button', { name: '恢复洗版前歌词', exact: true }).click();
  await expect(row).toContainText('已恢复');
  expect(
    (await (await page.request.get(`/api/v1/tracks/${track.id}/lyrics`)).json()).lines[0].text,
  ).toBe('Synthetic baseline');
  await panel.getByText('扫描频率默认设置', { exact: true }).click();
  await panel.getByLabel('低频间隔（秒）', { exact: true }).fill('12');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/manage/lyric-scan-settings') && r.request().method() === 'PUT',
  );
  await panel.getByRole('button', { name: '保存频率默认值', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  expect(
    (await (await page.request.get('/api/v1/manage/lyric-scan-settings')).json()).low_seconds,
  ).toBe(12);

  await page.getByRole('button', { name: '关闭歌词扫描', exact: true }).click();
  await section(page, '专辑');
  await page.getByRole('button', { name: '打开专辑 合成测试专辑', exact: true }).click();
  await page.getByLabel('集合更多操作').click();
  await page.getByRole('button', { name: '更新歌词', exact: true }).click();
  const albumDialog = page.getByRole('dialog', { name: '更新专辑歌词', exact: true });
  const queued = page.waitForResponse(
    (r) => r.url().endsWith('/manage/lyric-scans') && r.request().method() === 'POST',
  );
  await albumDialog.getByRole('button', { name: '开始查找歌词', exact: true }).click();
  const response = await queued;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    scope: 'album',
    scope_id: track.album_id,
  });
  await expect(albumDialog.getByRole('heading', { name: /扫描中|扫描结束/ })).toBeVisible();
  await albumDialog.getByRole('button', { name: '关闭歌词扫描', exact: true }).click();
  await page.getByLabel('集合更多操作').click();
  await page.getByRole('button', { name: '更新歌词', exact: true }).click();
  await expect(albumDialog.getByRole('heading', { name: /扫描中|扫描结束/ })).toBeVisible();
});

test('专辑歌词从页面直接开启，空范围不创建任务', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const albums = await (await page.request.get('/api/v1/albums')).json();
  await section(page, '专辑');
  await page
    .getByRole('button', { name: `打开专辑 ${albums.items[0].title}`, exact: true })
    .click();
  await page.getByLabel('集合更多操作').click();
  const albumActions = page.locator('.collection-menu > div');
  const menu = (await albumActions.boundingBox())!;
  const sidebar = await page.locator('.sidebar').boundingBox();
  expect(menu.x).toBeGreaterThanOrEqual((sidebar?.x ?? 0) + (sidebar?.width ?? 0));
  expect(menu.x + menu.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole('button', { name: '更新歌词', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新专辑歌词', exact: true });
  await expect(dialog).toBeVisible();
  const start = dialog.getByRole('button', { name: '开始查找歌词', exact: true });
  await expect(start).toBeEnabled();
  await expect(dialog.getByRole('combobox', { name: '请求频率' })).toBeHidden();
  await dialog.getByText('查询选项', { exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: '请求频率' })).toBeVisible();
  const forceText = dialog.getByText('强制重扫已查记录和缓存', { exact: true });
  expect(
    await forceText.evaluate((label) => {
      const range = document.createRange();
      range.selectNode(label.firstChild!);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  await dialog.getByRole('checkbox', { name: '强制重扫已查记录和缓存', exact: true }).check();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) =>
        window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value })),
      theme,
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      path: `../../artifacts/album-lyrics-${info.project.name}-${theme}.png`,
    });
  }
  let created = false;
  await page.route('**/manage/lyric-scans', (route) => {
    if (route.request().method() === 'POST') created = true;
    return route.continue();
  });
  await page.route('**/manage/lyric-scans/preview', (route) =>
    route.fulfill({ json: { total: 0 } }),
  );
  const request = page.waitForRequest((r) => r.url().endsWith('/manage/lyric-scans/preview'));
  await start.click();
  const body = (await request).postDataJSON();
  expect(body.scope).toBe('album');
  expect(body.scope_id).toBe(albums.items[0].id);
  expect(body.force).toBe(true);
  await expect(dialog.getByText('这张专辑没有需要查找歌词的歌曲。', { exact: true })).toBeVisible();
  expect(created).toBe(false);
  await dialog.getByRole('button', { name: '关闭歌词扫描', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('集合更多操作')).toBeFocused();
});
