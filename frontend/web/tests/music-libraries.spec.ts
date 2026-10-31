import { expect, test, type Page } from '@playwright/test';
import { section, podcastCatalog } from './helpers';

test.skip(process.env.WILDSTRING_TEST_LIBRARIES !== '1', 'Run make test-libraries-web.');
const headers = { 'X-Wildstring-Client': 'web' };
type Library = { id: string; name: string; sources: { root: string }[]; is_default: boolean };

async function owner(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(4);
  const policy = await (await page.request.get('/api/v1/podcasts/catalog-settings')).json();
  if (policy.allow_user_subscriptions) {
    await page.request.put('/api/v1/podcasts/catalog-settings', {
      headers,
      data: { version: policy.version, allow_user_subscriptions: false },
    });
  }
  return (await (await page.request.get('/api/v1/libraries')).json()) as Library[];
}

async function manage(page: Page) {
  if (await page.getByLabel('浏览方式', { exact: true }).isVisible()) {
    await page.getByLabel('浏览方式', { exact: true }).selectOption('manage');
  } else await page.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '曲库管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  return page.getByRole('region', { name: '音乐库配置', exact: true });
}

test('切换音乐库保留获授权的播放，跨库歌单统一显示', async ({ page }, info) => {
  const libraries = await owner(page);
  const classical = libraries.find((item) => item.name === '古典测试库')!;
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const playlist = await (
    await page.request.post('/api/v1/playlists', {
      headers,
      data: { name: `跨库歌单-${info.project.name}` },
    })
  ).json();
  expect(
    (
      await page.request.post(`/api/v1/playlists/${playlist.id}/tracks`, {
        headers,
        data: {
          version: playlist.version,
          track_ids: tracks.map((track: { id: string }) => track.id),
        },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await expect(page.getByRole('region', { name: '音乐播放器', exact: true })).toContainText(
    '晴天测试曲',
  );
  await page.getByLabel('选择音乐库', { exact: true }).selectOption(classical.id);
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table', { name: '歌曲列表' })).toContainText('跨库测试曲');
  await expect(page.getByRole('region', { name: '音乐播放器', exact: true })).toContainText(
    '晴天测试曲',
  );
  await section(page, '电台 · 播客');
  await expect(page.getByRole('button', { name: '我的关注', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '本服节目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '电台 · 播客', exact: true })).toBeVisible();
  await expect(page.getByLabel('选择音乐库', { exact: true })).toBeHidden();
  await expect(page.getByRole('search')).toHaveCount(0);
  await expect(page.getByText('YOUR OWN COLLECTION', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '通知中心', exact: true })).toBeVisible();
  await expect(page.locator('.podcast-card')).toHaveCount(1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      animations: 'disabled',
      path: `../../artifacts/catalog-podcasts-${theme}-${info.project.name}.png`,
    });
  }

  await section(page, '全部歌曲');
  await expect(page.getByLabel('选择音乐库', { exact: true })).toHaveValue(classical.id);
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(2);
  await section(page, '歌单');
  await page
    .getByRole('button', { name: `打开歌单 跨库歌单-${info.project.name}`, exact: true })
    .click();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(4);
});

test('资料编辑员只看到可执行的管理动作', async ({ page }, info) => {
  const libraries = await owner(page);
  const primary = libraries.find((library) => library.is_default)!;
  const username = `editor-actions-${info.project.name}`;
  expect(
    (
      await page.request.post('/api/v1/manage/users', {
        headers,
        data: {
          username,
          password: 'editor-actions-password',
          profile: 'editor',
          library_ids: [primary.id],
        },
      })
    ).status(),
  ).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  expect(
    (
      await page.request.post('/api/v1/auth/login', {
        headers,
        data: { username, password: 'editor-actions-password' },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await section(page, '管理');
  await expect(page.getByRole('heading', { name: '曲库管理', exact: true })).toBeVisible();
  for (const name of ['导入音乐', '扫描曲库', '更新曲库元数据', '批量核对资料']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  for (const name of ['导入与整理', '设置', '用户', '诊断']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: '任务记录', exact: true }).click();
  await expect(page.getByText('元数据候选中心', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '歌曲信息', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询本页资料', exact: true })).toHaveCount(0);
  await expect(page.getByText('编辑信息', { exact: true }).first()).toBeVisible();
});

test('所有者创建多来源库、分配权限、停用时保留配置', async ({ page }, info) => {
  const libraries = await owner(page);
  const username = `library-ui-${info.project.name}`;
  const user = await (
    await page.request.post('/api/v1/manage/users', {
      headers,
      data: { username, password: 'library-test-password', library_ids: [] },
    })
  ).json();
  const panel = await manage(page);
  const name = `书房音乐-${info.project.name}`;
  await panel.getByLabel('库名称', { exact: true }).fill(name);
  const currentLibrary = page.getByRole('region', { name: '当前音乐库设置', exact: true });
  await currentLibrary
    .getByLabel('选择音乐库', { exact: true })
    .selectOption(libraries.find((library) => !library.is_default)!.id);
  await expect(panel.getByLabel('库名称', { exact: true })).toHaveValue(name);
  await panel
    .getByLabel('源文件夹，每行一个', { exact: true })
    .fill(libraries.flatMap((item) => item.sources.map((source) => source.root)).join('\n'));
  await panel.getByRole('button', { name: '保存音乐库', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('音乐库已保存');
  const saved = (await (await page.request.get('/api/v1/libraries')).json()).find(
    (item: Library) => item.name === name,
  );
  await page.getByRole('button', { name: '用户', exact: true }).click();
  const accounts = page.getByRole('region', { name: '用户管理', exact: true });
  await expect(
    accounts.getByRole('button', { name: 'admin 的库权限', exact: true }),
  ).toBeDisabled();
  await accounts.getByRole('button', { name: `${username} 的库权限`, exact: true }).click();
  const grants = page.getByRole('dialog', { name: `${username} 的库权限`, exact: true });
  await grants.getByRole('checkbox', { name, exact: true }).check();
  // A concurrent administrator's change must be reread before this form can overwrite it.
  const access = await (await page.request.get(`/api/v1/libraries/access/${user.id}`)).json();
  const primary = libraries.find((library) => library.is_default)!;
  expect(
    (
      await page.request.put(`/api/v1/libraries/access/${user.id}`, {
        headers,
        data: { version: access.version, library_ids: [primary.id] },
      })
    ).status(),
  ).toBe(200);
  await grants.getByRole('button', { name: '保存库权限', exact: true }).click();
  await expect(grants.getByRole('alert')).toContainText('库权限已被修改');
  await expect(grants.getByRole('checkbox', { name: primary.name, exact: true })).toBeChecked();
  await expect(grants.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
  await grants.getByRole('checkbox', { name: primary.name, exact: true }).uncheck();
  await grants.getByRole('checkbox', { name, exact: true }).check();
  await grants.getByRole('button', { name: '保存库权限', exact: true }).click();
  await expect(grants).not.toBeVisible();
  await expect(accounts.getByRole('status')).toContainText('库权限已保存');
  expect(
    (await (await page.request.get(`/api/v1/libraries/access/${user.id}`)).json()).library_ids,
  ).toEqual([saved.id]);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../../artifacts/music-libraries-${theme}-${info.project.name}.png`,
    });
  }
  await panel.locator('.music-library-list button').filter({ hasText: name }).click();
  expect(
    (
      await page.request.put(`/api/v1/libraries/${saved.id}`, {
        headers,
        data: {
          version: saved.version,
          name: `${name}-其他编辑`,
          source_roots: saved.sources.map((source: { root: string }) => source.root),
        },
      })
    ).status(),
  ).toBe(200);
  await panel.getByLabel('库名称', { exact: true }).fill('本地尚未保存的名称');
  await panel.getByRole('button', { name: '保存音乐库', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('音乐库配置已变化');
  await panel.getByRole('button', { name: '重新读取配置', exact: true }).click();
  await expect(panel.getByLabel('库名称', { exact: true })).toHaveValue(`${name}-其他编辑`);
  await panel.getByRole('button', { name: '停用并保留音乐', exact: true }).click();
  await expect(panel.locator('.music-library-list')).toContainText('已停用');
  expect(
    (await (await page.request.get('/api/v1/libraries?include_disabled=true')).json()).find(
      (item: Library) => item.id === saved.id,
    ).sources,
  ).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('没有音乐库授权的听众可以关注节目，取关保留个人进度', async ({ page, request }, info) => {
  await owner(page);
  const feed = (await (await page.request.get('/api/v1/podcasts/radio-test')).json()).podcast
    .feed_url;
  const initialPolicy = await (await page.request.get('/api/v1/podcasts/catalog-settings')).json();
  await page.request.put('/api/v1/podcasts/catalog-settings', {
    headers,
    data: { version: initialPolicy.version, allow_user_subscriptions: true },
  });
  const username = `follows-ui-${info.project.name}`;
  expect(
    (
      await page.request.post('/api/v1/manage/users', {
        headers,
        data: { username, password: 'follows-test-password', library_ids: [] },
      })
    ).status(),
  ).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  expect(
    (
      await page.request.post('/api/v1/auth/login', {
        headers,
        data: { username, password: 'follows-test-password' },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await expect(page.getByText('暂无可播放的音乐，可联系管理员分配访问权限。')).toBeVisible();
  await section(page, '电台 · 播客');
  await expect(page.getByText('暂无可播放的音乐，可联系管理员分配访问权限。')).toBeHidden();
  await page.getByRole('button', { name: '我的关注', exact: true }).click();
  await expect(page.getByText('还没有关注的节目', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '本服节目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '浏览本服节目', exact: true })).toHaveCount(0);
  expect(
    (
      await page.request.post('/api/v1/podcasts', {
        headers,
        data: { feed_url: feed },
      })
    ).status(),
  ).toBe(200);
  await request.post('/api/v1/auth/login', {
    headers,
    data: { username: 'admin', password: 'disposable-browser-test-password' },
  });
  const latestPolicy = await (await request.get('/api/v1/podcasts/catalog-settings')).json();
  await request.put('/api/v1/podcasts/catalog-settings', {
    headers,
    data: { version: latestPolicy.version, allow_user_subscriptions: false },
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '取消关注', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的关注', exact: true }).click();
  await expect(page.locator('.podcast-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '+ 添加节目', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载管理', exact: true })).toHaveCount(0);
  const detail = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
  const id = detail.episodes[0].id;
  expect(
    (
      await page.request.put(`/api/v1/podcasts/episodes/${id}/progress`, {
        headers,
        data: {
          position_seconds: 3,
          duration_seconds: 10,
          event: 'pause',
          session_id: 'follows-browser-session',
          device_id: 'browser-test',
          base_version: 0,
          sequence: 1,
        },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('button', { name: '取消关注', exact: true }).click();
  await expect(page.getByText('还没有关注的节目', { exact: true })).toBeVisible();
  const after = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
  expect(after.episodes.find((item: { id: string }) => item.id === id).position_seconds).toBe(3);
});

test('网页配置监听、自定义托管目录并提交迁移', async ({ page }, info) => {
  const libraries = await owner(page);
  const primary = libraries.find((item) => item.is_default)! as Library & { managed_root: string };
  const base = primary.managed_root.slice(0, primary.managed_root.lastIndexOf('/'));
  const name = `存储设置-${info.project.name}`;
  const panel = await manage(page);
  await panel.getByLabel('库名称', { exact: true }).fill(name);
  await panel.getByLabel('源文件夹，每行一个', { exact: true }).fill(primary.sources[0].root);
  await panel
    .getByLabel('托管目录（可选）', { exact: true })
    .fill(`${base}/custom-${info.project.name}`);
  await panel.getByRole('checkbox', { name: primary.sources[0].root, exact: true }).uncheck();
  await panel.getByRole('button', { name: '保存音乐库', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('音乐库已保存');
  await panel.locator('.music-library-list button').filter({ hasText: name }).click();
  const storage = panel.getByLabel(`${name}的存储设置`, { exact: true });
  await expect(storage.getByLabel('检查间隔（秒）', { exact: true })).toBeVisible();
  await storage.getByLabel('定期检查监听文件夹', { exact: true }).check();
  await storage.getByLabel('检查间隔（秒）', { exact: true }).fill('300');
  await storage.getByLabel('文件稳定等待（秒）', { exact: true }).fill('15');
  await storage.getByRole('button', { name: '保存自动导入策略', exact: true }).click();
  await expect(storage.getByRole('status')).toContainText('自动导入设置已保存');
  const saved = (await (await page.request.get('/api/v1/libraries')).json()).find(
    (item: Library) => item.name === name,
  );
  expect(saved.sources[0].watch_enabled).toBe(0);
  const settings = await (
    await page.request.get(`/api/v1/manage/intake/settings?library_id=${saved.id}`)
  ).json();
  expect(settings.enabled).toBe(true);
  expect(settings.interval_seconds).toBe(300);
  await storage
    .getByLabel('新的托管目录', { exact: true })
    .fill(`${base}/migrated-${info.project.name}`);
  await storage.getByRole('button', { name: '复制、校验并迁移', exact: true }).click();
  await expect(storage).toContainText('目录已切换，旧文件已保留', { timeout: 15000 });
  const updated = (await (await page.request.get('/api/v1/libraries')).json()).find(
    (item: Library) => item.name === name,
  );
  expect(updated.id).toBe(saved.id);
  expect(updated.managed_root).toBe(`${base}/migrated-${info.project.name}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `../../artifacts/storage-settings-${info.project.name}.png` });
  expect(
    (
      await page.request.put(`/api/v1/libraries/${updated.id}`, {
        headers,
        data: {
          version: updated.version,
          name: updated.name,
          source_roots: updated.sources.map((source: { root: string }) => source.root),
          enabled: false,
        },
      })
    ).status(),
  ).toBe(200);
});

test('个人保存复用共享音频，管理员预览后清理零引用', async ({ page }, info) => {
  await owner(page);
  const cleanupEpisode = info.project.name === 'desktop' ? 1 : 2;
  const resources = await (await page.request.get('/api/v1/podcasts/resources')).json();
  // Keep one candidate; the other disposable fixture files are explicitly pinned here.
  for (const item of resources.items) {
    const protectedAudio = ![`radio-${cleanupEpisode}`, 'radio-6'].includes(item.id);
    if (item.protected !== protectedAudio) {
      const changed = await page.request.put(`/api/v1/podcasts/resources/${item.id}/protection`, {
        headers,
        data: { version: item.version, protected: protectedAudio },
      });
      expect(changed.status()).toBe(200);
    }
  }
  await podcastCatalog(page);
  await page.request.delete('/api/v1/podcasts/episodes/radio-6/download', { headers });
  await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
  const row = page
    .locator('.podcast-episode-row')
    .filter({ hasText: '第 6 集：给午后的一封声音来信' });
  await row.getByRole('button', { name: '保存到服务器', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已复用服务器已有音频' })).toBeVisible();
  await page.getByRole('button', { name: '我的下载', exact: false }).click();
  await expect(page.locator('.podcast-episode-row')).toHaveCount(1);
  await page.getByRole('button', { name: '共享音频管理', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '共享音频管理', exact: true });
  await expect(manager).toContainText('1 份引用');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    const contrast = await manager.getByRole('spinbutton').evaluate((input) => {
      const style = getComputedStyle(input);
      const brightness = (value: string) => {
        const components = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((n) => n / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
        return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
      };
      const a = brightness(style.color),
        b = brightness(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThan(4.5);
    await page.screenshot({
      path: `../../artifacts/podcast-resources-${theme}-${info.project.name}.png`,
    });
  }

  await manager.getByRole('button', { name: '预览零引用清理', exact: true }).click();
  await expect(manager).toContainText('当前可清理 1 个文件');
  await manager.getByRole('button', { name: '确认清理零引用文件', exact: true }).click();
  await expect(manager).toContainText('已清理 1 个文件');
  expect(
    (await (await page.request.get('/api/v1/podcasts/episodes/radio-6')).json()).resource_saved,
  ).toBe(true);
  expect(
    (await (await page.request.get(`/api/v1/podcasts/episodes/radio-${cleanupEpisode}`)).json())
      .download_status,
  ).toBe('none');
  await page.screenshot({ path: `../../artifacts/podcast-resources-${info.project.name}.png` });
  await manager.getByRole('button', { name: '关闭', exact: true }).click();
});

test('默认授权、服务器目录选择和账号授权行保持清晰', async ({ page }, info) => {
  const libraries = await owner(page);
  const panel = await manage(page);
  const primary = libraries.find((library) => library.is_default)!;
  await panel.getByRole('button', { name: '浏览添加来源', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择音乐来源文件夹', exact: true });
  await expect(picker.getByRole('button', { name: /音乐来源（只读）/ })).toBeVisible();
  await picker.getByLabel('服务器目录路径', { exact: true }).fill(primary.sources[0].root);
  await picker.getByRole('button', { name: '打开路径', exact: true }).click();
  await expect(picker.getByRole('button', { name: '选择此文件夹', exact: true })).toBeEnabled();
  await expect(picker.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled();
  await expect(picker).toContainText('音乐来源保持只读');
  await expect(picker).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      animations: 'disabled',
      path: `../../artifacts/catalog-folders-${theme}-${info.project.name}.png`,
    });
  }

  await picker.getByRole('button', { name: '选择此文件夹', exact: true }).click();
  await expect(panel.getByLabel('源文件夹，每行一个', { exact: true })).toHaveValue(
    primary.sources[0].root,
  );
  const second = libraries.find((library) => !library.is_default)!;
  await panel.locator('.music-library-list button').filter({ hasText: second.name }).click();
  await panel.getByRole('checkbox', { name: '新用户默认可访问此库', exact: true }).check();
  await panel.getByRole('button', { name: '保存音乐库', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('音乐库已保存');
  await page.getByRole('button', { name: '用户', exact: true }).click();
  const accounts = page.getByRole('region', { name: '用户管理', exact: true });
  await expect(accounts.getByRole('checkbox', { name: second.name, exact: true })).toBeChecked();
  const label = accounts.getByRole('checkbox', { name: second.name, exact: true }).locator('..');
  const geometry = await label.evaluate((element) => {
    const checkbox = element.querySelector('input')!.getBoundingClientRect();
    const name = element.querySelector('span')!.getBoundingClientRect();
    return {
      gap: name.left - checkbox.right,
      width: checkbox.width,
      overlap: Math.min(checkbox.bottom, name.bottom) - Math.max(checkbox.top, name.top),
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(20);
  expect(geometry.gap).toBeGreaterThanOrEqual(4);
  expect(geometry.gap).toBeLessThanOrEqual(16);
  expect(geometry.overlap).toBeGreaterThan(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await accounts
      .getByRole('checkbox', { name: second.name, exact: true })
      .scrollIntoViewIfNeeded();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      animations: 'disabled',
      path: `../../artifacts/catalog-accounts-${theme}-${info.project.name}.png`,
    });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('目录选择器新建文件夹、拒绝重名并直接选用新目录', async ({ page }, info) => {
  const libraries = await owner(page);
  const primary = libraries.find((library) => library.is_default)! as Library & {
    managed_root: string;
  };
  const parent = primary.managed_root.slice(0, primary.managed_root.lastIndexOf('/'));
  const panel = await manage(page);
  await panel.getByRole('button', { name: '浏览托管目录', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择托管目录', exact: true });
  await expect(picker.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled();
  await picker.getByLabel('服务器目录路径', { exact: true }).fill(parent);
  await picker.getByRole('button', { name: '打开路径', exact: true }).click();
  await picker.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const create = picker.getByRole('form', { name: '新建文件夹', exact: true });
  await page.screenshot({ path: `../../artifacts/folder-create-form-${info.project.name}.png` });
  await create
    .getByLabel('文件夹名称', { exact: true })
    .fill(primary.managed_root.slice(parent.length + 1));
  await create.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('已有同名文件或文件夹');
  const name = `网页新建-${info.project.name}`;
  await create.getByLabel('文件夹名称', { exact: true }).fill(name);
  await create.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(create).not.toBeVisible();
  await expect(picker.getByLabel('服务器目录路径', { exact: true })).toHaveValue(
    `${parent}/${name}`,
  );
  await expect(picker.getByRole('status')).toContainText('文件夹已创建');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('wildstring-theme', value);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({
      path: `../../artifacts/folder-create-${theme}-${info.project.name}.png`,
    });
  }
  await picker.getByRole('button', { name: '选择此文件夹', exact: true }).click();
  await expect(panel.getByLabel('托管目录（可选）', { exact: true })).toHaveValue(
    `${parent}/${name}`,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('管理员可切换普通用户添加 RSS，普通用户只添加并关注', async ({ page }, info) => {
  await owner(page);
  await manage(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const policy = page.getByRole('region', { name: '播客添加权限', exact: true });
  await policy.getByRole('checkbox', { name: '允许普通用户添加 RSS 并关注', exact: true }).check();
  await policy.getByRole('button', { name: '保存播客添加权限', exact: true }).click();
  await expect(policy.getByRole('status')).toContainText('播客添加权限已保存');
  const detail = await (await page.request.get('/api/v1/podcasts/radio-test')).json();
  const username = `rss-ui-${info.project.name}`;
  const created = await page.request.post('/api/v1/manage/users', {
    headers,
    data: { username, password: 'rss-ui-test-password', library_ids: [] },
  });
  expect(created.status()).toBe(201);
  await page.request.post('/api/v1/auth/logout', { headers });
  await page.request.post('/api/v1/auth/login', {
    headers,
    data: { username, password: 'rss-ui-test-password' },
  });
  await page.reload();
  await section(page, '电台 · 播客');
  await expect(page.getByRole('button', { name: '本服节目', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '+ 添加节目', exact: true }).click();
  const search = page.getByRole('dialog', { name: '搜索或添加节目', exact: true });
  await search.getByLabel('节目名称或 RSS 地址', { exact: true }).fill(detail.podcast.feed_url);
  await search.getByRole('button', { name: '添加并关注', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消关注', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '自动下载设置', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '共享音频管理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('search')).toHaveCount(0);
  await page.screenshot({ path: `../../artifacts/catalog-podcast-${info.project.name}.png` });
});
