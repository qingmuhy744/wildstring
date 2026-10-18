const assert = require('node:assert/strict');
const test = require('node:test');
const { deflateSync } = require('node:zlib');

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

test('Kugou decodes KRC bytes produced by native zlib with Pako 3', () => {
  const { decodeLyrics } = require('@wildstring/kugou-metadata/util/util');
  const text = '[0,1000]<0,500,0>合成歌词\n[1000,1000]<0,1000,0>Synthetic lyrics';
  const compressed = deflateSync(Buffer.from(text, 'utf8'));
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const encrypted = Buffer.from(compressed.map((byte, index) => byte ^ key[index % key.length]));
  const krc = Buffer.concat([Buffer.from('krc1'), encrypted]);
  assert.equal(decodeLyrics(krc), text);
  assert.equal(decodeLyrics(krc.toString('base64')), text);
  assert.equal(decodeLyrics(krc.subarray(0, 8)), '');
});
