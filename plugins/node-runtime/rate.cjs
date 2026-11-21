// Every physical request uses the same gate as the Python SDK adapter.
const { spawn } = require('node:child_process');
const axios = require('axios');

let upstreamError;
function inspectResponse(response) {
  if (!response) return;
  let body = response.data;
  if (Buffer.isBuffer(body)) body = body.toString();
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const status = [response.status, body?.code, body?.error_code].map(Number);
  if (status.includes(429)) {
    const header = response.headers?.['retry-after'];
    let delay = /^\d+$/.test(String(header ?? '')) ? Number(header) :
      (Date.parse(header) - Date.now()) / 1000;
    if (!Number.isFinite(delay)) delay = 900;
    upstreamError = {
      wildstring_error: 'source_plugin_rate_limited', upstream_429: true,
      retry_after: Math.max(60, Math.min(86400, Math.ceil(delay))),
    };
  } else if (status.includes(401) || status.includes(403)) {
    upstreamError = { wildstring_error: 'source_plugin_auth_or_rejected' };
  }
}
axios.interceptors.response.use((response) => {
  inspectResponse(response);
  return response;
}, (error) => {
  inspectResponse(error.response);
  return Promise.reject(error);
});
function gate(data) {
  if (!data.rate) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const [command, ...args] = data.rate_command;
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (part) => {
      output += part;
      if (output.length > 8192) child.kill();
    });
    child.on('error', () => reject({ wildstring_error: 'source_plugin_unavailable' }));
    child.on('close', (code) => {
      try {
        const result = JSON.parse(output);
        if (code || !result.ok)
          reject({ wildstring_error: result.error || 'source_plugin_unavailable', cooldown_until: result.cooldown_until });
        else resolve();
      } catch {
        reject({ wildstring_error: 'source_plugin_unavailable' });
      }
    });
    child.stdin.end(JSON.stringify(data.rate));
  });
}
exports.paced = (data, request) => {
  let chain = Promise.resolve();
  let lastStart = -Infinity;
  return (...args) => {
    const task = chain.then(async () => {
      await gate(data);
      // The gate subprocess may take different amounts of time to exit. Enforce the
      // interval at the actual HTTP start too, using a monotonic clock in this queue.
      const interval = Math.max(0, Number(data.rate?.interval_seconds) || 0) * 1000;
      while (performance.now() - lastStart < interval) {
        await new Promise((resolve) =>
          setTimeout(resolve, interval - (performance.now() - lastStart)),
        );
      }
      lastStart = performance.now();
      upstreamError = undefined;
      try {
        const result = await request(...args);
        if (upstreamError) throw upstreamError;
        const status = [result?.status, result?.body?.code, result?.body?.error_code].map(Number);
        if (status.includes(429)) throw { wildstring_error: 'source_plugin_rate_limited', upstream_429: true, retry_after: 900 };
        if (status.includes(401) || status.includes(403)) throw { wildstring_error: 'source_plugin_auth_or_rejected' };
        return result;
      } catch (error) {
        if (upstreamError) throw upstreamError;
        if (error?.wildstring_error) throw error;
        // NetEase wraps its own rejected answer inside a second 502 answer.
        const status = [error?.response?.status, error?.status, error?.body?.code,
          error?.body?.error_code, error?.body?.msg?.status, error?.body?.msg?.body?.code].map(Number);
        if (status.includes(429)) throw { wildstring_error: 'source_plugin_rate_limited', upstream_429: true, retry_after: 900 };
        if (status.includes(401) || status.includes(403))
          throw { wildstring_error: 'source_plugin_auth_or_rejected' };
        throw error;
      }
    });
    chain = task.catch(() => {});
    return task;
  };
};
