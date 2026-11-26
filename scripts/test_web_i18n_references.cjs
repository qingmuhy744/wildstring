const assert = require('node:assert/strict');
const test = require('node:test');
const { referencesIn } = require('./web_i18n_references.cjs');

test('checks literal keys in TSX and ignores comments, text, and dynamic keys', () => {
  const code = [
    "const text = \"t('plain.text')\"; // t('comment.key')",
    "const view = <p>{t('common.title', { count: 2 })}</p>;",
    'i18n.t("unknown.key");',
    't(`static.template`);',
    't(`dynamic.${text}`);',
    "t('dynamic.' + text);",
  ].join('\n');
  assert.deepEqual(referencesIn(code, 'example.tsx'), [
    ['example.tsx', 2, 'common.title'],
    ['example.tsx', 3, 'unknown.key'],
    ['example.tsx', 4, 'static.template'],
  ]);
});
