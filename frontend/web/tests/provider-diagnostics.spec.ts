import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function management(page: Page) {
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible())
    await page.getByLabel('浏览方式', { exact: true }).selectOption('manage');
  else await page.getByRole('button', { name: '管理', exact: true }).click();
}
async function settings(page: Page) {
  await management(page);
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
}
async function refreshTrack(page: Page) {
  await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '更新元数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新元数据', exact: true });
  await dialog.getByRole('button', { name: '开始更新', exact: true }).click();
  return dialog;
}

test('AcoustID 区分无效应用密钥和未测试本机指纹，缺少分项时延不显示 NaN', async ({
  page,
}, info) => {
  await login(page);
  let invalid = true;
  await page.route('**/api/v1/manage/providers/network-test', (route) =>
    route.fulfill({
      json: {
        proxy_mode: 'direct',
        items: [
          {
            provider: 'acoustid',
            status: invalid ? 'error' : 'ok',
            elapsed_ms: 814,
            code: invalid ? 'acoustid_error_4' : 'reachable',
            http_status: invalid ? 400 : 200,
            via_proxy: false,
            checks: [
              {
                name: 'api',
                status: invalid ? 'error' : 'ok',
                code: invalid ? 'acoustid_error_4' : 'reachable',
                domain: 'api.acoustid.org',
                scope: 'functional_api',
              },
              {
                name: 'local_fingerprint',
                status: 'unverified',
                code: 'unverified',
                domain: 'api.acoustid.org',
                scope: 'audio_recognition',
              },
            ],
          },
        ],
      },
    }),
  );
  await settings(page);
  const panel = page.getByRole('region', { name: '联网来源网络检测', exact: true });
  await panel.getByRole('button', { name: '检测网络', exact: true }).click();
  await expect(panel).toContainText('应用密钥无效');
  await expect(panel).toContainText('User API Key 不能用于识别');
  invalid = false;
  await panel.getByRole('button', { name: '检测网络', exact: true }).click();
  await expect(panel).toContainText('HTTP 200');
  await expect(panel).toContainText('本机音频指纹计算');
  await expect(panel).toContainText('本次未测试');
  await expect(panel).toContainText('无需额外密钥');
  await expect(panel).not.toContainText('NaN');
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({
    path: `../../artifacts/052-verification/acoustid-${info.project.name}.png`,
  });
});

