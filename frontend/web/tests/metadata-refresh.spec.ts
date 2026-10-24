import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
async function management(page: Page, mobile: boolean) {
  if (mobile) await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
}

test('元数据来源可拖动或用键盘排序，保存后保留且密钥不回显', async ({ page }, info) => {
  await login(page);
  const original = await (await page.request.get('/api/v1/manage/providers')).json();
  const {
    lastfm_configured: _fm,
    proxy_configured: _proxy,
    environment_proxy_configured: _env,
    acoustid_configured: _acoustid,
    fingerprint_available: _fp,
    ...body
  } = original;
  try {
    await management(page, info.project.name === 'mobile');
    await page
      .getByRole('navigation', { name: '管理分类' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    const list = page.getByRole('list', { name: '元数据来源优先级' });
    const grip = page.getByRole('button', { name: '拖动 Last.fm 优先级', exact: true });
    await grip.focus();
    await grip.press('ArrowUp');
    await expect(list.locator('li').first()).toContainText('Last.fm');
    // Actual pointer drag also works with touch capture on a narrow screen.
    await list.scrollIntoViewIfNeeded();
    const from = (await grip.boundingBox())!;
    const to = (await page
      .getByRole('button', { name: '拖动 MusicBrainz 优先级', exact: true })
      .boundingBox())!;
    if (info.project.name === 'mobile') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x + from.width / 2, y: from.y + from.height / 2 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: to.x + to.width / 2, y: to.y + to.height / 2 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
    }
    await expect(list.locator('li').first()).toContainText('MusicBrainz');
    await page.getByRole('button', { name: '拖动 Last.fm 优先级', exact: true }).press('ArrowUp');
    await page
      .getByLabel('AcoustID Application API Key', { exact: true })
      .fill('fixture-acoustid-key');
    await page.getByRole('button', { name: '保存联网设置', exact: true }).click();
    await expect(page.getByText('联网设置已保存。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('AcoustID Application API Key', { exact: true })).toHaveValue('');
    const saved = await (await page.request.get('/api/v1/manage/providers')).json();
    expect(saved.priority).toEqual(['lastfm', 'musicbrainz']);
    expect(saved.acoustid_configured).toBe(true);
    expect(saved.acoustid_api_key).toBeUndefined();
    await page.reload();
    await management(page, info.project.name === 'mobile');
    await page
      .getByRole('navigation', { name: '管理分类' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(list.locator('li').first()).toContainText('Last.fm');
    await page.screenshot({
      path: `../../artifacts/metadata-provider-settings-${info.project.name}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    const current = await (await page.request.get('/api/v1/manage/providers')).json();
    await page.request.put('/api/v1/manage/providers', {
      headers,
      data: { ...body, version: current.version, acoustid_api_key: '' },
    });
  }
});

test('歌曲、专辑、曲库手动更新先反馈再入队，保持当前音频', async ({ page }, info) => {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await audio(page)).duration).toBeGreaterThan(0);
  const before = await audio(page);
  const submitted: Record<string, unknown>[] = [];
  let release: (() => void) | undefined;
  await page.route('**/api/v1/manage/providers/refresh', async (route) => {
    submitted.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { queued: 1, already_active: 0, total: 1 } });
  });
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '更新元数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新元数据', exact: true });
  await expect(dialog.getByLabel('更新方式')).toHaveValue('missing');
  await dialog.getByLabel('更新方式').selectOption('all');
  await dialog.getByLabel('重新联网查询', { exact: true }).check();
  const start = dialog.getByRole('button', { name: '开始更新', exact: true });
  await start.click();
  await expect.poll(() => submitted.length).toBe(1);
  await expect(dialog.getByRole('button', { name: '正在提交…', exact: true })).toBeDisabled();
  expect(submitted[0]).toMatchObject({ scope: 'track', mode: 'all', force: true });
  expect(await audio(page)).toEqual(before);
  release!();
  await expect(dialog.getByRole('status')).toContainText('已加入 1 首');
  await page.screenshot({ path: `../../artifacts/metadata-refresh-${info.project.name}.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `../../artifacts/metadata-refresh-dark-${info.project.name}.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();

  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name: '专辑', exact: true })
    .click();
  await page.getByRole('button', { name: '打开专辑 合成测试专辑', exact: true }).click();
  await page.getByLabel('集合更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '更新专辑元数据', exact: true }).click();
  await dialog.getByRole('button', { name: '开始更新', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toMatchObject({ scope: 'album', mode: 'missing', force: false });
  release!();
  await expect(dialog.getByRole('status')).toContainText('已加入 1 首');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();

  await management(page, info.project.name === 'mobile');
  await page.getByRole('button', { name: '更新曲库元数据', exact: true }).click();
  await dialog.getByRole('button', { name: '开始更新', exact: true }).click();
  await expect.poll(() => submitted.length).toBe(3);
  expect(submitted[2]).toEqual({ scope: 'library', mode: 'missing', force: false });
  release!();
  await expect(dialog.getByRole('status')).toContainText('已加入 1 首');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '任务记录', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '元数据更新任务' })).toContainText('等待 0 首');
  expect(await audio(page)).toEqual(before);
});

test('歌曲编辑里的在线匹配展开收起后保留编辑器', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  const matcher = editor.locator('.online-metadata-matcher');
  await matcher.getByRole('button', { name: '查找网络元数据 ↗', exact: true }).click();
  await expect(matcher.getByRole('button', { name: '重新联网检索', exact: true })).toBeVisible();
  await matcher.getByRole('button', { name: '收起在线匹配', exact: true }).click();
  await expect(
    matcher.getByRole('button', { name: '查找网络元数据 ↗', exact: true }),
  ).toBeVisible();
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});
