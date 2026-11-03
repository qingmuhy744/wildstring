import { expect, test } from '@playwright/test';
import { login, section, personalCategory, leaveSettings, manageTab } from './helpers';

test('主题表单可读，默认连接参数与折叠导航一致', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'desktop') {
    const sidebar = page.locator('.sidebar');
    await expect(sidebar.getByRole('button', { name: '通知中心', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: '助手设置', exact: true })).toBeHidden();
    await expect(sidebar.getByRole('button', { name: '音乐助手', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: '通知中心', exact: true })).toBeVisible();
  await section(page, '助手设置');
  await expect(page.getByLabel('单次输出 Token 上限')).toHaveValue('8192');
  await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('low');
  await expect(page.getByLabel('超时（秒）', { exact: true })).toHaveValue('90');
  await page.getByRole('button', { name: '对话历史', exact: true }).click();
  const input = page.getByLabel('助手历史保留天数');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const contrast = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (value: string) => {
        const channels = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await input.fill('21');
    await expect(input).toHaveValue('21');
    await page.screenshot({
      path: `../../artifacts/052-verification/settings-${info.project.name}-${theme}.png`,
      fullPage: true,
    });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('推荐用临时歌单展示，更多菜单支持右键与偏好反馈', async ({ page }, info) => {
  await login(page);
  // Keep this visual interaction from changing the shared fixture's later recommendations.
  let dismissed = false;
  await page.route('**/api/v1/recommendations/feedback', (route) => {
    dismissed = route.request().postDataJSON().action === 'dismiss_track';
    return route.fulfill({ status: 204 });
  });
  await section(page, '推荐');
  const panel = page.getByRole('region', { name: '音乐发现', exact: true });
  const row = panel.locator('.daily-track').first();
  await expect(row).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(row.locator('.favorite-button')).toHaveCount(0);
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '不感兴趣', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '不感兴趣', exact: true })).toBeVisible();
  await page.screenshot({
    path: `../../artifacts/052-verification/daily-menu-${info.project.name}.png`,
    fullPage: false,
  });
  const title = (await row.locator('strong').innerText()).trim();
  await page.getByRole('menuitem', { name: '不感兴趣', exact: true }).click();
  await expect(
    panel.locator('.daily-track').filter({ has: page.getByText(title, { exact: true }) }),
  ).toHaveCount(0);
  expect(dismissed).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('迟到的设置回读不会覆盖已输入的保留天数', async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/agent/assistant-preferences', async (route) => {
    await gate;
    return route.fulfill({
      json: { retention_days: 30, context_summary: true, long_term_memory: true },
    });
  });
  await login(page);
  await section(page, '助手设置');
  await page.getByRole('button', { name: '对话历史', exact: true }).click();
  const input = page.getByLabel('助手历史保留天数');
  await input.fill('21');
  release!();
  await expect(page.getByRole('button', { name: '保存保留时间', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('21');
});

test('用户可以在账号设置中修改个人资料（登录 ID、昵称和邮箱）', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'mobile') {
    await page.getByLabel('浏览方式', { exact: true }).selectOption({ label: '个人设置' });
  } else {
    await page.getByRole('button', { name: '个人设置', exact: true }).click();
  }
  await personalCategory(page, 'account');
  const dialog = page.getByRole('region', { name: '个人设置', exact: true });
  await expect(dialog).toBeVisible();
  const form = dialog.getByRole('form', { name: '个人资料', exact: true });
  await expect(form).toBeVisible();
  const usernameInput = form.getByLabel('登录 ID');
  const displayNameInput = form.getByLabel('昵称');
  const emailInput = form.getByLabel('邮箱（仅作资料）');
  await expect(usernameInput).toHaveValue('admin');
  await displayNameInput.fill('管理员野弦');
  await emailInput.fill('admin@example.com');
  await form.getByRole('button', { name: '保存个人资料', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText('个人资料已保存。');
  await leaveSettings(page);
  await expect(dialog).toBeHidden();
});

test('点击侧边栏野弦品牌进入发现页且不触发整页刷新', async ({ page }, info) => {
  await login(page);
  if (info.project.name === 'desktop') {
    await section(page, '专辑');
    const mainNav = page.getByRole('navigation', { name: '主导航' });
    const albumsButton = mainNav.getByRole('button', { name: /^专辑(?: |$)/ });
    await expect(albumsButton).toHaveClass(/nav-current/);

    await page.evaluate(() => {
      (window as unknown as { __spa_retained: boolean }).__spa_retained = true;
    });

    const brand = page.locator('.sidebar a.brand');
    await expect(brand).toBeVisible();
    await brand.click();

    const discoverButton = mainNav.getByRole('button', { name: /^推荐(?: |$)/ });
    await expect(discoverButton).toHaveClass(/nav-current/);

    const isRetained = await page.evaluate(
      () => (window as unknown as { __spa_retained: boolean }).__spa_retained === true,
    );
    expect(isRetained).toBe(true);
  }
});

test('管理中心播客下载管理近期已完成配色温润且高对比度', async ({ page }, info) => {
  if (info.project.name !== 'desktop') return;
  await page.route('**/api/v1/podcasts/downloads/queue', (route) =>
    route.fulfill({
      json: {
        active_count: 0,
        queued_count: 0,
        failed_count: 0,
        total_pending: 0,
        downloading: [],
        queued: [],
        recent_completed: [
          {
            episode_id: 'ep-1',
            episode_title: '中国社保太“欺负”：大陆该跟中华民国学点什么？【王局拍案播客】',
            podcast_title: "王志安的播客Wang's Podcast",
            status: 'completed',
          },
          {
            episode_id: 'ep-2',
            episode_title: '责任全在美方',
            podcast_title: "王志安的播客Wang's Podcast",
            status: 'completed',
          },
        ],
        failed: [],
      },
    }),
  );
  await login(page);
  await manageTab(page, '下载管理');
  const sectionEl = page.locator('.podcast-download-content');
  await expect(sectionEl).toBeVisible();
  await expect(sectionEl.getByText('近期已完成 (2)')).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((val) => {
      document.documentElement.setAttribute('data-theme', val);
      localStorage.setItem('wildstring-theme', val);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: val }));
    }, theme);
    // Allow CSS transition (0.15s ease) on queue-task-card background to settle
    await page.waitForTimeout(350);

    const card = sectionEl.locator('.queue-task-card').first();
    await expect(card).toBeVisible();

    const styles = await card.evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        background: computed.backgroundColor,
        color: computed.color,
      };
    });
    if (theme === 'light') {
      const match = styles.background.match(/\d+/g);
      if (match) {
        const [r, g, b] = match.map(Number);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeGreaterThan(200);
        expect(b).toBeGreaterThan(190);
      }
    }

    const badge = sectionEl.locator('.queue-task-status.downloaded').first();
    await expect(badge).toBeVisible();

    if (theme === 'dark') {
      const match = styles.background.match(/\d+/g);
      if (match) {
        const [r, g, b] = match.map(Number);
        expect(r).toBeLessThan(70);
        expect(g).toBeLessThan(70);
        expect(b).toBeLessThan(70);
      }
    }

    await page.screenshot({
      path: `../../artifacts/podcast-completed-downloads-${theme}.png`,
    });
  }
});

