import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function section(page: Page, name: string) {
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible())
    await page.getByLabel('浏览方式', { exact: true }).selectOption({ label: name });
  else
    await page
      .locator('.sidebar')
      .getByRole('button', { name: new RegExp(`^${name}(?: |$)`) })
      .click();
}

test('真实后端：搜索配置、长期记忆管理与摘要开关', async ({ page }, info) => {
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '联网与记忆', exact: true }).click();
  const panel = page.getByRole('region', { name: '联网与记忆设置' });
  await expect(panel.getByRole('button', { name: '保存搜索设置', exact: true })).toBeEnabled();
  await panel.getByLabel('搜索服务', { exact: true }).selectOption('tavily');
  await panel.getByLabel('搜索 API Key', { exact: true }).fill('synthetic-browser-search-key');
  await panel.getByLabel('每日搜索请求上限').fill('12');
  await panel.getByLabel('启用聊天联网搜索').check();
  await panel.getByRole('button', { name: '保存搜索设置', exact: true }).click();
  await expect(panel).toContainText('联网搜索设置已保存');
  const settings = await (await page.request.get('/api/v1/agent/search-settings')).json();
  expect(settings).toMatchObject({
    enabled: true,
    provider: 'tavily',
    daily_budget: 12,
    has_api_key: true,
  });
  expect(JSON.stringify(settings)).not.toContain('synthetic-browser-search-key');
  const original = `优先录音室版本-${info.project.name}`;
  await panel.getByLabel('长期记忆内容').fill(original);
  await panel.getByRole('button', { name: '保存长期记忆', exact: true }).click();
  await expect(panel.getByText(original, { exact: true })).toBeVisible();
  await panel
    .locator('article')
    .filter({ hasText: original })
    .getByRole('button', { name: '编辑记忆', exact: true })
    .click();
  await panel.getByLabel('长期记忆内容').fill(`${original}，保留发行年份`);
  await panel.getByRole('button', { name: '更新记忆', exact: true }).click();
  await expect(panel.getByText(`${original}，保留发行年份`, { exact: true })).toBeVisible();
  await panel.getByLabel('启用长对话摘要').uncheck();
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/agent/assistant-preferences')).json())
          .context_summary,
    )
    .toBe(false);
  await page.screenshot({
    path: `../../artifacts/050-verification/research-settings-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await panel
    .locator('article')
    .filter({ hasText: original })
    .getByRole('button', { name: '删除记忆', exact: true })
    .click();
  await expect(panel.getByText(`${original}，保留发行年份`, { exact: true })).toHaveCount(0);
  await panel.getByLabel('启用聊天联网搜索').uncheck();
  await panel.getByLabel('清除已保存的搜索密钥').check();
  await panel.getByRole('button', { name: '保存搜索设置', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/agent/search-settings')).json()).has_api_key,
    )
    .toBe(false);
  await panel.getByLabel('启用长对话摘要').check();
});

test('联网回答来源可点击、历史摘要可查看并清除', async ({ page }, info) => {
  await login(page);
  const conversation = {
    id: 'research-fixture',
    title: '发行考证夹具',
    connection_id: null,
    created_at: '2026-10-18T08:00:00Z',
    context_summary: {
      summary: '用户希望核对最初发行，排除精选集。',
      updated_at: '2026-10-18T08:00:00Z',
    },
    messages: [
      {
        id: 'source-message',
        role: 'assistant',
        content: '本次来源提供了发行记录，仍需区分录音与再版。',
        created_at: '2026-10-18T08:00:00Z',
        sources: [
          {
            id: 's1',
            title: '正式发行公告',
            url: 'https://example.com/releases?id=42',
            published_at: null,
          },
        ],
      },
    ],
    runs: [],
  };
  await page.route('**/api/v1/agent/conversations?*', (route) =>
    route.fulfill({ json: { items: [conversation], total: 1, limit: 100, offset: 0 } }),
  );
  await page.route('**/api/v1/agent/conversations/research-fixture', (route) =>
    route.fulfill({ json: conversation }),
  );
  await page.route('**/api/v1/agent/conversations/research-fixture/summary', (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await section(page, '音乐助手');
  await page.getByRole('button', { name: '发行考证夹具', exact: true }).click();
  await expect(page.getByRole('link', { name: '正式发行公告' })).toHaveAttribute(
    'href',
    'https://example.com/releases?id=42',
  );
  await page.getByText('已压缩较早对话 · 查看上下文摘要', { exact: true }).click();
  await expect(page.getByText('用户希望核对最初发行，排除精选集。', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/050-verification/research-answer-${info.project.name}.png`,
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清除摘要', exact: true }).click();
  await expect(page.getByText('已压缩较早对话 · 查看上下文摘要', { exact: true })).toHaveCount(0);
});
