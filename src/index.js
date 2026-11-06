'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const {
  discoverClient,
  getChampSelectSession,
  getChampionCatalog,
  request,
} = require('./lcu');
const {
  chooseBenchTarget,
  isPhaseAllowed,
  normalizeWishlist,
  sessionInfo,
  shouldAcceptReadyCheck,
} = require('./logic');
const { startWebServer } = require('./web');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
  now.getDate(),
).padStart(2, '0')}`;
const LOG_PATH = path.join(LOG_DIR, `helper-${TODAY}.log`);

const FALLBACK_WISHLIST = [145, 136, 22, 17, 4, 110, 21, 202, 90, 41, 245, 235, 81];

const DEFAULTS = {
  clientDir: 'E:\\Program Files (x86)\\LOL(26)\\LeagueClient',
  lockfilePath: '',
  wishlist: FALLBACK_WISHLIST,
  pollMs: 300,
  startupDelayMs: 2500,
  stablePolls: 4,
  allowedPhases: ['BAN_PICK', 'FINALIZATION'],
  minTimeLeftMs: 1000,
  verifyDelayMs: 350,
  retryDelayMs: 600,
  maxRetries: 12,
  maxSwapsPerGame: 24,
  dryRun: false,
  webPort: 8765,
  autoPlayAgain: true,
  autoAccept: true,
  autoSelectCandidate: true,
  benchBurstMode: true,
  acceptDelayMs: 1500,
  playAgainDelayMs: 3000,
};

let logSeq = 0;

// Hextech ARAM burst: pre-fire 1s before finalization, high frequency for the
// first 3s, slow down for 2 more seconds, then stop.
const BURST_PRE_MS = 1000;
const BURST_HIGH_MS = 3000;
const BURST_SLOW_MS = 2000;
const BURST_HIGH_EVERY_MS = 300;
const BURST_SLOW_EVERY_MS = 800;

function freshState() {
  return {
    gameId: null,
    seenAt: 0,
    stableKey: '',
    stableCount: 0,
    lastLoggedKey: '',
    attempts: new Map(),
    lastAttemptAt: 0,
    swaps: 0,
    exhausted: new Set(),
    snapshotKey: '',
    snapshotCount: 0,
    finalWaitLogged: false,
    finalNear5Logged: false,
    finalNear1Logged: false,
    burstActive: false,
    burstFinalizationAt: 0,
    burstPreFireAt: 0,
    burstTarget: 0,
    burstLastPostAt: 0,
    burstPosts: 0,
    burstEndLogged: false,
    burstDone: false,
  };
}

function resetState(state) {
  const fresh = freshState();
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
  return state;
}

const runtime = {
  config: null,
  client: null,
  catalog: [],
  names: new Map(),
  state: freshState(),
  lastSession: null,
  status: null,
  statusKey: '',
  logs: [],
  listeners: new Set(),
  paused: false,
  lastAction: null,
  startedAt: Date.now(),
  server: null,
  warnedAboutWiner: false,
  gameflowPhase: null,
  lastGameflowAt: 0,
  inLobby: false,
  lobby: null,
  presence: null,
  lastPresenceAt: 0,
  playAgainPending: false,
  playAgainAttempts: 0,
  lastPlayAgainAt: 0,
  acceptPending: false,
};

function detectLevel(message) {
  const text = String(message);
  if (text.includes('[WARN]') || text.includes('失败') || text.includes('出错')) return 'warn';
  if (text.includes('[OK]') || text.includes('已确认')) return 'ok';
  if (text.includes('[DRY]')) return 'dry';
  return 'info';
}

function log(message, level = detectLevel(message)) {
  const entry = {
    seq: ++logSeq,
    at: Date.now(),
    level,
    message: String(message),
  };
  const line = `[${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${entry.message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // Logging must never take the tool down.
  }
  runtime.logs.push(entry);
  if (runtime.logs.length > 800) runtime.logs.splice(0, runtime.logs.length - 800);
  broadcast('log', entry);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of [...runtime.listeners]) {
    try {
      listener.write(payload);
    } catch {
      runtime.listeners.delete(listener);
    }
  }
}

function timelinePathForNow() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  return path.join(LOG_DIR, `timeline-${day}.log`);
}

/** Detailed per-poll champ-select timeline, used to inspect unusual choice flows. */
function timelineLog(session, info) {
  try {
    const at = new Date();
    const time = `${at.toLocaleTimeString('zh-CN', { hour12: false })}.${String(
      at.getMilliseconds(),
    ).padStart(3, '0')}`;
    const localCell = session.localPlayerCellId;
    const localActions = (session.actions || [])
      .flat()
      .filter((action) => action && action.actorCellId === localCell)
      .map(
        (action) =>
          `#${action.id} ${action.type} champ=${action.championId} ${
            action.completed ? 'completed' : 'pending'
          }${action.isInProgress ? ' inProgress' : ''}`,
      );
    const trades = (session.trades || [])
      .filter((trade) => trade && String(trade.state || '').toUpperCase() !== 'NONE')
      .map((trade) => {
        const mate = (session.myTeam || []).find(
          (player) => player.cellId === trade.cellId,
        );
        return `#${trade.id} cell${trade.cellId} ${trade.state} champ=${
          mate?.championId ?? '?'
        }(${nameOf(mate?.championId)})`;
      });
    const bench = (session.benchChampions || []).map(
      (champion) =>
        `${champion.championId}(${nameOf(champion.championId)})${
          champion.isPriority ? '*' : ''
        }`,
    );
    const candidates = (info.candidates || []).map(
      (championId) => `${championId}(${nameOf(championId)})`,
    );
    const line = `[${time}] game=${session.gameId} queue=${
      session.queueId
    } phase=${info.phase} left=${info.timeLeft}ms total=${
      session.timer?.totalTimeInPhase ?? '?'
    } held=${info.held}(${nameOf(info.held)}) intent=${
      info.pickIntent
    } bench=[${bench.join(', ')}] candidates=[${candidates.join(
      ', ',
    )}] trades=[${trades.join(', ')}] actions=[${localActions.join(', ')}]`;
    fs.appendFileSync(timelinePathForNow(), line + '\n');
  } catch {
    // A timeline write must never take the tool down.
  }
}

