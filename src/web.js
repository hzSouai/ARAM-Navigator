'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { requestBuffer } = require('./lcu');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const ICON_CACHE = new Map();

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
]);

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        reject(new Error('请求体太大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error('JSON 格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function sse(req, res, runtime) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  runtime.listeners.add(res);
  if (runtime.status) {
    res.write(`event: status\ndata: ${JSON.stringify(runtime.status)}\n\n`);
  }
  const close = () => runtime.listeners.delete(res);
  req.on('close', close);
  res.on('close', close);
}

async function championIcon(res, runtime, id) {
  if (!Number.isInteger(id) || id <= 0) {
    sendText(res, 400, 'bad champion id');
    return;
  }

  const cached = ICON_CACHE.get(id);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': cached.type,
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': cached.body.length,
    });
    res.end(cached.body);
    return;
  }

  if (!runtime.client) {
    sendText(res, 404, 'client not connected');
    return;
  }

  const entry = runtime.catalog.find((champion) => champion.id === id);
  const iconPath =
    entry?.icon && entry.icon.startsWith('/lol-game-data/')
      ? entry.icon
      : `/lol-game-data/assets/v1/champion-icons/${id}.png`;

  let result;
  try {
    result = await requestBuffer(runtime.client, iconPath);
  } catch {
    sendText(res, 404, 'icon unavailable');
    return;
  }

  if (result.status !== 200 || result.body.length === 0) {
    sendText(res, 404, 'icon unavailable');
    return;
  }
  if (result.contentType.includes('json')) {
    sendText(res, 404, 'icon unavailable');
    return;
  }

  ICON_CACHE.set(id, { body: result.body, type: result.contentType });
  if (ICON_CACHE.size > 300) {
    ICON_CACHE.delete(ICON_CACHE.keys().next().value);
  }

  res.writeHead(200, {
    'Content-Type': result.contentType,
    'Cache-Control': 'public, max-age=86400',
    'Content-Length': result.body.length,
  });
  res.end(result.body);
}

async function handleRequest(req, res, runtime, log) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (pathname === '/api/events' && req.method === 'GET') {
    sse(req, res, runtime);
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, runtime.status || { connected: false });
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    if (!runtime.lastSession) {
      sendJson(res, 404, { ok: false, message: '当前不在选人阶段' });
    } else {
      sendJson(res, 200, runtime.lastSession);
    }
    return;
  }

  if (pathname === '/api/log' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const logs = runtime.logs.filter((entry) => entry.seq > since);
    sendJson(res, 200, { logs });
    return;
  }

  if (pathname === '/api/champions' && req.method === 'GET') {
    sendJson(res, 200, runtime.catalog);
    return;
  }

  if (pathname === '/api/friends' && req.method === 'GET') {
    const result = await runtime.getFriends();
    sendJson(res, result.ok ? 200 : 503, result);
    return;
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await runtime.joinFriendLobby(body.partyId);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (pathname === '/api/leave-lobby' && req.method === 'POST') {
    const result = await runtime.leaveLobby();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (pathname === '/api/trade-accept' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await runtime.acceptTrade(body.tradeId);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, runtime.config);
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readJson(req);
    const config = runtime.applyConfig(body);
    sendJson(res, 200, { ok: true, config });
    return;
  }

  if (pathname === '/api/pause' && req.method === 'POST') {
    const body = await readJson(req);
    const paused = runtime.setPaused(Boolean(body.paused));
    sendJson(res, 200, { ok: true, paused });
    return;
  }

  if (pathname === '/api/swap' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await runtime.manualSwap(Number(body.championId));
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (pathname === '/api/open-logs' && req.method === 'POST') {
    sendJson(res, 200, runtime.openLogs());
    return;
  }

  if (pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    runtime.shutdown();
    return;
  }

  const iconMatch = /^\/api\/champion-icon\/(\d+)$/.exec(pathname);
  if (iconMatch && req.method === 'GET') {
    await championIcon(res, runtime, Number(iconMatch[1]));
    return;
  }

  const staticFile = STATIC_FILES.get(pathname);
  if (staticFile && req.method === 'GET') {
    const [file, type] = staticFile;
    try {
      const body = await fs.promises.readFile(path.join(WEB_ROOT, file));
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'Content-Length': body.length,
      });
      res.end(body);
    } catch {
      sendText(res, 500, 'web assets missing');
    }
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  sendText(res, 404, 'not found');
}

function startWebServer(runtime, log) {
  return new Promise((resolve, reject) => {
    const port = runtime.config.webPort || 8765;
    const server = http.createServer((req, res) => {
      handleRequest(req, res, runtime, log).catch((error) => {
        log(`网页请求出错: ${error.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, message: error.message });
        } else {
          res.end();
        }
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`网页控制台已启动: http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

module.exports = { startWebServer };
