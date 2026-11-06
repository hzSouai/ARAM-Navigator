/*! ARAM Navigator plugin 0.0.2 — read the three-card screen and click for the web console */
(() => {
  if (window.__aramNavigatorProbe) return;
  window.__aramNavigatorProbe = true;

  const VERSION = '0.0.2';
  const ENDPOINT = 'http://127.0.0.1:8765/api/plugin/cards';
  const COMMANDS_ENDPOINT = 'http://127.0.0.1:8765/api/plugin/commands';
  const RESULT_ENDPOINT = 'http://127.0.0.1:8765/api/plugin/result';
  const HEADING = '选择你的英雄';
  const PATTERNS = [
    /champion-icons\/(\d+)\.png/i,
    /champion-splash(?:es)?\/(\d+)[/.]/i,
    /champion-tiles?\/(\d+)[_.]/i,
    /champion-square\/(\d+)/i,
    /champion-assets\/(\d+)/i,
  ];
  let lastKey = '';
  let lastAt = 0;
  let polling = false;
  let hadHeading = false;
  let lastGoneAt = 0;

  const champId = (text) => {
    if (!text) return null;
    for (const re of PATTERNS) {
      const match = re.exec(text);
      if (match) return Number(match[1]);
    }
    return null;
  };
  const fullTextOf = (el) =>
    String((el && (el.innerText || el.textContent)) || '')
      .replace(/\s+/g, ' ')
      .trim();
  const textOf = (el) => fullTextOf(el).slice(0, 80);

  function rectOf(el) {
    try {
      const rect = el.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? rect : null;
    } catch {
      return null;
    }
  }

  function bgOf(el) {
    try {
      return getComputedStyle(el).backgroundImage || '';
    } catch {
      return '';
    }
  }

  function attrOf(el, name) {
    try {
      return String(el.getAttribute(name) || '');
    } catch {
      return '';
    }
  }

  function isCardLike(el) {
    const marker = `${el.className || ''} ${attrOf(el, 'role')}`;
    return /card|champion|pick|selection|option|choice/i.test(marker);
  }

  function findHeading() {
    let fallback = null;
    for (const el of document.querySelectorAll('div, span, h1, h2, h3, h4, p')) {
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text === HEADING || (text.includes(HEADING) && text.length <= 14)) {
        if (!fallback) fallback = el;
        const rect = rectOf(el);
        if (rect) return el;
      }
    }
    return fallback;
  }

  function scanImages(root) {
    const out = [];
    for (const el of root.querySelectorAll('img, [style]')) {
      const src = el.getAttribute('src') || '';
      const style = el.getAttribute('style') || '';
      const id = champId(src) || champId(style);
      if (!id) continue;
      const card =
        el.closest('[class*="card"], [class*="champion"], [class*="pick"], [class*="selection"]') ||
        el.parentElement ||
        el;
      out.push({
        id,
        text: textOf(card).slice(0, 60),
        cls: String(card.className || el.className || '').slice(0, 120),
        tag: el.tagName,
        src: src.slice(0, 180),
        style: style.slice(0, 180),
      });
    }
    const seen = new Set();
    return out.filter((entry) => {
      const key = `${entry.id}|${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function scanComputed(root, limit = 160) {
    const out = [];
    let seenCount = 0;
    for (const el of root.querySelectorAll('*')) {
      if (seenCount >= limit) break;
      const bg = bgOf(el);
      const id = champId(bg);
      if (!id) continue;
      seenCount += 1;
      out.push({
        id,
        text: textOf(el).slice(0, 60),
        cls: String(el.className || '').slice(0, 120),
        tag: el.tagName,
        src: '',
        style: bg.slice(0, 220),
      });
    }
    return out;
  }

  function uniqueById(entries) {
    const seen = new Set();
    return entries.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }

  function send(payload) {
    const data = JSON.stringify(payload);
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
      }).catch(() => sendXhr(data));
    } catch {
      sendXhr(data);
    }
  }

  function sendXhr(data) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(data);
    } catch {
      // The probe is best-effort.
    }
  }

  function postResult(result) {
    try {
      fetch(RESULT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      }).catch(() => {});
    } catch {
      // The result report is best-effort.
    }
  }

  // Pick the smallest visible element that carries the champion name (or its
  // champion-id background). Clicking it lets the event bubble to whatever
  // card handler the client uses, while avoiding a click on a huge container
  // whose center might fall on the wrong card.
  function scoreElement(el, cmd, headingRect) {
    const rect = rectOf(el);
    if (!rect) return null;
    const area = rect.width * rect.height;
    if (area < 600) return null;
    // A bench tile can carry the same champion as one of the three cards.
    // Never click the bench here; the three-card screen is a separate modal.
    try {
      if (el.closest('[class*="bench-champion"]')) return null;
    } catch {
      // Ignore a selector failure.
    }

    const text = fullTextOf(el);
    const label = `${attrOf(el, 'aria-label')} ${attrOf(el, 'title')}`;
    const idMatch = cmd.id > 0 && champId(bgOf(el)) === cmd.id;
    const nameMatch = Boolean(cmd.name) && (text.includes(cmd.name) || label.includes(cmd.name));
    if (!nameMatch && !idMatch) return null;

    let score = 0;
    if (nameMatch) score += 3;
    if (nameMatch && text.trim() === cmd.name) score += 3;
    if (nameMatch && text.trim().length <= cmd.name.length + 10) score += 2;
    if (idMatch) score += 4;
    if (isCardLike(el)) score += 2;
    if (el.tagName === 'BUTTON' || attrOf(el, 'role') === 'button') score += 2;
    if (area <= 80000) score += 2;
    if (area > 250000) score -= 4;
    if (text.length > 120) score -= 3;
    if (headingRect) {
      const gap = rect.top - headingRect.bottom;
      if (gap >= -120 && gap <= 620) score += 2;
      const centerDelta = Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2);
      if (centerDelta < window.innerWidth * 0.3) score += 1;
    }

    return {
      el,
      score,
      area,
      rect,
      text: text.slice(0, 60),
      cls: String(el.className || '').slice(0, 120),
      tag: el.tagName,
    };
  }

  function findCardElement(cmd) {
    const heading = findHeading();
    if (!heading) return null;
    const headingRect = rectOf(heading);
    if (!headingRect) return null;

    const roots = [];
    let node = heading.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body; i += 1) {
      if (cmd.name && fullTextOf(node).includes(cmd.name)) {
        roots.push(node);
        break;
      }
      node = node.parentElement;
    }
    let fallback = heading.parentElement;
    for (let i = 0; i < 5 && fallback && fallback !== document.body; i += 1) {
      if (!roots.includes(fallback)) roots.push(fallback);
      fallback = fallback.parentElement;
    }

    const scan = (scanRoots) => {
      const seen = new Set();
      const found = [];
      for (const root of scanRoots) {
        for (const el of root.querySelectorAll('*')) {
          if (el === heading || heading.contains(el) || seen.has(el)) continue;
          seen.add(el);
          const scored = scoreElement(el, cmd, headingRect);
          if (scored) found.push(scored);
        }
      }
      return found;
    };

    let candidates = scan(roots);
    if (!candidates.length) candidates = scan([document.body]);
    if (!candidates.length) return null;

    candidates.sort((a, b) => b.score - a.score || a.area - b.area);
    return candidates[0];
  }

  function dispatchClickSequence(el, x, y) {
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
    };
    const sequence = [
      ['pointerover', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent],
      ['pointerdown', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent],
      ['mousedown', MouseEvent],
      ['pointerup', typeof PointerEvent === 'function' ? PointerEvent : MouseEvent],
      ['mouseup', MouseEvent],
      ['click', MouseEvent],
    ];
    for (const [type, Ctor] of sequence) {
      try {
        const init = { ...options };
        if (type === 'mousedown' || type === 'pointerdown') init.buttons = 1;
        el.dispatchEvent(new Ctor(type, init));
      } catch {
        // Try the remaining event types.
      }
    }
  }

  function clickElement(el) {
    const rect = rectOf(el);
    if (!rect || rect.width < 8 || rect.height < 8) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    let topmost = null;
    try {
      topmost = document.elementFromPoint(x, y);
    } catch {
      topmost = null;
    }

    dispatchClickSequence(el, x, y);
    // Some client cards put a click-catcher overlay above the artwork/text.
    // If that overlay is a sibling (not an ancestor), click it too.
    if (topmost && topmost !== el && !el.contains(topmost) && !topmost.contains(el)) {
      dispatchClickSequence(topmost, x, y);
    }

    return {
      topmost: topmost
        ? `${topmost.tagName}.${String(topmost.className || '').slice(0, 100)}`
        : null,
    };
  }

  async function runCommand(cmd) {
    if (!cmd || !cmd.name) return;
    if (Date.now() - Number(cmd.at || 0) > 30000) {
      postResult({ ok: false, reason: 'stale', cmd });
      return;
    }
    const heading = findHeading();
    if (!heading) {
      postResult({ ok: false, reason: 'heading missing', cmd });
      return;
    }
    const hit = findCardElement(cmd);
    if (!hit) {
      postResult({ ok: false, reason: 'card not found', cmd });
      return;
    }
    const clicked = clickElement(hit.el);
    postResult({
      ok: Boolean(clicked),
      topmost: clicked?.topmost || null,
      tag: hit.tag,
      cls: hit.cls,
      text: hit.text,
      score: hit.score,
      html: String(hit.el.outerHTML || '').slice(0, 600),
      cmd,
    });
  }

  async function pollCommands() {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch(
        `${COMMANDS_ENDPOINT}?v=${VERSION}&t=${Date.now()}`,
        { cache: 'no-store' },
      );
      if (!response.ok) return;
      const data = await response.json();
      const commands = Array.isArray(data.commands) ? data.commands : [];
      for (const cmd of commands) {
        await runCommand(cmd);
      }
    } catch {
      // The helper may be restarting.
    } finally {
      polling = false;
    }
  }

  function collect() {
    const heading = findHeading();
    if (!heading) {
      if (hadHeading && Date.now() - lastGoneAt > 1500) {
        hadHeading = false;
        lastGoneAt = Date.now();
        console.log('[ARAM Navigator plugin] card screen closed');
        send({ at: Date.now(), heading: '', gone: true, cards: [], entries: [] });
      }
      return;
    }
    hadHeading = true;

    const parent = heading.parentElement;
    const grand = parent ? parent.parentElement : null;
    const nearbyInline = [
      ...(parent ? scanImages(parent) : []),
      ...(grand ? scanImages(grand) : []),
    ];
    const nearbyComputed = [
      ...(parent ? scanComputed(parent) : []),
      ...(grand ? scanComputed(grand) : []),
    ];
    const nearby = uniqueById([...nearbyInline, ...nearbyComputed]).slice(0, 40);
    const entries = nearby.length
      ? nearby
      : scanImages(document.body).slice(0, 30);
    const cards = uniqueById(entries).slice(0, 8).map((entry) => ({
      id: entry.id,
      name: entry.text,
      cls: entry.cls,
      tag: entry.tag,
      src: entry.src,
      style: entry.style,
    }));

    const payload = {
      at: Date.now(),
      url: location.href,
      heading: textOf(heading),
      parentTag: `${heading.parentElement?.tagName || ''}.${
        heading.parentElement?.className || ''
      }`.slice(0, 160),
      cards,
      entries,
      nearbyInline,
      nearbyComputed,
      parentHtml: parent ? parent.outerHTML.slice(0, 9000) : '',
      grandHtml: grand ? grand.outerHTML.slice(0, 9000) : '',
      parentText: parent ? textOf(parent).slice(0, 600) : '',
      grandText: grand ? textOf(grand).slice(0, 600) : '',
      bodyText: document.body
        ? String(document.body.innerText || '')
            .replace(/\s+/g, ' ')
            .slice(0, 2500)
        : '',
    };

    const key = JSON.stringify({
      heading: payload.heading,
      ids: cards.map((card) => card.id),
      names: cards.map((card) => card.name),
    });
    if (key === lastKey && Date.now() - lastAt < 2000) return;
    lastKey = key;
    lastAt = Date.now();
    console.log('[ARAM Navigator plugin]', payload);
    send(payload);
  }

  setInterval(collect, 600);
  setTimeout(collect, 400);
  setInterval(pollCommands, 250);
  setTimeout(pollCommands, 600);
  setTimeout(() => postResult({ type: 'hello', version: VERSION }), 1200);
})();
