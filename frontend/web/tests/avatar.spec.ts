import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login, section } from './helpers';

const photo = execFileSync(
  'backend/.venv/bin/python',
  [
    '-c',
    'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(120,80),"#458c91").save(b,format="PNG"); sys.stdout.buffer.write(b.getvalue())',
  ],
  { cwd: '../..' },
);

test('头像预览、上传、重新打开与恢复默认使用真实账号接口', async ({ page }, info) => {
  await login(page);
  try {
    await section(page, '账号设置');
    const editor = page.getByRole('region', { name: '自定义头像', exact: true });
    const choose = editor.getByLabel('选择头像', { exact: true });
    await choose.setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: photo });
    await expect(editor.getByRole('img', { name: '头像预览', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '上传头像', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('头像已保存');
    await expect(editor.locator('img')).toHaveAttribute(
      'src',
      /\/api\/v1\/auth\/avatar\?v=[a-f0-9]{64}/,
    );
    await expect
      .poll(() => editor.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(256);
    await page.getByRole('button', { name: '关闭账号设置', exact: true }).click();
    await page.reload();
    await section(page, '账号设置');
    await expect(editor.locator('img')).toBeVisible();
    await editor.screenshot({
      path: `../../artifacts/052-verification/avatar-${info.project.name}.png`,
    });
    await choose.setInputFiles({
      name: 'large.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(editor.getByRole('status')).toContainText('不超过 5 MiB');
    await expect(editor.getByRole('button', { name: '上传头像', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: '恢复默认头像', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('已恢复默认头像');
    await expect(editor.locator('img')).toHaveCount(0);
  } finally {
    await page.request.delete('/api/v1/auth/avatar', { headers: { 'X-Wildstring-Client': 'web' } });
  }
});
