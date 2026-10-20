import { section } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';
const headers = { 'X-Wildstring-Client': 'web' };

test('真实后端：草案确认后应用一次，歌单和通知可从网页补拉', async ({ page }, info) => {
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const title = `真实工作台歌单-${info.project.name}`;
  const created = await page.request.post('/api/v1/agent/drafts', {
    headers,
    data: {
      kind: 'playlist',
      title,
      payload: { name: title, track_ids: tracks.map((t: { id: string }) => t.id) },
      evidence: [{ source: '合成测试曲库', summary: '两首由测试创建的真实曲目；未调用模型。' }],
    },
  });
  expect(created.ok()).toBe(true);
  const draft = await created.json();
  await section(page, '待确认草案');
  await page.getByRole('button', { name: `查看草案 ${title}`, exact: true }).click();
  const detail = page.getByRole('article', { name: '草案详情' });
  await expect(detail).toContainText('晴天测试曲');
  await expect(detail).toContainText('夜晚测试曲');
  await detail.getByRole('button', { name: '接受并应用', exact: true }).click();
  await expect(detail).toContainText('歌单已保存');
  const applied = await (await page.request.get(`/api/v1/agent/drafts/${draft.id}`)).json();
  expect(applied.status).toBe('applied');
  const list = (await (await page.request.get('/api/v1/playlists')).json()).items.find(
    (p: { name: string }) => p.name === title,
  );
  expect(list.track_count).toBe(2);
  await section(page, '通知中心');
  const inbox = page.getByRole('region', { name: '通知中心', exact: true });
  await inbox.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(inbox).toContainText(title);
  const before = await (await page.request.get('/api/v1/agent/notifications')).json();
  const readTarget = before.items.find(
    (n: { draft_id: string; read_at: string | null }) => n.draft_id === draft.id && !n.read_at,
  );
  expect(readTarget).toBeTruthy();
  await page.request.post('/api/v1/agent/notifications/read', {
    headers,
    data: { ids: [readTarget.id] },
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => {
      const data = await (await page.request.get('/api/v1/agent/notifications')).json();
      return data.items.find((n: { id: string }) => n.id === readTarget.id).read_at;
    })
    .not.toBeNull();
  await page.screenshot({
    path: `../../artifacts/agent-real-inbox-${info.project.name}.png`,
    fullPage: true,
  });
  await page.request.delete(`/api/v1/playlists/${list.id}?version=${list.version}`, { headers });
});

test('真实后端：纯规则巡检完成、任务回读和关闭的计划可启停删除', async ({ page }, info) => {
  await login(page);
  await section(page, '巡检与任务');
  const panel = page.getByRole('region', { name: '巡检与任务', exact: true });
  await panel.getByRole('button', { name: '提交规则巡检', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('巡检已提交');
  await expect
    .poll(
      async () => {
        const items = (await (await page.request.get('/api/v1/agent/tasks')).json()).items;
        return items.some((item: { status: string }) =>
          ['succeeded', 'partial'].includes(item.status),
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('button', { name: '查看任务', exact: true }).first().click();
  await expect(page.getByRole('article', { name: '巡检任务详情' })).toContainText('巡检结果');
  await panel.getByRole('button', { name: '定时巡检', exact: true }).click();
  await panel.getByLabel('计划名称', { exact: true }).fill(`测试计划-${info.project.name}`);
  await panel.getByRole('button', { name: '保存关闭的计划', exact: true }).click();
  await expect(panel.getByRole('button', { name: '开启计划', exact: true }).last()).toBeVisible();
  await panel.getByRole('button', { name: '开启计划', exact: true }).last().click();
  await expect(panel.getByRole('button', { name: '关闭计划', exact: true }).last()).toBeVisible();
  await panel.getByRole('button', { name: '关闭计划', exact: true }).last().click();
  page.once('dialog', (d) => d.accept());
  await panel.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(panel).not.toContainText(`测试计划-${info.project.name}`);
});
