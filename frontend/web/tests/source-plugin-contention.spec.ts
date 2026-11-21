import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { login } from './helpers';

const headers = { 'X-Wildstring-Client': 'web' };

test('批扫持有来源时，单曲歌词查询等待后完成', async ({ page }, info) => {
  test.setTimeout(60_000);
  await login(page);
  const tracks = (await (await page.request.get('/api/v1/tracks')).json()).items;
  const track = tracks.find((row: { title: string }) => row.title === '晴天测试曲');
  expect(track).toBeDefined();
  const pluginId = `contention-${info.project.name}`;
  const zip = execFileSync(
    'backend/.venv/bin/python',
    [
      '-c',
      `
import io, json, sys, zipfile
track = json.load(sys.stdin)
candidate = {'id': 'song', 'title': track['title'], 'artists': track['artists'], 'duration_ms': track['duration_ms'], 'source_url': 'https://example.com/song'}
lyrics = {'format':'lrc', 'original':'[00:01]Synthetic lyric', 'normalized':{'kind':'synced', 'format':'lrc', 'lines':[{'time_ms':1000, 'text':'Synthetic lyric', 'words':[{'start_ms':1000, 'end_ms':2000, 'text':'Synthetic lyric'}]}], 'layers':{'translation':[{'time_ms':1000, 'text':'合成译文'}]}}}
adapter = """
import time
class Plugin:
    def search(self, context, query):
        if (context.data.get('rate') or {}).get('batch_id'):
            time.sleep(10)
        return CANDIDATES
    def metadata(self, context, request):
        return []
    def lyrics(self, context, candidate):
        return LYRICS
""".replace('CANDIDATES', repr([candidate])).replace('LYRICS', repr(lyrics))
data = io.BytesIO()
with zipfile.ZipFile(data, 'w') as archive:
    archive.writestr('manifest.json', json.dumps({'id':track['plugin_id'],'name':'并行合成来源','api_version':2,'version':'2.0.0','license':'GPL-3.0-only','upstream':'https://example.com','request_pacing':True,'settings':[]}))
    archive.writestr('adapter.py', adapter)
sys.stdout.buffer.write(data.getvalue())
`,
    ],
    { cwd: '../..', input: JSON.stringify({ ...track, plugin_id: pluginId }) },
  );
  const pluginUrl = `/api/v1/manage/source-plugins/${pluginId}`;
  let batchId: string | undefined;
  try {
    const imported = await page.request.post('/api/v1/manage/source-plugins/import', {
      headers: { ...headers, 'Content-Type': 'application/zip' },
      data: zip,
    });
    expect(imported.ok()).toBe(true);
    expect(
      (
        await page.request.put(pluginUrl, {
          headers,
          data: { version: 1, enabled: true, priority: 0 },
        })
      ).ok(),
    ).toBe(true);
    const scan = await page.request.post('/api/v1/manage/lyric-scans', {
      headers,
      data: { scope: 'album', scope_id: track.album_id, force: true },
    });
    expect(scan.ok()).toBe(true);
    batchId = (await scan.json()).id;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/v1/manage/lyric-scans/${batchId}`);
          const batch = await response.json();
          return batch.items.find((item: { track_id: string }) => item.track_id === track.id)
            ?.status;
        },
        { timeout: 15000, intervals: [100] },
      )
      .toBe('running');

    await page.getByRole('button', { name: '歌曲操作 晴天测试曲', exact: true }).click();
    await page.getByRole('button', { name: '编辑歌曲信息', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑歌曲信息', exact: true });
    await editor.getByRole('button', { name: '歌词', exact: true }).click();
    const panel = editor.locator('.online-lyrics');
    const search = panel.getByRole('button', { name: '查找联网歌词', exact: true });
    await expect(search).toBeEnabled();
    const currentBatch = await (
      await page.request.get(`/api/v1/manage/lyric-scans/${batchId}`)
    ).json();
    expect(
      currentBatch.items.find((item: { track_id: string }) => item.track_id === track.id)?.status,
    ).toBe('running');
    const queued = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/manage/tracks/${track.id}/online-lyrics`,
    );
    await search.click();
    const queuedResponse = await queued;
    expect(queuedResponse.ok()).toBe(true);
    const manualJobId: string = (await queuedResponse.json()).id;
    await expect(search).toBeDisabled();
    await expect
      .poll(
        async () => {
          const result = await (
            await page.request.get(`/api/v1/manage/tracks/${track.id}/online-lyrics`)
          ).json();
          return result.jobs.find((job: { id: string }) => job.id === manualJobId)?.status;
        },
        { timeout: 30000, intervals: [200] },
      )
      .toBe('completed');
    await expect(search).toBeEnabled({ timeout: 10000 });
    await expect(panel).toContainText(pluginId, { timeout: 10000 });
    const result = await (
      await page.request.get(`/api/v1/manage/tracks/${track.id}/online-lyrics`)
    ).json();
    expect(result.items.some((item: { plugin_id: string }) => item.plugin_id === pluginId)).toBe(
      true,
    );
    expect(result.jobs.find((job: { id: string }) => job.id === manualJobId)?.warnings).toEqual([]);
  } finally {
    if (batchId) {
      await page.request.post(`/api/v1/manage/lyric-scans/${batchId}/control`, {
        headers,
        data: { action: 'cancel' },
      });
    }
    const plugins = (await (await page.request.get('/api/v1/manage/source-plugins')).json()).items;
    const plugin = plugins.find((item: { id: string }) => item.id === pluginId);
    if (plugin) {
      const saved = await page.request.put(pluginUrl, {
        headers,
        data: { version: plugin.version, enabled: false },
      });
      if (saved.ok()) {
        const updated = await saved.json();
        await page.request.delete(`${pluginUrl}?version=${updated.version}`, { headers });
      }
    }
  }
});
