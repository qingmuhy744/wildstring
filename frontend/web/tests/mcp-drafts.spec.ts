import { expect, test } from '@playwright/test';
import { login, section } from './helpers';

for (const kind of ['intake', 'lyrics']) {
  test(`MCP ${kind} 草案展示具体差异、来源且批准后再应用`, async ({ page }, info) => {
    await login(page);
    let status = 'pending';
    let applications = 0;
    const title = kind === 'intake' ? '导入修正预览' : '双语逐字候选预览';
    function draft() {
      return {
        id: 'mcp-proposal',
        kind,
        title,
        status,
        version: 1,
        updated_at: '2026-10-19T05:00:00Z',
        evidence: [],
        trace_id: 'a'.repeat(32),
        payload:
          kind === 'intake'
            ? {
                item_id: 'intake-one',
                version: 1,
                overrides: { title: '合成摇滚', album: '合成专辑' },
              }
            : {
                candidate_id: 'lyric-one',
                version: 1,
                file_version: 'b'.repeat(64),
                offset_ms: 250,
              },
        before:
          kind === 'intake'
            ? { title: '缺失标题', album: null, source_path: 'Rock/CD01/01.flac' }
            : {
                title: '合成摇滚',
                provider: '合成歌词源',
                current_quality: { label: '静态歌词' },
                candidate_quality: { label: '双语逐字动态' },
                match: { score: 0.99, version_mismatch: false },
                current_lines: [{ text: '原歌词预览' }],
                candidate_lines: [
                  { text: 'Synthetic lyric ' + '长句'.repeat(90), translation: '合成译文' },
                ],
              },
        result:
          status === 'applied'
            ? kind === 'intake'
              ? { item_id: 'intake-one', state: 'approved' }
              : { track_id: 'song-one' }
            : null,
      };
    }
    await page.route('**/api/v1/agent/drafts**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approve')) status = 'approved';
      if (path.endsWith('/apply')) {
        applications++;
        status = 'applied';
      }
      await route.fulfill({
        json: path.endsWith('/drafts')
          ? { items: [draft()], total: 1, limit: 50, offset: 0 }
          : draft(),
      });
    });
    await section(page, '待确认草案');
    await page.getByRole('button', { name: `查看草案 ${title}`, exact: true }).click();
    const detail = page.getByRole('article', { name: '草案详情' });
    await expect(detail).toContainText(kind === 'intake' ? 'Rock/CD01/01.flac' : '双语逐字动态');
    await expect(detail).toContainText(kind === 'intake' ? '合成专辑' : '合成译文');
    expect(applications).toBe(0);
    await detail.getByRole('button', { name: '批准当前版本', exact: true }).click();
    await expect(detail.getByRole('button', { name: '应用已批准草案', exact: true })).toBeVisible();
    expect(applications).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../artifacts/mcp-${kind}-${info.project.name}.png`,
      fullPage: true,
    });
    await detail.getByRole('button', { name: '应用已批准草案', exact: true }).click();
    await expect(detail).toContainText('此版本已应用');
    expect(applications).toBe(1);
  });
}
