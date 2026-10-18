import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';
const now = '2026-10-17T09:00:00Z';
async function section(page: Page, name: string) {
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible())
    await page.getByLabel('浏览方式', { exact: true }).selectOption({ label: name });
  else
    await page
      .locator('.sidebar')
      .getByRole('button', { name: new RegExp(`^${name}(?: |$)`) })
      .click();
}
const list = (items: unknown[], extra = {}) => ({
  items,
  total: items.length,
  limit: 100,
  offset: 0,
  ...extra,
});

test('历史逐条改名和删除，失败保留对话，删除其他历史不影响当前会话', async ({ page }, info) => {
  await fixture(page);
  let history = ['a', 'b'].map((id) => ({
    id: `history-${id}`,
    title: id === 'a' ? '旧名字' : '另一段对话',
    connection_id: null,
    created_at: now,
    updated_at: now,
    messages: [{ id: `message-${id}`, role: 'user', content: `保留内容 ${id}`, created_at: now }],
    runs: [],
  }));
  let renamed: unknown = null,
    deletes: string[] = [],
    rejectDelete = true;
  await page.route('**/api/v1/agent/conversations?*', (route) =>
    route.fulfill({ json: list(history) }),
  );
  await page.route('**/api/v1/agent/conversations/history-*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    const item = history.find((entry) => entry.id === id)!;
    if (route.request().method() === 'PATCH') {
      renamed = route.request().postDataJSON();
      item.title = (renamed as { title: string }).title;
    }
    if (route.request().method() === 'DELETE') {
      deletes.push(id!);
      if (rejectDelete) {
        rejectDelete = false;
        return route.fulfill({ status: 409, json: { detail: 'conversation_busy' } });
      }
      history = history.filter((entry) => entry.id !== id);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: item });
  });
  await login(page);
  await section(page, '音乐助手');
  const panel = page.getByRole('region', { name: 'AI 音乐助手' });
  await panel.getByRole('button', { name: '另一段对话', exact: true }).click();
  await expect(panel).toContainText('保留内容 b');
  await panel.getByRole('button', { name: '改名：旧名字', exact: true }).click();
  const renameDialog = page.getByRole('dialog', { name: '对话改名', exact: true });
  await renameDialog.getByLabel('对话名称').fill('   ');
  await expect(renameDialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await renameDialog.getByLabel('对话名称').fill('  夜晚的摇滚歌单  ');
  await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(renameDialog).not.toBeVisible();
  expect(renamed).toEqual({ title: '夜晚的摇滚歌单' });
  await expect(panel.getByRole('button', { name: '夜晚的摇滚歌单', exact: true })).toBeVisible();
  await expect(panel).toContainText('保留内容 b');
  const remove = panel.getByRole('button', { name: '删除：夜晚的摇滚歌单', exact: true });
  await remove.click();
  const deleteDialog = page.getByRole('dialog', { name: '删除对话', exact: true });
  await expect(deleteDialog).toContainText('已有草案和歌单会保留');
  await page.screenshot({
    path: `../../artifacts/041-verification/history-delete-${info.project.name}.png`,
    fullPage: true,
  });
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(deletes).toEqual([]);
  await remove.click();
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(deleteDialog.getByRole('alert')).toContainText('正在生成回复');
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(deleteDialog).not.toBeVisible();
  await expect(panel.getByRole('button', { name: '夜晚的摇滚歌单', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('保留内容 b');
  await panel.getByRole('button', { name: '删除对话', exact: true }).click();
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(panel).not.toContainText('保留内容 b');
  await expect(panel.getByRole('heading', { name: '最近对话' })).toHaveCount(0);
  expect(deletes).toEqual(['history-a', 'history-a', 'history-b']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
async function fixture(page: Page) {
  await page.route('**/api/v1/agent/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/notifications'))
      return route.fulfill({
        json: list([], { next_cursor: '0', high_watermark: 0, unread_count: 0 }),
      });
    if (url.pathname.endsWith('/endpoint-policy'))
      return route.fulfill({ json: { allowed_hosts: [], allow_private: false } });
    if (url.pathname.endsWith('/notification-preferences'))
      return route.fulfill({
        json: {
          telegram_enabled: false,
          event_types: [],
          min_severity: 'info',
          quiet_start: null,
          quiet_end: null,
          timezone: 'Asia/Shanghai',
        },
      });
    return route.fulfill({ json: list([]) });
  });
}

test('通知跨页、已读补拉、快照批量已读与待确认跳转', async ({ page }, info) => {
  await fixture(page);
  let readPosts = 0,
    readAll: any = null,
    version = 1;
  const notices = Array.from({ length: 107 }, (_, i) => ({
    id: `notice-${i}`,
    event_id: `event-${i}`,
    event_type: 'draft.created',
    title: `待确认草案 ${i}`,
    summary: '已找到资料依据，尚未应用。',
    severity: 'info',
    task_id: null,
    draft_id: 'draft-one',
    trace_id: 'trace-notify-040',
    created_at: new Date(Date.parse(now) + i * 1000).toISOString(),
    read_at: null as string | null,
    version: 1,
    detail_route: null,
  }));
  const draft = {
    id: 'draft-one',
    kind: 'playlist',
    title: '轻摇滚候选',
    payload: { name: '轻摇滚候选', track_ids: [] },
    evidence: [{ source: '本地规则', summary: '来自真实曲库候选' }],
    status: 'pending',
    version: 1,
    approved_version: null,
    created_at: now,
    updated_at: now,
    result: null,
  };
  await page.route('**/api/v1/agent/drafts/draft-one', (r) => r.fulfill({ json: draft }));
  await page.route('**/api/v1/agent/notifications?*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    const offset = Number(q.get('offset') || 0);
    return r.fulfill({
      json: list(
        q.has('cursor') ? (version > 1 ? [notices[0]] : []) : notices.slice(offset, offset + 100),
        {
          total: notices.length,
          limit: 100,
          offset,
          next_cursor: String(version),
          high_watermark: 107,
          unread_count: notices.filter((n) => !n.read_at).length,
        },
      ),
    });
  });
  await page.route('**/api/v1/agent/notifications/read', async (r) => {
    readPosts++;
    const ids = r.request().postDataJSON().ids;
    for (const n of notices)
      if (ids.includes(n.id)) {
        n.read_at = now;
        n.version = ++version;
      }
    return r.fulfill({ json: {} });
  });
  await page.route('**/api/v1/agent/notifications/read-all', async (r) => {
    readAll = r.request().postDataJSON();
    for (const n of notices) {
      n.read_at = now;
      n.version = ++version;
    }
    return r.fulfill({ json: {} });
  });
  await login(page);
  await section(page, '通知中心');
  const panel = page.getByRole('region', { name: '通知中心', exact: true });
  await expect(panel.getByRole('heading', { name: /待确认草案 / })).toHaveCount(107);
  expect(readPosts).toBe(0);
  await panel.getByRole('button', { name: '标为已读 待确认草案 0', exact: true }).click();
  await expect(panel.getByRole('button', { name: '未读 · 106', exact: true })).toBeVisible();
  expect(readPosts).toBe(1);
  await panel.getByRole('button', { name: '将当前通知标为已读', exact: true }).click();
  await expect.poll(() => readAll).toEqual({ high_watermark: 107 });
  await panel.getByRole('button', { name: '查看草案', exact: true }).first().click();
  await expect(page.getByRole('region', { name: '草案工作台' })).toContainText('轻摇滚候选');
  await page.screenshot({
    path: `../../artifacts/agent-drafts-${info.project.name}.png`,
    fullPage: true,
  });
});

test('草案批准和应用分离，网络重试沿用幂等键且保留诊断编号', async ({ page }) => {
  await fixture(page);
  let draft: any = {
    id: 'playlist-draft',
    kind: 'playlist',
    title: '待确认歌单',
    payload: { name: '待确认歌单', track_ids: [] },
    evidence: [{ source: '本地曲库', summary: '真实曲目集合' }],
    status: 'pending',
    version: 2,
    approved_version: null,
    created_at: now,
    updated_at: now,
    result: null,
  };
  let approves = 0,
    applies: any[] = [];
  await page.route('**/api/v1/agent/drafts?*', (r) => r.fulfill({ json: list([draft]) }));
  await page.route('**/api/v1/agent/drafts/playlist-draft/approve', (r) => {
    approves++;
    expect(r.request().postDataJSON()).toEqual({ version: 2 });
    draft = { ...draft, status: 'approved', version: 3, approved_version: 3 };
    return r.fulfill({ json: draft });
  });
  await page.route('**/api/v1/agent/drafts/playlist-draft/apply', (r) => {
    applies.push(r.request().postDataJSON());
    if (applies.length === 1)
      return r.fulfill({
        status: 503,
        headers: { 'X-Wildstring-Trace-Id': 'trace-apply-040' },
        json: { detail: 'temporary_unavailable' },
      });
    draft = { ...draft, status: 'applied', version: 4, result: { playlist_id: 'saved' } };
    return r.fulfill({ json: draft });
  });
  await login(page);
  await section(page, '待确认草案');
  await page.getByRole('button', { name: '查看草案 待确认歌单', exact: true }).click();
  await page.getByRole('button', { name: '批准当前版本', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用已批准草案', exact: true })).toBeVisible();
  expect(approves).toBe(1);
  expect(applies).toHaveLength(0);
  await page.getByRole('button', { name: '应用已批准草案', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('trace-apply-040');
  await page.getByRole('button', { name: '应用已批准草案', exact: true }).click();
  await expect(page.getByRole('article', { name: '草案详情' })).toContainText('歌单已保存');
  expect(applies[1].idempotency_key).toBe(applies[0].idempotency_key);
});

test('旧服务端不支持新接口时明确降级，通知不误报成功', async ({ page }) => {
  await page.route('**/api/v1/agent/**', (r) =>
    r.fulfill({ status: 404, json: { detail: 'not_found' } }),
  );
  await login(page);
  await section(page, '通知中心');
  await expect(page.getByRole('region', { name: '通知中心' })).toContainText(
    '当前服务端尚未提供这项功能',
  );
  await section(page, '音乐助手');
  await expect(page.getByRole('region', { name: 'AI 音乐助手' })).toContainText(
    '当前服务端尚未提供这项功能',
  );
  await section(page, '全部歌曲');
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
});

test('多轮助手保留中文组合输入，失败不丢草稿，回退与草案单独展示', async ({ page }, info) => {
  await fixture(page);
  let conversation: any = { id: 'chat-one', title: '中文找歌', messages: [], runs: [] },
    fail = true;
  let submitted: string[] = [];
  await page.route('**/api/v1/agent/conversations', (r) => r.fulfill({ json: conversation }));
  await page.route('**/api/v1/agent/conversations/chat-one', (r) =>
    r.fulfill({ json: conversation }),
  );
  await page.route('**/api/v1/agent/conversations/chat-one/messages', (r) => {
    const content = r.request().postDataJSON().content;
    submitted.push(content);
    if (fail) {
      fail = false;
      return r.fulfill({
        status: 502,
        headers: { 'X-Wildstring-Trace-Id': 'trace-chat-040' },
        json: { detail: 'ai_connection_failed' },
      });
    }
    conversation = {
      ...conversation,
      messages: [
        { id: 'u', role: 'user', content, created_at: now },
        {
          id: 'a',
          role: 'assistant',
          content: '找到了真实曲库候选，先核对歌单草案。',
          created_at: now,
        },
      ],
      runs: [
        {
          id: 'run',
          status: 'local_fallback',
          connection_id: null,
          error_code: null,
          tool_calls: [],
          draft_ids: ['draft-one'],
          trace_id: 'trace-local-040',
        },
      ],
    };
    return r.fulfill({ json: conversation });
  });
  await login(page);
  await section(page, '音乐助手');
  const box = page.getByRole('textbox', { name: '给助手的消息' });
  await box.fill('找出许嵩的歌曲，先生成草案');
  await box.dispatchEvent('compositionstart');
  await box.press('Enter');
  await box.dispatchEvent('compositionend');
  expect(submitted).toHaveLength(0);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('trace-chat-040');
  await expect(box).toHaveValue(/找出许嵩/);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 音乐助手' })).toContainText(
    '本地关键词检索 · 未调用模型',
  );
  await expect(page.getByRole('button', { name: '查看待确认草案' })).toBeVisible();
  await expect(box).toHaveValue('');
  await page.screenshot({
    path: `../../artifacts/agent-chat-${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Telegram 目标需显式验证，未验证无测试入口，未知投递先确认', async ({ page }, info) => {
  await fixture(page);
  let targets: any[] = [],
    verifySends = 0,
    testSends = 0,
    retries = 0;
  await page.route('**/api/v1/agent/telegram-targets?*', (r) => r.fulfill({ json: list(targets) }));
  await page.route('**/api/v1/agent/telegram-targets', (r) => {
    expect(r.request().postDataJSON().enabled).toBe(false);
    targets = [
      {
        id: 'tg',
        name: '私人结果',
        has_token: true,
        verified: false,
        enabled: false,
        version: 1,
        created_at: now,
      },
    ];
    return r.fulfill({ json: targets[0] });
  });
  await page.route('**/api/v1/agent/telegram-targets/tg/verify-send', (r) => {
    verifySends++;
    return r.fulfill({ json: { sent: true } });
  });
  await page.route('**/api/v1/agent/telegram-targets/tg/verify', (r) => {
    expect(r.request().postDataJSON()).toEqual({ code: '123456' });
    targets[0] = { ...targets[0], verified: true, enabled: true, version: 2 };
    return r.fulfill({ json: targets[0] });
  });
  await page.route('**/api/v1/agent/telegram-targets/tg/test', (r) => {
    testSends++;
    return r.fulfill({ json: {} });
  });
  await page.route('**/api/v1/agent/deliveries?*', (r) =>
    r.fulfill({
      json: list([
        {
          id: 'unknown-delivery',
          target_id: 'tg',
          event_id: 'event1',
          status: 'unknown',
          attempt: 1,
          next_attempt_at: null,
          error_code: 'timeout',
          message_id: null,
          trace_id: 'trace-delivery-040',
        },
      ]),
    }),
  );
  await page.route('**/api/v1/agent/deliveries/unknown-delivery/retry', (r) => {
    retries++;
    expect(r.request().postDataJSON()).toEqual({ acknowledge_unknown: true });
    return r.fulfill({ json: {} });
  });
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '通知与 Telegram', exact: true }).click();
  await page.getByText('添加 Telegram 接收目标', { exact: true }).click();
  await page.getByLabel('Telegram 目标名称', { exact: true }).fill('私人结果');
  await page
    .getByLabel('Telegram Bot Token', { exact: true })
    .fill('12345:synthetic-private-bot-token');
  await page.getByLabel('Telegram Chat ID', { exact: true }).fill('98765');
  await page.getByRole('button', { name: '保存待验证目标', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送验证消息', exact: true })).toBeVisible();
  expect(verifySends).toBe(0);
  await expect(page.getByRole('button', { name: '发送测试消息', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '发送验证消息', exact: true }).click();
  await expect.poll(() => verifySends).toBe(1);
  await page.getByLabel('私人结果 的验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '确认验证码', exact: true }).click();
  await page.getByRole('button', { name: '发送测试消息', exact: true }).click();
  await expect.poll(() => testSends).toBe(1);
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: '重试投递', exact: true }).click();
  expect(retries).toBe(0);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '重试投递', exact: true }).click();
  await expect.poll(() => retries).toBe(1);
  expect(await page.getByRole('region', { name: 'Telegram 通知设置' }).textContent()).not.toContain(
    'synthetic-private-bot-token',
  );
  await page.screenshot({
    path: `../../artifacts/agent-telegram-${info.project.name}.png`,
    fullPage: true,
  });
});

test('连接编辑仅发送允许字段，MCP 凭据只显示一次且可撤销', async ({ page }) => {
  await fixture(page);
  let connection: any = {
    id: 'personal',
    name: '私人模型',
    scope: 'personal',
    base_url: 'https://model.example/v1',
    model: 'test-model',
    timeout: 30,
    shared: false,
    background_allowed: false,
    daily_call_budget: 100,
    enabled: true,
    has_api_key: true,
    version: 2,
    capabilities: { text: true, tools: false, tested_at: now },
    created_at: now,
  };
  let edited: any = null,
    credential: any = null;
  await page.route('**/api/v1/agent/connections?*', (r) => r.fulfill({ json: list([connection]) }));
  await page.route('**/api/v1/agent/connections/personal', (r) => {
    edited = r.request().postDataJSON();
    connection = { ...connection, ...edited, version: 3 };
    return r.fulfill({ json: connection });
  });
  await page.route('**/api/v1/agent/credentials?*', (r) =>
    r.fulfill({ json: list(credential ? [credential] : []) }),
  );
  await page.route('**/api/v1/agent/credentials', (r) => {
    credential = {
      id: 'credential',
      name: r.request().postDataJSON().name,
      scopes: r.request().postDataJSON().scopes,
      created_at: now,
      expires_at: now,
      revoked_at: null,
    };
    return r.fulfill({ json: { ...credential, token: 'ws_synthetic-once-only-secret' } });
  });
  await page.route('**/api/v1/agent/credentials/credential', (r) => {
    credential = { ...credential, revoked_at: now };
    return r.fulfill({ status: 204 });
  });
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '编辑连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('重命名私人模型');
  await page.getByRole('button', { name: '保存连接修改', exact: true }).click();
  await expect.poll(() => edited?.name).toBe('重命名私人模型');
  expect(edited.version).toBe(2);
  expect(edited.id).toBeUndefined();
  expect(edited.capabilities).toBeUndefined();
  expect(edited.api_key).toBeUndefined();
  await page.getByRole('button', { name: 'MCP 工具凭据', exact: true }).click();
  await page.getByLabel('工具凭据名称', { exact: true }).fill('本机 Codex');
  await page.getByRole('button', { name: '生成工具凭据', exact: true }).click();
  await expect(page.getByRole('region', { name: 'MCP 工具凭据' })).toContainText(
    'ws_synthetic-once-only-secret',
  );
  await page.getByRole('button', { name: '隐藏凭据', exact: true }).click();
  await expect(page.getByRole('region', { name: 'MCP 工具凭据' })).not.toContainText(
    'ws_synthetic-once-only-secret',
  );
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '撤销凭据', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'MCP 工具凭据' }).getByRole('status'),
  ).toContainText('凭据已撤销');
});

test('已有实例模型可手动巡检，定时计划仍要求自动使用授权', async ({ page }, info) => {
  await fixture(page);
  const legacy = {
    id: 'legacy',
    name: '实例 AI（已有配置）',
    model: 'synthetic',
    enabled: true,
    read_only: true,
    background_allowed: false,
  };
  const automatic = {
    ...legacy,
    id: 'automatic',
    name: '自动巡检模型',
    read_only: false,
    background_allowed: true,
  };
  await page.route('**/api/v1/agent/connections', (r) =>
    r.fulfill({ json: list([legacy, automatic]) }),
  );
  let submitted: any = null;
  await page.route('**/api/v1/agent/tasks', (r) => {
    submitted = r.request().postDataJSON();
    return r.fulfill({ json: { id: 'task-manual' } });
  });
  await login(page);
  await section(page, '巡检与任务');
  await page.getByLabel('使用 AI 辅助巡检', { exact: true }).check();
  const submit = page.getByRole('button', { name: '提交 AI 辅助巡检', exact: true });
  await expect(submit).toBeDisabled();
  await expect(page.getByText('请选择用于本次巡检的 AI 连接。', { exact: true })).toBeVisible();
  await page.getByLabel('巡检模型连接', { exact: true }).selectOption('legacy');
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: info.outputPath('manual-ai-inspection.png'), fullPage: true });
  await submit.click();
  await expect
    .poll(() => submitted)
    .toEqual({ max_tracks: 500, max_calls: 4, use_ai: true, connection_id: 'legacy' });
  await page.getByRole('button', { name: '定时巡检', exact: true }).click();
  const save = page.getByRole('button', { name: '保存关闭的计划', exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByLabel('巡检模型连接').locator('option[value="legacy"]')).toHaveCount(0);
  await page.getByLabel('巡检模型连接').selectOption('automatic');
  await expect(save).toBeEnabled();
});

test('规则巡检不调用模型，计划默认关闭并通过完整版本参数启用', async ({ page }) => {
  await fixture(page);
  let submitted: any = null,
    changed: any = null,
    schedules: any[] = [];
  await page.route('**/api/v1/agent/tasks?*', (r) => r.fulfill({ json: list([]) }));
  await page.route('**/api/v1/agent/tasks', (r) => {
    submitted = r.request().postDataJSON();
    return r.fulfill({ json: { id: 'task' } });
  });
  await page.route('**/api/v1/agent/schedules?*', (r) => r.fulfill({ json: list(schedules) }));
  await page.route('**/api/v1/agent/schedules', (r) => {
    const body = r.request().postDataJSON();
    expect(body.enabled).toBe(false);
    schedules = [{ id: 'schedule', ...body, version: 1, next_run_at: null }];
    return r.fulfill({ json: schedules[0] });
  });
  await page.route('**/api/v1/agent/schedules/schedule', (r) => {
    changed = r.request().postDataJSON();
    schedules[0] = { ...schedules[0], ...changed, version: 2 };
    return r.fulfill({ json: schedules[0] });
  });
  await login(page);
  await section(page, '巡检与任务');
  await page.getByRole('button', { name: '提交规则巡检', exact: true }).click();
  await expect.poll(() => submitted).toEqual({ max_tracks: 500, max_calls: 0, use_ai: false });
  await page.getByRole('button', { name: '定时巡检', exact: true }).click();
  await page.getByRole('button', { name: '保存关闭的计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '开启计划', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开启计划', exact: true }).click();
  await expect.poll(() => changed?.enabled).toBe(true);
  expect(changed).toMatchObject({
    name: '每日曲库巡检',
    version: 1,
    interval_hours: 24,
    parameters: { use_ai: false },
  });
  expect(changed.id).toBeUndefined();
});

test('受控诊断按编号筛选，时间线带错误码，临时调试最长15分钟', async ({ page }) => {
  await fixture(page);
  let queries: URLSearchParams[] = [],
    debug: any = null;
  await page.route('**/api/v1/manage/diagnostics/status', (r) =>
    r.fulfill({
      json: {
        version: '0.4.0',
        schema_version: 17,
        logging: { retention_days: 7, max_bytes: 209715200, degraded: false, debug_until: null },
        external_services: ['musicbrainz'],
        agent_available: true,
      },
    }),
  );
  await page.route('**/api/v1/manage/diagnostics/events?*', (r) => {
    queries.push(new URL(r.request().url()).searchParams);
    return r.fulfill({
      json: {
        items: [
          {
            id: 'event',
            time: now,
            level: 'ERROR',
            event: 'outbound.failed',
            trace_id: 'trace-log-040',
            service: 'musicbrainz',
            code: 'timeout',
            elapsed_ms: 1000,
            domain: 'musicbrainz.org',
          },
        ],
        next_cursor: null,
        debug_until: null,
        degraded: false,
      },
    });
  });
  await page.route('**/api/v1/manage/diagnostics/debug', (r) => {
    debug = r.request().postDataJSON();
    return r.fulfill({ json: { debug_until: now, module: debug.module } });
  });
  await login(page);
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible())
    await page.getByLabel('浏览方式', { exact: true }).selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '诊断', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '系统诊断' });
  await expect(panel).toContainText('outbound.failed');
  await panel.getByLabel('筛选诊断编号', { exact: true }).fill('trace-log-040');
  await panel.getByRole('button', { name: '查询日志', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('trace_id')).toBe('trace-log-040');
  await panel.getByText('临时详细日志', { exact: true }).click();
  await panel.getByLabel('详细日志分钟数', { exact: true }).fill('16');
  await expect(panel.getByRole('button', { name: '开启临时详细日志', exact: true })).toBeDisabled();
  await panel.getByLabel('详细日志分钟数', { exact: true }).fill('5');
  await panel.getByRole('button', { name: '开启临时详细日志', exact: true }).click();
  await expect.poll(() => debug).toEqual({ minutes: 5, module: 'outbound' });
});

test('通知游标过期自动完整补拉，隐藏页面停止定时请求，前台与恢复网络再同步', async ({ page }) => {
  await fixture(page);
  await page.clock.install();
  let reads = 0,
    fullReads = 0,
    expired = false;
  await page.route('**/api/v1/agent/notifications?*', (r) => {
    reads++;
    const q = new URL(r.request().url()).searchParams;
    if (!q.has('cursor')) fullReads++;
    if (q.has('cursor') && !expired) {
      expired = true;
      return r.fulfill({ status: 410, json: { detail: 'notification_cursor_expired' } });
    }
    return r.fulfill({
      json: list([], { next_cursor: 'valid-cursor', high_watermark: 0, unread_count: 0 }),
    });
  });
  await login(page);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => fullReads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = reads;
  await page.clock.fastForward(300001);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(reads).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads).toBeGreaterThan(before);
  const after = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reads).toBeGreaterThan(after);
});

test('巡检模型超限展示原因和失败阶段，历史 completed 不误示成功', async ({ page }, info) => {
  await fixture(page);
  const task = {
    id: 'limited-task',
    status: 'failed',
    stage: 'completed',
    parameters: { use_ai: true },
    counts: { processed: 134, issues: 0, failed: 0, skipped: 0, calls: 1 },
    error_code: 'ai_output_limit',
    created_at: now,
    updated_at: now,
    version: 1,
    results: [{ track_id: 'fixture', title: '合成测试曲', issues: [] }],
  };
  await page.route('**/api/v1/agent/tasks?*', (r) => r.fulfill({ json: list([task]) }));
  await page.route('**/api/v1/agent/tasks/limited-task', (r) => r.fulfill({ json: task }));
  await login(page);
  await section(page, '巡检与任务');
  await page.getByRole('button', { name: '查看任务', exact: true }).click();
  const detail = page.getByRole('article', { name: '巡检任务详情' });
  await expect(detail).toContainText('处理结束，未全部完成');
  await expect(detail).toContainText('模型达到输出 Token 上限');
  await expect(detail).toContainText('降低推理强度');
  await expect(detail.getByRole('button', { name: '从进度恢复', exact: true })).toBeVisible();
  await expect(detail).not.toContainText('ai_output_limit');
  await page.screenshot({
    path: `../../artifacts/051-verification/inspection-${info.project.name}.png`,
    fullPage: true,
  });
});

test('AI 巡检混合结果与草案入口可显示，旧计划编辑保留范围与版本', async ({ page }) => {
  await fixture(page);
  let changed: any = null;
  let schedule: any = {
    id: 'existing',
    name: '指定范围巡检',
    enabled: false,
    interval_hours: 24,
    timezone: 'Asia/Shanghai',
    parameters: { track_ids: ['kept-id'], max_tracks: 50, max_calls: 0, use_ai: false },
    next_run_at: null,
    version: 3,
  };
  const task = {
    id: 'ai-task',
    parameters: { use_ai: true },
    status: 'succeeded',
    stage: 'completed',
    counts: { processed: 1, issues: 1, calls: 2 },
    created_at: now,
    updated_at: now,
    trace_id: 'trace-ai-task-040',
    version: 1,
    results: [
      { track_id: 'track', title: '合成测试曲', issues: ['missing_album'], metadata_version: 1 },
      { analysis: '依据缺失专辑生成草案，请先核对。', draft_ids: ['draft-one'] },
    ],
  };
  await page.route('**/api/v1/agent/tasks?*', (r) => r.fulfill({ json: list([task]) }));
  await page.route('**/api/v1/agent/tasks/ai-task', (r) => r.fulfill({ json: task }));
  await page.route('**/api/v1/agent/schedules?*', (r) => r.fulfill({ json: list([schedule]) }));
  await page.route('**/api/v1/agent/schedules/existing', (r) => {
    changed = r.request().postDataJSON();
    schedule = { ...schedule, ...changed, version: 4 };
    return r.fulfill({ json: schedule });
  });
  await login(page);
  await section(page, '巡检与任务');
  await page.getByRole('button', { name: '查看任务', exact: true }).click();
  await expect(page.getByRole('article', { name: '巡检任务详情' })).toContainText(
    '依据缺失专辑生成草案',
  );
  await expect(page.getByRole('button', { name: '查看待确认草案', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '定时巡检', exact: true }).click();
  await page.getByRole('button', { name: '编辑计划', exact: true }).click();
  await page.getByLabel('计划名称', { exact: true }).fill('已调整的范围巡检');
  await page.getByRole('button', { name: '保存计划修改', exact: true }).click();
  await expect.poll(() => changed?.name).toBe('已调整的范围巡检');
  expect(changed.version).toBe(3);
  expect(changed.parameters.track_ids).toEqual(['kept-id']);
  expect(changed.enabled).toBe(false);
});

test('工作台视觉验收：前台入口、通知与错误草案在浅色深色均保持对齐', async ({ page }, info) => {
  await fixture(page);
  const draft = {
    id: 'visual',
    kind: 'playlist',
    title: '把明天留给摇滚',
    payload: { name: '把明天留给摇滚', track_ids: [] },
    evidence: [{ source: '本地曲库', summary: '根据你收藏过的曲目整理候选，等待确认后应用。' }],
    status: 'pending',
    version: 1,
    approved_version: null,
    created_at: now,
    updated_at: now,
    result: null,
    trace_id: 'trace-visual-040',
  };
  await page.route('**/api/v1/agent/drafts?*', (r) => r.fulfill({ json: list([draft]) }));
  await page.route('**/api/v1/agent/drafts/visual/approve', (r) =>
    r.fulfill({
      status: 409,
      headers: { 'X-Wildstring-Trace-Id': 'trace-visual-conflict-040' },
      json: { detail: 'draft_version_conflict' },
    }),
  );
  const notices = [
    {
      id: 'notification',
      event_id: 'event',
      event_type: 'draft.created',
      title: '歌单草案已准备好',
      summary: '3 项依据已核对。先看一眼，确认后再应用到歌单。',
      severity: 'info',
      task_id: null,
      draft_id: 'visual',
      trace_id: 'trace-visual-040',
      created_at: now,
      read_at: null,
      version: 1,
      detail_route: null,
    },
  ];
  await page.route('**/api/v1/agent/notifications?*', (r) =>
    r.fulfill({
      json: list(new URL(r.request().url()).searchParams.has('cursor') ? [] : notices, {
        next_cursor: '1',
        unread_count: 1,
        high_watermark: 1,
      }),
    }),
  );
  await login(page);
  for (const color of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, color);
    await section(page, '音乐助手');
    await page.screenshot({
      path: `../../artifacts/agent-workspace-${info.project.name}-${color}.png`,
      fullPage: true,
    });
    const composer = page.getByRole('textbox', { name: '给助手的消息' });
    await composer.focus();
    if (info.project.name === 'mobile') {
      const field = await composer.boundingBox(),
        player = await page.getByRole('region', { name: '音乐播放器' }).boundingBox();
      expect(field && player && field.y + field.height <= player.y).toBeTruthy();
      await page.screenshot({
        path: `../../artifacts/agent-composer-${info.project.name}-${color}.png`,
      });
    }
    await section(page, '通知中心');
    await page.screenshot({
      path: `../../artifacts/agent-notifications-${info.project.name}-${color}.png`,
      fullPage: true,
    });
    await section(page, '待确认草案');
    await page.getByRole('button', { name: '查看草案 把明天留给摇滚', exact: true }).click();
    await page.getByRole('button', { name: '批准当前版本', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('trace-visual-conflict-040');
    await page.screenshot({
      path: `../../artifacts/agent-review-${info.project.name}-${color}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('站外安全详情链接登录后打开本人草案，显式本地模式不会默选模型', async ({ page }) => {
  await fixture(page);
  const draft = {
    id: 'deep-draft',
    kind: 'playlist',
    title: '站外通知详情',
    payload: { name: '站外通知详情', track_ids: [] },
    evidence: [],
    status: 'pending',
    version: 1,
    approved_version: null,
    created_at: now,
    updated_at: now,
    result: null,
  };
  await page.route('**/api/v1/agent/drafts/deep-draft', (r) => r.fulfill({ json: draft }));
  let chosen: any = null;
  const conversation = {
    id: 'local-test',
    title: '本地模式',
    messages: [],
    runs: [],
    connection_id: null,
  };
  await page.route('**/api/v1/agent/conversations', (r) => r.fulfill({ json: conversation }));
  await page.route('**/api/v1/agent/conversations/local-test', (r) =>
    r.fulfill({ json: conversation }),
  );
  await page.route('**/api/v1/agent/conversations/local-test/messages', (r) => {
    chosen = r.request().postDataJSON().connection_id;
    return r.fulfill({ json: conversation });
  });
  await page.route('**/api/v1/agent/connections?*', (r) =>
    r.fulfill({
      json: list([{ id: 'paid', name: '已有付费连接', model: 'paid-model', enabled: true }]),
    }),
  );
  await login(page);
  await page.goto('/#agent/drafts/deep-draft');
  await expect(page.getByRole('article', { name: '草案详情' })).toContainText('站外通知详情');
  await section(page, '音乐助手');
  await page.getByLabel('给助手的消息', { exact: true }).fill('本地找歌');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => chosen).toBe('local');
});

test('Telegram 草案与暂停订阅使用实际后端事件名', async ({ page }) => {
  await fixture(page);
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/v1/agent/notification-preferences', (route) => {
    if (route.request().method() === 'PUT') submitted = route.request().postDataJSON();
    return route.fulfill({
      json: submitted || {
        telegram_enabled: false,
        event_types: [],
        min_severity: 'info',
        quiet_start: null,
        quiet_end: null,
        timezone: 'Asia/Shanghai',
      },
    });
  });
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '通知与 Telegram', exact: true }).click();
  await page.getByLabel('草案待确认', { exact: true }).check();
  await page.getByLabel('任务暂停，需要处理', { exact: true }).check();
  await page.getByRole('button', { name: '保存通知偏好', exact: true }).click();
  await expect.poll(() => submitted?.event_types).toEqual(['draft.pending', 'task.paused']);
});

test('通知补拉忙碌时合并恢复联网事件，完成后再拉取最新结果', async ({ page }) => {
  await fixture(page);
  let reads = 0,
    blockNext = false,
    latest = false,
    release: (() => void) | undefined;
  const notification = {
    id: 'after-network',
    event_id: 'event-after-network',
    event_type: 'task.completed',
    title: '恢复联网后的任务结果',
    summary: '在上一轮响应截取后才产生。',
    severity: 'info',
    task_id: null,
    draft_id: null,
    trace_id: null,
    created_at: now,
    read_at: null,
    version: 1,
    detail_route: null,
  };
  await page.route('**/api/v1/agent/notifications?*', async (route) => {
    reads++;
    // Freeze the response snapshot before the next online event arrives.
    const response = list(latest ? [notification] : [], {
      next_cursor: latest ? 'cursor-2' : 'cursor-1',
      high_watermark: latest ? 1 : 0,
      unread_count: latest ? 1 : 0,
    });
    if (blockNext) {
      blockNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.fulfill({ json: response });
  });
  await login(page);
  await section(page, '通知中心');
  const panel = page.getByRole('region', { name: '通知中心', exact: true });
  await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  blockNext = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => !!release).toBe(true);
  const before = reads;
  latest = true;
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('online'));
  });
  expect(reads).toBe(before);
  release!();
  await expect(panel.getByRole('heading', { name: notification.title, exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  expect(reads).toBe(before + 1);
  await expect(panel.getByRole('button', { name: '未读 · 1', exact: true })).toBeVisible();
});
