// Provider compatibility surface backed entirely by Node/OpenSSL public-key encryption.
// Deliberately no certificate parsing, signature verification or private-key operations.
const { createPublicKey, publicEncrypt, constants } = require('node:crypto');

function unsignedHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

class PublicInteger {
  constructor(hex, radix = 16) {
    if (radix !== 16) throw new Error('Only hexadecimal public integers are supported');
    this.value = BigInt('0x' + (hex || '0'));
  }
  bitLength() {
    return this.value.toString(2).length;
  }
  toString(radix) {
    return this.value.toString(radix);
  }
  modPow(exponent, modulus) {
    const key = createPublicKey({
      key: {
        kty: 'RSA',
        n: unsignedHex(modulus.value).toString('base64url'),
        e: unsignedHex(exponent.value).toString('base64url'),
      },
      format: 'jwk',
    });
    const size = Math.ceil(modulus.bitLength() / 8);
    const input = unsignedHex(this.value);
    if (input.length > size) throw new Error('Data length exceeds key size');
    const padded = Buffer.alloc(size);
    input.copy(padded, size - input.length);
    return new PublicInteger(
      publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded).toString('hex'),
    );
  }
}

function publicKeyFromPem(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('Only RSA public keys are supported');
  const jwk = key.export({ format: 'jwk' });
  const integer = (value) => new PublicInteger(Buffer.from(value, 'base64url').toString('hex'));
  const n = integer(jwk.n);
  return {
    n,
    e: integer(jwk.e),
    encrypt(binary, scheme = 'RSAES-PKCS1-V1_5', options = {}) {
      let input = Buffer.from(binary, 'latin1');
      let padding;
      let oaepHash;
      if (scheme === 'NONE' || scheme === 'RAW') {
        padding = constants.RSA_NO_PADDING;
        const size = Math.ceil(n.bitLength() / 8);
        if (input.length > size) throw new Error('Data length exceeds key size');
        input = Buffer.concat([Buffer.alloc(size - input.length), input]);
      } else if (scheme === 'RSAES-PKCS1-V1_5') {
        padding = constants.RSA_PKCS1_PADDING;
      } else if (scheme === 'RSA-OAEP') {
        padding = constants.RSA_PKCS1_OAEP_PADDING;
        oaepHash = options.md?.algorithm || 'sha1';
        if (options.mgf1?.md && options.mgf1.md.algorithm !== oaepHash)
          throw new Error('Independent MGF1 hashes are not supported');
      } else throw new Error('Unsupported RSA encryption scheme');
      return publicEncrypt({ key, padding, oaepHash }, input).toString('latin1');
    },
  };
}

module.exports = {
  pki: { publicKeyFromPem },
  jsbn: { BigInteger: PublicInteger },
  util: {
    bytesToHex: (bytes) => Buffer.from(bytes, 'latin1').toString('hex'),
    encode64: (bytes) => Buffer.from(bytes, 'latin1').toString('base64'),
  },
  md: { sha256: { create: () => ({ algorithm: 'sha256' }) } },
};