/** Keep a raw LCU champ-select snapshot for debugging unusual choice screens. */
function saveSessionSnapshot(session, reason) {
  try {
    const dir = path.join(LOG_DIR, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `session-${session.gameId || 'unknown'}-${Date.now()}.json`,
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ reason, at: new Date().toISOString(), session }, null, 2),
    );
    log(`已保存选人会话快照: ${path.basename(file)}`);
  } catch (error) {
    log(`[WARN] 保存选人会话快照失败: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function winerWishlist() {
  try {
    const settingsPath = path.join(
      process.env.APPDATA || '',
      'app.winer.desktop',
      'settings.json',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const list = settings?.automation?.bench?.champions;
    if (Array.isArray(list) && list.length > 0) return normalizeWishlist(list);
  } catch {
    // winer is optional.
  }
  return FALLBACK_WISHLIST;
}

function winerBenchAutoEnabled() {
  try {
    const settingsPath = path.join(
      process.env.APPDATA || '',
      'app.winer.desktop',
      'settings.json',
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return Boolean(settings?.automation?.bench?.enabled);
  } catch {
    return false;
  }
}

function isWinerRunning() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq winer.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
      .toLowerCase()
      .includes('winer.exe');
  } catch {
    return false;
  }
}

function normalizeConfig(parsed) {
  const config = { ...DEFAULTS, ...parsed };
  config.wishlist = normalizeWishlist(config.wishlist).slice(0, 20);
  config.pollMs = clampNumber(config.pollMs, 100, 5000, DEFAULTS.pollMs);
  config.startupDelayMs = clampNumber(
    config.startupDelayMs,
    0,
    60000,
    DEFAULTS.startupDelayMs,
  );
  config.stablePolls = clampNumber(config.stablePolls, 1, 100, DEFAULTS.stablePolls);
  config.minTimeLeftMs = clampNumber(
    config.minTimeLeftMs,
    0,
    120000,
    DEFAULTS.minTimeLeftMs,
  );
  config.verifyDelayMs = clampNumber(
    config.verifyDelayMs,
    100,
    5000,
    DEFAULTS.verifyDelayMs,
  );
  config.retryDelayMs = clampNumber(
    config.retryDelayMs,
    200,
    30000,
    DEFAULTS.retryDelayMs,
  );
  config.maxRetries = clampNumber(config.maxRetries, 1, 20, DEFAULTS.maxRetries);
  config.maxSwapsPerGame = clampNumber(
    config.maxSwapsPerGame,
    1,
    100,
    DEFAULTS.maxSwapsPerGame,
  );
  config.webPort = clampNumber(config.webPort, 1024, 65535, DEFAULTS.webPort);
  config.allowedPhases = Array.isArray(config.allowedPhases)
    ? config.allowedPhases.map(String)
    : DEFAULTS.allowedPhases;
  config.dryRun = Boolean(config.dryRun);
  config.autoPlayAgain = Boolean(config.autoPlayAgain);
  config.autoAccept = Boolean(config.autoAccept);
  config.autoSelectCandidate = Boolean(config.autoSelectCandidate);
  config.benchBurstMode = Boolean(config.benchBurstMode);
  config.acceptDelayMs = clampNumber(
    config.acceptDelayMs,
    0,
    10000,
    DEFAULTS.acceptDelayMs,
  );
  config.playAgainDelayMs = clampNumber(
    config.playAgainDelayMs,
    0,
    30000,
    DEFAULTS.playAgainDelayMs,
  );
  return config;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    const initial = normalizeConfig({ ...DEFAULTS, wishlist: winerWishlist() });
    fs.writeFileSync(configPath, JSON.stringify(initial, null, 2) + '\n', 'utf8');
    log(`未找到配置，已生成 ${configPath}`);
    return initial;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`config.json 解析失败: ${error.message}`);
  }
  return normalizeConfig(parsed);
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (error) {
    log(`[WARN] 保存配置失败: ${error.message}`);
  }
}

function nameOf(id) {
  const number = Number(id);
  return runtime.names.get(number) || String(number || '--');
}

function champRef(id) {
  const number = Number(id);
  return { id: number, name: nameOf(number) };
}

function buildStatus() {
  const session = runtime.lastSession;
  const info = session ? sessionInfo(session) : null;
  const config = runtime.config;
  return {
    connected: Boolean(runtime.client),
    paused: runtime.paused,
    dryRun: Boolean(config.dryRun),
    phase: info?.phase ?? null,
    gameflowPhase: runtime.gameflowPhase,
    held: info && info.held > 0 ? champRef(info.held) : null,
    bench: info ? info.bench.map(champRef) : [],
    candidates: info ? info.candidates.map(champRef) : [],
    trades: info
      ? info.trades.map((trade) => ({
          ...champRef(trade.championId),
          tradeId: trade.tradeId,
          cellId: trade.cellId,
        }))
      : [],
    wishlist: (config.wishlist || []).map(champRef),
    queueId: session?.queueId ?? null,
    gameId: session?.gameId ?? null,
    timeLeft: info?.timeLeft ?? null,
    isInfinite: info?.isInfinite ?? false,
    lastAction: runtime.lastAction,
    presence: runtime.presence,
    inLobby: Boolean(runtime.inLobby),
    lobby: runtime.lobby,
    client: runtime.client
      ? { port: runtime.client.port, source: runtime.client.source }
      : null,
    catalogSize: runtime.catalog.length,
    startedAt: runtime.startedAt,
    autoPlayAgain: Boolean(config.autoPlayAgain),
    autoAccept: Boolean(config.autoAccept),
    autoSelectCandidate: Boolean(config.autoSelectCandidate),
    benchBurstMode: Boolean(config.benchBurstMode),
    config: {
      startupDelayMs: config.startupDelayMs,
      stablePolls: config.stablePolls,
      minTimeLeftMs: config.minTimeLeftMs,
      maxRetries: config.maxRetries,
      pollMs: config.pollMs,
      dryRun: config.dryRun,
      allowedPhases: config.allowedPhases,
      autoPlayAgain: config.autoPlayAgain,
      autoAccept: config.autoAccept,
      autoSelectCandidate: config.autoSelectCandidate,
      benchBurstMode: config.benchBurstMode,
      acceptDelayMs: config.acceptDelayMs,
      playAgainDelayMs: config.playAgainDelayMs,
    },
  };
}

function publishStatus(force = false) {
  if (!runtime.config) return;
  const status = buildStatus();
  const key = JSON.stringify({
    ...status,
    timeLeft:
      status.timeLeft === null || status.timeLeft === undefined
        ? null
        : Math.floor(status.timeLeft / 1000),
  });
  if (!force && key === runtime.statusKey) return;
  runtime.statusKey = key;
  runtime.status = status;
  broadcast('status', status);
}

function applyConfig(partial) {
  runtime.config = normalizeConfig({ ...runtime.config, ...partial });
  saveConfig(runtime.config);
  log('配置已更新');
  publishStatus(true);
  return runtime.config;
}

function setPaused(paused) {
  runtime.paused = Boolean(paused);
  log(runtime.paused ? '自动换人已暂停' : '自动换人已恢复');
  publishStatus(true);
  return runtime.paused;
}

function shutdown() {
  log('收到退出请求，正在关闭喵');
  if (runtime.server) {
    try {
      runtime.server.close();
    } catch {
      // Ignore.
    }
  }
  setTimeout(() => process.exit(0), 200);
}

function openLogs() {
  try {
    execFile('explorer.exe', [LOG_DIR], () => {});
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function leaveLobby() {
  if (!runtime.client) return { ok: false, message: '还没有连接客户端' };
  const phase = runtime.gameflowPhase;
  try {
    if (phase === 'Matchmaking') {
      await request(
        runtime.client,
        'DELETE',
        '/lol-lobby/v2/lobby/matchmaking/search',
      ).catch(() => null);
    }
    if (phase === 'ReadyCheck') {
      await request(
        runtime.client,
        'POST',
        '/lol-matchmaking/v1/ready-check/decline',
        {},
      ).catch(() => null);
    }
    const res = await request(runtime.client, 'DELETE', '/lol-lobby/v2/lobby');
    if (res.status >= 200 && res.status < 300) {
      log('[OK] 已离开房间');
      runtime.inLobby = false;
      runtime.lobby = null;
      publishStatus(true);
      return { ok: true, message: '已离开房间喵' };
    }
    let detail = '';
    try {
      const body = JSON.parse(res.body);
      detail = body.message || body.errorCode || '';
    } catch {
      detail = res.body.slice(0, 200);
    }
    log(`[WARN] 离开房间失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    return {
      ok: false,
      message: `离开失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
    };
  } catch (error) {
    log(`[WARN] 离开房间失败: ${error.message}`);
    return { ok: false, message: error.message };
  }
}

function friendTextField(lol, key) {
  const value = lol?.[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function friendPartyId(lol) {
  let pty = lol?.pty;
  if (typeof pty === 'string') {
    try {
      pty = JSON.parse(pty);
    } catch {
      pty = null;
    }
  }
  const id = pty?.partyId ?? lol?.lobbyId ?? lol?.partyId ?? '';
  return String(id || '').trim();
}

function normalizeFriend(friend, myPartyId) {
  if (!friend || !friend.id) return null;
  const availability = String(friend.availability || '').trim().toLowerCase();
  if (availability === 'offline') return null;

  const lol = friend.lol && typeof friend.lol === 'object' ? friend.lol : {};
  const gameStatus = friendTextField(lol, 'gameStatus') || 'outOfGame';
  const statusKey = gameStatus.toLowerCase();
  const partyId = friendPartyId(lol);
  const joinableStatus =
    statusKey === 'outofgame' ||
    statusKey === 'inqueue' ||
    statusKey.startsWith('hosting');
  const name = friend.gameName || friend.name || friend.pid || friend.puuid || '?';
  const tag = friend.gameTag || '';

  return {
    id: friend.id,
    name: tag ? `${name}#${tag}` : name,
    icon: Number(friend.icon) || null,
    availability,
    gameStatus,
    queueId: Number(friendTextField(lol, 'queueId')) || null,
    gameQueueType: friendTextField(lol, 'gameQueueType'),
    partyId,
    inMyParty: Boolean(myPartyId && partyId && partyId === myPartyId),
    joinable:
      Boolean(partyId) &&
      joinableStatus &&
      !(myPartyId && partyId === myPartyId),
  };
}

async function getFriendsForUi() {
  if (!runtime.client) {
    return { ok: false, friends: [], message: '还没有连接客户端' };
  }
  try {
    const [friendsRes, lobbyRes] = await Promise.all([
      request(runtime.client, 'GET', '/lol-chat/v1/friends'),
      request(runtime.client, 'GET', '/lol-lobby/v2/lobby').catch(() => null),
    ]);
    if (friendsRes.status !== 200 || !friendsRes.body.trim()) {
      return {
        ok: false,
        friends: [],
        message: `读取好友列表失败: HTTP ${friendsRes.status}`,
      };
    }

    let myPartyId = '';
    if (lobbyRes && lobbyRes.status === 200 && lobbyRes.body.trim()) {
      try {
        myPartyId = String(JSON.parse(lobbyRes.body).partyId || '');
      } catch {
        myPartyId = '';
      }
    }

    const raw = JSON.parse(friendsRes.body);
    const friends = (Array.isArray(raw) ? raw : [])
      .map((friend) => normalizeFriend(friend, myPartyId))
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(b.joinable) - Number(a.joinable) ||
          a.name.localeCompare(b.name, 'zh-CN'),
      );
    return { ok: true, friends, myPartyId };
  } catch (error) {
    return { ok: false, friends: [], message: error.message };
  }
}

