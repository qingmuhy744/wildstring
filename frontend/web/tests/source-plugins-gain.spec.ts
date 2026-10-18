import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login, audio } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
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
    .getByLabel('数据源插件 ZIP')
    .setInputFiles({ name: 'synthetic.zip', mimeType: 'application/zip', buffer: zip });
  await panel.getByRole('button', { name: '导入插件', exact: true }).click();
  const plugin = panel.locator('article').filter({ hasText: '浏览器合成来源' });
  await expect(plugin).toContainText('插件 1.0.0');
  await expect(plugin.getByLabel('启用此插件')).not.toBeChecked();
  await plugin.getByLabel('启用此插件').check();
  await expect(
    plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }),
  ).toBeDisabled();
  await expect(plugin).toContainText('请先保存当前插件设置，再测试。');
  await plugin.getByRole('button', { name: '保存 浏览器合成来源', exact: true }).click();
  await expect(panel.getByRole('status').first()).toContainText('已保存');
  await plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }).click();
  await expect(plugin.getByRole('status')).toContainText('已响应');
  await expect(panel.getByRole('status').first()).toContainText('已保存');
  await page.route('**/api/v1/manage/source-plugins/browser-source/test', (route) =>
    route.fulfill({ status: 409, json: { detail: 'source_plugin_configuration_changed' } }),
  );
  await plugin.getByRole('button', { name: '测试 浏览器合成来源', exact: true }).click();
  await expect(plugin.getByRole('status')).toContainText('配置已变化');
  const exported = await page.request.get('/api/v1/manage/source-plugins/browser-source/export');
  expect(await exported.body()).toEqual(zip);
  await page.screenshot({
    path: `../../artifacts/050-verification/source-plugins-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const current = (
    await (await page.request.get('/api/v1/manage/source-plugins')).json()
  ).items.find((p: { id: string }) => p.id === 'browser-source');
  const upgraded = await page.request.post(
    `/api/v1/manage/source-plugins/import?expected_id=browser-source&expected_version=${current.version}`,
    { headers: { ...headers, 'Content-Type': 'application/zip' }, data: zip },
  );
  expect(upgraded.ok()).toBe(true);
  const value = await upgraded.json();
  expect(value.enabled).toBe(false);
  expect(
    (
      await page.request.delete(
        `/api/v1/manage/source-plugins/browser-source?version=${value.version}`,
        { headers },
      )
    ).ok(),
  ).toBe(true);
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
