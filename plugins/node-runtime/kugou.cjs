// Only metadata and lyrics endpoints are included in this provider-owned executable bundle.
const request = require('kugou-upstream/util/request').createRequest;
const methods = {
  '/search': require('kugou-upstream/module/search'),
  '/krm/audio': require('kugou-upstream/module/krm_audio'),
  '/search/lyric': require('kugou-upstream/module/search_lyric'),
  '/lyric': require('kugou-upstream/module/lyric'),
};
console.log = console.info = console.warn = console.error = () => {};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 100000) process.exit(1);
});
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const method = methods[data.path];
    if (!method) throw Error('method');
    const cookie = Object.fromEntries(
      (data.cookie || '')
        .split(';')
        .filter((v) => v.includes('='))
        .map((v) => {
          const i = v.indexOf('=');
          return [v.slice(0, i).trim(), v.slice(i + 1).trim()];
        }),
    );
    const result = await method({ ...data.parameters, cookie }, (options) =>
      request({ ...options, timeout: 12000 }),
    );
    process.stdout.write(JSON.stringify(result.body));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({ error_code: 1 }));
    process.exit(0);
  }
});
