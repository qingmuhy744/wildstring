import { expect, test } from '@playwright/test';
import packageInfo from '../package.json' with { type: 'json' };
import { audio, login, section, personalCategory, leaveSettings, manageTab } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };

test('服务器设置卡片有留白，转码字段在窄屏和明暗主题下保持对齐', async ({ page }, info) => {
  await login(page);
  await manageTab(page, '转码与缓存');
  const card = page.getByRole('form', { name: 'AAC 转码设置', exact: true });
  await expect(card.getByRole('button', { name: '保存转码设置' })).toBeEnabled();
  const widths = info.project.name === 'desktop' ? [1360, 820] : [393, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      const bounds = (await card.boundingBox())!;
      const title = (await card.getByRole('heading', { name: 'AAC 转码与缓存' }).boundingBox())!;
      expect(title.x - bounds.x).toBeGreaterThanOrEqual(16);
      expect(title.y - bounds.y).toBeGreaterThanOrEqual(16);
      for (const input of await card.locator('input').all()) {
        const field = (await input.boundingBox())!;
        expect(field.x - bounds.x).toBeGreaterThanOrEqual(16);
        expect(bounds.x + bounds.width - field.x - field.width).toBeGreaterThanOrEqual(15);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `../../artifacts/server-settings-${width}-${theme}.png` });
    }
  }
});

test('通知进入任务后可以切换管理分类，不重复跳回旧任务', async ({ page }) => {
  await page.route('**/api/v1/agent/notifications?*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'settings-navigation',
            event_id: 'settings-navigation',
            event_type: 'metadata.completed',
            title: '资料整理完成',
            summary: '查看本次处理结果',
            severity: 'info',
            task_id: null,
            draft_id: null,
            trace_id: null,
            created_at: new Date().toISOString(),
            read_at: null,
            version: 1,
            detail_route: null,
            actions: [{ id: 'metadata', target: 'metadata-center', label: '查看整理任务' }],
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
        next_cursor: null,
        unread_count: 1,
        high_watermark: 1,
      },
    }),
  );
  await login(page);
  await section(page, '通知中心');
  await page.getByRole('button', { name: '查看整理任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '歌曲信息补全', exact: true })).toBeVisible();
  await manageTab(page, '共享音频管理');
  await expect(page.getByRole('region', { name: '共享音频管理', exact: true })).toBeVisible();
  await leaveSettings(page);
  await expect(page.getByRole('button', { name: '查看整理任务', exact: true })).toBeVisible();
});

test('个人设置分层导航、昼夜布局、歌词偏好与播放连续', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await audio(page);
  await section(page, '个人设置');
  await expect(page.locator('.sidebar .account-entry')).toHaveClass(/nav-current/);
  const center = page.getByRole('region', { name: '个人设置', exact: true });
  await expect(
    center.getByRole('navigation', { name: '设置分类' }).getByRole('button'),
  ).toHaveCount(6);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await personalCategory(page, 'appearance');
    await center.getByLabel('外观模式').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      path: `../../artifacts/settings-appearance-${theme}-${info.project.name}.png`,
    });
    await center.getByRole('button', { name: '返回分类' }).click();
    await page.screenshot({
      path: `../../artifacts/settings-home-${theme}-${info.project.name}.png`,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await personalCategory(page, 'account');
  await center.getByRole('button', { name: '密码与安全', exact: true }).click();
  await expect(center.getByLabel('当前密码', { exact: true })).toBeVisible();
  await personalCategory(page, 'playback');
  await center.getByLabel('歌词大小', { exact: true }).selectOption('large');
  await center.getByLabel('显示歌词译文').uncheck();
  await center.getByLabel('显示歌词音译').check();
  await personalCategory(page, 'about');
  await expect(center).toContainText(`WildString 网页端 v${packageInfo.version}`);
  await personalCategory(page, 'playback');
  await expect(center.getByLabel('歌词大小', { exact: true })).toHaveValue('large');
  await expect(center.getByLabel('显示歌词译文')).not.toBeChecked();
  await expect(center.getByLabel('显示歌词音译')).toBeChecked();
  await leaveSettings(page);
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
  expect(await audio(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('播客管理集中入口、策略持久化与快捷入口保持一致', async ({ page }, info) => {
  await login(page);
  const original = await (await page.request.get('/api/v1/podcasts/resources/settings')).json();
  try {
    await section(page, '管理中心');
    await expect(page.locator('.sidebar .manage-entry')).toHaveClass(/nav-current/);
    await page.screenshot({ path: `../../artifacts/settings-management-${info.project.name}.png` });
    await manageTab(page, '共享音频管理');
    const resources = page.getByRole('region', { name: '共享音频管理', exact: true });
    await resources.getByLabel('自动清理零引用音频', { exact: true }).check();
    await resources.getByLabel('零引用后保留天数', { exact: true }).fill('3650');
    await resources.getByRole('button', { name: '保存清理策略' }).click();
    await expect(resources.getByRole('status')).toContainText('自动清理策略已保存');
    expect(
      await (await page.request.get('/api/v1/podcasts/resources/settings')).json(),
    ).toMatchObject({ enabled: true, retention_days: 3650 });
    await section(page, '电台 · 播客');
    await manageTab(page, '共享音频管理');
    await expect(resources.getByLabel('零引用后保留天数')).toHaveValue('3650');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: `../../artifacts/settings-cleanup-${info.project.name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await leaveSettings(page);
    await expect(page.locator('.podcasts-page')).toBeVisible();
    await manageTab(page, '下载管理');
    await expect(page.getByRole('region', { name: '下载管理', exact: true })).toBeVisible();
    await leaveSettings(page);
    await section(page, '个人设置');
    await personalCategory(page, 'downloads');
    await page.getByRole('button', { name: '前往我的播客', exact: true }).click();
    await expect(page.locator('.podcasts-page')).toBeVisible();
  } finally {
    const current = await (await page.request.get('/api/v1/podcasts/resources/settings')).json();
    await page.request.put('/api/v1/podcasts/resources/settings', {
      headers,
      data: { ...original, version: current.version },
    });
  }
});
