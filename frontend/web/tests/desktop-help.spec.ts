import { test, expect, type Page } from '@playwright/test';
import { login, section } from './helpers';

async function gain(page: Page) {
  await login(page);
  await page.getByRole('button', { name: '播放 晴天测试曲', exact: true }).click();
  await page.getByRole('button', { name: '响度', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '响度均衡与手动调整' });
  await expect(dialog.getByLabel('自动均衡前级（dB）', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  return dialog;
}
async function settings(page: Page) {
  await login(page);
  await section(page, '管理');
  await page
    .getByRole('navigation', { name: '管理分类' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
}

test('图标提示延迟出现，可悬停阅读和 Esc 关闭，原操作保持可用', async ({ page }, info) => {
  await login(page);
  const button = page.getByRole('button', { name: '播放队列', exact: true });
  await page.clock.install();
  await button.hover();
  await page.clock.runFor(300);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.clock.runFor(120);
  if (info.project.name === 'mobile') {
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await button.click();
    await expect(page.locator('.queue-panel')).toBeVisible();
    return;
  }
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('播放队列');
  await tooltip.hover();
  await page.clock.runFor(5000);
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(12);
  expect(box!.y).toBeGreaterThanOrEqual(12);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900 - 12);
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await button.click();
  await expect(page.locator('.queue-panel')).toBeVisible();
});

test('参数名称保持可访问，弹窗内聚焦说明不裁切，Esc 先关闭提示', async ({ page }, info) => {
  const dialog = await gain(page);
  const input = dialog.getByLabel('自动均衡前级（dB）', { exact: true });
  await input.evaluate((el) => el.setAttribute('aria-describedby', 'existing-gain-help'));
  await input.blur();
  await input.focus();
  if (info.project.name === 'mobile') {
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(dialog.locator('.desktop-help-marker').first()).toBeHidden();
    await expect(input).toHaveAttribute('aria-describedby', 'existing-gain-help');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    return;
  }
  const tooltip = dialog.getByRole('tooltip');
  await expect(tooltip).toContainText('正值更响');
  expect(await tooltip.evaluate((el) => el.matches(':popover-open'))).toBe(true);
  const id = await tooltip.getAttribute('id');
  await expect(input).toHaveAttribute('aria-describedby', `existing-gain-help ${id}`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(input).toHaveAttribute('aria-describedby', 'existing-gain-help');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('悬停转键盘聚焦保留说明关联，切换参数只显示一份并在关闭弹窗后清理', async ({ page }, info) => {
  const dialog = await gain(page);
  const preamp = dialog.getByLabel('自动均衡前级（dB）', { exact: true });
  const label = dialog.locator('.desktop-help-label').filter({ hasText: '自动均衡前级' });
  await label.hover();
  if (info.project.name === 'mobile') {
    await preamp.focus();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    return;
  }
  await expect(page.getByRole('tooltip')).toContainText('自动响度均衡');
  await preamp.focus();
  const id = await page.getByRole('tooltip').getAttribute('id');
  await expect(preamp).toHaveAttribute('aria-describedby', id!);
  const other = dialog.getByLabel('单曲增益 dB', { exact: true });
  await other.focus();
  await expect(page.getByRole('tooltip')).toHaveCount(1);
  await expect(page.getByRole('tooltip')).toContainText('只对当前歌曲额外微调');
  await expect(preamp).not.toHaveAttribute('aria-describedby');
  await dialog.getByRole('button', { name: '关闭响度设置', exact: true }).click();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('导入计数解释可由键盘读取，手机不增加帮助焦点', async ({ page }, info) => {
  await page.route('**/api/v1/manage/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.last_scan = {
      status: 'completed',
      counts: { waiting: 2, assets_copied: 20, review: 1, skipped: 5 },
      errors: [],
    };
    await route.fulfill({ json: data });
  });
  await login(page);
  await section(page, '管理');
  const counter = page.locator('.run-counters .desktop-help-term').filter({ hasText: '附属文件' });
  await expect(counter).toHaveText('附属文件 20');
  if (info.project.name === 'mobile') {
    await expect(counter).not.toHaveAttribute('tabindex');
    await counter.hover();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    return;
  }
  await page.keyboard.press('Tab');
  await counter.focus();
  await expect(page.getByRole('tooltip')).toContainText('不计为歌曲');
  await page.keyboard.press('Tab');
  await expect(
    page.locator('.run-counters .desktop-help-term').filter({ hasText: '待整理' }),
  ).toBeFocused();
  await expect(page.getByRole('tooltip')).toContainText('待整理');
});

test('设置提示适应浅深色及屏幕边缘，缩成手机宽度立即收起', async ({ page }, info) => {
  await settings(page);
  const input = page.getByLabel('AcoustID Application API Key', { exact: true });
  await page.keyboard.press('Tab');
  await input.focus();
  if (info.project.name === 'mobile') {
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(
      await page
        .locator('.desktop-help-marker')
        .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).display === 'none')),
    ).toBe(true);
    await page.screenshot({ path: '../../artifacts/0512-help-mobile-unchanged.png' });
    await page.setViewportSize({ width: 1100, height: 900 });
    await input.focus();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(
      await page
        .locator('.desktop-help-marker')
        .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).display === 'none')),
    ).toBe(true);
    return;
  }
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Application API Key');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await input.blur();
    await input.scrollIntoViewIfNeeded();
    await input.focus();
    await expect(tooltip).toContainText('Application API Key');
    const box = await tooltip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(12);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1360 - 12);
    await page.screenshot({ path: `../../artifacts/0512-help-settings-${theme}.png` });
  }
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(tooltip).toHaveCount(0);
  await expect(input).not.toHaveAttribute('aria-describedby');
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await input.blur();
  await input.focus();
  await expect(tooltip).toBeVisible();
});
