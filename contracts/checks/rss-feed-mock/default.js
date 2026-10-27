// Offline RSS 2.0 dependency used by the real subscription integration check.
const http = require('http');
http.createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/feed.xml') {
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return response.end('<rss version="2.0"><channel><title>Local RSS integration</title><description>Disposable feed</description><link>http://rss.wildstring.test/</link><item><guid>rss-fixture-1</guid><title>First episode</title><enclosure url="https://audio.example.com/fixture.mp3" length="10" type="audio/mpeg"/></item></channel></rss>');
  }
  if (request.method === 'GET' && path === '/policies.xml') {
    const items = [6, 5, 4, 3, 2, 1].map((n) => `<item><guid>policy-${n}</guid><title>Episode ${n}</title><pubDate>0${n} Oct 2026 12:00:00 GMT</pubDate><enclosure url="http://rss.wildstring.test/audio/${n}.mp3" type="audio/mpeg"/></item>`).join('');
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return response.end(`<rss version="2.0"><channel><title>Personal policy integration</title><description>Disposable feed</description>${items}</channel></rss>`);
  }
  if (request.method === 'GET' && /^\/audio\/[1-6]\.mp3$/.test(path)) {
    // Synthetic transport bytes exercise shared storage, not audio codec decoding.
    const bytes = Buffer.from('ID3-WildString-disposable-audio-' + path);
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.length });
    return response.end(bytes);
  }
  if (request.method === 'GET' && path === '/broken.xml') {
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return response.end('<rss>');
  }
  response.writeHead(501);
  response.end('Path outside this RSS fixture');
}).listen(process.env.PORT || 4500, '127.0.0.1');