async function joinFriendLobby(partyId) {
  if (!runtime.client) return { ok: false, message: '还没有连接客户端' };
  const id = String(partyId || '').trim();
  if (!id) return { ok: false, message: '缺少房间 ID' };
  if (
    ['InProgress', 'ChampSelect', 'GameStart', 'Reconnect'].includes(
      runtime.gameflowPhase,
    )
  ) {
    return { ok: false, message: '当前在游戏/选人中，不能加入好友房间喵' };
  }
  if (id.length > 200) return { ok: false, message: '房间 ID 不正确' };

  try {
    const res = await request(
      runtime.client,
      'POST',
      `/lol-lobby/v2/party/${encodeURIComponent(id)}/join`,
      {},
    );
    if (res.status >= 200 && res.status < 300) {
      log(`[OK] 已加入好友房间 ${id}`);
      return { ok: true, message: '已加入好友房间喵' };
    }
    let detail = '';
    try {
      const body = JSON.parse(res.body);
      detail = body.message || body.errorCode || '';
    } catch {
      detail = res.body.slice(0, 200);
    }
    log(`[WARN] 加入好友房间失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    return {
      ok: false,
      message: `加入失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
    };
  } catch (error) {
    log(`[WARN] 加入好友房间失败: ${error.message}`);
    return { ok: false, message: error.message };
  }
}

