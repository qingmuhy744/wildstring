import { expect, test as base, type Page } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    try {
      await use(page);
    } finally {
      // Tests can still wait explicitly for handlers they release before teardown.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  },
});

export async function section(page: Page, name: string) {
  await expect(page.locator('.app-shell')).toBeVisible();
  if (name === '助手设置') {
    await personalSettings(page, 'assistant');
    return;
  }
  if (name === '跨设备继续') {
    await personalSettings(page, 'downloads');
    return;
  }
  if (name === '账号设置') {
    await personalSettings(page, 'account');
    return;
  }
  if (name === '管理') {
    await manageTab(page, '概览');
    return;
  }
  await leaveSettings(page);
  if (name === '通知中心') {
    await page.getByRole('button', { name, exact: true }).click();
    return;
  }
  const workbench = name === '待确认' || name === '曲库检查';
  const entry = workbench ? '整理' : name;
  const mobileSection = page.locator('select.mobile-section');
  if (await mobileSection.isVisible()) {
    await mobileSection.selectOption({ label: entry });
  } else {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: new RegExp(`^${entry}(?: |$)`) })
      .click();
  }
  if (workbench) {
    await page
      .getByRole('navigation', { name: '整理', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
  }
}

export async function login(page: Page, options: { automaticSync?: boolean } = {}) {
  if (!options.automaticSync)
    await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  const [signedIn] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: '进入曲库' }).click(),
  ]);
  expect(signedIn.ok()).toBeTruthy();
  await expect(page.getByRole('table', { name: '歌曲列表' }).getByRole('row')).toHaveCount(3);
}

export async function audio(page: Page) {
  return page.locator('audio').evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    time: element.currentTime,
    duration: element.duration,
    volume: element.volume,
    playbackRate: element.playbackRate,
    source: element.currentSrc,
    ended: element.ended,
  }));
}

/** 电台页只显示本人关注的节目；先关注固定装置里的全部节目，再打开电台页。 */
export async function podcastCatalog(page: Page) {
  const headers = { 'X-Wildstring-Client': 'web' };
  const response = await page.request.get('/api/v1/podcasts');
  const shows: { id: string; followed: boolean }[] = response.ok() ? await response.json() : [];
  let changed = false;
  for (const show of shows) {
    if (show.followed) continue;
    await page.request.put(`/api/v1/podcasts/${encodeURIComponent(show.id)}/follow`, {
      headers,
      data: { followed: true },
    });
    changed = true;
  }
  if (changed) await page.reload();
  await section(page, '电台 · 播客');
}

export async function leaveSettings(page: Page) {
  for (let step = 0; step < 2; step++) {
    const back = page.locator('.settings-center:visible .settings-back');
    if (!(await back.isVisible())) break;
    await back.click();
  }
}
export async function personalCategory(page: Page, category: string) {
  const names: Record<string, string> = {
    account: '账号与安全',
    appearance: '外观与语言',
    playback: '播放与歌词',
    downloads: '下载与接续',
    assistant: '助手与通知',
    about: '关于野弦',
  };
  const root = page.locator('.personal-settings');
  if (await root.locator('.settings-content').isVisible())
    await root.locator('.settings-back').click();
  await root.getByRole('button', { name: new RegExp(`^${names[category]}`) }).click();
  return root.getByRole('region', { name: '个人设置', exact: true });
}
export async function personalSettings(page: Page, category: string) {
  await section(page, '个人设置');
  return personalCategory(page, category);
}
export async function manageTab(page: Page, tab: string) {
  const categories: Record<string, string> = {
    概览: '音乐库与导入',
    歌曲信息: '音乐库与导入',
    导入与整理: '音乐库与导入',
    音乐库: '音乐库与导入',
    当前音乐库设置: '音乐库与导入',
    全服节目: '播客',
    目录搜索: '播客',
    重复节目: '播客',
    节目准入: '播客',
    共享音频管理: '播客',
    下载管理: '播客',
    书库与存储: '书架',
    元数据来源: '书架',
    数据源: '数据源与模型',
    模型连接: '数据源与模型',
    用户: '用户与权限',
    任务记录: '任务与诊断',
    诊断: '任务与诊断',
    服务状态: '任务与诊断',
    转码与缓存: '服务器',
    访问设置: '服务器',
  };
  const root = page.locator('.management');
  if (!(await root.isVisible())) await section(page, '管理中心');
  if (await root.locator('.settings-content').isVisible())
    await root.locator('.settings-back').click();
  await root.getByRole('button', { name: new RegExp(`^${categories[tab]}`) }).click();
  await root
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: tab, exact: true })
    .click();
}
