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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The three-card screen ("选择你的英雄") is client-local: LCU knows nothing
// about it. A Pengu Loader plugin reads the client DOM and posts the visible
// champion names here; we turn them into the card list shown on the web page.
function deriveClientCards(body, runtime) {
  const names = runtime.names;
  if (!names || names.size === 0) return [];
  const nameToId = new Map(
    [...names.entries()].map(([id, name]) => [name, Number(id)]),
  );

  // The client screen lists the cards right after the heading. This is more
  // reliable than the scanned backgrounds, because the visible bench (5 champs)
  // also has champion backgrounds and must not be mistaken for the cards.
  const text = String(body.bodyText || '');
  const headingAt = text.indexOf('选择你的英雄');
  if (headingAt >= 0) {
    const after = text.slice(headingAt + '选择你的英雄'.length);
    const pattern = new RegExp(
      [...nameToId.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|'),
      'g',
    );

    const found = [];
    const seen = new Set();
    let match;
    while ((match = pattern.exec(after)) && found.length < 3) {
      const name = match[0];
      const id = nameToId.get(name);
      if (id && !seen.has(id)) {
        seen.add(id);
        found.push({ id, name });
      }
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
    const nonCards = knownNonCardNames(runtime);
    while (found.length > 1 && nonCards.has(found[found.length - 1].name)) {
      found.pop();
    }
    if (found.length >= 1) return found;
  }

  // Fallback: use card entries only when they carry a real champion name.
  const rawCards = Array.isArray(body.cards) ? body.cards : [];
  const valid = rawCards
    .map((card) => ({
      id: Number(card.id),
      name: String(card.name || '').trim(),
    }))
    .filter((card) => Number.isInteger(card.id) && card.id > 0 && nameToId.has(card.name));
  if (valid.length >= 2 && valid.length <= 4) {
    const seen = new Set();
    return valid.filter((card) => {
      if (seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  }
  return [];
}

// On a two-card version of the screen, the text right after the heading is
// "card A card B teammate". The teammate can be in the wishlist (e.g. 海洋之灾),
// so never treat a known non-card name as the third card.
function knownNonCardNames(runtime) {
  const names = new Set();
  const session = runtime.lastSession;
  if (!session || !Array.isArray(session.myTeam)) return names;
  const localCell = session.localPlayerCellId;
  for (const player of session.myTeam) {
    const championId = Number(player.championId);
    if (!championId) continue;
    if (player.cellId !== localCell) {
      const name = runtime.names.get(championId);
      if (name) names.add(name);
    }
  }
  const localPlayer = session.myTeam.find((player) => player.cellId === localCell);
  const localName = runtime.names.get(Number(localPlayer?.championId));
  if (localName) names.add(localName);
  return names;
}

function queueClientCardCommand(runtime, card, source, log) {
  runtime.pluginCommands = Array.isArray(runtime.pluginCommands)
    ? runtime.pluginCommands
    : [];
  const command = {
    id: Number(card.id),
    name: String(card.name || ''),
    index: Number(card.index) || 0,
    source,
    at: Date.now(),
  };
  runtime.pluginCommands.push(command);
  runtime.lastCardCommand = command;
  log(
    `[PLUGIN] 请求代选客户端卡片: ${command.name}(${command.id}) [${
      source === 'auto' ? '自动' : '网页'
    }]`,
  );
  return command;
}

// When the client-local three-card screen includes a wishlist champion, queue
// the click immediately. The screen is short-lived, so waiting for a web click
// often runs out of time.
function maybeAutoPickClientCard(runtime, cards, log) {
  if (!cards.length) return;
  const config = runtime.config;
  if (!config || config.autoPickClientCard === false) return;
  if (runtime.paused) return;
  if (!runtime.lastSession && runtime.gameflowPhase !== 'ChampSelect') return;

  const rank = new Map();
  for (const [index, id] of (config.wishlist || []).entries()) {
    const name = runtime.names.get(Number(id));
    if (name && !rank.has(name)) rank.set(name, index);
  }
  let best = null;
  for (const card of cards) {
    const position = rank.get(card.name);
    if (position !== undefined && (!best || position < best.rank)) {
      best = { card, rank: position };
    }
  }
  if (!best) return;

  const gameId = runtime.lastSession?.gameId || 0;
  const marker = `${gameId}|${cards
    .map((card) => card.name)
    .sort()
    .join('|')}`;
  if (runtime.lastAutoCardMarker === marker) return;
  runtime.lastAutoCardMarker = marker;

  if (config.dryRun) {
    log(
      `[DRY] 客户端三选一出现心愿英雄 ${best.card.name}（优先级 #${
        best.rank + 1
      }），练习模式不代选`,
    );
    return;
  }
  log(
    `[AUTO] 客户端三选一出现心愿英雄 ${best.card.name}（优先级 #${best.rank + 1}）`,
  );
  queueClientCardCommand(runtime, best.card, 'auto', log);
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

  if (pathname.startsWith('/api/plugin/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    sse(req, res, runtime);
    return;
  }

  if (pathname === '/api/plugin/cards' && req.method === 'POST') {
    const body = await readJson(req);
    runtime.cardProbe = body;
    runtime.pluginLastSeenAt = Date.now();
    const cards = deriveClientCards(body, runtime);
    runtime.clientCards = cards;
    runtime.clientCardsAt = Date.now();
    try {
      const dir = path.resolve(__dirname, '..', 'logs');
      const file = path.join(dir, `card-probe-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      const cardText = cards.map((card) => card.name).join(' / ');
      log(
        `[PLUGIN] 三选一探测: heading=${body.heading || '?'} cards=${
          Array.isArray(body.cards) ? body.cards.length : 0
        } entries=${Array.isArray(body.entries) ? body.entries.length : 0}${
          cardText ? ` · 识别: ${cardText}` : ''
        } -> ${path.basename(file)}`,
      );
      if (cards.length) {
        log(`[PLUGIN] 网页可代选: ${cards.map((card) => card.name).join(' / ')}`);
      }
    } catch (error) {
      log(`[WARN] 保存三选一探测失败: ${error.message}`);
    }
    try {
      maybeAutoPickClientCard(runtime, cards, log);
    } catch (error) {
      log(`[WARN] 自动代选客户端卡片失败: ${error.message}`);
    }
    sendJson(res, 200, { ok: true, cards });
    return;
  }

  if (pathname === '/api/plugin/commands' && req.method === 'GET') {
    runtime.pluginLastSeenAt = Date.now();
    const version = String(url.searchParams.get('v') || '').trim();
    if (version) runtime.pluginVersion = version;
    const commands = Array.isArray(runtime.pluginCommands)
      ? runtime.pluginCommands.splice(0)
      : [];
    sendJson(res, 200, { commands });
    return;
  }

  if (pathname === '/api/plugin/result' && req.method === 'POST') {
    const body = await readJson(req);
    runtime.lastPluginResult = { ...body, at: Date.now() };
    runtime.pluginLastSeenAt = Date.now();
    if (body.type === 'hello') {
      if (body.version) runtime.pluginVersion = String(body.version);
      log(`[PLUGIN] 客户端插件已加载: v${body.version || '?'}`);
    } else {
      log(`[PLUGIN] 客户端代选结果: ${JSON.stringify(body).slice(0, 300)}`);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/client-card-select' && req.method === 'POST') {
    const body = await readJson(req);
    const id = Number(body.id);
    const name = String(body.name || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !name) {
      sendJson(res, 400, { ok: false, message: '缺少要选择的英雄喵' });
      return;
    }
    queueClientCardCommand(
      runtime,
      { id, name, index: Number(body.index) || 0 },
      'web',
      log,
    );
    sendJson(res, 200, { ok: true, queued: runtime.pluginCommands.length });
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

  if (pathname === '/api/create-lobby' && req.method === 'POST') {
    const result = await runtime.createHextechLobby();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (pathname === '/api/find-match' && req.method === 'POST') {
    const result = await runtime.findMatch();
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
