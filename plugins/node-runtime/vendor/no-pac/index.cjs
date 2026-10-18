// These metadata providers support explicit HTTP(S) proxies; they never execute PAC.
exports.PacProxyAgent = class {
  constructor() {
    throw new Error('PAC is not supported by this plugin');
  }
};