test('共享音频管理支持预览并弹出宽框查看待清理清单', async ({ page }, info) => {
  await login(page);

  // First verify real empty/current state
  await manageTab(page, '共享音频管理');
  const region = page.getByRole('region', { name: '共享音频管理', exact: true });
  await expect(region).toBeVisible();

  // Button to view candidate list is present
  const viewBtn = region.getByRole('button', { name: /查看待清理清单/ }).first();
  await expect(viewBtn).toBeVisible();

  // Click to open wide modal in empty state
  await viewBtn.click();
  const dialog = page.locator('.podcast-cleanup-dialog');
  await expect(dialog).toBeVisible();

  // Verify dialog is wide: width >= 700px on desktop
  if (info.project.name === 'desktop') {
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.width).toBeGreaterThanOrEqual(700);
  }

  // Header and title
  await expect(dialog.getByRole('heading', { name: '待清理零引用音频' })).toBeVisible();

  // Test both themes and capture screenshots for empty state
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((val) => {
      localStorage.setItem('wildstring-theme', val);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: val }));
    }, theme);
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `../../artifacts/podcast-cleanup-empty-${theme}-${info.project.name}.png`,
    });
  }

  // Close dialog using close button
  await dialog.getByRole('button', { name: '关闭待清理清单' }).click();
  await expect(dialog).toBeHidden();

  // Now test with candidates populated
  await page.route('**/api/v1/podcasts/resources/cleanup', async (route) => {
    const request = route.request();
    const data = request.postDataJSON() as { dry_run?: boolean };
    if (data.dry_run) {
      return route.fulfill({
        json: {
          dry_run: true,
          candidate_count: 2,
          candidate_bytes: 52428800,
          deleted_count: 0,
          freed_bytes: 0,
          failed_count: 0,
          candidates: [
            {
              id: 'ep-001',
              podcast_id: 'pod-1',
              podcast_title: '文化有限',
              title: 'Vol.200 聊聊我们为什么喜欢散步',
              size_bytes: 31457280,
              local_path: '/data/podcasts/cultural-limited/vol200.mp3',
            },
            {
              id: 'ep-002',
              podcast_id: 'pod-2',
              podcast_title: '忽左忽右',
              title: '第 150 期：重访老建筑与城市声景',
              size_bytes: 20971520,
              local_path: '/data/podcasts/left-right/ep150.m4a',
            },
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        dry_run: false,
        candidate_count: 2,
        candidate_bytes: 52428800,
        deleted_count: 2,
        freed_bytes: 52428800,
        failed_count: 0,
        candidates: [],
      },
    });
  });

  // Re-trigger preview with candidates
  await region.getByRole('button', { name: '预览零引用清理', exact: true }).click();
  await expect(region).toContainText('当前可清理 2 个文件');

  const openListBtn = region.getByRole('button', { name: /查看待清理清单 \(2\)/ }).first();
  await expect(openListBtn).toBeVisible();
  await openListBtn.click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Vol.200 聊聊我们为什么喜欢散步')).toBeVisible();
  await expect(dialog.getByText('文化有限')).toBeVisible();
  await expect(dialog.getByText('第 150 期：重访老建筑与城市声景')).toBeVisible();
  await expect(dialog.getByText('忽左忽右')).toBeVisible();
  await expect(dialog.getByText('2 个文件 · 50.0 MB')).toBeVisible();

  // Test both themes and capture screenshots with candidate items
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((val) => {
      localStorage.setItem('wildstring-theme', val);
      window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: val }));
    }, theme);
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `../../artifacts/podcast-cleanup-candidates-${theme}-${info.project.name}.png`,
    });
  }

  // Click confirm cleanup inside modal
  const confirmBtn = dialog.getByRole('button', { name: '确认清理 (2)' });
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await expect(dialog).toBeHidden();
  await expect(region).toContainText('已清理 2 个文件，释放 50.0 MB');
});
