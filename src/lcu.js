'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  parseLockfile,
  parseLeagueClientCommandLine,
  normalizeChampionSummary,
} = require('./logic');

const KNOWN_LOCKFILES = [
  'E:\\Program Files (x86)\\LOL(26)\\LeagueClient\\lockfile',
  'C:\\Program Files (x86)\\LOL\\LeagueClient\\lockfile',
  'D:\\Program Files (x86)\\LOL\\LeagueClient\\lockfile',
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  'E:\\Riot Games\\League of Legends\\lockfile',
];

function runPowerShell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  ).trim();
}

function isElevated() {
  try {
    return (
      runPowerShell(
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      ).toLowerCase() === 'true'
    );
  } catch {
    return false;
  }
}

function candidateLockfiles(config) {
  const paths = [];
  if (config.lockfilePath) paths.push(config.lockfilePath);
  if (config.clientDir) paths.push(path.join(config.clientDir, 'lockfile'));
  paths.push(...KNOWN_LOCKFILES);
  return [...new Set(paths)];
}

function request(client, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const transport = client.protocol === 'http' ? http : https;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {
      Authorization: `Basic ${Buffer.from(`riot:${client.password}`).toString('base64')}`,
      Accept: 'application/json',
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = transport.request(
      {
        host: '127.0.0.1',
        port: client.port,
        path: endpoint,
        method,
        headers,
        rejectUnauthorized: false,
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error('LCU 请求超时')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function works(client) {
  try {
    const res = await request(client, 'GET', '/lol-gameflow/v1/gameflow-phase');
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Find the local League Client and prove the credentials work before
 * returning them. Normal users can connect to the LCU, but the command line
 * of an elevated Tencent client is only readable from an elevated process,
 * so the launcher asks for administrator rights.
 */
async function discoverClient(config, log) {
  for (const lockfile of candidateLockfiles(config)) {
    let text;
    try {
      text = fs.readFileSync(lockfile, 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const info = parseLockfile(text);
    if (!info) continue;
    const client = { ...info, source: `lockfile ${lockfile}` };
    if (await works(client)) {
      log(`已通过 lockfile 连接客户端: ${lockfile}`);
      return client;
    }
  }

  if (!isElevated()) {
    log('lockfile 不可用，且当前不是管理员权限；尝试读取客户端命令行大概率会失败。');
  }

  for (const processName of ['LeagueClientUx.exe', 'LeagueClient.exe']) {
    let commandLine = '';
    try {
      commandLine = runPowerShell(
        `(Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Select-Object -First 1).CommandLine`,
      );
    } catch {
      continue;
    }
    const info = parseLeagueClientCommandLine(commandLine);
    if (!info) continue;
    const client = { ...info, source: `进程 ${processName}` };
    if (await works(client)) {
      log(`已通过客户端进程连接到 LCU: ${processName} (端口 ${client.port})`);
      return client;
    }
  }

  throw new Error(
    '找不到可用的 League Client。请确认客户端已经登录，然后以管理员身份运行 start.bat。',
  );
}

async function getChampSelectSession(client) {
  const res = await request(client, 'GET', '/lol-champ-select/v1/session');
  if (res.status === 404 || res.status === 204 || !res.body.trim()) return null;
  if (res.status !== 200) {
    throw new Error(`读取选人会话失败: HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

async function getChampionNames(client) {
  for (const endpoint of [
    '/lol-game-data/assets/v1/champion-summary.json',
    '/lol-champions/v1/owned-champions-minimal',
  ]) {
    try {
      const res = await request(client, 'GET', endpoint);
      if (res.status === 200 && res.body.trim()) {
        const names = normalizeChampionSummary(JSON.parse(res.body));
        if (names.size > 0) return names;
      }
    } catch {
      // Try the next endpoint.
    }
  }
  return new Map();
}

/** Full champion catalog (id, localized name, icon path) for the web UI. */
async function getChampionCatalog(client) {
  try {
    const res = await request(client, 'GET', '/lol-game-data/assets/v1/champion-summary.json');
    if (res.status !== 200 || !res.body.trim()) return [];
    const data = JSON.parse(res.body);
    const entries = Array.isArray(data) ? data : Object.values(data);
    const catalog = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const id = Number(entry.id ?? entry.championId);
      if (!Number.isInteger(id) || id <= 0) continue;
      catalog.push({
        id,
        name: String(entry.name || entry.alias || id),
        alias: String(entry.alias || ''),
        icon: String(entry.squarePortraitPath || entry.portraitPath || ''),
      });
    }
    catalog.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return catalog;
  } catch {
    return [];
  }
}

/** Binary LCU request, used to proxy champion portraits to the web UI. */
function requestBuffer(client, endpoint) {
  return new Promise((resolve, reject) => {
    const transport = client.protocol === 'http' ? http : https;
    const req = transport.request(
      {
        host: '127.0.0.1',
        port: client.port,
        path: endpoint,
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`riot:${client.password}`).toString('base64')}`,
        },
        rejectUnauthorized: false,
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || 'application/octet-stream',
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('LCU 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  discoverClient,
  getChampSelectSession,
  getChampionNames,
  getChampionCatalog,
  request,
  requestBuffer,
  isElevated,
};
