import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpSetup, mcpClients } from '../src/mcp-setup.ts';

test('four clients generate remote configuration without a real credential', () => {
  for (const client of Object.keys(mcpClients)) {
    const setup = mcpSetup(client, 'home-music', 'https://music.example.test/base/mcp', false);
    assert.ok(setup.prompt.includes('保留其他 MCP'));
    assert.ok(setup.prompt.includes('仅保存配置不代表接入成功'));
    assert.ok(!setup.config.includes('ws_'));
    if (client === 'generic') {
      assert.equal(setup.config, '');
      assert.ok(setup.prompt.includes('通用提示词未附带客户端专属配置'));
    } else if (client === 'codex') {
      assert.ok(setup.config.includes('bearer_token_env_var = "HOME_MUSIC_MCP_TOKEN"'));
      assert.ok(setup.config.includes('[mcp_servers.home-music]'));
    } else {
      const config = JSON.parse(setup.config);
      const entry = (config.mcp ?? config.mcpServers)['home-music'];
      assert.equal(entry.url ?? entry.serverUrl, 'https://music.example.test/base/mcp');
      if (client === 'opencode') {
        assert.equal(entry.oauth, false);
        assert.equal(entry.headers.Authorization, 'Bearer {env:HOME_MUSIC_MCP_TOKEN}');
      } else if (client === 'cursor') {
        assert.equal(entry.headers.Authorization, 'Bearer ${env:HOME_MUSIC_MCP_TOKEN}');
      } else {
        assert.equal(entry.headers.Authorization, 'Bearer REPLACE_WITH_YOUR_TOKEN');
      }
    }
  }
});
test('reject credential-bearing addresses, invalid identifiers and implicit HTTP', () => {
  for (const url of [
    'https://user:pass@music.test/mcp',
    'https://music.test/mcp?token=secret',
    'https://music.test/mcp#secret',
    'file:///tmp/mcp',
    'garbage',
  ]) {
    assert.throws(() => mcpSetup('codex', 'wildstring', url, true));
  }
  for (const name of ['', 'foo.bar', 'x]\ncommand = "bad"', 'a'.repeat(65)]) {
    assert.throws(() => mcpSetup('codex', name, 'https://music.test/mcp', false));
  }
  assert.throws(() => mcpSetup('cursor', 'wildstring', 'http://192.168.1.2/mcp', false));
  assert.ok(
    mcpSetup('cursor', 'wildstring', 'http://192.168.1.2/mcp', true).prompt.includes(
      '不提供 TLS 加密',
    ),
  );
});
