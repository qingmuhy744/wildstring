import { createHash, randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { personalSettings, test } from './helpers';

function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('OAuth 2.1 完整浏览器授权、真实 MCP 调用、错误边界与站内撤销', async ({
  page,
  isMobile,
}, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/wildstring-e2e';

  const registered = await page.request.post('/oauth/register', {
    data: {
      client_name: 'Google Gemini',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const { verifier, challenge } = pkcePair();
  const state = `state-${Date.now()}`;
  const origin = new URL(page.url() === 'about:blank' ? info.project.use.baseURL! : page.url())
    .origin;
  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'library:read personal:read',
    state,
    resource: `${origin}/mcp`,
  });

  // 1. Visiting /oauth/authorize while signed out reuses the in-app Login screen.
  await page.goto(`/oauth/authorize?${authorizeParams.toString()}`);
  await expect(page.getByRole('status')).toContainText('登录后核对并确认外部应用的 MCP 访问权限');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();

  // 2. Consent card appears immediately without losing query params.
  await expect(
    page.getByRole('heading', { name: '授权 Google Gemini 访问你的野弦账号' }),
  ).toBeVisible();
  await expect(page.locator('.oauth-host')).toHaveText('oauth-redirect.googleusercontent.com');
  await expect(page.getByLabel('读取共享曲库')).toBeChecked();
  await expect(page.getByLabel('读取我的歌单与历史')).toBeChecked();

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`oauth-consent-${theme}.png`),
      animations: 'disabled',
    });
  }

  // Narrow scope to library:read only and approve; capture redirected code.
  await page.getByLabel('读取我的歌单与历史').uncheck();
  let capturedUrl = '';
  await page.route('https://oauth-redirect.googleusercontent.com/**', async (route) => {
    capturedUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'oauth-callback-ok' });
  });
  await page.getByRole('button', { name: '允许访问', exact: true }).click();
  await expect.poll(() => capturedUrl).toContain(redirectUri);
  const callback = new URL(capturedUrl);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code');
  expect(code).toBeTruthy();

  // 3. Exchange code via PKCE and invoke real /mcp endpoint.
  const tokenRes = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  expect(tokens.scope).toBe('library:read');
  expect(tokens.access_token.startsWith('ws_')).toBe(true);

  const mcpRes = await page.request.post('/mcp', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  expect(mcpRes.status()).toBe(200);
  const tools = (await mcpRes.json()).result.tools.map((t: { name: string }) => t.name);
  expect(tools).toContain('search_tracks');
  expect(tools).not.toContain('get_personal_library');

  // 4. Invalid authorize request renders calm error state safely without redirecting.
  await page.goto('/oauth/authorize?client_id=unknown-client&response_type=code');
  await expect(page.getByRole('heading', { name: '无法完成授权请求' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();

  // 5. Open Personal Settings -> Assistant -> MCP & External Tools to inspect & revoke.
  await page.goto('/');
  await expect(page.getByRole('table', { name: '歌曲列表' })).toBeVisible();
  await personalSettings(page, 'assistant');
  await page.getByRole('button', { name: 'MCP 工具凭据', exact: true }).click();
  const oauthSection = page.getByRole('region', { name: 'OAuth 2.1 外部应用连接' });
  await expect(oauthSection).toContainText('Google Gemini');
  await expect(oauthSection).toContainText('动态注册');

  // Create a static OAuth client too so both workflows are covered.
  await oauthSection.getByText('手动注册静态 OAuth 客户端（可选）').click();
  await oauthSection.getByLabel('客户端名称', { exact: true }).fill('手动连接器测试');
  await oauthSection
    .getByLabel('允许的回调地址（每行一个）', { exact: true })
    .fill('https://oauth-redirect.googleusercontent.com/r/static-e2e');
  await oauthSection.getByRole('button', { name: '创建静态客户端', exact: true }).click();
  await expect(oauthSection.getByRole('status')).toContainText('客户端密钥仅显示这一次');

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await oauthSection.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`oauth-settings-${theme}.png`),
      animations: 'disabled',
    });
  }

  // Revoke OAuth grant from Settings -> token immediately rejected by /mcp.
  page.once('dialog', (dialog) => void dialog.accept());
  await oauthSection.getByRole('button', { name: '撤销授权', exact: true }).first().click();
  await expect(oauthSection).toContainText('已撤销该应用授权');

  const afterRevoke = await page.request.post('/mcp', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
    },
    data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  expect(afterRevoke.status()).toBe(401);
});
