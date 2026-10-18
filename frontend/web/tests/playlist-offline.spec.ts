import { expect, test } from '@playwright/test';
import { login, section } from './helpers';
const headers = { 'X-Wildstring-Client': 'web' };

test('歌单右击和更多菜单可编辑删除，自动下载受网络设置控制并保留默认音质', async ({
  page,
}, info) => {
  await login(page);
  const track = (await (await page.request.get('/api/v1/tracks')).json()).items[0];
  let playlist = await (
    await page.request.post('/api/v1/playlists', {
      headers,
      data: { name: '自动离线测试', kind: 'manual' },
    })
  ).json();
  playlist = await (
    await page.request.post(`/api/v1/playlists/${playlist.id}/tracks`, {
      headers,
      data: { version: playlist.version, track_ids: [track.id] },
    })
  ).json();
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/stream?'))
      requests.push(request.url());
  });
  async function view(value: string, name: string) {
    await section(page, name);
  }
  try {
    await view('playlists', '歌单');
    await page
      .getByRole('button', { name: '打开歌单 自动离线测试', exact: true })
      .click({ button: 'right' });
    let menu = page.getByRole('menu', { name: '自动离线测试的歌单操作' });
    await menu.getByRole('menuitem', { name: '编辑歌单', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('歌单名称').fill('自动离线改名');
    await editor.getByRole('button', { name: '保存歌单', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await view('offline', '离线音乐');
    const panel = page.getByRole('region', { name: '离线音乐', exact: true });
    await panel.locator('summary').click();
    await panel.getByLabel('默认下载音质', { exact: true }).selectOption('192');
    await panel.getByRole('button', { name: '选择自动下载歌单', exact: true }).click();
    await panel.getByLabel('自动离线改名', { exact: true }).check();
    await expect(panel).toContainText('已选 1 个歌单');
    expect(requests).toHaveLength(0);
    await panel.getByLabel('允许在移动数据或未知网络自动下载').check();
    await expect(panel).toContainText('已离线保存');
    expect(new URL(requests[0]).searchParams.get('bitrate_kbps')).toBe('192');
    await page.reload();
    await view('offline', '离线音乐');
    await page.getByRole('region', { name: '离线音乐', exact: true }).locator('summary').click();
    await expect(page.getByLabel('默认下载音质', { exact: true })).toHaveValue('192');
    await view('playlists', '歌单');
    await page.getByRole('button', { name: '自动离线改名的歌单操作', exact: true }).click();
    menu = page.getByRole('menu', { name: '自动离线改名的歌单操作' });
    await expect(menu.getByRole('menuitem', { name: '关闭自动下载', exact: true })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await menu.getByRole('menuitem', { name: '删除歌单', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '打开歌单 自动离线改名', exact: true }),
    ).toHaveCount(0);
    await view('offline', '离线音乐');
    await expect(page.getByRole('region', { name: '离线音乐', exact: true })).toContainText(
      '已离线保存',
    );
  } finally {
    const fresh = await page.request.get(`/api/v1/playlists/${playlist.id}`);
    if (fresh.ok())
      await page.request.delete(
        `/api/v1/playlists/${playlist.id}?version=${(await fresh.json()).version}`,
        { headers },
      );
  }
});
