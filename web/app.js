'use strict';

const STATIC_MODE = new URLSearchParams(window.location.search).has('static');
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
const firstChar = (name) => [...String(name || '?')][0] || '?';
const iconUrl = (id) => `/api/champion-icon/${id}`;

const state = {
  status: null,
  config: null,
  catalog: [],
  logs: [],
  lastLogSeq: 0,
  wishlist: [],
  renderedWishlistKey: '',
  settingsLoaded: false,
  dragging: false,
  toastTimer: null,
  es: null,
  friends: [],
  friendsError: '',
  clientCardsKey: '',
  idleWishKey: '',
};

function champIcon(id, name, size = '') {
  if (!id) {
    return `<span class="champ-icon ${size} placeholder"><span class="fallback-letter">?</span></span>`;
  }
  return `<span class="champ-icon ${size}" title="${esc(name)}">
    <img src="${iconUrl(id)}" alt="" loading="lazy"
      onerror="this.style.display='none';this.parentElement.classList.add('fallback')">
    <span class="fallback-letter">${esc(firstChar(name))}</span>
  </span>`;
}

function tradeStateInfo(state) {
  switch (String(state || '').toUpperCase()) {
    case 'AVAILABLE':
      return { key: 'available', label: '可交换' };
    case 'BUSY':
      return { key: 'busy', label: '交换中' };
    case 'SENT':
    case 'REQUESTED':
      return { key: 'busy', label: '已请求' };
    case 'ACCEPTED':
      return { key: 'accepted', label: '已接受' };
    case 'INVALID':
      return {
        key: 'invalid',
        label: '不可交换',
        hint: '客户端判定当前不可交换，可能是队友未拥有该英雄或阶段限制',
      };
    case 'DECLINED':
    case 'CANCELLED':
    case 'CANCELED':
      return { key: 'idle', label: '已取消' };
    default:
      return {
        key: 'idle',
        label: '无交易',
        hint: '当前没有可用的交换请求',
      };
  }
}

function nameOf(id) {
  const number = Number(id);
  const statusHit =
    state.status?.wishlist?.find((item) => item.id === number) ||
    state.status?.bench?.find((item) => item.id === number) ||
    (state.status?.held?.id === number ? state.status.held : null);
  if (statusHit?.name) return statusHit.name;
  const catalogHit = state.catalog.find((item) => item.id === number);
  return catalogHit?.name || String(number);
}

function fmtTime(at) {
  if (!at) return '';
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

const FLOW_LABELS = {
  None: '空闲',
  Lobby: '房间',
  Matchmaking: '匹配中',
  ReadyCheck: '准备确认',
  ChampSelect: '选人',
  GameStart: '游戏开始',
  InProgress: '游戏中',
  Reconnect: '重连中',
  WaitingForStats: '结算中',
  PreEndOfGame: '结算中',
  EndOfGame: '对局结束',
};

function flowLabel(phase) {
  return FLOW_LABELS[phase] || phase || '--';
}

const PHASE_LABELS = {
  PLANNING: '预选阶段',
  BAN_PICK: '选择阶段',
  FINALIZATION: '最终确认',
  GAME_STARTING: '即将开始',
};

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || phase || '';
}

function showConfirm(message, options = {}) {
  const modal = $('confirmModal');
  if (!modal) return Promise.resolve(window.confirm(message));

  const title = $('confirmTitle');
  const messageEl = $('confirmMessage');
  const okBtn = $('confirmOk');
  const cancelBtn = $('confirmCancel');
  title.textContent = options.title || '确认';
  messageEl.textContent = message;
  okBtn.textContent = options.okText || '确定';
  cancelBtn.textContent = options.cancelText || '取消';
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      document.body.classList.remove('modal-open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.querySelectorAll('[data-close-confirm]').forEach((element) => {
        element.removeEventListener('click', onCancel);
      });
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        cleanup(true);
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.querySelectorAll('[data-close-confirm]').forEach((element) => {
      element.addEventListener('click', onCancel);
    });
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

function showToast(message, kind = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.style.borderColor =
    kind === 'error' ? 'rgba(255,107,107,.45)' : 'rgba(10,200,185,.35)';
  toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add('hidden'), kind === 'error' ? 4200 : 2400);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok: response.ok, status: response.status, data };
}

async function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setConnection(connected, label) {
  const pill = $('conn');
  pill.textContent = label || (connected ? '已连接' : '未连接');
  pill.className = `pill ${connected ? 'online' : 'offline'}`;
}

