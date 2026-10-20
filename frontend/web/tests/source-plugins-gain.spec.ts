import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login, audio } from './helpers';

const zip = execFileSync(
  'backend/.venv/bin/python',
  [
    '-c',
    `
import io,json,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('manifest.json',json.dumps({'id':'browser-source','name':'浏览器合成来源','upstream':'https://example.com/plugin','license':'GPL-3.0-only','version':'1.0.0','settings':[]}))
 z.writestr('adapter.py','class Plugin:\\n def search(self,c,q): return []\\n def metadata(self,c,v): return {}\\n def lyrics(self,c,v): return {}\\n')
sys.stdout.buffer.write(b.getvalue())
`,
  ],
  { cwd: '../..' },
);

test('ZIP 导入、配置、测试、升级及导出使用真实后端', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  const panel = page.locator('.source-plugins');
  await panel
    .getByLabel('数据源插件 ZIP', { exact: true })
    .setInputFiles({ name: 'synthetic.zip', mimeType: 'application/zip', buffer: zip });
  await panel.getByRole('button', { name: '导入插件', exact: true }).click();
  const plugin = panel.locator('article').filter({ hasText: '浏览器合成来源' });
  await expect(plugin).toContainText('插件 1.0.0');
  await expect(plugin.getByLabel('启用此插件')).not.toBeChecked();
  await plugin.getByLabel('启用此插件').check();
  await expect(
    plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }),
  ).toBeDisabled();
  await expect(plugin).toContainText('有未保存的设置，请先保存，再测试或升级。');
  await plugin.getByRole('button', { name: '保存 浏览器合成来源', exact: true }).click();
  await expect(plugin.locator('.plugin-operation-result')).toContainText('已保存');
  await plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }).click();
  await expect(plugin.locator('.plugin-test-result')).toContainText('已响应');
  await expect(plugin.locator('.plugin-operation-result')).toContainText('已保存');
  await page.route('**/api/v1/manage/source-plugins/browser-source/test', (route) =>
    route.fulfill({ status: 409, json: { detail: 'source_plugin_configuration_changed' } }),
  );
  await plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }).click();
  await expect(plugin.locator('.plugin-test-result')).toContainText('配置已变化');
  const exported = await page.request.get('/api/v1/manage/source-plugins/browser-source/export');
  expect(await exported.body()).toEqual(zip);
  await page.screenshot({
    path: `../../artifacts/050-verification/source-plugins-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const maintenance = plugin.locator('.plugin-maintenance');
  await maintenance.getByText('版本与维护', { exact: true }).click();
  await expect(
    maintenance.getByRole('button', { name: '卸载 浏览器合成来源', exact: true }),
  ).toBeDisabled();
  const current = (
    await (await page.request.get('/api/v1/manage/source-plugins')).json()
  ).items.find((p: { id: string }) => p.id === 'browser-source');
  await maintenance
    .getByLabel('浏览器合成来源 升级 ZIP', { exact: true })
    .setInputFiles({ name: 'upgrade.zip', mimeType: 'application/zip', buffer: zip });
  expect(
    (await (await page.request.get('/api/v1/manage/source-plugins')).json()).items.find(
      (p: { id: string }) => p.id === 'browser-source',
    ).version,
  ).toBe(current.version);
  const uploaded = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/source-plugins/import?'),
  );
  await maintenance.getByRole('button', { name: '确认升级', exact: true }).click();
  const request = await uploaded;
  expect(new URL(request.url()).searchParams.get('expected_version')).toBe(String(current.version));
  expect(new URL(request.url()).searchParams.get('expected_id')).toBe('browser-source');
  await expect(plugin.locator('.plugin-operation-result')).toContainText('已升级并停用');
  await expect(plugin.getByLabel('启用此插件')).not.toBeChecked();
  await expect(maintenance.getByLabel('浏览器合成来源 升级 ZIP', { exact: true })).toHaveValue('');
  await maintenance.getByRole('button', { name: '卸载 浏览器合成来源', exact: true }).click();
  await expect(plugin).toHaveCount(0);
  await expect(panel.locator('.plugin-import-result')).toContainText('已卸载');
});

test('手动专辑与单曲调整可叠加归零，保持实际音频播放', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
  await page.getByRole('button', { name: '响度', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '响度均衡与手动调整' });
  await panel.getByLabel('专辑增益 dB', { exact: true }).fill('-3');
  await panel.getByRole('button', { name: '保存专辑调整', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  await panel.getByLabel('单曲增益 dB', { exact: true }).fill('-2');
  await panel.getByRole('button', { name: '保存单曲调整', exact: true }).click();
  await expect(panel).toContainText('实际 -5.0');
  await page.screenshot({
    path: `../../artifacts/050-verification/playback-gain-${info.project.name}.png`,
  });
  expect((await audio(page)).paused).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: '归零专辑', exact: true }).click();
  await expect(panel).toContainText('实际 -2.0');
  await panel.getByRole('button', { name: '归零单曲', exact: true }).click();
  await expect(panel).toContainText('实际 0.0');
  await panel.getByRole('button', { name: '关闭响度设置', exact: true }).click();
});

async function pluginFixture(page: import('@playwright/test').Page, project: string) {
  let items = ['酷狗音乐 / KuGouMusicApi', '网易云音乐 / API Enhanced', 'QQ 音乐 / QQMusicApi'].map(
    (name, i) => ({
      id: `preview-${i}`,
      name,
      version: 3,
      plugin_version: '1.1.3',
      available: true,
      enabled: true,
      metadata_enabled: true,
      lyrics_enabled: true,
      priority: 50,
      upstream: 'https://example.com/plugin',
      license: 'GPL-3.0-only',
      config: { base_url: 'https://example.com/service' },
      configured_secrets: ['cookie'],
      settings: [
        { key: 'base_url', label: '外部服务地址（可选）', type: 'url' },
        { key: 'cookie', label: '平台 Cookie（可选，留空保留）', type: 'secret' },
      ],
    }),
  );
  await page.route('**/api/v1/manage/source-plugins', (route) =>
    route.fulfill({ json: { items } }),
  );
  await page.addInitScript(() => localStorage.setItem('wildstring:theme', 'light'));
  await login(page);
  if (project === 'mobile') await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  const panel = page.locator('.source-plugins');
  await expect(panel.locator('.source-plugin-card')).toHaveCount(3);
  return {
    panel,
    setItems: (next: typeof items) => {
      items = next;
    },
    getItems: () => items,
  };
}

test('ZIP 拖放和选取校验不会自动上传，取消与重新选择可用', async ({ page }, info) => {
  const { panel } = await pluginFixture(page, info.project.name);
  let requests = 0;
  await page.route('**/api/v1/manage/source-plugins/import*', (route) => {
    requests++;
    return route.fulfill({ json: {} });
  });
  const importer = panel.locator('.plugin-import');
  const input = importer.getByLabel('数据源插件 ZIP', { exact: true });
  const action = importer.getByRole('button', { name: '导入插件', exact: true });
  const drop = importer.locator('.plugin-dropzone');
  await expect(action).toBeDisabled();
  await input.setInputFiles({
    name: 'wrong.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('wrong'),
  });
  await expect(importer.getByRole('alert')).toContainText('.zip');
  await input.setInputFiles({
    name: 'empty.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(0),
  });
  await expect(importer.getByRole('alert')).toContainText('空的');
  const large = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'large.zip'));
    return transfer;
  });
  await drop.dispatchEvent('drop', { dataTransfer: large });
  await large.dispose();
  await expect(importer.getByRole('alert')).toContainText('超过 16 MiB');
  const multiple = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['PK1'], 'one.zip'));
    transfer.items.add(new File(['PK2'], 'two.zip'));
    return transfer;
  });
  await drop.dispatchEvent('drop', { dataTransfer: multiple });
  await multiple.dispose();
  await expect(importer.getByRole('alert')).toContainText('一个插件');
  const valid = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(bytes)], 'rock-lyrics.ZIP', { type: 'application/zip' }),
    );
    return transfer;
  }, Array.from(zip));
  await drop.dispatchEvent('dragenter', { dataTransfer: valid });
  await expect(drop).toHaveClass(/is-dragging/);
  await drop.dispatchEvent('drop', { dataTransfer: valid });
  await valid.dispose();
  await expect(drop).not.toHaveClass(/is-dragging/);
  await expect(importer).toContainText('rock-lyrics.ZIP');
  await expect(importer).toContainText('KiB');
  await expect(importer.getByRole('alert')).toHaveCount(0);
  await expect(action).toBeEnabled();
  expect(requests).toBe(0);
  const chooser = page.waitForEvent('filechooser');
  await importer.getByRole('button', { name: '重新选择', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'selected.zip', mimeType: 'application/zip', buffer: zip });
  await expect(importer).toContainText('selected.zip');
  await importer.getByRole('button', { name: '移除文件', exact: true }).click();
  await expect(importer).not.toContainText('selected.zip');
  await expect(action).toBeDisabled();
  expect(requests).toBe(0);
});

test('ZIP 上传反馈就地显示，处理中禁用重复提交，失败保留文件可重试', async ({ page }, info) => {
  const { panel, getItems, setItems } = await pluginFixture(page, info.project.name);
  const other = panel.getByRole('article', { name: 'QQ 音乐 / QQMusicApi', exact: true });
  await other.getByLabel('来源优先级').fill('7');
  let release: (() => void) | undefined;
  const submissions: Buffer[] = [];
  await page.route('**/api/v1/manage/source-plugins/import', async (route) => {
    submissions.push(route.request().postDataBuffer()!);
    if (submissions.length === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return route.fulfill({ status: 422, json: { detail: 'source_plugin_invalid_zip' } });
    }
    const imported = { ...getItems()[0], id: 'new-preview', name: '新增测试来源', enabled: false };
    setItems([...getItems(), imported]);
    return route.fulfill({ json: imported });
  });
  const importer = panel.locator('.plugin-import');
  await importer
    .getByLabel('数据源插件 ZIP', { exact: true })
    .setInputFiles({ name: 'retry.zip', mimeType: 'application/zip', buffer: zip });
  await importer.getByRole('button', { name: '导入插件', exact: true }).click();
  await expect(
    importer.getByRole('button', { name: '正在上传并校验…', exact: true }),
  ).toBeDisabled();
  await expect(importer.getByRole('button', { name: '重新选择', exact: true })).toBeDisabled();
  await expect.poll(() => submissions.length).toBe(1);
  release!();
  await expect(importer.getByRole('alert')).toContainText('不符合格式');
  await expect(importer).toContainText('retry.zip');
  await importer.getByRole('button', { name: '导入插件', exact: true }).click();
  await expect(importer.locator('.plugin-import-result')).toContainText('已导入');
  await expect(importer).not.toContainText('retry.zip');
  await expect(panel.locator('.source-plugin-card')).toHaveCount(4);
  await expect(other.getByLabel('来源优先级')).toHaveValue('7');
  await expect(other).toContainText('未保存');
  expect(submissions).toEqual([zip, zip]);
  await expect(importer.getByRole('button', { name: '导入插件', exact: true })).toBeDisabled();
});

test('插件卡片层次、显式升级、错误反馈和浅深色窄屏布局', async ({ page }, info) => {
  const { panel, getItems, setItems } = await pluginFixture(page, info.project.name);
  const card = panel.getByRole('article', { name: '酷狗音乐 / KuGouMusicApi', exact: true });
  const maintenance = card.locator('.plugin-maintenance');
  await expect(maintenance).not.toHaveAttribute('open');
  await expect(card.getByLabel('启用此插件')).toBeChecked();
  await card.getByText('版本与维护', { exact: true }).click();
  await expect(
    maintenance.getByRole('button', { name: '卸载 酷狗音乐 / KuGouMusicApi', exact: true }),
  ).toBeDisabled();
  await expect(maintenance.getByRole('link', { name: '导出 ZIP', exact: true })).toHaveAttribute(
    'href',
    '/api/v1/manage/source-plugins/preview-0/export',
  );
  let attempts = 0;
  await page.route('**/api/v1/manage/source-plugins/import?*', (route) => {
    attempts++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get('expected_id')).toBe('preview-0');
    expect(url.searchParams.get('expected_version')).toBe('3');
    if (attempts === 1)
      return route.fulfill({ status: 409, json: { detail: 'source_plugin_identity_conflict' } });
    setItems(
      getItems().map((p) =>
        p.id === 'preview-0' ? { ...p, version: 4, plugin_version: '1.1.4', enabled: false } : p,
      ),
    );
    return route.fulfill({ json: getItems()[0] });
  });
  await maintenance
    .getByLabel('酷狗音乐 / KuGouMusicApi 升级 ZIP', { exact: true })
    .setInputFiles({ name: 'kugou-update.zip', mimeType: 'application/zip', buffer: zip });
  expect(attempts).toBe(0);
  await maintenance.getByRole('button', { name: '确认升级', exact: true }).click();
  await expect(card.locator('.plugin-operation-result')).toContainText('插件 ID 不同');
  await expect(maintenance).toContainText('kugou-update.zip');
  await maintenance.getByRole('button', { name: '确认升级', exact: true }).click();
  await expect(card.locator('.plugin-operation-result')).toContainText('已升级并停用');
  await expect(card.getByLabel('启用此插件')).not.toBeChecked();
  await expect(card.getByLabel('外部服务地址（可选）')).toHaveValue('https://example.com/service');
  await expect(card.getByLabel('平台 Cookie（可选，留空保留）')).toHaveAttribute(
    'placeholder',
    '已保存，留空保留',
  );
  await expect(maintenance).not.toContainText('kugou-update.zip');
  await maintenance
    .getByRole('button', { name: '卸载 酷狗音乐 / KuGouMusicApi', exact: true })
    .scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(maintenance.getByRole('button', { name: '确认升级', exact: true })).toBeDisabled();
  await expect(card.locator('.plugin-maintenance')).toHaveAttribute('open', '');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await card.screenshot({
      path: `../../artifacts/0512-source-plugin-maintenance-${theme}-${info.project.name}.png`,
    });
    await maintenance.getByText('版本与维护', { exact: true }).click();
    await panel.screenshot({
      style: '.player { visibility: hidden; }',
      path: `../../artifacts/0512-source-plugin-overview-${theme}-${info.project.name}.png`,
    });
    await maintenance.getByText('版本与维护', { exact: true }).click();
  }
  if (info.project.name === 'desktop') {
    const line = await page.locator('.sidebar-bottom').evaluate((el) => ({
      border: getComputedStyle(el).borderTopStyle,
      width: getComputedStyle(el).borderTopWidth,
    }));
    expect(line).toEqual({ border: 'solid', width: '1px' });
    await page
      .locator('.sidebar')
      .screenshot({ path: '../../artifacts/0512-sidebar-separator.png' });
  }
});
