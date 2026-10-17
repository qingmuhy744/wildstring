import { expect, test, type Page } from '@playwright/test';
import { audio } from './helpers';

test.skip(process.env.WILDSTRING_TEST_BROWSE_LIBRARY !== '1', '独立的连续浏览曲库夹具');

async function login(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wildstring:playback-sync:admin', 'off'));
  await page.goto('/');
  await page.getByLabel('密码', { exact: true }).fill('disposable-browser-test-password');
  await page.getByRole('button', { name: '进入曲库' }).click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(51);
}
async function tab(page: Page, name: string) {
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name, exact: true })
    .click();
}

test('真实拼音索引：远跳未加载的 Z、向前补载、列表去重及完整队列', async ({ page }) => {
  await login(page);
  await expect(page.locator('.pagination')).toHaveCount(0);
  const rail = page.getByRole('navigation', { name: '首字母定位' });
  await expect(rail.getByRole('button')).toHaveCount(28);
  await expect(rail.getByRole('button', { name: '定位到 C', exact: true })).toBeDisabled();
  const index = await (await page.request.get('/api/v1/browse-index?kind=tracks')).json();
  const last = index.groups.find((group: { key: string }) => group.key === 'Z');
  expect(last.offset).toBeGreaterThan(150);
  const request = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname.endsWith('/tracks') && url.searchParams.get('offset') === String(last.offset)
    );
  });
  await rail.getByRole('button', { name: '定位到 Z', exact: true }).click();
  await request;
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('最后');
  const count = await page.getByRole('table').getByRole('row').count();
  await page.getByRole('button', { name: '加载前面的歌曲', exact: true }).click();
  await expect.poll(() => page.getByRole('table').getByRole('row').count()).toBeGreaterThan(count);
  const ids = await page
    .locator('.track-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-browse-id')));
  expect(new Set(ids).size).toBe(ids.length);
  const target = page
    .getByRole('table')
    .getByRole('button', { name: /^播放 最后/ })
    .first();
  await target.click();
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const key = Object.keys(localStorage).find((item) =>
          item.startsWith('wildstring:playback:'),
        );
        return key ? JSON.parse(localStorage.getItem(key)!).tracks.length : 0;
      });
    })
    .toBe(258);
  await expect.poll(async () => (await audio(page)).paused).toBe(false);
});

test('字母拖动只预览，松手定位；增量失败保留列表并支持重试', async ({ page }) => {
  await login(page);
  const rail = page.getByRole('navigation', { name: '首字母定位' });
  // Starting a scrub over an empty, disabled group must still capture the rail.
  const a = await rail.getByRole('button', { name: '定位到 C', exact: true }).boundingBox();
  const z = await rail.getByRole('button', { name: '定位到 Z', exact: true }).boundingBox();
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/tracks')) requests.push(request.url());
  });
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await expect(page.locator('.alphabet-preview')).toHaveText('C');
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2, { steps: 8 });
  await expect(page.locator('.alphabet-preview')).toHaveText('Z');
  expect(requests).toHaveLength(0);
  await page.mouse.up();
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('最后');
  let failed = false;
  await page.route('**/api/v1/tracks?*', (route) => {
    const url = new URL(route.request().url());
    if (!failed && Number(url.searchParams.get('offset')) > 230) {
      failed = true;
      return route.fulfill({ status: 503, json: { detail: 'test_failure' } });
    }
    return route.continue();
  });
  await page.locator('.browse-boundary').last().scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toHaveCount(0);
  await expect(page.locator('.browse-boundary').last()).toContainText('已到底');
});