test('网络检测使用代理草稿和已存密钥，先反馈不重复，不保存且失败可重试', async ({ page }, info) => {
  await login(page);
  const original = await (await page.request.get('/api/v1/manage/providers')).json();
  const submitted: Record<string, unknown>[] = [];
  let release!: () => void;
  let fail = false;
  await page.route('**/api/v1/manage/providers/network-test', async (route) => {
    const body = route.request().postDataJSON();
    submitted.push(body);
    if (submitted.length === 1)
      await new Promise<void>((r) => {
        release = r;
      });
    if (fail) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        proxy_mode: body.proxy_mode,
        items: [
          {
            provider: 'musicbrainz',
            status: body.proxy_mode === 'direct' ? 'ok' : 'error',
            elapsed_ms: 123,
            code: body.proxy_mode === 'direct' ? 'reachable' : 'tls_eof',
            via_proxy: body.proxy_mode === 'custom',
          },
          {
            provider: 'lastfm',
            status: 'unconfigured',
            elapsed_ms: 0,
            code: 'lastfm_not_configured',
            via_proxy: false,
          },
          {
            provider: 'caa',
            status: 'ok',
            elapsed_ms: 99,
            http_status: 404,
            code: 'reachable',
            via_proxy: body.proxy_mode === 'custom',
          },
          {
            provider: 'acoustid',
            status: 'unconfigured',
            elapsed_ms: 0,
            code: 'acoustid_not_configured',
            via_proxy: false,
          },
        ],
      },
    });
  });
  await settings(page);
  await page.getByLabel('联网代理', { exact: true }).selectOption('custom');
  await page
    .getByLabel('HTTP 代理地址', { exact: true })
    .fill('http://fixture:diagnostic-password@127.0.0.1:7890');
  await page.getByLabel('Last.fm API Key', { exact: true }).fill('unsaved-api-key');
  await page
    .getByLabel('AcoustID Application API Key', { exact: true })
    .fill('unsaved-acoustid-key');
  const panel = page.getByRole('region', { name: '联网来源网络检测', exact: true });
  await panel.getByRole('button', { name: '检测网络', exact: true }).click();
  await expect(panel.getByRole('button', { name: '正在检测网络…', exact: true })).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('正在逐个检测');
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toEqual({
    proxy_mode: 'custom',
    proxy_url: 'http://fixture:diagnostic-password@127.0.0.1:7890',
  });
  release();
  await expect(panel).toContainText('TLS 连接提前断开');
  await expect(panel).toContainText('123 ms');
  await expect(panel).toContainText('HTTP 404');
  await expect(panel).toContainText('尚未保存 Last.fm');
  expect(await (await page.request.get('/api/v1/manage/providers')).json()).toEqual(original);
  expect(await panel.textContent()).not.toContain('diagnostic-password');
  expect(await panel.textContent()).not.toContain('unsaved-api-key');
  await page.getByLabel('联网代理', { exact: true }).selectOption('direct');
  await page.getByLabel('HTTP 代理地址', { exact: true }).fill('');
  await expect(panel.getByRole('status')).toContainText('代理草稿已变化');
  fail = true;
  await panel.getByRole('button', { name: '检测网络', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  fail = false;
  await panel.getByRole('button', { name: '重新检测网络', exact: true }).click();
  await expect(panel).toContainText('本次代理方式：直接连接');
  expect(submitted[2]).toEqual({ proxy_mode: 'direct' });
  expect(await (await page.request.get('/api/v1/manage/providers')).json()).toEqual(original);
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `../../artifacts/provider-network-${info.project.name}.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await panel.screenshot({
    path: `../../artifacts/provider-network-dark-${info.project.name}.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('刷新弹窗轮询本批进度，查询失败单独重试且终态停止轮询', async ({ page }, info) => {
  await login(page);
  let posts = 0,
    reads = 0;
  await page.route('**/api/v1/manage/providers/refresh', (route) => {
    posts++;
    return route.fulfill({
      json: { batch_id: 'test-batch', total: 3, queued: 2, already_active: 1 },
    });
  });
  await page.route('**/api/v1/manage/providers/refresh/test-batch', (route) => {
    reads++;
    if (reads === 2) return route.fulfill({ status: 503, json: {} });
    const terminal = reads > 2;
    return route.fulfill({
      json: {
        total: 3,
        queued: terminal ? 0 : 1,
        running: terminal ? 0 : 2,
        completed: terminal ? 1 : 0,
        failed: terminal ? 1 : 0,
        no_match: terminal ? 1 : 0,
        stale: 0,
        truncated: false,
        items: [
          {
            id: '1',
            track_id: 'sunny',
            title: '晴天测试曲',
            status: terminal ? 'completed' : 'running',
            error: null,
            warnings: '[]',
          },
          {
            id: '2',
            track_id: 'night',
            title: '夜晚测试曲',
            status: terminal ? 'failed' : 'running',
            error: null,
            warnings: terminal ? '["tls_eof"]' : '[]',
          },
          {
            id: '3',
            track_id: 'unknown',
            title: '暂未找到资料的歌',
            status: terminal ? 'no_match' : 'queued',
            error: null,
            warnings: '[]',
          },
        ],
      },
    });
  });
  const dialog = await refreshTrack(page);
  await expect(dialog.getByRole('status')).toContainText('排队 1 首 · 查询中 2 首');
  await expect(dialog.getByRole('button', { name: '开始更新', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '关闭（后台继续）', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('alert')).toContainText('任务不会重新提交');
  expect(posts).toBe(1);
  await dialog.getByRole('button', { name: '重试查询进度', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('本批查询已结束');
  await expect(dialog.getByRole('progressbar', { name: '本批元数据更新进度' })).toHaveAttribute(
    'value',
    '3',
  );
  await expect(dialog).toContainText('TLS 连接提前断开');
  await expect(dialog).toContainText('没有新增资料 1 首');
  await expect(dialog).not.toContainText('已有 1 首正在处理');
  await page.waitForTimeout(2200);
  expect(reads).toBe(3);
  expect(posts).toBe(1);
  await page.screenshot({ path: `../../artifacts/metadata-batch-${info.project.name}.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `../../artifacts/metadata-batch-dark-${info.project.name}.png` });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('处理中可以关窗，任务记录和歌曲建议说明具体失败原因', async ({ page }) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items.find(
    (item: { title: string }) => item.title === '晴天测试曲',
  );
  let posts = 0;
  await page.route('**/api/v1/manage/providers/refresh', (route) => {
    posts++;
    return route.fulfill({
      json: { batch_id: 'ongoing-batch', total: 1, queued: 0, already_active: 1 },
    });
  });
  await page.route('**/api/v1/manage/providers/refresh/ongoing-batch', (route) =>
    route.fulfill({
      json: {
        total: 1,
        queued: 0,
        running: 1,
        completed: 0,
        failed: 0,
        no_match: 0,
        stale: 0,
        items: [
          {
            id: 'running-job',
            track_id: track.id,
            title: track.title,
            status: 'running',
            error: null,
            warnings: '[]',
          },
        ],
        truncated: false,
      },
    }),
  );
  const dialog = await refreshTrack(page);
  await expect(dialog.getByRole('status')).toContainText('查询中 1 首');
  await dialog.getByRole('button', { name: '关闭（后台继续）', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(1);
  await page.route('**/api/v1/manage/providers/tasks?**', (route) =>
    route.fulfill({
      json: {
        queued: 0,
        running: 0,
        view: new URL(route.request().url()).searchParams.get('view'),
        total: 1,
        limit: 20,
        offset: 0,
        snapshot_at: Date.now() / 1000,
        retention_days: 30,
        counts: { active: 0, pending: 0, attention: 1, history: 0 },
        items: [
          {
            id: 'failed-job',
            track_id: track.id,
            title: track.title,
            status: 'failed',
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
            job_count: 1,
            suggestion_count: 0,
            has_issue: 1,
            requires_attention: 1,
            acknowledged_at: null,
            error: 'dns_error',
            warnings: '["tls_eof"]',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/manage/providers/tracks/${track.id}`, (route) =>
    route.fulfill({
      json: {
        suggestions: [],
        jobs: [
          {
            id: 'failed-job',
            status: 'failed',
            error: 'proxy_auth_required',
            warnings: '["tls_eof"]',
          },
        ],
      },
    }),
  );
  await management(page);
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '任务记录', exact: true })
    .click();
  const jobs = page.getByRole('region', { name: '元数据更新任务', exact: true });
  await expect(jobs).toContainText('服务端无法解析目标域名');
  await expect(jobs).toContainText('TLS 连接提前断开');
  await jobs.getByRole('button', { name: `查看 ${track.title} 的资料建议`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
  await editor.getByRole('button', { name: '联网建议', exact: true }).click();
  await expect(editor).toContainText('代理要求认证');
  await expect(editor).toContainText('TLS 连接提前断开');
  expect(posts).toBe(1);
});