function renderStatus(s) {
  if (!s) return;
  state.status = s;

  setConnection(s.connected, s.connected ? '已连接' : '未连接');
  const statusDot = $('statusDot');
  if (statusDot) {
    statusDot.className = `status-dot ${
      !s.connected ? 'off' : s.pluginOnline ? 'ok' : 'warn'
    }`;
  }
  const phase = $('phase');
  const flow = flowLabel(s.gameflowPhase);
  phase.textContent = s.phase
    ? phaseLabel(s.phase)
    : s.gameflowPhase
      ? flow
      : '等待选人';
  phase.className = `pill phase${s.phase || s.gameflowPhase ? ' active' : ''}`;
  $('phaseHint').textContent = phaseLabel(s.phase) || '选人阶段';

  if (s.held) {
    const name = s.held.name || nameOf(s.held.id);
    $('heldIcon').className = 'champ-icon large';
    $('heldIcon').innerHTML = `<img src="${iconUrl(s.held.id)}" alt=""
        onerror="this.style.display='none';this.parentElement.classList.add('fallback')">
      <span class="fallback-letter">${esc(firstChar(name))}</span>`;
    $('heldName').textContent = name;
    $('heldMeta').textContent = [
      s.phase ? `阶段 ${phaseLabel(s.phase)}` : null,
      s.queueId ? `队列 ${s.queueId}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  } else {
    $('heldIcon').className = 'champ-icon large placeholder';
    $('heldIcon').innerHTML = '<span class="fallback-letter">?</span>';
    $('heldName').textContent = '未进入选人';
    $('heldMeta').textContent = s.connected ? '等待进入大乱斗选人喵...' : '等待客户端喵...';
  }

  const timeLeft = s.timeLeft;
  const hextechQueueId = Number(s.hextechQueueId) || 2400;
  if (s.queueId === hextechQueueId && s.phase === 'BAN_PICK') {
    $('timerLabel').textContent = '距可换人约';
  } else if (s.queueId === hextechQueueId && s.phase === 'FINALIZATION') {
    $('timerLabel').textContent = '可换人剩余';
  } else if (s.phase === 'FINALIZATION') {
    $('timerLabel').textContent = '即将开始';
  } else {
    $('timerLabel').textContent = '阶段剩余';
  }
  if (s.isInfinite) {
    $('timer').textContent = '∞';
  } else if (timeLeft === null || timeLeft === undefined) {
    $('timer').textContent = '--';
  } else {
    $('timer').textContent = `${Math.max(0, Math.ceil(timeLeft / 1000))} 秒`;
  }
  $('timer').classList.toggle(
    'urgent',
    !s.isInfinite &&
      typeof timeLeft === 'number' &&
      timeLeft >= 0 &&
      timeLeft <= 5000,
  );

  if (s.bench?.length) {
    const wishRanks = new Map(
      (s.wishlist || []).map((item, index) => [item.id, index + 1]),
    );
    const pendingId = Number(s.pendingSwap?.id) || 0;
    $('bench').innerHTML = s.bench
      .map((champion) => {
        const rank = wishRanks.get(champion.id);
        const pending = champion.id === pendingId;
        const title = pending
          ? `已预约 ${champion.name}，等 FINALIZATION 自动尝试`
          : `点击换到 ${champion.name}${rank ? ` · 心愿英雄优先级 #${rank}` : ''}`;
        return `<button class="bench-item${rank ? ' wish' : ''}${
          pending ? ' pending' : ''
        }" data-champ="${champion.id}" title="${esc(title)}">
            ${rank ? `<span class="wish-badge">#${rank}</span>` : ''}
            ${pending ? '<span class="pending-badge">预约</span>' : ''}
            ${champIcon(champion.id, champion.name)}
            <span>${esc(champion.name)}</span>
          </button>`;
      })
      .join('');
  } else {
    $('bench').innerHTML = '<div class="empty">备选席还是空的喵...</div>';
  }
  $('benchCount').textContent = s.bench?.length ? `${s.bench.length} 个` : '空';

  const idle = !s.phase;
  $('idlePanel').classList.toggle('hidden', !idle);
  $('benchHead').classList.toggle('hidden', idle);
  $('bench').classList.toggle('hidden', idle);
  if (idle) {
    const wishlist = s.wishlist || [];
    const wishKey = wishlist.map((champion) => champion.id).join(',');
    if (state.idleWishKey !== wishKey) {
      state.idleWishKey = wishKey;
      $('idleWishlist').innerHTML = wishlist
        .map(
          (champion, index) => `<span class="idle-wish-chip">
            <span class="rank">#${index + 1}</span>
            ${champIcon(champion.id, champion.name)}
            <span>${esc(champion.name)}</span>
          </span>`,
        )
        .join('');
    }
  } else {
    state.idleWishKey = '';
  }

  const clientCards = (s.clientCards || []).filter((card) => card && card.id && card.name);
  const cardsFresh = s.clientCardsAt && Date.now() - s.clientCardsAt < 15000;
  const clientCardsKey = clientCards.map((card) => `${card.id}:${card.name}`).join('|');
  if (clientCards.length && cardsFresh) {
    if (state.clientCardsKey !== clientCardsKey) {
      state.clientCardsKey = clientCardsKey;
      $('clientCards').innerHTML =
        '<span class="client-cards-label">客户端三选一 · 点这里让插件替你点客户端</span>' +
        clientCards
          .map(
            (card, index) => `<button class="client-card-chip" data-client-id="${card.id}"
                data-client-name="${esc(card.name)}" data-client-index="${index}"
                title="让客户端插件点「${esc(card.name)}」">
                ${champIcon(card.id, card.name)}
                <span class="client-card-name">${esc(card.name)}</span>
                <span class="choose">选它</span>
              </button>`,
          )
          .join('');
    }
    $('clientCards').classList.remove('hidden');
  } else {
    state.clientCardsKey = '';
    $('clientCards').classList.add('hidden');
    $('clientCards').innerHTML = '';
  }

  const benchIds = new Set((s.bench || []).map((champion) => champion.id));
  const extraCandidates = (s.candidates || []).filter(
    (champion) => !benchIds.has(champion.id) && champion.id !== s.held?.id,
  );
  if (extraCandidates.length) {
    $('candidates').classList.remove('hidden');
    $('candidates').innerHTML =
      '<span class="candidate-label">待选</span>' +
      extraCandidates
        .map(
          (champion) => `<button class="candidate-chip" data-champ="${champion.id}"
              title="选择 ${esc(champion.name)}">
              ${champIcon(champion.id, champion.name)}
              <span>${esc(champion.name)}</span>
            </button>`,
        )
        .join('');
  } else {
    $('candidates').classList.add('hidden');
    $('candidates').innerHTML = '';
  }

  const teammates = Array.isArray(s.teammates) ? s.teammates : [];
  if (s.phase && teammates.length) {
    const counts = {};
    const cards = teammates
      .map((mate) => {
        const info = tradeStateInfo(mate.tradeState);
        counts[info.key] = (counts[info.key] || 0) + 1;
        const clickable =
          mate.tradeState === 'AVAILABLE' && Number(mate.tradeId) > 0;
        const tag = clickable ? 'button' : 'div';
        const attrs = clickable
          ? `type="button" data-trade="${Number(mate.tradeId)}"`
          : '';
        const championName = mate.champion?.id
          ? mate.champion.name
          : '未选英雄';
        const title = `召唤师ID ${mate.summonerId || '?'} · ${championName} · ${
          info.label
        }${info.hint ? ` · ${info.hint}` : ''}`;
        return `<${tag} class="teammate-card ${info.key}" ${attrs}
            title="${esc(title)}">
            ${champIcon(mate.champion?.id, championName)}
            <span class="teammate-info">
              <span class="teammate-name">${esc(mate.name)}</span>
              <span class="teammate-champ">${esc(championName)}</span>
            </span>
            <span class="trade-state ${info.key}">${info.label}</span>
          </${tag}>`;
      })
      .join('');
    const summary = [];
    if (counts.available) summary.push(`可交换 ${counts.available}`);
    if (counts.accepted) summary.push(`已接受 ${counts.accepted}`);
    if (counts.busy) summary.push(`交换中 ${counts.busy}`);
    if (counts.invalid) summary.push(`不可交换 ${counts.invalid}`);
    if (!summary.length) summary.push('暂无进行中的交易');
    $('teammates').innerHTML =
      '<span class="teammate-strip-label">队友</span>' +
      cards +
      `<span class="teammate-summary">${esc(summary.join(' · '))}</span>`;
    $('teammates').classList.remove('hidden');
  } else {
    $('teammates').classList.add('hidden');
    $('teammates').innerHTML = '';
  }

  $('connDetail').textContent = s.client
    ? `127.0.0.1:${s.client.port}`
    : '尚未连接';
  $('pluginDetail').textContent = s.pluginOnline
    ? `已连接${s.pluginVersion ? ` · v${s.pluginVersion}` : ''}`
    : '未连接（重启客户端加载插件）';
  $('pluginDetail').className = s.pluginOnline ? 'presence-chat' : 'muted';
  $('flowDetail').textContent = flow;
  const presenceLabels = {
    chat: '在线',
    away: '离开',
    dnd: '勿扰',
    mobile: '手机在线',
    offline: '离线',
  };
  if (s.presence) {
    const availability = s.presence.availability || 'chat';
    $('presenceDetail').textContent = `${
      presenceLabels[availability] || availability
    }${s.presence.statusMessage ? ` · ${s.presence.statusMessage}` : ''}`;
    $('presenceDetail').className = `presence-${availability}`;
  } else {
    $('presenceDetail').textContent = '--';
    $('presenceDetail').className = '';
  }
  $('lobbyDetail').textContent = s.inLobby
    ? `房间 ${s.lobby?.size || '?'} 人${
        s.lobby?.queueId ? ` · 队列 ${s.lobby.queueId}` : ''
      }${s.lobby?.isLeader === true ? ' · 房主' : ''}`
    : '不在房间';
  $('leaveLobbyBtn').classList.toggle('hidden', !s.inLobby);

  const createLobbyBtn = $('createLobbyBtn');
  const findMatchBtn = $('findMatchBtn');
  const lobbyHint = $('lobbyHint');
  if (createLobbyBtn && findMatchBtn && lobbyHint) {
    const busyPhases = [
      'Matchmaking',
      'ReadyCheck',
      'ChampSelect',
      'GameStart',
      'InProgress',
      'Reconnect',
      'WaitingForStats',
      'PreEndOfGame',
      'EndOfGame',
    ];
    const canCreate =
      s.connected && !s.inLobby && !busyPhases.includes(s.gameflowPhase);
    const canFind =
      s.connected &&
      s.inLobby &&
      s.lobby?.queueId === hextechQueueId &&
      s.lobby?.isLeader !== false &&
      ![
        'Matchmaking',
        'ReadyCheck',
        'ChampSelect',
        'GameStart',
        'InProgress',
        'Reconnect',
      ].includes(s.gameflowPhase);
    createLobbyBtn.disabled = !canCreate;
    findMatchBtn.disabled = !canFind;

    let hint = '创建房间后可以开始匹配';
    if (!s.connected) {
      hint = '客户端未连接';
    } else if (s.inLobby) {
      if (s.lobby?.queueId !== hextechQueueId) {
        hint = '当前房间不是海克斯大乱斗';
      } else if (s.lobby?.isLeader === false) {
        hint = '只有房主能开始匹配';
      } else if (s.gameflowPhase === 'Matchmaking') {
        hint = '正在寻找对局...';
      } else if (s.gameflowPhase === 'ReadyCheck') {
        hint = '准备确认中...';
      } else if (
        ['ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(
          s.gameflowPhase,
        )
      ) {
        hint = '游戏/选人中不能开始匹配';
      } else {
        hint = '房间已就绪 · 可以开始匹配';
      }
    } else if (busyPhases.includes(s.gameflowPhase)) {
      hint = '游戏/选人中不能创建房间';
    }
    lobbyHint.textContent = hint;
  }

  const extras = [];
  if (s.autoPlayAgain) extras.push('自动返回');
  if (s.autoAccept) extras.push('自动接受');
  if (s.autoSelectCandidate) extras.push('待选自动');
  if (s.autoPickClientCard) extras.push('三选一自动');
  $('modeDetail').textContent = `${s.dryRun ? '练习模式' : '自动换人'}${
    s.paused ? ' · 已暂停' : ''
  }${extras.length ? ` · ${extras.join(' / ')}` : ''}`;
  $('gameDetail').textContent = `队列 ${s.queueId ?? '--'} / 对局 ${s.gameId ?? '--'}`;
  if (s.lastAction) {
    const action = s.lastAction;
    const when = fmtTime(action.at);
    const mark = action.ok ? '✅' : '⚠️';
    $('lastAction').textContent = `${mark} ${action.manual ? '手动 · ' : ''}${
      action.message || action.target?.name || '--'
    }${when ? ` · ${when}` : ''}`;
  } else {
    $('lastAction').textContent = '暂无动作';
  }

  $('pauseBtn').textContent = s.paused ? '恢复自动' : '暂停自动';

  const ids = (s.wishlist || []).map((item) => item.id);
  const key = ids.join(',');
  if (!state.dragging && key !== state.renderedWishlistKey) {
    state.wishlist = ids;
    renderWishlist(s.wishlist || []);
  }

  if (!state.settingsLoaded && s.config) {
    loadSettings(s.config);
    state.settingsLoaded = true;
  }

  if (
    s.connected &&
    (state.catalog.length === 0 ||
      (s.catalogSize && state.catalog.length !== s.catalogSize))
  ) {
    refreshCatalog();
  }
}

function renderWishlist(list) {
  const ids = list.map((item) => item.id);
  state.renderedWishlistKey = ids.join(',');
  state.wishlist = ids;

  if (!list.length) {
    $('wishlist').innerHTML = '<div class="empty">还没有心愿英雄喵</div>';
    return;
  }

  $('wishlist').innerHTML = list
    .map(
      (champion, index) => `<div class="wish-item" draggable="true" data-id="${champion.id}">
        <span class="rank">${index + 1}</span>
        ${champIcon(champion.id, champion.name || nameOf(champion.id))}
        <span class="name">${esc(champion.name || nameOf(champion.id))}</span>
        <span class="wish-actions">
          <button data-act="up" title="上移">↑</button>
          <button data-act="down" title="下移">↓</button>
          <button data-act="remove" title="移除">×</button>
        </span>
      </div>`,
    )
    .join('');

  let dragId = null;
  for (const item of $('wishlist').querySelectorAll('.wish-item')) {
    item.addEventListener('dragstart', (event) => {
      dragId = Number(item.dataset.id);
      state.dragging = true;
      item.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragId));
    });
    item.addEventListener('dragend', () => {
      state.dragging = false;
      item.classList.remove('dragging');
      dragId = null;
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const targetId = Number(item.dataset.id);
      if (!dragId || dragId === targetId) return;
      const ids = [...state.wishlist];
      const from = ids.indexOf(dragId);
      let to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      const [moved] = ids.splice(from, 1);
      if (from < to) to -= 1;
      ids.splice(to, 0, moved);
      saveWishlist(ids);
    });
  }
}

async function saveWishlist(ids) {
  state.wishlist = ids;
  renderWishlist(ids.map((id) => ({ id, name: nameOf(id) })));
  try {
    const result = await postJson('/api/config', { wishlist: ids });
    if (!result.ok) throw new Error(result.data?.message || `HTTP ${result.status}`);
    state.config = result.data.config;
    showToast('心愿顺序已保存喵');
  } catch (error) {
    showToast(`保存失败: ${error.message}`, 'error');
  }
}

function moveWishlist(id, delta) {
  const ids = [...state.wishlist];
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  saveWishlist(ids);
}

function removeWishlist(id) {
  saveWishlist(state.wishlist.filter((item) => item !== id));
}

async function addChampion(id) {
  if (state.wishlist.includes(id)) {
    showToast('这个英雄已经在心愿列表里了喵');
    return;
  }
  if (state.wishlist.length >= 20) {
    showToast('最多 20 个心愿英雄喵', 'error');
    return;
  }
  await saveWishlist([...state.wishlist, id]);
  $('search').value = '';
  hideSearch();
}

function renderSearchResults() {
  const query = $('search').value.trim().toLowerCase();
  const results = $('searchResults');
  if (!query) {
    hideSearch();
    return;
  }
  if (state.catalog.length === 0) {
    results.innerHTML = '<div class="empty">英雄列表还在加载，等客户端连上喵...</div>';
    results.classList.remove('hidden');
    return;
  }

  const matches = state.catalog
    .filter((champion) => !state.wishlist.includes(champion.id))
    .filter((champion) => {
      const name = String(champion.name || '').toLowerCase();
      const alias = String(champion.alias || '').toLowerCase();
      return name.includes(query) || alias.includes(query) || String(champion.id) === query;
    })
    .slice(0, 12);

  if (!matches.length) {
    results.innerHTML = '<div class="empty">没有找到匹配的英雄喵</div>';
    results.classList.remove('hidden');
    return;
  }

  results.innerHTML = matches
    .map(
      (champion) => `<button type="button" data-add="${champion.id}">
        ${champIcon(champion.id, champion.name)}
        <span>${esc(champion.name)}</span>
        <span class="muted">#${champion.id}</span>
      </button>`,
    )
    .join('');
  results.classList.remove('hidden');
}

function hideSearch() {
  $('searchResults').classList.add('hidden');
}

async function refreshCatalog() {
  try {
    const result = await requestJson('/api/champions');
    if (result.ok && Array.isArray(result.data)) {
      state.catalog = result.data;
    }
  } catch {
    // The client may still be connecting.
  }
}

const QUEUE_NAMES = {
  400: '匹配',
  420: '单双排',
  430: '匹配',
  440: '灵活排位',
  450: '大乱斗',
  1700: '斗魂竞技场',
  1710: '斗魂竞技场',
  2400: '海克斯大乱斗',
};

function queueLabel(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.includes('KIWI')) return '海克斯大乱斗';
  if (text.includes('ARAM')) return '大乱斗';
  if (text.includes('RANKED_SOLO')) return '单双排';
  if (text.includes('RANKED_FLEX')) return '灵活排位';
  if (text.includes('ARENA')) return '斗魂竞技场';
  return '';
}

function queueLabelById(id) {
  return QUEUE_NAMES[Number(id)] || '';
}

function friendStatus(friend) {
  const game = String(friend.gameStatus || '').toLowerCase();
  let label;
  let className = '';

  if (friend.inMyParty) {
    label = '同房间';
  } else if (game === 'inprogress' || game === 'ingame') {
    label = '游戏中';
    className = 'in-game';
  } else if (game === 'championselect') {
    label = '选人中';
    className = 'in-game';
  } else if (game === 'inqueue') {
    label = '队列中';
    className = 'in-room';
  } else if (game === 'spectating') {
    label = '观战中';
  } else if (game.startsWith('hosting')) {
    label = '开房间';
    className = 'in-room';
  } else if (game === 'outofgame') {
    label = friend.partyId ? '房间' : '空闲';
    className = friend.partyId ? 'in-room' : '';
  } else {
    label = friend.gameStatus || '在线';
  }

  if (['inprogress', 'ingame', 'championselect', 'inqueue'].includes(game)) {
    const mode = queueLabel(friend.gameQueueType) || queueLabelById(friend.queueId);
    if (mode) label += ` · ${mode}`;
  }
  if (friend.availability === 'dnd') label += ' · 勿扰';
  else if (friend.availability === 'away') label += ' · 离开';

  return { label, className };
}

function renderFriends() {
  const container = $('friends');
  if (state.friendsError) {
    container.innerHTML = `<div class="empty">${esc(state.friendsError)}</div>`;
    return;
  }
  if (!state.friends.length) {
    container.innerHTML = '<div class="empty">没有在线好友喵</div>';
    return;
  }

  const joinable = state.friends.filter((friend) => friend.joinable);
  const header = joinable.length
    ? ''
    : '<div class="empty">暂时没有可加入的好友房间喵</div>';

  container.innerHTML =
    header +
    state.friends
      .map((friend) => {
        const status = friendStatus(friend);
        return `<div class="friend-card ${friend.joinable ? 'joinable' : ''}">
          <span class="friend-avatar">${esc(firstChar(friend.name))}</span>
          <div class="friend-info">
            <span class="friend-name" title="${esc(friend.name)}">${esc(friend.name)}</span>
            <span class="friend-status ${status.className}">${esc(status.label)}</span>
          </div>
          ${
            friend.joinable
              ? `<button class="btn small" data-join="${esc(friend.partyId)}"
                   data-name="${esc(friend.name)}">加入</button>`
              : `<span class="friend-lock">${friend.inMyParty ? '已在大厅' : '不可加入'}</span>`
          }
        </div>`;
      })
      .join('');
}

async function loadFriends() {
  try {
    const result = await requestJson('/api/friends');
    if (result.ok && result.data?.ok) {
      state.friends = result.data.friends || [];
      state.friendsError = '';
    } else {
      state.friends = [];
      state.friendsError =
        result.data?.message || `读取好友失败: HTTP ${result.status}`;
    }
  } catch (error) {
    state.friends = [];
    state.friendsError = error.message;
  }
  renderFriends();
}

async function createLobby() {
  try {
    showToast('正在创建海克斯大乱斗房间喵...');
    const result = await postJson('/api/create-lobby', {});
    if (result.ok) {
      showToast(result.data?.message || '已创建海克斯大乱斗房间喵');
      refreshStatus();
    } else {
      showToast(result.data?.message || '创建房间失败喵', 'error');
    }
  } catch (error) {
    showToast(`创建房间失败: ${error.message}`, 'error');
  }
}

async function findMatch() {
  if (
    !(await showConfirm(
      '确认开始寻找海克斯大乱斗对局喵？整个房间会进入匹配。',
      { title: '寻找对局', okText: '开始匹配' },
    ))
  ) {
    return;
  }
  try {
    showToast('正在开始寻找对局喵...');
    const result = await postJson('/api/find-match', {});
    if (result.ok) {
      showToast(result.data?.message || '开始寻找对局喵');
      refreshStatus();
    } else {
      showToast(result.data?.message || '开始匹配失败喵', 'error');
    }
  } catch (error) {
    showToast(`开始匹配失败: ${error.message}`, 'error');
  }
}

async function joinFriend(partyId, name) {
  try {
    showToast(`正在加入 ${name} 的房间喵...`);
    const result = await postJson('/api/join', { partyId });
    if (result.ok) {
      showToast(`已加入 ${name} 的房间喵`);
      await loadFriends();
      refreshStatus();
    } else {
      showToast(result.data?.message || '加入失败喵', 'error');
    }
  } catch (error) {
    showToast(`加入失败: ${error.message}`, 'error');
  }
}

function loadSettings(config) {
  if (!config) return;
  $('startupDelayMs').value = config.startupDelayMs ?? 2500;
  $('stablePolls').value = config.stablePolls ?? 4;
  $('minTimeLeftMs').value = config.minTimeLeftMs ?? 1000;
  $('maxRetries').value = config.maxRetries ?? 4;
  $('acceptDelayMs').value = config.acceptDelayMs ?? 1500;
  $('playAgainDelayMs').value = config.playAgainDelayMs ?? 3000;
  $('autoPlayAgain').checked = config.autoPlayAgain !== false;
  $('autoAccept').checked = config.autoAccept !== false;
  $('autoSelectCandidate').checked = config.autoSelectCandidate !== false;
  $('autoPickClientCard').checked = config.autoPickClientCard !== false;
  $('benchBurstMode').checked = config.benchBurstMode !== false;
  $('dryRun').checked = Boolean(config.dryRun);
}

async function openSettings() {
  try {
    const result = await requestJson('/api/config');
    if (result.ok && result.data) {
      state.config = result.data;
      loadSettings(result.data);
      state.settingsLoaded = true;
    }
  } catch {
    // Keep the values already on screen.
  }
  $('settingsModal').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function saveSettings() {
  const payload = {
    startupDelayMs: Number($('startupDelayMs').value),
    stablePolls: Number($('stablePolls').value),
    minTimeLeftMs: Number($('minTimeLeftMs').value),
    maxRetries: Number($('maxRetries').value),
    acceptDelayMs: Number($('acceptDelayMs').value),
    playAgainDelayMs: Number($('playAgainDelayMs').value),
    autoPlayAgain: $('autoPlayAgain').checked,
    autoAccept: $('autoAccept').checked,
    autoSelectCandidate: $('autoSelectCandidate').checked,
    autoPickClientCard: $('autoPickClientCard').checked,
    benchBurstMode: $('benchBurstMode').checked,
    dryRun: $('dryRun').checked,
  };
  try {
    const result = await postJson('/api/config', payload);
    if (!result.ok) throw new Error(result.data?.message || `HTTP ${result.status}`);
    state.config = result.data.config;
    loadSettings(state.config);
    closeSettings();
    showToast('设置已保存喵');
  } catch (error) {
    showToast(`保存失败: ${error.message}`, 'error');
  }
}

async function togglePause() {
  const paused = !state.status?.paused;
  try {
    const result = await postJson('/api/pause', { paused });
    if (!result.ok) throw new Error(result.data?.message || `HTTP ${result.status}`);
    if (state.status) state.status.paused = paused;
    $('pauseBtn').textContent = paused ? '恢复自动' : '暂停自动';
    showToast(paused ? '自动换人已暂停喵' : '自动换人已恢复喵');
  } catch (error) {
    showToast(`操作失败: ${error.message}`, 'error');
  }
}

async function manualSwap(id) {
  try {
    const result = await postJson('/api/swap', { championId: id });
    if (result.ok) {
      showToast(result.data?.message || `已确认换到 ${nameOf(id)} 喵`);
    } else {
      showToast(result.data?.message || '换人没有落地喵', 'error');
    }
    refreshStatus();
  } catch (error) {
    showToast(`换人失败: ${error.message}`, 'error');
    refreshStatus();
  }
}

async function selectClientCard(id, name, index) {
  if (!id || !name) return;
  try {
    const result = await postJson('/api/client-card-select', { id, name, index });
    if (result.ok) {
      showToast(`已让客户端插件选 ${name} 喵，盯着客户端看`);
    } else {
      showToast(result.data?.message || '代选请求失败喵', 'error');
    }
  } catch (error) {
    showToast(`代选失败: ${error.message}`, 'error');
  }
}

async function manualTrade(tradeId) {
  try {
    const result = await postJson('/api/trade-accept', { tradeId });
    if (result.ok) {
      showToast(result.data?.message || '已接受队友交易喵');
    } else {
      showToast(result.data?.message || '接受交易失败喵', 'error');
    }
    refreshStatus();
  } catch (error) {
    showToast(`接受交易失败: ${error.message}`, 'error');
    refreshStatus();
  }
}

function appendLog(entry) {
  if (!entry || entry.seq <= state.lastLogSeq) return;
  state.lastLogSeq = entry.seq;
  const line = document.createElement('div');
  line.className = `log-line ${entry.level || 'info'}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = fmtTime(entry.at);
  line.append(time, document.createTextNode(entry.message));
  const log = $('log');
  log.appendChild(line);
  while (log.childElementCount > 500) log.firstElementChild.remove();
  if ($('autoScroll').checked) log.scrollTop = log.scrollHeight;
}

function connectSSE() {
  if (!('EventSource' in window)) return;
  const source = new EventSource('/api/events');
  state.es = source;
  source.addEventListener('status', (event) => {
    try {
      renderStatus(JSON.parse(event.data));
    } catch {
      // Ignore a malformed frame.
    }
  });
  source.addEventListener('log', (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch {
      // Ignore.
    }
  });
  source.onopen = () => setConnection(true, '已连接');
  source.onerror = () => setConnection(false, '重连中');
}

async function refreshStatus() {
  try {
    const result = await requestJson('/api/status');
    if (result.ok) renderStatus(result.data);
  } catch {
    setConnection(false, '未连接');
  }
}

async function boot() {
  bindEvents();

  const [statusRes, configRes, catalogRes, logRes] = await Promise.all([
    requestJson('/api/status').catch(() => ({ ok: false })),
    requestJson('/api/config').catch(() => ({ ok: false })),
    requestJson('/api/champions').catch(() => ({ ok: false })),
    requestJson('/api/log?since=0').catch(() => ({ ok: false })),
  ]);

  if (catalogRes.ok && Array.isArray(catalogRes.data)) state.catalog = catalogRes.data;
  if (configRes.ok && configRes.data) {
    state.config = configRes.data;
    loadSettings(state.config);
    state.settingsLoaded = true;
  }
  if (logRes.ok && Array.isArray(logRes.data?.logs)) {
    logRes.data.logs.forEach(appendLog);
  }
  if (statusRes.ok) renderStatus(statusRes.data);
  if (state.status?.connected && state.catalog.length === 0) refreshCatalog();

  await loadFriends();

  if (STATIC_MODE && new URLSearchParams(window.location.search).has('settings')) {
    openSettings();
  }

  if (!STATIC_MODE) {
    connectSSE();
    setInterval(refreshStatus, 5000);
    setInterval(loadFriends, 15000);
  }
}

function bindEvents() {
  $('pauseBtn').addEventListener('click', togglePause);
  $('saveSettings').addEventListener('click', saveSettings);

  const statusBtn = $('statusBtn');
  const statusPopover = $('statusPopover');
  const closeStatusPopover = () => {
    if (!statusBtn || !statusPopover) return;
    statusPopover.classList.add('hidden');
    statusBtn.classList.remove('open');
    statusBtn.setAttribute('aria-expanded', 'false');
  };
  if (statusBtn && statusPopover) {
    statusBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = statusPopover.classList.contains('hidden');
      statusPopover.classList.toggle('hidden', !willOpen);
      statusBtn.classList.toggle('open', willOpen);
      statusBtn.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (event) => {
      if (statusPopover.classList.contains('hidden')) return;
      if (statusPopover.contains(event.target) || statusBtn.contains(event.target)) return;
      closeStatusPopover();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeStatusPopover();
    });
  }

  $('leaveLobbyBtn').addEventListener('click', async () => {
    if (
      !(await showConfirm(
        '确认离开当前房间喵？如果你是房主，队伍可能会解散。',
        { title: '离开房间', okText: '离开' },
      ))
    ) {
      return;
    }
    const result = await postJson('/api/leave-lobby', {});
    if (result.ok) showToast('已离开房间喵');
    else showToast(result.data?.message || '离开失败', 'error');
  });
  $('settingsBtn').addEventListener('click', openSettings);
  document.querySelectorAll('[data-close-settings]').forEach((element) => {
    element.addEventListener('click', closeSettings);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettings();
  });

  $('wishlist').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('.wish-item');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (button.dataset.act === 'up') moveWishlist(id, -1);
    if (button.dataset.act === 'down') moveWishlist(id, 1);
    if (button.dataset.act === 'remove') removeWishlist(id);
  });

  $('bench').addEventListener('click', (event) => {
    const button = event.target.closest('[data-champ]');
    if (!button) return;
    manualSwap(Number(button.dataset.champ));
  });

  $('teammates').addEventListener('click', (event) => {
    const button = event.target.closest('[data-trade]');
    if (!button) return;
    manualTrade(Number(button.dataset.trade));
  });

  $('clientCards').addEventListener('click', (event) => {
    const button = event.target.closest('[data-client-id]');
    if (!button) return;
    selectClientCard(
      Number(button.dataset.clientId),
      button.dataset.clientName || '',
      Number(button.dataset.clientIndex || 0),
    );
  });

  $('candidates').addEventListener('click', (event) => {
    const tradeButton = event.target.closest('[data-trade]');
    if (tradeButton) {
      manualTrade(Number(tradeButton.dataset.trade));
      return;
    }
    const button = event.target.closest('[data-champ]');
    if (!button) return;
    manualSwap(Number(button.dataset.champ));
  });

  $('refreshFriends').addEventListener('click', loadFriends);
  if ($('createLobbyBtn')) {
    $('createLobbyBtn').addEventListener('click', createLobby);
  }
  if ($('findMatchBtn')) {
    $('findMatchBtn').addEventListener('click', findMatch);
  }
  $('friends').addEventListener('click', (event) => {
    const button = event.target.closest('[data-join]');
    if (!button) return;
    joinFriend(button.dataset.join, button.dataset.name || '好友');
  });

  $('search').addEventListener('input', renderSearchResults);
  $('search').addEventListener('focus', renderSearchResults);
  $('search').addEventListener('blur', () => setTimeout(hideSearch, 180));
  $('searchResults').addEventListener('mousedown', (event) => {
    const button = event.target.closest('[data-add]');
    if (!button) return;
    event.preventDefault();
    addChampion(Number(button.dataset.add));
  });

  $('clearLogs').addEventListener('click', () => {
    $('log').innerHTML = '';
  });

  $('openLogsBtn').addEventListener('click', async () => {
    const result = await postJson('/api/open-logs', {});
    if (result.ok) showToast('已打开日志目录喵');
    else showToast(result.data?.message || '打开日志目录失败', 'error');
  });

  $('exportSessionBtn').addEventListener('click', async () => {
    const result = await requestJson('/api/session');
    if (!result.ok || result.data?.ok === false) {
      showToast(result.data?.message || '当前不在选人阶段喵', 'error');
      return;
    }
    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `lol-session-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('已导出当前选人会话喵');
  });

  $('quitBtn').addEventListener('click', async () => {
    if (
      !(await showConfirm('确认退出助手喵？退出后自动换人会停止。', {
        title: '退出助手',
        okText: '退出',
      }))
    ) {
      return;
    }
    await postJson('/api/shutdown', {});
    closeSettings();
    setConnection(false, '已退出');
    showToast('助手已退出，可以关掉这个页面了喵');
  });
}

boot().catch((error) => {
  setConnection(false, '页面出错');
  showToast(`页面初始化失败: ${error.message}`, 'error');
});