async function getGameflowPhase(client) {
  const res = await request(client, 'GET', '/lol-gameflow/v1/gameflow-phase');
  if (res.status !== 200 || !res.body.trim()) return null;
  try {
    const parsed = JSON.parse(res.body);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return res.body.replace(/^"|"$/g, '') || null;
  }
}

async function getReadyCheck(client) {
  const res = await request(client, 'GET', '/lol-matchmaking/v1/ready-check');
  if (res.status !== 200 || !res.body.trim()) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/**
 * The non-champ-select automations: return to the lobby after a game, and
 * accept a ready check. Both re-read the client state after their delay so a
 * manual answer or a phase change cancels them.
 */
async function tickGameflow(client, runtime2) {
  const nowMs = Date.now();
  if (nowMs - runtime2.lastGameflowAt < 1000) return;
  runtime2.lastGameflowAt = nowMs;

  let phase;
  try {
    phase = await getGameflowPhase(client);
  } catch {
    return;
  }
  if (phase !== runtime2.gameflowPhase) {
    log(`gameflow: ${runtime2.gameflowPhase || '?'} -> ${phase || '?'}`);
    runtime2.gameflowPhase = phase;
  }

  if (nowMs - runtime2.lastPresenceAt > 5000) {
    runtime2.lastPresenceAt = nowMs;
    try {
      const meRes = await request(client, 'GET', '/lol-chat/v1/me');
      if (meRes.status === 200 && meRes.body.trim()) {
        const me = JSON.parse(meRes.body);
        runtime2.presence = {
          availability: String(me.availability || 'chat'),
          statusMessage: String(me.statusMessage || ''),
          gameName: String(me.gameName || me.name || ''),
          gameTag: String(me.gameTag || me.tagLine || ''),
        };
      }
    } catch {
      // Presence is informational; keep the last value.
    }
  }

  if (['Lobby', 'Matchmaking', 'ReadyCheck'].includes(phase)) {
    try {
      const lobbyRes = await request(client, 'GET', '/lol-lobby/v2/lobby');
      if (lobbyRes.status === 200 && lobbyRes.body.trim()) {
        const lobby = JSON.parse(lobbyRes.body);
        runtime2.inLobby = true;
        runtime2.lobby = {
          partyId: String(lobby.partyId || ''),
          queueId: Number(lobby.gameConfig?.queueId) || null,
          size: Array.isArray(lobby.members) ? lobby.members.length : 0,
        };
      } else {
        runtime2.inLobby = false;
        runtime2.lobby = null;
      }
    } catch {
      runtime2.inLobby = false;
      runtime2.lobby = null;
    }
  } else {
    runtime2.inLobby = false;
    runtime2.lobby = null;
  }

  const config = runtime2.config;
  const playAgainPhases = ['WaitingForStats', 'PreEndOfGame', 'EndOfGame'];
  const canPlayAgain = playAgainPhases.includes(phase);

  if (!canPlayAgain) {
    runtime2.playAgainPending = false;
    runtime2.playAgainAttempts = 0;
  }
  if (phase !== 'ReadyCheck') runtime2.acceptPending = false;

  if (
    canPlayAgain &&
    config.autoPlayAgain &&
    !runtime2.playAgainPending &&
    runtime2.playAgainAttempts < 3 &&
    nowMs - runtime2.lastPlayAgainAt > 10000
  ) {
    runtime2.playAgainPending = true;
    runtime2.playAgainAttempts += 1;
    runtime2.lastPlayAgainAt = nowMs;
    log(`检测到对局结束（${phase}），准备自动返回房间喵`);
    await sleep(config.playAgainDelayMs);
    try {
      const current = await getGameflowPhase(client);
      if (!playAgainPhases.includes(current)) {
        log('已经离开结算界面，取消自动返回房间');
      } else {
        const res = await request(client, 'POST', '/lol-lobby/v2/play-again', {});
        if (res.status >= 200 && res.status < 300) {
          log('[OK] 已自动返回房间');
        } else {
          log(`[WARN] 自动返回房间失败: HTTP ${res.status}`);
        }
      }
    } catch (error) {
      log(`[WARN] 自动返回房间失败: ${error.message}`);
    } finally {
      runtime2.playAgainPending = false;
      publishStatus(true);
    }
  }

  if (phase === 'ReadyCheck' && config.autoAccept && !runtime2.acceptPending) {
    runtime2.acceptPending = true;
    try {
      const check = await getReadyCheck(client);
      if (shouldAcceptReadyCheck(check)) {
        log('检测到对局确认，准备自动接受喵');
        await sleep(config.acceptDelayMs);
        const again = await getReadyCheck(client);
        if (shouldAcceptReadyCheck(again)) {
          const res = await request(
            client,
            'POST',
            '/lol-matchmaking/v1/ready-check/accept',
            {},
          );
          if (res.status >= 200 && res.status < 300) {
            log('[OK] 已自动接受对局');
          } else {
            log(`[WARN] 自动接受对局失败: HTTP ${res.status}`);
          }
        } else {
          log('对局确认已结束或被处理，取消自动接受');
        }
      }
    } catch (error) {
      log(`[WARN] 自动接受对局失败: ${error.message}`);
    } finally {
      runtime2.acceptPending = false;
      publishStatus(true);
    }
  }

  publishStatus();
}

async function attemptSwap(client, target, attemptNumber, runtime2, options = {}) {
  const config = runtime2.config;
  const label = nameOf(target);
  const manual = Boolean(options.manual);
  runtime2.lastAction = {
    type: 'swap',
    target: champRef(target),
    manual,
    ok: false,
    at: Date.now(),
    message: `正在请求换到 ${label}`,
  };
  publishStatus(true);

  if (config.dryRun) {
    log(`[DRY] 会请求换到 ${label}${manual ? '（手动）' : ''}`);
    runtime2.lastAction.message = '练习模式，未真正换人';
    publishStatus(true);
    return { ok: false, message: '练习模式，未真正换人' };
  }

  log(`-> 请求换到 ${label}${manual ? '（手动）' : ''}（第 ${attemptNumber} 次尝试）`);
  let response;
  try {
    response = await request(
      client,
      'POST',
      `/lol-champ-select/v1/session/bench/swap/${target}`,
      {},
    );
  } catch (error) {
    log(`   请求失败: ${error.message}`);
    runtime2.lastAction = {
      type: 'swap',
      target: champRef(target),
      manual,
      ok: false,
      at: Date.now(),
      message: `请求失败: ${error.message}`,
    };
    publishStatus(true);
    return { ok: false, message: error.message };
  }

  log(`   客户端返回 HTTP ${response.status}`);
  if (response.status < 200 || response.status >= 300) {
    runtime2.lastAction = {
      type: 'swap',
      target: champRef(target),
      manual,
      ok: false,
      at: Date.now(),
      message: `HTTP ${response.status}`,
    };
    publishStatus(true);
    return { ok: false, message: `HTTP ${response.status}` };
  }

  await sleep(config.verifyDelayMs);
  let session;
  try {
    session = await getChampSelectSession(client);
  } catch (error) {
    log(`   校验失败: ${error.message}`);
    runtime2.lastAction.message = `校验失败: ${error.message}`;
    publishStatus(true);
    return { ok: false, message: error.message };
  }
  if (!session) {
    log('   校验失败: 选人已经结束');
    runtime2.lastAction.message = '选人已经结束';
    publishStatus(true);
    return { ok: false, message: '选人已经结束' };
  }

  runtime2.lastSession = session;
  const info = sessionInfo(session);
  if (info.held === target) {
    log(`   [OK] 已确认手上是 ${label}`);
    runtime2.lastAction = {
      type: 'swap',
      target: champRef(target),
      manual,
      ok: true,
      at: Date.now(),
      message: `已确认换到 ${label}`,
    };
    publishStatus(true);
    return { ok: true, message: `已确认换到 ${label}` };
  }

  const benchText = info.bench.map((id) => nameOf(id)).join(' / ');
  log(
    `   [WARN] 没有落地：手上是 ${nameOf(info.held)}，备选席 = [${benchText || '空'}]`,
  );
  runtime2.lastAction = {
    type: 'swap',
    target: champRef(target),
    manual,
    ok: false,
    at: Date.now(),
    message: '没有落地，等待重试',
  };
  publishStatus(true);
  return { ok: false, message: '没有落地' };
}

async function acceptTrade(tradeId) {
  if (!runtime.client) return { ok: false, message: '还没有连接客户端' };
  const id = Number(tradeId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, message: '交易 ID 不正确喵' };
  }
  const trade = (runtime.lastSession?.trades || []).find(
    (entry) => Number(entry.id) === id,
  );
  if (!trade) return { ok: false, message: '这条交易已经不存在了喵' };
  if (String(trade.state || '').toUpperCase() !== 'AVAILABLE') {
    return { ok: false, message: `交易状态是 ${trade.state}喵` };
  }
  const teammate = (runtime.lastSession?.myTeam || []).find(
    (player) => player.cellId === trade.cellId,
  );
  const target = champRef(Number(teammate?.championId) || 0);

  try {
    const res = await request(
      runtime.client,
      'POST',
      `/lol-champ-select/v1/session/trades/${id}/accept`,
      {},
    );
    if (res.status >= 200 && res.status < 300) {
      log(`[OK] 已接受换英雄交易：${target.name}喵`);
      runtime.lastAction = {
        type: 'trade',
        target,
        manual: true,
        ok: true,
        at: Date.now(),
        message: `已接受换英雄交易：${target.name}`,
      };
      publishStatus(true);
      return { ok: true, message: `已接受换英雄交易：${target.name}喵` };
    }
    let detail = '';
    try {
      const body = JSON.parse(res.body);
      detail = body.message || body.errorCode || '';
    } catch {
      detail = res.body.slice(0, 200);
    }
    log(`[WARN] 接受交易失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    return {
      ok: false,
      message: `接受交易失败: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
    };
  } catch (error) {
    log(`[WARN] 接受交易失败: ${error.message}`);
    return { ok: false, message: error.message };
  }
}

