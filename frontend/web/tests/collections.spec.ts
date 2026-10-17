import { expect, test, type Page } from '@playwright/test';
import { audio, login } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };
async function tracks(page: Page) {
  return (await (await page.request.get('/api/v1/tracks')).json()).items as {
    id: string;
    title: string;
    play_count: number;
    listened_ms: number;
  }[];
}
async function lists(page: Page) {
  return (await (await page.request.get('/api/v1/playlists')).json()).items as {
    id: string;
    name: string;
    version: number;
    kind: string;
  }[];
}
async function clean(page: Page, prefix: string) {
  for (const list of await lists(page))
    if (list.name.startsWith(prefix) && list.kind !== 'favorites')
      await page.request.delete(`/api/v1/playlists/${list.id}?version=${list.version}`, {
        headers,
      });
}
async function tab(page: Page, name: string) {
  await page
    .getByRole('group', { name: '曲库显示方式' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function create(page: Page, name: string, smart = false) {
  await tab(page, '歌单');
  await page.getByRole('button', { name: '新建歌单' }).click();
  const editor = page.getByRole('dialog', { name: '新建歌单', exact: true });
  await editor.getByLabel('歌单名称', { exact: true }).fill(name);
  if (smart) await editor.getByLabel('歌单类型').selectOption('smart');
  return editor;
}

test('艺人入口、歌曲与专辑交集、播放和手机布局', async ({ page }, info) => {
  await login(page);
  await tab(page, '艺人');
  const card = page.getByRole('button', { name: '查看艺人 客席测试', exact: true });
  await expect(card).toContainText('1 张专辑 · 1 首歌曲');
  await card.click();
  await expect(page.getByRole('heading', { name: '客席测试', exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('table')).toContainText('晴天测试曲');
  await expect(page.getByRole('table')).not.toContainText('夜晚测试曲');
  await tab(page, '专辑');
  const album = page.getByRole('button', { name: '打开专辑 合成测试专辑', exact: true });
  await expect(album).toContainText('1 首');
  await album.click();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: '播放专辑', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.screenshot({ path: `../../artifacts/artist-${info.project.name}.png` });
  await page.getByRole('button', { name: '返回 客席测试' }).click();
  await expect(album).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('默认我喜欢歌单、心形状态与刷新后持久化', async ({ page }) => {
  await login(page);
  const target = (await tracks(page)).find((track) => track.title === '晴天测试曲')!;
  await page.request.put(`/api/v1/tracks/${target.id}/favorite`, {
    headers,
    data: { loved: false },
  });
  await page.getByRole('button', { name: '刷新曲库' }).click();
  await page
    .getByRole('table')
    .getByRole('button', { name: '喜欢 晴天测试曲', exact: true })
    .click();
  await expect(
    page.getByRole('table').getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await tab(page, '歌单');
  await page.getByRole('button', { name: '打开歌单 ♥ 我喜欢', exact: true }).click();
  await expect(page.getByRole('heading', { name: '♥ 我喜欢', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('晴天测试曲');
  await expect(page.getByRole('button', { name: '删除歌单', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await tab(page, '歌单');
  await page.getByRole('button', { name: '打开歌单 ♥ 我喜欢', exact: true }).click();
  await page
    .getByRole('table')
    .getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true })
    .click();
  await expect(page.getByText('喜欢的歌，留在这里。')).toBeVisible();
});

test('普通歌单创建、单曲与整页加入、排序移除和持久化', async ({ page }, info) => {
  await login(page);
  const prefix = `浏览器普通-${info.project.name}`;
  await clean(page, prefix);
  try {
    const editor = await create(page, prefix);
    await editor.getByRole('button', { name: '保存歌单', exact: true }).click();
    await expect(page.getByRole('heading', { name: prefix, exact: true })).toBeVisible();
    await tab(page, '歌曲');
    await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
    await page
      .getByLabel('将 晴天测试曲 加入歌单', { exact: true })
      .selectOption({ label: prefix });
    await expect(page.locator('.toast')).toContainText(`已加入：${prefix}`);
    await page.getByText('批量加入歌单', { exact: true }).click();
    await page.getByLabel('已加载歌曲加入歌单', { exact: true }).selectOption({ label: prefix });
    await page.getByRole('button', { name: '加入已加载', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('已加载歌曲已加入');
    await tab(page, '歌单');
    await page.getByRole('button', { name: `打开歌单 ${prefix}`, exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('晴天测试曲');
    await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
    await page.getByRole('button', { name: '歌单中上移', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('夜晚测试曲');
    await page.reload();
    await expect(page.getByRole('table')).toBeVisible();
    await tab(page, '歌单');
    await page.getByRole('button', { name: `打开歌单 ${prefix}`, exact: true }).click();
    await expect(page.getByRole('table').getByRole('row').nth(1)).toContainText('夜晚测试曲');
    await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
    await page.getByRole('button', { name: '从歌单移除', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  } finally {
    await clean(page, prefix);
  }
});

test('可视化规则歌单、实时收藏筛选与编辑任一条件', async ({ page }, info) => {
  await login(page);
  const prefix = `浏览器规则-${info.project.name}`;
  const target = (await tracks(page)).find((track) => track.title === '晴天测试曲')!;
  await page.request.put(`/api/v1/tracks/${target.id}/favorite`, {
    headers,
    data: { loved: true },
  });
  await clean(page, prefix);
  try {
    await page.getByRole('button', { name: '刷新曲库' }).click();
    const editor = await create(page, prefix, true);
    await editor.getByLabel('条件 1 字段', { exact: true }).selectOption('loved');
    await editor.getByRole('button', { name: '添加条件' }).click();
    await editor.getByLabel('条件 2 字段', { exact: true }).selectOption('artist');
    await editor.getByLabel('条件 2 值', { exact: true }).fill('客席');
    await editor.getByLabel('规则排序').selectOption('playCount');
    await editor.getByLabel('排序方向').selectOption('desc');
    await page.screenshot({ path: `../../artifacts/smart-editor-${info.project.name}.png` });
    await editor.getByRole('button', { name: '保存歌单', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
    await page
      .getByRole('table')
      .getByRole('button', { name: '取消喜欢 晴天测试曲', exact: true })
      .click();
    await expect(page.getByText('还没有符合规则的歌')).toBeVisible();
    await page.getByRole('button', { name: '编辑歌单', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑歌单', exact: true });
    await edit.getByLabel('条件匹配方式').selectOption('any');
    await edit.getByLabel('条件 2 字段', { exact: true }).selectOption('title');
    await edit.getByLabel('条件 2 值', { exact: true }).fill('夜晚');
    await edit.getByRole('button', { name: '保存歌单', exact: true }).click();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
    await expect(page.getByRole('table')).toContainText('夜晚测试曲');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await clean(page, prefix);
    await page.request.put(`/api/v1/tracks/${target.id}/favorite`, {
      headers,
      data: { loved: false },
    });
  }
});

test('下一首插入、三横杠鼠标或触摸拖动保持当前播放', async ({ page }, info) => {
  await login(page);
  const firstTitle = (await tracks(page))[0].title;
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  const before = await audio(page);
  await page.getByRole('button', { name: '歌曲操作 夜晚测试曲', exact: true }).click();
  await page.getByRole('button', { name: '下一首播放', exact: true }).click();
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  const queue = page.getByRole('complementary', { name: '播放队列', exact: true });
  await expect(queue.getByRole('listitem')).toHaveCount(3);
  await expect(queue.getByRole('listitem').nth(1)).toContainText('夜晚测试曲');
  await expect(queue.getByRole('button', { name: /上移队列|下移队列/ })).toHaveCount(0);
  async function drag(from: number, to: number) {
    const handle = await queue
      .getByRole('button', { name: `拖动队列第 ${from + 1} 首排序`, exact: true })
      .boundingBox();
    const target = await queue.getByRole('listitem').nth(to).boundingBox();
    if (!handle || !target) throw new Error('Queue drag target unavailable');
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    const targetY = target.y + target.height / 2;
    if (info.project.name === 'mobile') {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 8; step++)
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: y + ((targetY - y) * step) / 8 }],
          });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await session.detach();
      }
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, targetY, { steps: 10 });
      await page.mouse.up();
    }
  }
  await drag(0, 2);
  await expect(queue.getByRole('listitem').last()).toContainText(firstTitle);
  await expect(queue.locator('li.selected')).toContainText(firstTitle);
  expect((await audio(page)).source).toBe(before.source);
  expect((await audio(page)).time).toBeGreaterThanOrEqual(before.time);
  expect((await audio(page)).paused).toBe(false);
  await drag(2, 0);
  await expect(queue.getByRole('listitem').first()).toContainText(firstTitle);
  const keyboardHandle = queue.getByRole('button', { name: '拖动队列第 1 首排序', exact: true });
  await keyboardHandle.focus();
  await keyboardHandle.press('ArrowDown');
  await expect(
    queue.getByRole('button', { name: '拖动队列第 2 首排序', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(queue.getByRole('listitem').first()).toContainText(firstTitle);
  await queue.getByRole('button', { name: '关闭队列' }).click();
  await page.getByRole('button', { name: '下一首', exact: true }).click();
  await expect.poll(async () => (await audio(page)).source).not.toBe(before.source);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('长队列拖动边缘滚动、取消与暂停状态', async ({ page }, info) => {
  await login(page);
  const firstTitle = (await tracks(page))[0].title;
  await page.getByRole('button', { name: '播放全部', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const before = await audio(page);
  for (let i = 0; i < 16; i++) {
    await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
    await page.getByRole('button', { name: '将 晴天测试曲 加入队列', exact: true }).click();
  }
  await page.getByRole('button', { name: '播放队列', exact: true }).last().click();
  const queue = page.getByRole('complementary', { name: '播放队列', exact: true });
  await expect(queue.getByRole('listitem')).toHaveCount(18);
  const handle = await queue
    .getByRole('button', { name: '拖动队列第 1 首排序', exact: true })
    .boundingBox();
  const box = await queue.boundingBox();
  if (!handle || !box) throw new Error('Queue drag target unavailable');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  const edge = box.y + box.height - 5;
  const session = info.project.name === 'mobile' ? await page.context().newCDPSession(page) : null;
  async function pointer(type: 'start' | 'move' | 'end' | 'cancel', clientY = y) {
    if (session) {
      await session.send('Input.dispatchTouchEvent', {
        type: { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' }[
          type
        ] as 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
        touchPoints: type === 'end' || type === 'cancel' ? [] : [{ x, y: clientY }],
      });
    } else {
      if (type === 'start') {
        await page.mouse.move(x, y);
        await page.mouse.down();
      }
      if (type === 'move') await page.mouse.move(x, clientY, { steps: 10 });
      if (type === 'cancel') await page.keyboard.press('Escape');
      if (type === 'end' || type === 'cancel') await page.mouse.up();
    }
  }
  try {
    await pointer('start');
    await pointer('move', edge);
    await expect.poll(() => queue.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    await pointer('cancel');
    await expect(queue.locator('.is-dragging')).toHaveCount(0);
    await expect(queue.getByRole('listitem').first()).toContainText(firstTitle);
    await queue.evaluate((node) => {
      node.scrollTop = 0;
    });
    await pointer('start');
    await pointer('move', edge);
    await expect.poll(() => queue.evaluate((node) => node.scrollTop)).toBeGreaterThan(250);
    await pointer('end', edge);
    await expect(queue.locator('li.selected')).toContainText(firstTitle);
    expect(
      await queue
        .locator('li.selected')
        .evaluate((node) => Array.from(node.parentElement!.children).indexOf(node)),
    ).toBeGreaterThan(2);
    expect((await audio(page)).source).toBe(before.source);
    expect((await audio(page)).time).toBe(before.time);
    expect((await audio(page)).paused).toBe(true);
    await page.screenshot({ path: `../../artifacts/queue-drag-${info.project.name}.png` });
  } finally {
    await session?.detach();
  }
});

test('实际收听累计、一次计数、暂停跳转不增加与收听视图', async ({ page }, info) => {
  await login(page);
  const target = (await tracks(page)).find((track) => track.title === '夜晚测试曲')!;
  await page.getByRole('button', { name: '播放 夜晚测试曲', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time, { timeout: 12000 }).toBeGreaterThan(6.3);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/tracks/${target.id}`)).json()).play_count,
    )
    .toBe(target.play_count + 1);
  const heard = await (await page.request.get(`/api/v1/tracks/${target.id}`)).json();
  expect(heard.listened_ms - target.listened_ms).toBeGreaterThan(5500);
  expect(heard.listened_ms - target.listened_ms).toBeLessThan(9000);
  await page.getByLabel('播放进度').focus();
  await page.getByLabel('播放进度').press('Home');
  for (let step = 0; step < 80; step++) await page.getByLabel('播放进度').press('ArrowRight');
  const after = await (await page.request.get(`/api/v1/tracks/${target.id}`)).json();
  expect(after.listened_ms).toBe(heard.listened_ms);
  expect(after.play_count).toBe(heard.play_count);
  if (info.project.name === 'mobile') await page.getByLabel('浏览方式').selectOption('listening');
  else await page.getByRole('button', { name: '收听记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '那些反复响起的。', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('夜晚测试曲');
  await expect(page.getByLabel('收听统计')).toBeVisible();
  await page.screenshot({ path: `../../artifacts/listening-${info.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Replaying the final queue entry must create a new listening session.
  await tab(page, '歌曲');
  const finalTrack = (await tracks(page)).at(-1)!;
  const sessions = new Set<string>();
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/v1/listening') || request.method() !== 'POST') return;
    const payload = request.postDataJSON();
    if (payload.track_id === finalTrack.id && payload.listened_ms === 0)
      sessions.add(payload.session_id);
  });
  await page.getByRole('button', { name: `播放 ${finalTrack.title}`, exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.2);
  await expect.poll(() => sessions.size).toBe(1);
  await page.getByLabel('播放进度').focus();
  await page.getByLabel('播放进度').press('End');
  await expect.poll(async () => (await audio(page)).ended).toBe(true);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(0.1);
  await expect.poll(() => sessions.size).toBe(2);
});
