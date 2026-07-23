'use strict';

// Zero-dependency static file server for the frontend build.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Player/team images never change in place (a new player only ever adds a
// new filename), so they can be cached hard — without this, every DOM
// rebuild that recreates an <img> (e.g. picking a player's role re-renders
// the whole squad list) forces a real network re-fetch of every card photo
// instead of an instant cache hit. HTML/JS/CSS aren't content-hashed, so
// they stay revalidate-on-use (via Last-Modified/304s) so a deploy is
// visible immediately instead of being masked by a stale cache.
const LONG_CACHE_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico']);

const server = http.createServer((req, res) => {
  const reqPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, reqPath === '/' ? 'index.html' : reqPath);

  // prevent path traversal outside the frontend root
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      // SPA-style fallback: unknown paths serve index.html
      return fs.readFile(path.join(ROOT, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
    }

    const ext = path.extname(filePath).toLowerCase();
    const lastModified = stat.mtime.toUTCString();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Last-Modified': lastModified,
    };
    headers['Cache-Control'] = LONG_CACHE_EXT.has(ext)
      ? 'public, max-age=2592000, immutable' // 30 days
      : 'no-cache'; // always revalidate so deploys take effect right away

    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, headers);
      return res.end();
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[frontend] serving ${ROOT} on http://localhost:${PORT}`);
});