async function manualSwap(championId) {
  const id = Number(championId);
  if (!runtime.client) return { ok: false, message: '还没有连接客户端' };
  if (!runtime.lastSession) return { ok: false, message: '当前不在选人阶段' };
  const info = sessionInfo(runtime.lastSession);
  if (runtime.lastSession.queueId === 2400 && info.phase !== 'FINALIZATION') {
    return { ok: false, message: '海克斯大乱斗要等所有人选完才能换备选席喵' };
  }
  if (!info.bench.includes(id)) return { ok: false, message: '这个英雄不在备选席' };
  if (info.held === id) return { ok: false, message: '已经在这个英雄上' };
  return attemptSwap(runtime.client, id, 1, runtime, { manual: true });
}

/**
 * Hextech ARAM (queue 2400) burst: the bench unlocks at FINALIZATION, so
 * pre-fire from the last second of BAN_PICK, keep a high rate for 3 seconds,
 * slow down for 2 more seconds, then stop.
 */
async function handleHextechBurst(client, session, info, runtime2, state) {
  const config = runtime2.config;
  if (state.burstDone) return true;
  if (!info.benchEnabled || runtime2.paused) return true;
  if (!config.autoSelectCandidate) return true;

  const now = Date.now();

  if (info.phase === 'BAN_PICK') {
    const seconds = info.isInfinite
      ? null
      : Math.max(0, Math.ceil(info.timeLeft / 1000));
    if (!state.finalWaitLogged) {
      log(
        `海克斯大乱斗要等所有人选完（FINALIZATION）才能换备选席，当前阶段还剩约 ${
          seconds ?? '?'
        } 秒，先等着喵`,
      );
      state.finalWaitLogged = true;
    }
    if (seconds !== null && seconds <= 5 && !state.finalNear5Logged) {
      log('还有约 5 秒进入可换人阶段喵');
      state.finalNear5Logged = true;
    }
    if (seconds !== null && seconds <= 1 && !state.finalNear1Logged) {
      log('马上进入可换人阶段，准备抢喵');
      state.finalNear1Logged = true;
    }
    if (seconds === null || seconds > 1) return true;
    if (!state.burstActive) {
      state.burstActive = true;
      state.burstPreFireAt = now;
      state.burstFinalizationAt = 0;
      state.burstTarget = 0;
      log('开始爆发抢英雄：最后 1 秒预发喵');
    }
  } else if (info.phase === 'FINALIZATION') {
    if (!state.burstActive) {
      state.burstActive = true;
      state.burstPreFireAt = now - BURST_PRE_MS;
      state.burstFinalizationAt = now;
      state.burstTarget = 0;
      log('进入可换人阶段，开始爆发抢英雄喵');
    } else if (!state.burstFinalizationAt) {
      state.burstFinalizationAt = now;
      log('进入可换人阶段，爆发窗口启动喵');
    }
  } else {
    return true;
  }

  if (!state.burstActive) return true;

  const finalizationAt = state.burstFinalizationAt || 0;
  const stopAt =
    finalizationAt > 0
      ? finalizationAt + BURST_HIGH_MS + BURST_SLOW_MS
      : state.burstPreFireAt +
        BURST_PRE_MS +
        BURST_HIGH_MS +
        BURST_SLOW_MS +
        2000;
  if (now >= stopAt) {
    if (!state.burstEndLogged) {
      log(
        `[WARN] 爆发窗口结束（约 5 秒），未确认换到 ${
          state.burstTarget ? nameOf(state.burstTarget) : '目标'
        }喵`,
      );
      state.burstEndLogged = true;
    }
    state.burstActive = false;
    state.burstDone = true;
    return true;
  }
  if (!finalizationAt && now - state.burstPreFireAt > 2500) {
    log('[WARN] 预发后 2.5 秒还没进入 FINALIZATION，爆发窗口取消喵');
    state.burstEndLogged = true;
    state.burstActive = false;
    state.burstDone = true;
    return true;
  }

  const target = chooseBenchTarget(session, config.wishlist, {
    allowEmptyHeld: info.phase === 'FINALIZATION' && config.autoSelectCandidate,
  });
  if (!target) {
    if (state.burstTarget && info.held !== state.burstTarget) {
      log(
        `[WARN] ${nameOf(state.burstTarget)} 已不在备选席（可能被队友拿走）喵`,
      );
      state.burstTarget = 0;
    }
    return true;
  }
  if (
    state.burstTarget &&
    state.burstTarget !== target &&
    info.held !== state.burstTarget
  ) {
    log(`[WARN] ${nameOf(state.burstTarget)} 已不在备选席（可能被队友拿走）喵`);
  }
  if (target !== state.burstTarget) {
    state.burstTarget = target;
    log(`爆发目标：${nameOf(target)}喵`);
  }
  if (info.held === target) {
    log(`[OK] 爆发窗口内已确认手上是 ${nameOf(target)}喵`);
    state.burstActive = false;
    state.burstDone = true;
    return true;
  }

  const interval =
    finalizationAt > 0 && now >= finalizationAt + BURST_HIGH_MS
      ? BURST_SLOW_EVERY_MS
      : BURST_HIGH_EVERY_MS;
  if (now - state.burstLastPostAt < interval) return true;
  if (state.swaps >= config.maxSwapsPerGame) {
    if (!state.burstEndLogged) {
      log('[WARN] 本局换人请求次数达到上限，爆发停止喵');
      state.burstEndLogged = true;
    }
    state.burstActive = false;
    state.burstDone = true;
    return true;
  }

  state.burstLastPostAt = now;
  state.burstPosts += 1;
  state.swaps += 1;
  if (config.dryRun) {
    log(`[DRY] 爆发请求换到 ${nameOf(target)}喵`);
    return true;
  }

  try {
    const res = await request(
      client,
      'POST',
      `/lol-champ-select/v1/session/bench/swap/${target}`,
      {},
    );
    if (res.status >= 200 && res.status < 300) {
      log(`爆发 ${state.burstPosts}: ${nameOf(target)} -> HTTP ${res.status}`);
    } else {
      log(`[WARN] 爆发 ${nameOf(target)} -> HTTP ${res.status}`);
    }
  } catch (error) {
    log(`[WARN] 爆发请求失败: ${error.message}`);
  }
  return true;
}

