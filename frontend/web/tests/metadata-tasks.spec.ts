import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('任务完成自动退出进行中，建议保留，忽略和清理可恢复且历史默认折叠', async ({ page }, info) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items[0];
  let completed = false,
    ignored = false,
    cleared = false,
    reject = true;
  const mutations: { path: string; body: unknown }[] = [];
  await page.route('**/api/v1/manage/providers/tasks**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      mutations.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (reject) return route.fulfill({ status: 503, json: { detail: 'provider_unavailable' } });
      if (url.pathname.endsWith('/review')) ignored = true;
      if (url.pathname.endsWith('/clear')) cleared = true;
      return route.fulfill({ json: { reviewed: 1, cleared: 1 } });
    }
    const view = url.searchParams.get('view') || 'active';
    const counts = {
      active: completed ? 0 : 1,
      pending: completed && !ignored ? 1 : 0,
      attention: 0,
      history: completed && ignored && !cleared ? 1 : 0,
    };
    const item = {
      id: 'task-one',
      track_id: track.id,
      title: track.title,
      status: completed ? 'completed' : 'running',
      warnings: completed ? '["provider_http_error"]' : '[]',
      has_issue: completed ? 1 : 0,
      requires_attention: completed && !ignored ? 1 : 0,
      job_count: 2,
      suggestion_count: ignored ? 0 : 2,
      created_at: Date.now() / 1000 - 100,
      updated_at: Date.now() / 1000 - 1,
      acknowledged_at: ignored ? Date.now() / 1000 : null,
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
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '任务记录', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '元数据更新任务', exact: true });
  await expect(panel.getByRole('list', { name: '进行中的元数据任务' })).toContainText(track.title);
  completed = true;
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(panel).toContainText('当前没有进行中的查询');
  await panel.getByRole('button', { name: /待确认\s*1/ }).click();
  await expect(panel).toContainText('部分完成');
  await expect(panel).toContainText('2 条待确认建议');
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
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '忽略建议', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel).toContainText('2 条待确认建议');
  reject = false;
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '忽略建议', exact: true }).click();
  await expect(panel).toContainText('没有待确认的建议');
  expect(mutations[1].body).toEqual({ view: 'pending', through: 12345 });
  await panel.locator('summary').click();
  await expect(panel.getByRole('list', { name: '历史记录的元数据任务' })).toContainText(
    track.title,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByRole('button', { name: '清理历史', exact: true }).click();
  await expect(panel).toContainText('没有已归档的查询');
  expect(mutations.at(-1)?.body).toEqual({ through: 12345 });
});
