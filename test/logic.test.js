'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chooseBenchTarget,
  isPhaseAllowed,
  normalizeChampionSummary,
  normalizeWishlist,
  parseLeagueClientCommandLine,
  parseLockfile,
  sessionInfo,
  shouldAcceptReadyCheck,
} = require('../src/logic');

function makeSession({ held = 0, bench = [], phase = 'BAN_PICK', benchEnabled = true } = {}) {
  return {
    gameId: 123,
    queueId: 450,
    localPlayerCellId: 7,
    benchEnabled,
    benchChampions: bench.map((championId) => ({ championId })),
    myTeam: [{ cellId: 7, championId: held }],
    timer: { phase, adjustedTimeLeftInPhase: 30000, isInfinite: false },
  };
}

test('parseLockfile reads the standard lockfile', () => {
  assert.deepEqual(
    parseLockfile('LeagueClient:4321:62082:abcDEF123:https'),
    {
      name: 'LeagueClient',
      pid: 4321,
      port: 62082,
      password: 'abcDEF123',
      protocol: 'https',
    },
  );
});

test('parseLockfile rejects incomplete text', () => {
  assert.equal(parseLockfile(''), null);
  assert.equal(parseLockfile('LeagueClient:1:2'), null);
  assert.equal(parseLockfile('LeagueClient:1:not-a-port:token:https'), null);
});

test('parseLeagueClientCommandLine finds port and token', () => {
  const cmd =
    '"C:\\...\\LeagueClientUx.exe" --riotclient-auth-token=x --app-port=62082 --remoting-auth-token=secret_123';
  assert.deepEqual(parseLeagueClientCommandLine(cmd), {
    name: 'LeagueClientUx',
    pid: null,
    port: 62082,
    password: 'secret_123',
    protocol: 'https',
  });
});

test('parseLeagueClientCommandLine supports a space instead of equals', () => {
  const cmd = 'LeagueClientUx.exe --app-port 62082 --remoting-auth-token secret_123';
  assert.equal(parseLeagueClientCommandLine(cmd).port, 62082);
  assert.equal(parseLeagueClientCommandLine(cmd).password, 'secret_123');
});

test('sessionInfo finds the local player and bench', () => {
  const info = sessionInfo(makeSession({ held: 145, bench: [136, 235] }));
  assert.equal(info.held, 145);
  assert.deepEqual(info.bench, [136, 235]);
  assert.equal(info.phase, 'BAN_PICK');
  assert.equal(info.benchEnabled, true);
});

test('collects available teammate trades as candidates', () => {
  const session = makeSession({ held: 166, bench: [] });
  session.myTeam.push({ cellId: 6, championId: 58 });
  session.trades = [{ id: 106, cellId: 6, state: 'AVAILABLE' }];
  assert.deepEqual(sessionInfo(session).trades, [
    { tradeId: 106, cellId: 6, championId: 58 },
  ]);
});

test('collects pick intent and local pick actions as candidates', () => {
  const session = makeSession({ held: 0, bench: [] });
  session.myTeam[0].championPickIntent = 25;
  session.actions = [
    [{ actorCellId: 7, type: 'pick', championId: 33, isInProgress: true }],
    [{ actorCellId: 99, type: 'pick', championId: 1, isInProgress: true }],
  ];
  assert.deepEqual(sessionInfo(session).candidates.sort((a, b) => a - b), [25, 33]);
});

test('no bench means no target', () => {
  assert.equal(
    chooseBenchTarget(makeSession({ bench: [], benchEnabled: false }), [145]),
    null,
  );
});

test('waits for the client to assign an initial champion', () => {
  const session = makeSession({ held: 0, bench: [136, 235] });
  assert.equal(chooseBenchTarget(session, [145, 136, 235]), null);
});

test('the finalization choice may pick without an assigned champion', () => {
  const session = makeSession({ held: 0, bench: [136, 235] });
  assert.equal(
    chooseBenchTarget(session, [145, 136, 235], { allowEmptyHeld: true }),
    136,
  );
  assert.equal(
    chooseBenchTarget(session, [145, 235], { allowEmptyHeld: true }),
    235,
  );
});

test('picks the highest wishlist champion on the bench', () => {
  const session = makeSession({ held: 142, bench: [81, 136, 235] });
  assert.equal(chooseBenchTarget(session, [145, 136, 235, 81]), 136);
});

test('ignores champions that are not on the wishlist', () => {
  const session = makeSession({ held: 142, bench: [143, 235] });
  assert.equal(chooseBenchTarget(session, [145, 235]), 235);
  assert.equal(chooseBenchTarget(session, [145]), null);
});

test('never swaps down to a lower-ranked champion', () => {
  const session = makeSession({ held: 136, bench: [235, 81] });
  assert.equal(chooseBenchTarget(session, [145, 136, 235, 81]), null);
});

test('a held champion outside the wishlist counts as worse than every wishlist champion', () => {
  const session = makeSession({ held: 142, bench: [235, 81] });
  assert.equal(chooseBenchTarget(session, [145, 235, 81]), 235);
});

test('a held champion at rank zero blocks every bench swap', () => {
  const session = makeSession({ held: 145, bench: [136, 235] });
  assert.equal(chooseBenchTarget(session, [145, 136, 235]), null);
});

test('isPhaseAllowed checks the configured phases', () => {
  assert.equal(isPhaseAllowed('BAN_PICK', ['BAN_PICK', 'FINALIZATION']), true);
  assert.equal(isPhaseAllowed('PLANNING', ['BAN_PICK', 'FINALIZATION']), false);
});

test('shouldAcceptReadyCheck only accepts an unanswered ready check', () => {
  assert.equal(shouldAcceptReadyCheck({ state: 'InProgress', playerResponse: 'None' }), true);
  assert.equal(
    shouldAcceptReadyCheck({ state: 'InProgress', playerResponse: 'Accepted' }),
    false,
  );
  assert.equal(
    shouldAcceptReadyCheck({ state: 'InProgress', playerResponse: 'Declined' }),
    false,
  );
  assert.equal(shouldAcceptReadyCheck({ state: 'Invalid', playerResponse: 'None' }), false);
  assert.equal(shouldAcceptReadyCheck(null), false);
});

test('normalizeWishlist drops duplicates, zeroes and non-numbers', () => {
  assert.deepEqual(normalizeWishlist([145, '145', 0, -1, 'x', 235, 235]), [145, 235]);
});

test('normalizeChampionSummary accepts an array and an object', () => {
  const array = normalizeChampionSummary([
    { id: -1, name: 'None' },
    { id: 235, name: 'Senna' },
  ]);
  assert.equal(array.get(235), 'Senna');
  assert.equal(array.has(-1), false);

  const object = normalizeChampionSummary({
    136: { id: 136, alias: 'AurelionSol' },
  });
  assert.equal(object.get(136), 'AurelionSol');
});