async function handleSession(client, session, runtime2, state) {
  const config = runtime2.config;
  const info = sessionInfo(session);
  timelineLog(session, info);

  if (session.gameId !== state.gameId) {
    resetState(state);
    state.gameId = session.gameId;
    state.seenAt = Date.now();
    log(
      `进入选人: gameId=${session.gameId ?? '?'} queue=${session.queueId ?? '?'} phase=${info.phase}`,
    );
    log(`详细选人时间线: ${timelinePathForNow()}`);
  }

  const stableKey = `${info.phase}|${info.held}|${info.bench.join(',')}`;
  if (stableKey === state.stableKey) state.stableCount += 1;
  else {
    state.stableKey = stableKey;
    state.stableCount = 1;
  }

  if (stableKey !== state.lastLoggedKey) {
    log(
      `状态: ${info.phase} | 手上 ${nameOf(info.held)} | 备选席 [${
        info.bench.length ? info.bench.map((id) => nameOf(id)).join(' / ') : '空'
      }]`,
    );
    state.lastLoggedKey = stableKey;
  }

  const snapshotKey = `${info.phase}|${info.held}|${info.bench.join(
    ',',
  )}|${info.candidates.join(',')}|${JSON.stringify(
    session.trades || [],
  )}|${JSON.stringify(session.actions || [])}`;
  if (snapshotKey !== state.snapshotKey && state.snapshotCount < 60) {
    state.snapshotKey = snapshotKey;
    state.snapshotCount += 1;
    saveSessionSnapshot(session, `${info.phase} held=${info.held}`);
  }

  const lostTargets = new Set();
  for (const championId of [...state.attempts.keys()]) {
    if (!info.bench.includes(championId)) {
      if (info.held !== championId) lostTargets.add(championId);
      state.attempts.delete(championId);
    }
  }
  for (const championId of [...state.exhausted]) {
    if (typeof championId === 'number' && !info.bench.includes(championId)) {
      if (info.held !== championId) lostTargets.add(championId);
      state.exhausted.delete(championId);
    }
  }
  if (lostTargets.size > 0) {
    log(
      `[WARN] ${[...lostTargets]
        .map((id) => nameOf(id))
        .join(' / ')} 已从备选席消失（可能被队友拿走），停止重试`,
    );
  }

  if (session.queueId === 2400 && config.benchBurstMode) {
    await handleHextechBurst(client, session, info, runtime2, state);
    return;
  }

  if (!info.benchEnabled) return;
  if (runtime2.paused) return;
  if (!isPhaseAllowed(info.phase, config.allowedPhases)) return;

  // Hextech ARAM (2400) keeps the bench locked until everyone has finished
  // picking. Attempts during BAN_PICK return 204 but do nothing, so wait for
  // FINALIZATION instead of burning the retry budget early.
  if (session.queueId === 2400 && info.phase !== 'FINALIZATION') {
    const seconds = info.isInfinite
      ? null
      : Math.max(0, Math.ceil(info.timeLeft / 1000));
    if (!state.finalWaitLogged) {
      log(
        `海克斯大乱斗要等所有人选完（FINALIZATION）才能换备选席，当前阶段还剩约 ${
          seconds ?? '?'
        } 秒，先等着喵`,
      );
      state.finalWaitLogged = true;
    }
    if (seconds !== null && seconds <= 5 && !state.finalNear5Logged) {
      log('还有约 5 秒进入可换人阶段喵');
      state.finalNear5Logged = true;
    }
    if (seconds !== null && seconds <= 1 && !state.finalNear1Logged) {
      log('马上进入可换人阶段，准备抢喵');
      state.finalNear1Logged = true;
    }
    return;
  }
  state.finalWaitLogged = false;
  state.finalNear5Logged = false;
  state.finalNear1Logged = false;

  if (info.phase === 'FINALIZATION' && !config.autoSelectCandidate) return;
  if (Date.now() - state.seenAt < config.startupDelayMs) return;
  const requiredStable =
    info.phase === 'FINALIZATION' ? 1 : config.stablePolls;
  if (state.stableCount < requiredStable) return;
  if (!info.isInfinite && info.timeLeft > 0 && info.timeLeft < config.minTimeLeftMs) return;
  if (state.swaps >= config.maxSwapsPerGame) {
    if (!state.exhausted.has('game')) {
      log(`[WARN] 本局已经尝试换人 ${state.swaps} 次，停止，避免和客户端打架`);
      state.exhausted.add('game');
    }
    return;
  }

  const target = chooseBenchTarget(session, config.wishlist, {
    allowEmptyHeld: info.phase === 'FINALIZATION' && config.autoSelectCandidate,
  });
  if (!target || target === info.held) return;

  const tries = state.attempts.get(target) || 0;
  if (tries >= config.maxRetries) {
    if (!state.exhausted.has(target)) {
      log(
        `[WARN] ${nameOf(target)} 试了 ${tries} 次都没确认落地，先放弃（重新进选人会重置）`,
      );
      state.exhausted.add(target);
    }
    return;
  }

  if (Date.now() - state.lastAttemptAt < config.retryDelayMs) return;

  if (info.phase === 'FINALIZATION' && tries === 0) {
    log(`待选界面出现心愿英雄 ${nameOf(target)}，自动选择喵`);
  }

  state.attempts.set(target, tries + 1);
  state.lastAttemptAt = Date.now();
  state.swaps += 1;
  await attemptSwap(client, target, tries + 1, runtime2);
}

