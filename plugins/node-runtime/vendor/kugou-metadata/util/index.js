const { appid, clientver } = require('./config.json');
module.exports = { appid, clientver, decodeLyrics: require('./util').decodeLyrics };
