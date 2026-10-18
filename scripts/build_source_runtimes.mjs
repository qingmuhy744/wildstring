/** Package selected community modules into the ZIP, with locked dependencies and license notices. */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
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
      if (entry.isSymbolicLink()) {
        const target = await realpath(file);
        if (target.startsWith(path.join(root, 'plugins/node-runtime/vendor') + path.sep))
          await walk(file, depth + 1);
        continue;
      }
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