async function runLoop(initialClient, runtime2) {
  let client = initialClient;
  const state = runtime2.state;
  let lastIdleLogAt = 0;
  let lastErrorAt = 0;
  let consecutiveErrors = 0;

  log('开始监听选人阶段，网页里可以看实时状态喵');

  for (;;) {
    const config = runtime2.config;
    const pollStartedAt = Date.now();
    try {
      await tickGameflow(client, runtime2);
      const session = await getChampSelectSession(client);
      consecutiveErrors = 0;
      runtime2.client = client;
      if (!session) {
        runtime2.lastSession = null;
        resetState(state);
        publishStatus();
        if (Date.now() - lastIdleLogAt > 30000) {
          log('当前不在选人阶段，等待进入大乱斗/海克斯大乱斗...');
          lastIdleLogAt = Date.now();
        }
      } else {
        runtime2.lastSession = session;
        await handleSession(client, session, runtime2, state);
        publishStatus();
      }
    } catch (error) {
      consecutiveErrors += 1;
      if (Date.now() - lastErrorAt > 5000) {
        log(`轮询出错: ${error.message}`);
        lastErrorAt = Date.now();
      }
      if (consecutiveErrors >= 3) {
        runtime2.client = null;
        runtime2.lastSession = null;
        publishStatus(true);
        // Let the supervisor re-discover. It retries every 5 seconds, which
        // covers a client restart/update that changes the LCU port.
        throw new Error(`与客户端断开: ${error.message}`);
      }
      await sleep(1000);
      continue;
    }

    const elapsed = Date.now() - pollStartedAt;
    await sleep(Math.max(50, config.pollMs - elapsed));
  }
}

