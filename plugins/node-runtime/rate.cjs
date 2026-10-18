// Every physical request uses the same gate as the Python SDK adapter.
const { spawn } = require('node:child_process');
function gate(data) {
  if (!data.rate) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const [command, ...args] = data.rate_command;
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; if (output.length > 8192) child.kill(); });
    child.on('error', () => reject({ wildstring_error: 'source_plugin_unavailable' }));
    child.on('close', (code) => {
      try {
        const result = JSON.parse(output);
        if (code || !result.ok) reject({ wildstring_error: result.error || 'source_plugin_unavailable' });
        else resolve();
      } catch { reject({ wildstring_error: 'source_plugin_unavailable' }); }
    });
    child.stdin.end(JSON.stringify(data.rate));
  });
}
exports.paced = (data, request) => {
  let chain = Promise.resolve();
  return (...args) => {
    const task = chain.then(async () => {
      await gate(data);
      try { return await request(...args); }
      catch (error) {
        const status = error?.response?.status || error?.status || error?.body?.code;
        if (status === 429) throw { wildstring_error: 'source_plugin_rate_limited' };
        if (status === 401 || status === 403) throw { wildstring_error: 'source_plugin_auth_or_rejected' };
        throw error;
      }
    });
    chain = task.catch(() => {});
    return task;
  };
};
