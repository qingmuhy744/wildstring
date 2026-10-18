const assert = require('node:assert/strict');
const test = require('node:test');

test('Kugou metadata subset keeps only required public platform configuration', () => {
  const config = require('@wildstring/kugou-metadata/util/config.json');
  assert.deepEqual(Object.keys(config).sort(), ['appid', 'clientver', 'liteAppid', 'liteClientver'].sort());
  for (const value of Object.values(config)) assert.ok(value);
});

test('Kugou lyric search receives the platform identifiers after source trimming', async () => {
  const search = require('@wildstring/kugou-metadata/module/search_lyric');
  const config = require('@wildstring/kugou-metadata/util/config.json');
  const request = await search({ keywords: 'synthetic song', duration: 180 }, async (options) => options);
  assert.equal(request.params.appid, config.appid);
  assert.equal(request.params.clientver, config.clientver);
  assert.equal(request.params.keyword, 'synthetic song');
  assert.equal(request.url, '/v1/search');
});
