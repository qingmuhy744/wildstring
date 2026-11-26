const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { parsers } = require('../frontend/web/node_modules/prettier/plugins/babel');

function referencesIn(text, path) {
  const references = [];
  const ast = parsers['babel-ts'].parse(text, { filepath: path });
  function visit(node) {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee;
      const key = node.arguments[0];
      if (callee.type === 'Identifier' && callee.name === 't') {
        if (key?.type === 'StringLiteral') {
          references.push([path, key.loc.start.line, key.value]);
        } else if (key?.type === 'TemplateLiteral' && !key.expressions.length) {
          references.push([path, key.loc.start.line, key.quasis[0].value.cooked]);
        }
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) visit(item);
      } else if (child?.type) visit(child);
    }
  }
  visit(ast);
  return references;
}

if (require.main === module) {
  const directory = process.argv[2];
  const references = readdirSync(directory, { recursive: true })
    .filter((name) => /\.tsx?$/.test(name))
    .flatMap((name) => {
      const path = join(directory, name);
      return referencesIn(readFileSync(path, 'utf8'), path);
    });
  process.stdout.write(JSON.stringify(references));
}
module.exports = { referencesIn };
