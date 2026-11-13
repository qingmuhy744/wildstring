import { expect, test } from '@playwright/test';
import { login, manageTab } from './helpers';

test('单一队列说明待办原因，归档与清理都可恢复且历史默认折叠', async ({ page }, info) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items[0];
  let completed = false,
    archived = false,
    cleared = false,
    reject = true;
  const mutations: { path: string; body: unknown }[] = [];
  await page.route('**/api/v1/manage/providers/tasks**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      mutations.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (reject) return route.fulfill({ status: 503, json: { detail: 'provider_unavailable' } });
      if (url.pathname.endsWith('/review')) archived = true;
      if (url.pathname.endsWith('/clear')) cleared = true;
      return route.fulfill({ json: { reviewed: 1, cleared: 1 } });
    }
    const view = url.searchParams.get('view') || 'queue';
    const counts = {
      active: completed ? 0 : 1,
      pending: completed && !archived ? 1 : 0,
      attention: 0,
      queue: completed && !archived ? 1 : 0,
      history: completed && archived && !cleared ? 1 : 0,
    };
    const item = {
      id: 'task-one',
      track_id: track.id,
      title: track.title,
      status: completed ? 'completed' : 'running',
      warnings: completed ? '["provider_http_error"]' : '[]',
      has_issue: completed ? 1 : 0,
      requires_attention: completed && !archived ? 1 : 0,
      job_count: 2,
      suggestion_count: archived ? 0 : 2,
      created_at: Date.now() / 1000 - 100,
      updated_at: Date.now() / 1000 - 1,
      acknowledged_at: archived ? Date.now() / 1000 : null,
    };
    return route.fulfill({
      json: {
        view,
        counts,
        items: counts[view as keyof typeof counts] ? [item] : [],
        total: counts[view as keyof typeof counts],
        limit: 20,
        offset: 0,
        queued: 0,
        running: counts.active,
        snapshot_at: 12345,
        retention_days: 30,
      },
    });
  });
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('manage');
  else await page.getByRole('button', { name: '管理中心', exact: true }).click();
  await manageTab(page, '任务记录');
  const panel = page.getByRole('region', { name: '歌曲信息补全', exact: true });
  await expect(panel).toContainText('没有需要补充的歌曲信息');
  await expect(panel).toContainText('正在查询 1 首');
  completed = true;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(panel).toContainText('还有 1 首需要确认');
  await expect(panel.getByRole('list', { name: '需要补全的歌曲' })).toContainText(track.title);
  await expect(panel).toContainText('有 2 项信息等待确认');
  await expect(panel).toContainText('合并 2 次查询');
  await expect(panel.getByRole('button', { name: '清理历史', exact: true })).toBeHidden();
  await page.screenshot({
    path: `../../artifacts/metadata-tasks-${info.project.name}.png`,
    fullPage: true,
  });
  const widths = await panel.evaluate((node) => ({
    width: node.clientWidth,
    scroll: node.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.width + 1);
  await panel.getByRole('button', { name: `${track.title} 的更多操作`, exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '不再处理这首', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel).toContainText('有 2 项信息等待确认');
  reject = false;
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '不再处理这首', exact: true }).click();
  await expect(panel).toContainText('没有需要补充的歌曲信息');
  expect(mutations.at(-1)?.body).toEqual({ view: 'queue', through: 12345 });
  await panel.locator('summary').last().click();
  await expect(panel.getByRole('list', { name: '已归档的查询' })).toContainText(track.title);
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '清理历史', exact: true }).click();
  await expect(panel).toContainText('没有已归档的查询');
  expect(mutations.at(-1)?.body).toEqual({ through: 12345 });
});
