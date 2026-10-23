import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('专辑网格操作菜单打开专辑编辑器，修改 FLAC 标签与封面', async ({ page }) => {
  await login(page);

  // 切换到专辑视图
  await page.getByRole('button', { name: '专辑', exact: true }).first().click();

  const albumCard = page.locator('.album-card').first();
  await expect(albumCard).toBeVisible();

  // 右键或通过操作按钮打开专辑卡片操作菜单
  const actionBtn = albumCard.locator('.album-card-action');
  await actionBtn.click();

  // 菜单应弹出
  const menu = page.locator('.playlist-context');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('编辑专辑与封面');

  // 点击编辑专辑与封面
  await menu.getByRole('menuitem', { name: '编辑专辑与封面' }).click();

  // 专辑编辑弹窗应弹出
  const dialog = page.locator('.album-editor-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('FLAC ALBUM METADATA & ARTWORK');
  await expect(dialog).toContainText('专辑名称 (ALBUM)');
  await expect(dialog).toContainText('专辑艺人 (ALBUMARTIST)');
  await expect(dialog).toContainText('发行日期 (DATE)');

  // 展开高级标签
  await dialog.getByRole('button', { name: '展开唱片厂牌、编号与高级标签' }).click();
  await expect(dialog).toContainText('唱片厂牌 (LABEL / ORGANIZATION)');
  await expect(dialog).toContainText('唱片编号 (CATALOGNUMBER)');
  await expect(dialog).toContainText('总碟数 (DISCTOTAL)');

  // 关闭弹窗
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).not.toBeVisible();
});
