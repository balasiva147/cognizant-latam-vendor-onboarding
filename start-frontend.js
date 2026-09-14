// Serve only public UI files. Never expose server/.env or server/uploads.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/auth-ui.js', 'auth-ui.js']]);
function handler(req, res) {
  const file = files.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
}
if (require.main === module) http.createServer(handler).listen(8765, '127.0.0.1', () => console.log('Frontend: http://127.0.0.1:8765/'));
module.exports = { handler };
