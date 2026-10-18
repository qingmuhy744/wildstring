const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, publicEncrypt, privateDecrypt, constants } = require('node:crypto');
const rsa = require('../vendor/native-rsa/index.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

test('provider subsets match their reviewed provenance and contain no Forge or FTP packages', () => {
  for (const provider of ['kugou', 'netease']) {
    const root = path.join(__dirname, '../vendor', provider + '-metadata');
    const provenance = JSON.parse(fs.readFileSync(path.join(root, 'UPSTREAM.json'), 'utf8'));
    for (const [name, expected] of Object.entries(provenance.files))
      assert.equal(
        createHash('sha256')
          .update(fs.readFileSync(path.join(root, name)))
          .digest('hex'),
        expected,
        name,
      );
  }
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  assert.equal(
    Object.keys(lock.packages).some((name) =>
      /node_modules\/(?:node-forge|basic-ftp|pac-proxy-agent)$/.test(name),
    ),
    false,
  );
});
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });

test('NetEase raw RSA pads on the left and preserves binary bytes', () => {
  const input = Buffer.from([0, 0xff, 0x80, 0x41]);
  const padded = Buffer.alloc(256);
  input.copy(padded, padded.length - input.length);
  const encrypted = rsa.pki.publicKeyFromPem(pem).encrypt(input.toString('latin1'), 'NONE');
  assert.deepEqual(
    Buffer.from(encrypted, 'latin1'),
    publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, padded),
  );
});

test('KuGou raw RSA preserves its right-padded protocol representation', () => {
  const upstream = require('@wildstring/kugou-metadata/util/crypto');
  const input = Buffer.from('WildString 中文', 'utf8');
  const padded = Buffer.alloc(256);
  input.copy(padded);
  assert.equal(
    upstream.cryptoRSAEncrypt(input, pem),
    publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, padded).toString('hex'),
  );
});

test('PKCS#1 v1.5 encryption has valid randomized padding and unchanged data', () => {
  const input = Buffer.from([0, 0xff, 0x80, 0x41]);
  const key = rsa.pki.publicKeyFromPem(pem);
  const encrypted = Buffer.from(
    key.encrypt(input.toString('latin1'), 'RSAES-PKCS1-V1_5'),
    'latin1',
  );
  const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted);
  assert.equal(block[0], 0);
  assert.equal(block[1], 2);
  const separator = block.indexOf(0, 2);
  assert.ok(separator >= 10);
  assert.deepEqual(block.subarray(separator + 1), input);
  assert.notDeepEqual(encrypted, Buffer.from(key.encrypt(input.toString('latin1')), 'latin1'));
});

test('KuGou OAEP uses SHA-256 for both the message and mask hash', () => {
  const key = rsa.pki.publicKeyFromPem(pem);
  const options = { md: rsa.md.sha256.create(), mgf1: { md: rsa.md.sha256.create() } };
  const encrypted = Buffer.from(key.encrypt('0123456789abcdef', 'RSA-OAEP', options), 'latin1');
  assert.equal(
    privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encrypted,
    ).toString(),
    '0123456789abcdef',
  );
  assert.throws(() =>
    key.encrypt('x', 'RSA-OAEP', {
      md: { algorithm: 'sha256' },
      mgf1: { md: { algorithm: 'sha1' } },
    }),
  );
});

test('unsupported cryptographic and PAC operations fail closed', () => {
  const key = rsa.pki.publicKeyFromPem(pem);
  assert.equal(key.verify, undefined);
  assert.equal(rsa.pki.certificateFromPem, undefined);
  assert.throws(() => key.encrypt('x', 'unsupported'));
  assert.throws(() => key.encrypt('x'.repeat(257), 'NONE'));
  const { PacProxyAgent } = require('../vendor/no-pac/index.cjs');
  assert.throws(() => new PacProxyAgent('pac+http://example.invalid'), /not supported/);
});

test('NetEase metadata encryption still produces protocol-shaped results', () => {
  const crypto = require('@wildstring/netease-metadata/util/crypto');
  const result = crypto.weapi({ s: '许巍', type: 1, limit: 3 });
  assert.match(result.encSecKey, /^[0-9a-f]{256}$/);
  assert.ok(result.params.length > 20);
});
