'use strict';

/**
 * Pure helpers for the ARAM bench auto-swap. Kept free of I/O so they can be
 * unit tested without a running League Client.
 */

function normalizeWishlist(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function rankOf(wishlist, championId) {
  const index = wishlist.indexOf(Number(championId));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/** The parts of a champ-select session this tool cares about. */
function sessionInfo(session) {
  const me = (session?.myTeam || []).find(
    (player) => player.cellId === session.localPlayerCellId,
  );
  const bench = (session?.benchChampions || [])
    .map((entry) => Number(entry.championId))
    .filter((id) => Number.isInteger(id) && id > 0);

  // The two-card "选择你的英雄" screen is not always made only of bench
  // champions. Also collect the local player's pick intent and in-progress
  // pick actions; the exact field can be confirmed from a raw session snapshot.
  const localCellId = session?.localPlayerCellId;
  const actions = (session?.actions || []).flat();
  const localPickActions = actions.filter(
    (action) =>
      action &&
      action.actorCellId === localCellId &&
      String(action.type || '').toLowerCase() === 'pick' &&
      Number(action.championId) > 0,
  );
  const pickIntent = Number(me?.championPickIntent) || 0;
  const priorityBench = (session?.benchChampions || [])
    .filter((entry) => entry?.isPriority && Number(entry.championId) > 0)
    .map((entry) => Number(entry.championId));
  const candidates = [
    ...new Set([
      ...(pickIntent ? [pickIntent] : []),
      ...localPickActions.map((action) => Number(action.championId)),
      ...priorityBench,
    ]),
  ];

  const trades = (session?.trades || [])
    .filter(
      (trade) =>
        trade && String(trade.state || '').toUpperCase() === 'AVAILABLE',
    )
    .map((trade) => {
      const teammate = (session.myTeam || []).find(
        (player) => player.cellId === trade.cellId,
      );
      const championId = Number(teammate?.championId) || 0;
      return championId > 0
        ? {
            tradeId: Number(trade.id) || 0,
            cellId: Number(trade.cellId) || 0,
            championId,
          }
        : null;
    })
    .filter(Boolean);

  return {
    held: Number(me?.championId) || 0,
    bench,
    candidates,
    trades,
    pickIntent,
    phase: session?.timer?.phase || 'UNKNOWN',
    timeLeft: Number(session?.timer?.adjustedTimeLeftInPhase ?? 0),
    isInfinite: Boolean(session?.timer?.isInfinite),
    benchEnabled: Boolean(session?.benchEnabled),
  };
}

/**
 * The best champion to take off the bench: the one highest on the wishlist,
 * and only when it ranks above the champion currently held. Champions that
 * are not on the wishlist are ignored, so the tool never picks a random
 * bench champion on its own.
 */
function chooseBenchTarget(session, wishlist, options = {}) {
  if (!session?.benchEnabled) return null;
  const { held, bench } = sessionInfo(session);
  // The client has not assigned the initial ARAM champion yet. Swapping now
  // can return 200 but be overwritten when the assignment lands, which is the
  // race that makes winer's automatic swap look successful but do nothing.
  // The finalization choice screen is the exception: there the two cards are
  // the actual choice and the player may not hold a champion yet.
  if (held <= 0 && !options.allowEmptyHeld) return null;
  const heldRank = held > 0 ? rankOf(wishlist, held) : Number.POSITIVE_INFINITY;
  let best = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const championId of bench) {
    const rank = rankOf(wishlist, championId);
    if (!Number.isFinite(rank) || rank >= heldRank) continue;
    if (rank < bestRank) {
      best = championId;
      bestRank = rank;
    }
  }
  return best;
}

function isPhaseAllowed(phase, allowedPhases) {
  return Array.isArray(allowedPhases) && allowedPhases.includes(phase);
}

/** The ready check is up and this player has not answered yet. */
function shouldAcceptReadyCheck(check) {
  return Boolean(
    check && check.state === 'InProgress' && check.playerResponse === 'None',
  );
}

/**
 * Parse the League Client lockfile: name:pid:port:password:protocol.
 * The password may contain ':' in theory, so keep the last field as the
 * protocol and the fourth field as the password.
 */
function parseLockfile(text) {
  const parts = String(text || '').trim().split(':');
  if (parts.length < 5) return null;
  const protocol = parts[parts.length - 1];
  const password = parts[parts.length - 2];
  const port = Number(parts[parts.length - 3]);
  const pid = Number(parts[parts.length - 4]);
  if (!Number.isInteger(port) || port <= 0 || !password) return null;
  return {
    name: parts.slice(0, parts.length - 4).join(':') || 'LeagueClient',
    pid: Number.isInteger(pid) ? pid : null,
    port,
    password,
    protocol: protocol === 'http' ? 'http' : 'https',
  };
}

/** Pull --app-port and --remoting-auth-token out of a LeagueClientUx command line. */
function parseLeagueClientCommandLine(commandLine) {
  const cmd = String(commandLine || '');
  const portMatch = /--app-port(?:=|\s+)(\d+)/.exec(cmd);
  const tokenMatch = /--remoting-auth-token(?:=|\s+)([^\s"']+)/.exec(cmd);
  if (!portMatch || !tokenMatch) return null;
  return {
    name: 'LeagueClientUx',
    pid: null,
    port: Number(portMatch[1]),
    password: tokenMatch[1],
    protocol: 'https',
  };
}

/**
 * Turn either the champion-summary array or an id-keyed object into a
 * Map<number, string>. The LCU returns localized names when the client is
 * in Chinese, which is what we want in the log.
 */
function normalizeChampionSummary(data) {
  const entries = Array.isArray(data) ? data : Object.values(data || {});
  const names = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const id = Number(entry.id ?? entry.championId);
    if (!Number.isInteger(id) || id <= 0) continue;
    const name = entry.name || entry.alias || entry.title;
    if (name) names.set(id, String(name));
  }
  return names;
}

module.exports = {
  normalizeWishlist,
  rankOf,
  sessionInfo,
  chooseBenchTarget,
  isPhaseAllowed,
  shouldAcceptReadyCheck,
  parseLockfile,
  parseLeagueClientCommandLine,
  normalizeChampionSummary,
};