async function supervisor(runtime2) {
  for (;;) {
    try {
      const client = await discoverClient(runtime2.config, log);
      runtime2.client = client;
      runtime2.catalog = await getChampionCatalog(client);
      runtime2.names = new Map(runtime2.catalog.map((entry) => [entry.id, entry.name]));
      log(`客户端英雄名映射: ${runtime2.catalog.length} 个`);
      if (!runtime2.warnedAboutWiner && isWinerRunning() && winerBenchAutoEnabled()) {
        runtime2.warnedAboutWiner = true;
        log(
          '[WARN] 检测到 winer 正在运行，而且它的「自动换心愿英雄」还开着。请先在 winer 里关掉它，避免两个程序同时抢换人请求喵。',
        );
      }
      publishStatus(true);
      await runLoop(client, runtime2);
    } catch (error) {
      runtime2.client = null;
      runtime2.lastSession = null;
      log(`连接客户端失败: ${error.message}`);
      publishStatus(true);
      await sleep(5000);
    }
  }
}

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`LOL 大乱斗备选席自动换人工具

用法:
  start.bat                  控制台模式（黑框）
  launch-web.vbs             网页控制台（推荐）
  start.bat --dry-run        只打印会做什么，不真正换人
  start.bat --probe          打印当前选人会话（调试用）
  start.bat --list-champions 列出客户端里的英雄 ID 和名字
  start.bat --help           显示本帮助

网页模式:
  node src/index.js --web    启动本地网页控制台，默认 http://127.0.0.1:8765

配置:
  ${CONFIG_PATH}
  wishlist 越靠前优先级越高。网页里可以直接拖动/上下调整。
`);
}

async function main() {
  if (hasFlag('--help')) {
    printHelp();
    return;
  }

  const configPath = getOption('--config') || CONFIG_PATH;
  const config = loadConfig(configPath);
  if (hasFlag('--dry-run')) config.dryRun = true;
  runtime.config = config;

  runtime.applyConfig = applyConfig;
  runtime.setPaused = setPaused;
  runtime.manualSwap = manualSwap;
  runtime.shutdown = shutdown;
  runtime.openLogs = openLogs;
  runtime.leaveLobby = leaveLobby;
  runtime.acceptTrade = acceptTrade;
  runtime.getFriends = getFriendsForUi;
  runtime.joinFriendLobby = joinFriendLobby;

  publishStatus(true);
  log(`配置: ${configPath}`);
  log(`心愿英雄顺序: ${config.wishlist.join(', ')}`);

  if (hasFlag('--probe') || hasFlag('--list-champions')) {
    const client = await discoverClient(config, log);
    runtime.client = client;
    runtime.catalog = await getChampionCatalog(client);
    runtime.names = new Map(runtime.catalog.map((entry) => [entry.id, entry.name]));
    log(`客户端英雄名映射: ${runtime.catalog.length} 个`);
    if (hasFlag('--list-champions')) {
      for (const entry of runtime.catalog) {
        console.log(`${String(entry.id).padStart(4)}  ${entry.name}`);
      }
      return;
    }
    const session = await getChampSelectSession(client);
    if (!session) {
      log('当前不在选人阶段');
    } else {
      console.log(JSON.stringify(session, null, 2));
    }
    return;
  }

  if (hasFlag('--web')) {
    runtime.server = await startWebServer(runtime, log);
    publishStatus(true);
  }

  await supervisor(runtime);
}

main().catch((error) => {
  log(`启动失败: ${error.message}`);
  process.exitCode = 1;
});
