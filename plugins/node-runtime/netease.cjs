// The upstream reads anonymous state at module load; isolate it inside this plugin's state dir.
const fs = require('fs');
const path = require('path');
const root = require('os').tmpdir();
if (!fs.existsSync(path.join(root, 'anonymous_token')))
  fs.writeFileSync(path.join(root, 'anonymous_token'), '');
global.deviceId = 'WildStringSourcePlugin';
console.log = console.info = console.warn = console.error = () => {};
const request = require('@wildstring/netease-metadata/util/request');
const { paced } = require('./rate.cjs');
const methods = {
  '/cloudsearch': require('@wildstring/netease-metadata/module/cloudsearch'),
  '/song/detail': require('@wildstring/netease-metadata/module/song_detail'),
  '/album': require('@wildstring/netease-metadata/module/album'),
  '/lyric/new': require('@wildstring/netease-metadata/module/lyric_new'),
};
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
    const result = await method({ ...data.parameters, cookie, timeout: 12000 }, paced(data, request));
    process.stdout.write(JSON.stringify(result.body));
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify(error?.wildstring_error ? error : { code: 502 }));
    process.exit(0);
  }
});