test('专辑紧凑曲目、管理收进菜单，返回列表保留位置', async ({ page }, info) => {
  await login(page);
  await tab(page, '专辑');
  await page
    .getByRole('navigation', { name: '首字母定位' })
    .getByRole('button', { name: '定位到 J', exact: true })
    .click();
  const card = page.getByRole('button', { name: '打开专辑 紧凑测试专辑', exact: true });
  await card.scrollIntoViewIfNeeded();
  const previous = await page.evaluate(() => scrollY);
  await card.click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(13);
  await expect(page.locator('.album-tracks .track-identity img')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '首字母定位' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更新专辑元数据', exact: true })).not.toBeVisible();
  await page.getByLabel('集合更多操作', { exact: true }).click();
  await expect(page.getByRole('button', { name: '更新专辑元数据', exact: true })).toBeVisible();
  await page.getByLabel('集合更多操作', { exact: true }).click();
  const row = page.locator('.album-tracks .track-row').first();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(74);
  await page.screenshot({ path: `../../artifacts/continuous-album-${info.project.name}.png` });
  await page.getByRole('button', { name: '返回专辑', exact: false }).click();
  await expect(card).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(previous, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('专辑与艺人远跳、角色及搜索切换重建字母分组', async ({ page }) => {
  await login(page);
  await tab(page, '专辑');
  const rail = page.getByRole('navigation', { name: '首字母定位' });
  await rail.getByRole('button', { name: '定位到 Z', exact: true }).click();
  await expect(page.locator('.album-card').first()).toContainText('最后专辑');
  await tab(page, '艺人');
  await page.getByLabel('艺人参与角色').selectOption('artist');
  await rail.getByRole('button', { name: '定位到 Z', exact: true }).click();
  await expect(page.locator('.artist-card').first()).toContainText('最后艺人');
  await page.getByLabel('搜索曲库', { exact: true }).fill('北京');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.artist-card').first()).toContainText('北京艺人');
  await expect(rail.getByRole('button', { name: '定位到 Z', exact: true })).toBeDisabled();
  await expect(rail.getByRole('button', { name: '定位到 B', exact: true })).toBeEnabled();
  await page.locator('.artist-card').first().click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table')).toContainText('北京歌曲');
});

test('远跳失败重试替换窗口，快速搜索不会回填过期结果', async ({ page }) => {
  await login(page);
  const index = await (await page.request.get('/api/v1/browse-index?kind=tracks')).json();
  const last = index.groups.find((group: { key: string }) => group.key === 'Z');
  let fail = true;
  await page.route('**/api/v1/tracks?*', (route) => {
    if (fail && new URL(route.request().url()).searchParams.get('offset') === String(last.offset)) {
      fail = false;
      return route.fulfill({ status: 503, json: { detail: 'test_failure' } });
    }
    return route.continue();
  });
  await page
    .getByRole('navigation', { name: '首字母定位' })
    .getByRole('button', { name: '定位到 Z', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '重试加载', exact: true })).toBeVisible();
  const retry = page.getByRole('button', { name: '重试加载', exact: true });
  await retry.scrollIntoViewIfNeeded();
  // The error lives below the old 50-row window. Retrying must scroll upwards
  // to Z without interpreting that programmatic move as backward browsing.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const retryOffsets: number[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/tracks')) retryOffsets.push(Number(url.searchParams.get('offset')));
  });
  await retry.click();
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('最后歌曲');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(retryOffsets).toEqual([last.offset]);
  await expect(page.locator('.track-number').first()).toHaveText(String(last.offset + 1));
  // A real upward gesture still extends the window and keeps earlier tracks accessible.
  await page.mouse.wheel(0, -150);
  await expect(page.locator('.track-number').first()).toHaveText(String(last.offset - 50 + 1));
  await page.unroute('**/api/v1/tracks?*');
  let release: (() => void) | undefined;
  let intercepted: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  await page.route('**/api/v1/tracks?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === '北京') {
      intercepted!();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.continue().catch(() => {});
    } else await route.continue();
  });
  await page.getByLabel('搜索曲库', { exact: true }).fill('北京');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await requested;
  await page.getByLabel('搜索曲库', { exact: true }).fill('最后');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('最后歌曲');
  release!();
  await expect(page.getByRole('table')).not.toContainText('北京歌曲');
});

test('加载第二批歌曲后切换小大中，保留首个完整可见歌曲及其位置', async ({ page }) => {
  await login(page);
  await page.locator('.browse-boundary').last().scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('.track-row').count()).toBeGreaterThanOrEqual(100);
  const navigation = page.getByLabel('浏览方式', { exact: true });
  if (await navigation.isVisible()) await navigation.selectOption('account');
  else await page.getByRole('button', { name: '账号设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '账号设置', exact: true });
  await page
    .locator('.track-row')
    .nth(72)
    .evaluate((row) => window.scrollTo(0, row.getBoundingClientRect().top + scrollY - 8));
  async function firstVisible() {
    return page.locator('.track-row').evaluateAll((rows) => {
      const edge = Math.min(
        innerHeight,
        document.querySelector('.player')!.getBoundingClientRect().top,
      );
      const row = rows.find(
        (row) => row.getBoundingClientRect().top >= 0 && row.getBoundingClientRect().bottom <= edge,
      )!;
      return { id: row.getAttribute('data-browse-id'), top: row.getBoundingClientRect().top };
    });
  }
  const before = await firstVisible();
  for (const size of ['small', 'large', 'medium']) {
    await settings.getByLabel('歌曲列表大小', { exact: true }).selectOption(size);
    await expect(page.locator('.track-list')).toHaveAttribute('data-list-size', size);
    await expect.poll(firstVisible).toEqual(before);
  }
  await settings.getByRole('button', { name: '关闭账号设置', exact: true }).click();
  await expect.poll(firstVisible).toEqual(before);
  expect(await page.locator('.track-row').count()).toBeGreaterThanOrEqual(100);
});
