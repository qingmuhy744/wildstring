/** Package selected community modules into the ZIP, with locked dependencies and license notices. */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/web/package.json'));
const { rolldown } = await import(pathToFileURL(require.resolve('rolldown')).href);
const output = path.join(root, '.cache/source-runtimes');
await mkdir(output, { recursive: true });
for (const provider of ['kugou', 'netease']) {
  const build = await rolldown({
    input: path.join(root, `plugins/node-runtime/${provider}.cjs`),
    platform: 'node',
    plugins: [
      {
        name: 'metadata-only',
        resolveId(source) {
          if (source === 'pac-proxy-agent') return '\0metadata-only-pac';
        },
        load(id) {
          if (id === '\0metadata-only-pac')
            return 'exports.PacProxyAgent = class {constructor(){throw new Error("PAC is not supported by this plugin")}}';
          if (provider === 'netease' && /\/module\/register_checktoken_v[23]\.js$/.test(id))
            return 'module.exports = {getToken: async () => {throw new Error("Unsupported plugin operation")}};';
        },
      },
    ],
  });
  await build.write({ file: path.join(output, `${provider}.cjs`), format: 'cjs', minify: true });
  await build.close();
  const notices = [];
  const { readdir } = await import('node:fs/promises');
  const modules = path.join(root, 'plugins/node-runtime/node_modules');
  async function walk(directory, depth = 0) {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        entry.isDirectory() &&
        (depth === 0 || path.basename(directory).startsWith('@') || entry.name === 'node_modules')
      )
        await walk(file, depth + 1);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name))
        notices.push(`\n=== ${path.relative(modules, file)} ===\n${await readFile(file, 'utf8')}`);
    }
  }
  await walk(modules);
  await writeFile(path.join(output, `${provider}-THIRD-PARTY-NOTICES.txt`), notices.join('\n'));
  console.log(`Built ${provider} plugin runtime`);
}
