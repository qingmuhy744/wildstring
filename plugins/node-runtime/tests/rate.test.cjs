const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { paced, observeAxios } = require('../rate.cjs');
observeAxios(require('axios'));
const { createRequest } = require('@wildstring/kugou-metadata/util/request');

test('preserves 429 and Retry-After through the vendor 502 wrapper', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Retry-After': '120' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = paced({}, createRequest);
    await assert.rejects(
      request({ url: '/', baseURL: `http://127.0.0.1:${server.address().port}`, method: 'GET' }),
      (error) => error.wildstring_error === 'source_plugin_rate_limited' &&
        error.upstream_429 === true && error.retry_after === 120,
    );
  } finally {
    server.close();
  }
});

test('parses Retry-After dates and response body rate codes', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Retry-After': new Date(Date.now() + 180000).toUTCString() });
    res.end('{"error_code":429}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      paced({}, createRequest)({ url: '/', baseURL: `http://127.0.0.1:${server.address().port}`, method: 'GET' }),
      (error) => error.upstream_429 === true && error.retry_after >= 178 && error.retry_after <= 180,
    );
  } finally {
    server.close();
  }
});

test('preserves a NetEase 429 despite its 502 wrapper', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Retry-After': '30' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const cloudsearch = require('@wildstring/netease-metadata/module/cloudsearch');
    const request = require('@wildstring/netease-metadata/util/request');
    await assert.rejects(
      cloudsearch({ keywords: 'fixture', domain: `http://127.0.0.1:${server.address().port}` }, paced({}, request)),
      (error) => error.upstream_429 === true && error.retry_after === 60,
    );
  } finally {
    server.close();
  }
});

test('successful follow-up request clears an earlier authentication response', async () => {
  const axios = require('axios');
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/first' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const result = await paced({}, async () => {
      await axios.get(baseURL + '/first').catch(() => {});
      await axios.get(baseURL + '/second');
      return { status: 200, body: { ok: true } };
    })();
    assert.equal(result.body.ok, true);
  } finally {
    server.close();
  }
});
