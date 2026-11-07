// @ts-check
/* Agent Ledger webview. Plain JS + inline SVG, no external libraries. */
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** Row layout (see src/payload.ts) */
  const SRC = 0, TS = 1, MODEL = 2, SESS = 3, PROJ = 4, IN = 5, CR = 6, CW = 7, OUT = 8, REASON = 9, COST = 10;
  const DAY = 86400;

  const saved = vscode.getState() || {};
  const state = Object.assign({
    tab: 'overview',
    range: '30d',
    metric: 'tokens',
    tokenMode: 'all',
    hidden: [],         // source ids filtered out of the view
    calSpan: 'auto',    // 'auto' | '26' | '53' | '<year>'
    selectedDay: null,
    sessionSort: 'tokens',
    search: '',
  }, saved);
  if (state.tab === 'sources') state.tab = 'agents';
  if (!Array.isArray(state.hidden)) state.hidden = [];
  /** @type {any} */ let data = null;
  let scanMsg = '';
  let errorMsg = '';

  const save = () => vscode.setState(state);
  const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtTok(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }
  function fmtUsd(n) {
    if (n === 0) return '$0';
    if (n < 0.01) return '<$0.01';
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString();
  }
  const fmtVal = (v) => (state.metric === 'cost' ? fmtUsd(v) : fmtTok(v));
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  function dayKey(sec) {
    const d = new Date(sec * 1000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function keyToDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  const fmtDate = (k, opts) => keyToDate(k).toLocaleDateString(undefined, opts || { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function dur(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    return (sec / 3600).toFixed(1) + 'h';
  }
  const projName = (i) => { const p = data.projects[i] || ''; if (!p) return '(unknown)'; const c = p.replace(/[\\/]+$/, ''); return c.split(/[\\/]/).pop() || c; };

  // ---------- metrics ----------
  function tok(r) {
    if (state.tokenMode === 'output') return r[OUT];
    if (state.tokenMode === 'nocache') return r[IN] + r[CW] + r[OUT];
    return r[IN] + r[CR] + r[CW] + r[OUT];
  }
  const val = (r) => (state.metric === 'cost' ? r[COST] : tok(r));
  const srcOn = (i) => !state.hidden.includes(data.sources[i].id);
  const color = (i) => (data.sources[i] && data.sources[i].color) || '#888';
  const zeros = () => new Array(data.sources.length).fill(0);

  function rangeBounds() {
    const now = new Date();
    const end = Date.now() / 1000 + 60;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    switch (state.range) {
      case 'today': return [startOfToday, end];
      case '7d': return [startOfToday - 6 * DAY, end];
      case '30d': return [startOfToday - 29 * DAY, end];
      case '90d': return [startOfToday - 89 * DAY, end];
      case 'month': return [new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000, end];
      case 'year': return [startOfToday - 364 * DAY, end];
      default: return [0, end];
    }
  }
  const RANGE_LABEL = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', month: 'This month', year: 'Last 12 months', all: 'All time' };

  function filtered() {
    const [a, b] = rangeBounds();
    return data.rows.filter((r) => srcOn(r[SRC]) && r[TS] >= a && r[TS] < b);
  }
  function bySource() { return data.rows.filter((r) => srcOn(r[SRC])); }

  function sum(rows) {
    const t = { req: 0, tok: 0, cost: 0, in: 0, cr: 0, cw: 0, out: 0, reason: 0, val: 0, sessions: new Set(), days: new Set() };
    for (const r of rows) {
      t.req++; t.tok += tok(r); t.cost += r[COST]; t.in += r[IN]; t.cr += r[CR]; t.cw += r[CW]; t.out += r[OUT]; t.reason += r[REASON];
      t.val += val(r); t.sessions.add(r[SESS]); t.days.add(dayKey(r[TS]));
    }
    return t;
  }

  function dailyMap(rows) {
    /** @type {Map<string, {val:number, tok:number, cost:number, req:number, src:number[], sessions:Set<number>}>} */
    const m = new Map();
    for (const r of rows) {
      const k = dayKey(r[TS]);
      let d = m.get(k);
      if (!d) { d = { val: 0, tok: 0, cost: 0, req: 0, src: zeros(), sessions: new Set() }; m.set(k, d); }
      const v = val(r);
      d.val += v; d.tok += tok(r); d.cost += r[COST]; d.req++; d.src[r[SRC]] += v; d.sessions.add(r[SESS]);
    }
    return m;
  }

  function streaks(days) {
    const keys = [...days.keys()].filter((k) => days.get(k).req > 0).sort();
    let longest = 0, run = 0, prev = null, longestEnd = null;
    for (const k of keys) {
      const d = keyToDate(k);
      if (prev && Math.round((d.getTime() - prev.getTime()) / 864e5) === 1) run++; else run = 1;
      if (run > longest) { longest = run; longestEnd = k; }
      prev = d;
    }
    let current = 0;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const cursor = new Date(t);
    if (!days.has(dayKey(cursor.getTime() / 1000))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(dayKey(cursor.getTime() / 1000))) { current++; cursor.setDate(cursor.getDate() - 1); }
    return { current, longest, longestEnd };
  }

  // ---------- small SVG/HTML helpers ----------
  function bar(parts, total) {
    if (!total) return '<div class="stack empty"></div>';
    return '<div class="stack">' + parts.filter((p) => p.v > 0).map((p) => `<span style="width:${(p.v / total) * 100}%;background:${p.c}" title="${esc(p.label)}: ${esc(p.fmt || fmtVal(p.v))}"></span>`).join('') + '</div>';
  }
  function share(v, max, color) {
    return `<div class="share"><span style="width:${max ? Math.max(1, (v / max) * 100) : 0}%;background:${color || 'var(--accent)'}"></span></div>`;
  }
  const dot = (i) => `<i class="dot" style="background:${color(i)}"></i>`;
  function kpi(label, value, sub, title) {
    return `<div class="kpi"${title ? ` title="${esc(title)}"` : ''}><div class="kpi-l">${esc(label)}</div><div class="kpi-v">${value}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;
  }
  function empty(msg) { return `<div class="empty-state">${esc(msg)}</div>`; }

  // ---------- calendar heatmap ----------
  function calendar() {
    const all = dailyMap(bySource());
    const width = app.clientWidth || 300;
    let weeks = 53, endDate = new Date();
    const years = [...new Set([...all.keys()].map((k) => k.slice(0, 4)))].sort().reverse();
    if (state.calSpan === 'auto') weeks = width < 420 ? 26 : 53;
    else if (state.calSpan === '26' || state.calSpan === '53') weeks = Number(state.calSpan);
    else { endDate = new Date(Number(state.calSpan), 11, 31); weeks = 53; }
    endDate.setHours(0, 0, 0, 0);
    const end = new Date(endDate); end.setDate(end.getDate() + (6 - end.getDay())); // Saturday of the end week
    const start = new Date(end); start.setDate(start.getDate() - (weeks * 7 - 1));    // a Sunday

    const cells = [];
    const vals = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = dayKey(d.getTime() / 1000);
      const e = all.get(k);
      cells.push({ k, d, e, future: d > endDate });
      if (e && e.val > 0) vals.push(e.val);
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
    const th = [q(0.25), q(0.5), q(0.75)];
    const level = (v) => (v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4);

    const S = 13, C = 11, L = 26, T = 16;
    const W = L + weeks * S, H = T + 7 * S;
    let svg = `<svg class="cal" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Usage calendar">`;
    ['Mon', 'Wed', 'Fri'].forEach((n, i) => { svg += `<text x="0" y="${T + (i * 2 + 1) * S + 9}" class="cal-lbl">${n}</text>`; });
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const d = cells[w * 7].d;
      if (d.getMonth() !== lastMonth && (w < weeks - 2)) {
        if (d.getDate() <= 7 || w === 0) svg += `<text x="${L + w * S}" y="10" class="cal-lbl">${d.toLocaleDateString(undefined, { month: 'short' })}</text>`;
        lastMonth = d.getMonth();
      }
    }
    let sumV = 0, active = 0;
    cells.forEach((c, i) => {
      const w = Math.floor(i / 7), dow = i % 7;
      if (c.future) return;
      const v = c.e ? c.e.val : 0;
      if (v > 0) { sumV += v; active++; }
      const sel = state.selectedDay === c.k ? ' sel' : '';
      svg += `<rect x="${L + w * S}" y="${T + dow * S}" width="${C}" height="${C}" rx="2" class="l${level(v)}${sel}" data-day="${c.k}"></rect>`;
    });
    svg += '</svg>';

    const st = streaks(all);
    let best = null;
    for (const [k, e] of all) if (!best || e.val > best[1].val) best = [k, e];

    const spanOpts = [['auto', 'Auto'], ['26', '6 months'], ['53', '12 months'], ...years.map((y) => [y, y])]
      .map(([v, l]) => `<option value="${v}"${state.calSpan === v ? ' selected' : ''}>${l}</option>`).join('');

    return `<section class="card wide">
      <div class="card-h"><h3>Usage calendar</h3><select data-act="calSpan" title="Calendar span">${spanOpts}</select></div>
      <div class="cal-wrap">${svg}</div>
      <div class="legend"><span>${fmtVal(sumV)} · ${active} active days</span><span class="lg">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</span></div>
      <div class="mini-stats">
        <div><b>${st.current}</b><span>day streak</span></div>
        <div><b>${st.longest}</b><span>longest streak</span></div>
        <div title="${best ? esc(fmtDate(best[0])) : ''}"><b>${best ? fmtVal(best[1].val) : '–'}</b><span>busiest day${best ? ' · ' + esc(fmtDate(best[0], { month: 'short', day: 'numeric' })) : ''}</span></div>
      </div>
      <div class="hint">Click a day to see what you did. Colour = ${state.metric === 'cost' ? 'estimated cost' : tokenModeLabel().toLowerCase()} per day.</div>
    </section>`;
  }
  function tokenModeLabel() { return { all: 'All tokens', nocache: 'Tokens without cache reads', output: 'Output tokens' }[state.tokenMode]; }

  function dayDetail() {
    if (!state.selectedDay) return '';
    const k = state.selectedDay;
    const rows = bySource().filter((r) => dayKey(r[TS]) === k);
    const t = sum(rows);
    const sess = new Map();
    for (const r of rows) addToSession(sess, r);
    const hours = new Array(24).fill(0);
    for (const r of rows) hours[new Date(r[TS] * 1000).getHours()] += val(r);
    const hmax = Math.max(...hours, 1);
    const hourBars = hours.map((h, i) => `<span style="height:${Math.max(h ? 6 : 0, (h / hmax) * 100)}%" title="${i}:00 · ${fmtVal(h)}"></span>`).join('');
    const perSrc = zeros(); for (const r of rows) perSrc[r[SRC]] += val(r);
    const list = [...sess.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 12).map(([si, s]) => sessionRow(si, s)).join('');
    return `<section class="card day wide">
      <div class="card-h"><h3>${esc(fmtDate(k))}</h3><button class="link" data-act="closeDay">✕</button></div>
      ${rows.length ? `
      <div class="kpis three">${kpi('Tokens', fmtTok(t.tok))}${kpi('Est. cost', fmtUsd(t.cost))}${kpi('Requests', t.req.toLocaleString())}</div>
      ${bar(perSrc.map((v, i) => ({ v, c: color(i), label: data.sources[i].name })), perSrc.reduce((a, b) => a + b, 0))}
      <div class="hours">${hourBars}</div><div class="hours-axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      <h4>Sessions</h4><div class="list">${list}</div>` : empty('No AI usage on this day.')}
    </section>`;
  }

  /** Active time = sum of gaps between consecutive requests, ignoring idle gaps over 30 min. Rows are sorted by time. */
  const IDLE = 30 * 60;
  function addToSession(map, r) {
    let s = map.get(r[SESS]);
    if (!s) { s = { v: 0, cost: 0, req: 0, first: r[TS], last: r[TS], active: 0, models: new Set() }; map.set(r[SESS], s); }
    const gap = r[TS] - s.last;
    if (gap > 0 && gap < IDLE) s.active += gap;
    s.v += val(r); s.cost += r[COST]; s.req++; s.last = Math.max(s.last, r[TS]); s.first = Math.min(s.first, r[TS]); s.models.add(r[MODEL]);
    return s;
  }

  function sessionRow(si, s) {
    const info = data.sessions[si];
    const title = info.title || '(untitled session)';
    const models = s.models ? [...s.models].map((m) => data.models[m].name).join(', ') : '';
    return `<div class="row" title="${esc(title)}\n${esc(models)}">
      <div class="row-main">${dot(info.source)}<span class="row-title">${esc(title)}</span><span class="row-val">${fmtVal(s.v)}</span></div>
      <div class="row-sub">${esc(projName(info.project))} · ${s.req} req · ${dur(s.active)} active · ${fmtUsd(s.cost)}</div>
    </div>`;
  }

  // ---------- tabs ----------
  function overview() {
    const rows = filtered();
    const t = sum(rows);
    const days = t.days.size;
    const inputSide = t.in + t.cr + t.cw;
    const perSrc = zeros().map(() => ({ v: 0, cost: 0, tok: 0, req: 0 }));
    for (const r of rows) { const p = perSrc[r[SRC]]; p.v += val(r); p.cost += r[COST]; p.tok += tok(r); p.req++; }
    const maxSrc = Math.max(...perSrc.map((p) => p.v), 0);

    let projection = '';
    if (state.range === 'month' && t.cost > 0) {
      const now = new Date();
      const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const elapsed = now.getDate() - 1 + now.getHours() / 24;
      projection = kpi('Month projection', fmtUsd((t.cost / Math.max(elapsed, 0.5)) * dim), 'at current pace');
    }

    const idle = data.sources.filter((s, i) => srcOn(i) && !perSrc[i].req).map((s) => s.name);
    const tools = data.sources.map((s, i) => srcOn(i) && perSrc[i].req ? `<div class="tool">
        <div class="row-main">${dot(i)}<span class="row-title">${esc(s.name)}${supportBadge(s.support)}</span><span class="row-val">${fmtVal(perSrc[i].v)}</span></div>
        ${share(perSrc[i].v, maxSrc, color(i))}
        <div class="row-sub">${fmtTok(perSrc[i].tok)} tokens · ${costLabel(s, perSrc[i].cost)} · ${perSrc[i].req.toLocaleString()} requests</div>
      </div>` : '').join('');

    const mix = [
      { v: t.in, c: 'var(--c-in)', label: 'Input', fmt: fmtTok(t.in) },
      { v: t.cw, c: 'var(--c-cw)', label: 'Cache write', fmt: fmtTok(t.cw) },
      { v: t.cr, c: 'var(--c-cr)', label: 'Cache read', fmt: fmtTok(t.cr) },
      { v: t.out, c: 'var(--c-out)', label: 'Output', fmt: fmtTok(t.out) },
    ];
    const mixTotal = t.in + t.cw + t.cr + t.out;

    return `
      <div class="kpis">
        ${kpi('Tokens', fmtTok(t.tok), tokenModeLabel())}
        ${kpi('Est. cost', fmtUsd(t.cost), 'API-equivalent', 'What this usage would cost at public API prices. On a subscription you pay your plan price instead.')}
        ${kpi('Sessions', t.sessions.size.toLocaleString(), t.req.toLocaleString() + ' requests')}
        ${kpi('Active days', String(days), days ? fmtVal(t.val / days) + ' / day' : '')}
        ${kpi('Cache hit', pct(t.cr, inputSide) + '%', 'of input tokens', 'Share of input tokens served from the prompt cache (cheaper).')}
        ${projection || kpi('Avg / request', t.req ? fmtTok(t.tok / t.req) : '–', t.req ? fmtUsd(t.cost / t.req) : '')}
      </div>
      ${calendar()}
      ${dayDetail()}
      <section class="card"><div class="card-h"><h3>By tool</h3><span class="muted">${esc(RANGE_LABEL[state.range])}</span></div>${tools || empty('No usage in this range.')}${idle.length ? `<div class="hint">No usage in this range: ${esc(idle.join(', '))}</div>` : ''}</section>
      <section class="card"><div class="card-h"><h3>Token mix</h3></div>
        ${bar(mix, mixTotal)}
        <div class="mix-legend">${mix.map((m) => `<span><i style="background:${m.c}"></i>${m.label} <b>${m.fmt}</b> <em>${pct(m.v, mixTotal)}%</em></span>`).join('')}</div>
        <div class="hint">Reasoning/thinking: ${fmtTok(t.reason)} (${pct(t.reason, t.out)}% of output). Agents resend the whole conversation on each turn, so cache reads usually dominate.</div>
      </section>`;
  }

  function activity() {
    const rows = filtered();
    if (!rows.length) return empty('No usage in this range.');
    const [a] = rangeBounds();
    const first = state.range === 'all' ? rows[0][TS] : a;
    const spanDays = Math.ceil((Date.now() / 1000 - first) / DAY) + 1;
    const weekly = spanDays > 120;
    const buckets = new Map();
    const keyOf = (sec) => {
      if (!weekly) return dayKey(sec);
      const d = new Date(sec * 1000); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
      return dayKey(d.getTime() / 1000);
    };
    // pre-fill so gaps show
    const startD = new Date(first * 1000); startD.setHours(0, 0, 0, 0);
    if (weekly) startD.setDate(startD.getDate() - startD.getDay());
    for (let d = new Date(startD); d <= new Date(); d.setDate(d.getDate() + (weekly ? 7 : 1))) buckets.set(dayKey(d.getTime() / 1000), zeros());
    for (const r of rows) { const k = keyOf(r[TS]); if (!buckets.has(k)) buckets.set(k, zeros()); buckets.get(k)[r[SRC]] += val(r); }
    const keys = [...buckets.keys()].sort();
    const max = Math.max(...keys.map((k) => buckets.get(k).reduce((x, y) => x + y, 0)), 1);
    const W = Math.max(keys.length * 6, 240), H = 120, bw = W / keys.length;
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H + 14}" preserveAspectRatio="none">`;
    keys.forEach((k, i) => {
      let y = H;
      const vs = buckets.get(k);
      const total = vs.reduce((x, z) => x + z, 0);
      vs.forEach((v, s) => {
        if (!v) return;
        const h = (v / max) * (H - 4);
        y -= h;
        svg += `<rect x="${i * bw + 0.5}" y="${y}" width="${Math.max(bw - 1, 1)}" height="${h}" fill="${color(s)}"><title>${esc((weekly ? 'Week of ' : '') + fmtDate(k))}\n${data.sources[s].name}: ${fmtVal(v)}\nTotal: ${fmtVal(total)}</title></rect>`;
      });
    });
    svg += `<line x1="0" y1="${H + 0.5}" x2="${W}" y2="${H + 0.5}" class="axis"/></svg>`;

    // weekday x hour punchcard
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) { const d = new Date(r[TS] * 1000); grid[d.getDay()][d.getHours()] += val(r); }
    const gmax = Math.max(...grid.flat(), 1);
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let pc = `<svg class="punch" viewBox="0 0 ${28 + 24 * 11} ${7 * 11 + 14}">`;
    grid.forEach((row, d) => {
      pc += `<text x="0" y="${d * 11 + 9}" class="cal-lbl">${names[d]}</text>`;
      row.forEach((v, h) => {
        const o = v ? 0.15 + 0.85 * (v / gmax) : 0.06;
        pc += `<rect x="${28 + h * 11}" y="${d * 11}" width="10" height="10" rx="2" fill="var(--accent)" fill-opacity="${o.toFixed(2)}"><title>${names[d]} ${h}:00 · ${fmtVal(v)}</title></rect>`;
      });
    });
    [0, 6, 12, 18].forEach((h) => { pc += `<text x="${28 + h * 11}" y="${7 * 11 + 11}" class="cal-lbl">${h}h</text>`; });
    pc += '</svg>';
    let peak = [0, 0, 0];
    grid.forEach((row, d) => row.forEach((v, h) => { if (v > peak[0]) peak = [v, d, h]; }));

    const wd = new Array(7).fill(0);
    const dm = dailyMap(rows);
    for (const [k, e] of dm) wd[keyToDate(k).getDay()] += e.val;
    const wmax = Math.max(...wd, 1);

    return `<section class="card"><div class="card-h"><h3>${weekly ? 'Weekly' : 'Daily'} usage</h3><span class="muted">${esc(RANGE_LABEL[state.range])}</span></div>
        <div class="chart-wrap">${svg}</div>
        <div class="axis-lbl"><span>${esc(fmtDate(keys[0], { month: 'short', day: 'numeric' }))}</span><span>peak ${fmtVal(max)}</span><span>${esc(fmtDate(keys[keys.length - 1], { month: 'short', day: 'numeric' }))}</span></div>
        <div class="mix-legend">${data.sources.map((s, i) => srcOn(i) ? `<span><i style="background:${color(i)}"></i>${esc(s.name)}</span>` : '').join('')}</div>
      </section>
      <section class="card"><div class="card-h"><h3>When you work</h3><span class="muted">peak ${names[peak[1]]} ${peak[2]}:00</span></div>${pc}</section>
      <section class="card"><div class="card-h"><h3>By weekday</h3></div>
        ${wd.map((v, i) => `<div class="kv"><span>${names[i]}</span>${share(v, wmax)}<b>${fmtVal(v)}</b></div>`).join('')}
      </section>`;
  }

  function sessions() {
    const rows = filtered();
    const m = new Map();
    for (const r of rows) addToSession(m, r);
    const q = state.search.trim().toLowerCase();
    let list = [...m.entries()].filter(([si]) => {
      if (!q) return true;
      const s = data.sessions[si];
      return (s.title + ' ' + projName(s.project) + ' ' + data.sources[s.source].name).toLowerCase().includes(q);
    });
    const sorters = { tokens: (a, b) => b[1].v - a[1].v, cost: (a, b) => b[1].cost - a[1].cost, recent: (a, b) => b[1].last - a[1].last, requests: (a, b) => b[1].req - a[1].req };
    list.sort(sorters[state.sessionSort] || sorters.tokens);
    const total = list.length;
    const avg = total ? list.reduce((x, y) => x + y[1].cost, 0) / total : 0;
    const items = list.slice(0, 150).map(([si, s]) => {
      const info = data.sessions[si];
      const title = info.title || '(untitled session)';
      return `<div class="row" title="${esc(title)}">
        <div class="row-main">${dot(info.source)}<span class="row-title">${esc(title)}</span><span class="row-val">${fmtVal(s.v)}</span></div>
        <div class="row-sub">${esc(projName(info.project))} · ${esc(fmtDate(dayKey(s.last), { month: 'short', day: 'numeric' }))} · ${s.req} req · ${dur(s.active)} active · ${fmtUsd(s.cost)}</div>
        <div class="row-sub models">${[...s.models].map((x) => esc(data.models[x].name)).join(' · ')}</div>
      </div>`;
    }).join('');
    const opt = (v, l) => `<option value="${v}"${state.sessionSort === v ? ' selected' : ''}>${l}</option>`;
    return `<section class="card">
      <div class="toolbar"><input type="search" data-act="search" placeholder="Search sessions, projects…" value="${esc(state.search)}">
      <select data-act="sessionSort">${opt('tokens', 'Most ' + (state.metric === 'cost' ? 'cost' : 'tokens'))}${opt('cost', 'Most expensive')}${opt('recent', 'Most recent')}${opt('requests', 'Most requests')}</select></div>
      <div class="muted small">${total} sessions · avg ${fmtUsd(avg)} per session${total > 150 ? ' · showing top 150' : ''}</div>
      <div class="list">${items || empty('No sessions match.')}</div></section>`;
  }

  function groupTable(keyFn, labelFn, extraFn) {
    const rows = filtered();
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      let g = m.get(k);
      if (!g) { g = { v: 0, tok: 0, cost: 0, req: 0, srcs: new Set(), sessions: new Set(), out: 0 }; m.set(k, g); }
      g.v += val(r); g.tok += tok(r); g.cost += r[COST]; g.req++; g.srcs.add(r[SRC]); g.sessions.add(r[SESS]); g.out += r[OUT];
    }
    const list = [...m.entries()].sort((a, b) => b[1].v - a[1].v);
    const max = list.length ? list[0][1].v : 0;
    const total = list.reduce((x, y) => x + y[1].v, 0);
    return list.map(([k, g]) => `<div class="row">
        <div class="row-main">${[...g.srcs].map(dot).join('')}<span class="row-title">${labelFn(k)}</span><span class="row-val">${fmtVal(g.v)} <em>${pct(g.v, total)}%</em></span></div>
        ${share(g.v, max, color([...g.srcs][0]))}
        <div class="row-sub">${extraFn(k, g)}</div></div>`).join('') || empty('No usage in this range.');
  }

  function models() {
    return `<section class="card"><div class="card-h"><h3>Models</h3><span class="muted">${esc(RANGE_LABEL[state.range])}</span></div>
      ${groupTable((r) => r[MODEL], (k) => esc(data.models[k].name), (k, g) => {
        const m = data.models[k];
        const src = m.reported ? ' · <span class="muted">cost reported by the tool</span>' : m.priceLabel ? '' : ' · <span class="warn">no price, set aiUsage.pricing</span>';
        return `${fmtTok(g.tok)} tokens · ${fmtUsd(g.cost)} · ${g.req.toLocaleString()} req${g.tok && g.cost ? ' · ' + fmtUsd((g.cost / g.tok) * 1e6) + '/1M' : ''}${src}`;
      })}
      <div class="hint">When a tool logs its own cost (Cline, Roo, Kilo, OpenCode) that number is used. Otherwise cost is estimated from public list prices (Nov 2026), which you can override with <code>aiUsage.pricing</code>.</div></section>`;
  }

  function projects() {
    return `<section class="card"><div class="card-h"><h3>Projects</h3><span class="muted">${esc(RANGE_LABEL[state.range])}</span></div>
      ${groupTable((r) => projName(r[PROJ]), (k) => esc(k), (k, g) => `${fmtTok(g.tok)} tokens · ${fmtUsd(g.cost)} · ${g.sessions.size} sessions · ${g.req.toLocaleString()} req`)}
      </section>`;
  }

  function limits() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
    const monthCost = zeros();
    for (const r of data.rows) if (r[TS] >= monthStart) monthCost[r[SRC]] += r[COST];
    const subs = data.subscriptions || {};
    const ALIAS = { 'claude-code': 'claude', 'copilot-chat': 'copilot' };
    const value = data.sources.map((s, i) => {
      const paid = Number(subs[s.id] ?? subs[ALIAS[s.id]] ?? 0);
      const ratio = paid > 0 ? monthCost[i] / paid : 0;
      return `<div class="row"><div class="row-main">${dot(i)}<span class="row-title">${esc(s.name)}</span><span class="row-val">${fmtUsd(monthCost[i])}</span></div>
        <div class="row-sub">${paid > 0 ? `plan ${fmtUsd(paid)}/mo → <b>${ratio.toFixed(1)}×</b> value` : 'no plan price set'}</div>
        ${paid > 0 ? share(Math.min(ratio, 10), 10, color(i)) : ''}</div>`;
    }).join('');

    const win = (w, name) => {
      if (!w) return '';
      const resetIn = (w.resetsAt - Date.now()) / 1000;
      const winLabel = w.windowMinutes >= 1440 ? Math.round(w.windowMinutes / 1440) + '-day' : Math.round(w.windowMinutes / 60) + '-hour';
      const when = new Date(w.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const used = resetIn > 0 ? w.usedPercent : 0; // window rolled over with no use since
      const cls = used >= 90 ? 'bad' : used >= 70 ? 'warnbar' : '';
      return `<div class="limit"><div class="row-main"><span class="row-title">${name} · ${winLabel} window</span><span class="row-val">${Math.round(used)}%</span></div>
        <div class="share ${cls}"><span style="width:${Math.min(100, used)}%"></span></div>
        <div class="row-sub">${resetIn > 0 ? 'resets in ' + dur(resetIn) + ' (' + when + ')' : `reset on ${when}. It was at ${Math.round(w.usedPercent)}% before that`}</div></div>`;
    };
    const statusOf = (id) => data.status.find((s) => s.id === id);
    const limitCards = (data.rateLimits || []).map((rl) => {
      const st = statusOf(rl.source);
      const name = st ? st.name : rl.source;
      return `<section class="card"><div class="card-h"><h3>${esc(name)} limits</h3>${st ? `<i class="dot" style="background:${st.color}"></i>` : ''}</div>
        ${win(rl.primary, 'Primary')}${win(rl.secondary, 'Secondary')}
        <div class="hint">Plan: <b>${esc(rl.plan || 'unknown')}</b>. Last seen in a log ${ago(rl.observedAt)}; it updates whenever you use ${esc(name)}.</div></section>`;
    }).join('');
    const withLimits = new Set((data.rateLimits || []).map((r) => r.source));
    const noLimits = data.sources.filter((s) => !withLimits.has(s.id)).map((s) => s.name);

    return `${limitCards}
      <section class="card"><div class="card-h"><h3>Plan value this month</h3><button class="link" data-act="openSettings">Set plan prices</button></div>${value}
        <div class="hint">API-equivalent cost of this month's usage compared with what you pay. Set <code>aiUsage.subscriptions</code> by agent id, e.g. {"claude-code": 100, "codex": 8}.</div></section>
      ${noLimits.length ? `<section class="card"><div class="card-h"><h3>Other limits</h3></div>
        <div class="hint">${esc(noLimits.join(', '))} ${noLimits.length === 1 ? "doesn't" : "don't"} write quota or rate-limit status to local logs, so only usage is shown. Use the calendar and the Activity tab to spot heavy days.</div></section>` : ''}`;
  }

  const SUPPORT = {
    full: ['counted', 'Tokens are read from local logs.'],
    partial: ['partial', 'Requests are counted, but this tool logs only some token fields. See its notes in the Agents tab.'],
    'detect-only': ['not countable', "Installed, but this tool doesn't store usage on your computer (or its format isn't supported yet)."],
  };
  function supportBadge(level) {
    if (level === 'full') return '';
    const [label, tip] = SUPPORT[level] || ['', ''];
    return ` <span class="badge ${level}" title="${esc(tip)}">${label}</span>`;
  }
  function costLabel(source, cost) {
    return source.id === 'copilot-chat' && cost === 0 ? 'billed per request' : fmtUsd(cost);
  }

  function agents() {
    const detected = data.status.filter((s) => s.detected);
    const missing = data.status.filter((s) => !s.detected);
    const counted = detected.filter((s) => s.support !== 'detect-only').length;
    const card = (s) => {
      const state = !s.enabled ? '<span class="row-val muted">off</span>'
        : s.support === 'detect-only' ? '<span class="row-val muted">installed</span>'
        : s.records ? '<span class="row-val ok">● counted</span>' : '<span class="row-val muted">no usage yet</span>';
      return `<div class="src${s.enabled ? '' : ' disabled'}">
        <div class="row-main"><i class="dot" style="background:${s.color}"></i><span class="row-title">${esc(s.name)}${supportBadge(s.support)}</span>${state}</div>
        ${s.support !== 'detect-only' ? `<div class="row-sub">${s.files} files · ${s.records.toLocaleString()} requests${s.unreadableFiles ? ' · ' + s.unreadableFiles + ' unreadable' : ''}</div>` : ''}
        ${s.roots.map((r) => `<button class="path" data-act="openFolder" data-path="${esc(r)}" title="Reveal in file explorer">${esc(r)}</button>`).join('')}
        ${s.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
        ${s.support !== 'detect-only' ? `<button class="link" data-act="toggleAgent" data-id="${esc(s.id)}">${s.enabled ? 'Ignore this agent' : 'Count this agent again'}</button>` : ''}
      </div>`;
    };
    return `<section class="card"><div class="card-h"><h3>${detected.length} agent${detected.length === 1 ? '' : 's'} on this computer</h3><span class="muted">${counted} counted</span></div>
        ${detected.map(card).join('') || empty('No AI coding agents found.')}
        <div class="hint">Scanned ${ago(data.scannedAt)} in ${(data.durationMs / 1000).toFixed(1)}s. Everything is read from files on this computer; nothing is uploaded and no API keys are needed.</div></section>
      <section class="card"><div class="card-h"><h3>Also supported</h3><span class="muted">not found here</span></div>
        <div class="supported">${missing.map((s) => `<span class="pill" title="${esc((SUPPORT[s.support] || [])[1] || '')}"><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>
        <div class="hint">Installed somewhere unusual? Add its folder under <code>aiUsage.extraPaths</code>.</div></section>
      <section class="card actions">
        <button data-act="refresh">Rescan logs</button>
        <button data-act="exportCsv">Export CSV</button>
        <button data-act="openPanel">Open full dashboard</button>
        <button data-act="openSettings">Settings</button>
        <button data-act="showLog">Scan log</button>
      </section>`;
  }

  // ---------- shell ----------
  const TABS = [['overview', 'Overview'], ['activity', 'Activity'], ['sessions', 'Sessions'], ['models', 'Models'], ['projects', 'Projects'], ['limits', 'Limits'], ['agents', 'Agents']];

  function render() {
    if (errorMsg) { app.innerHTML = `<div class="empty-state">Error: ${esc(errorMsg)}<br><button data-act="refresh">Try again</button></div>`; return; }
    if (!data) { app.innerHTML = `<div class="loading">${esc(scanMsg || 'Reading local logs…')}</div>`; return; }
    if (!data.rows.length) {
      app.innerHTML = `<div class="empty-state"><h3>No AI usage found yet</h3>Use any supported coding agent (Claude Code, Codex, GitHub Copilot, Cline, Gemini CLI…) and it will show up here.</div>${agents()}`;
      return;
    }
    const scrollY = window.scrollY;
    const chips = data.sources.map((s, i) => `<button class="chip${srcOn(i) ? ' on' : ''}" data-act="toggleSrc" data-i="${i}" style="--c:${color(i)}">${dot(i)}${esc(s.name)}</button>`).join('');
    const ranges = Object.entries(RANGE_LABEL).map(([v, l]) => `<option value="${v}"${state.range === v ? ' selected' : ''}>${l}</option>`).join('');
    const modes = [['all', 'All tokens'], ['nocache', 'No cache reads'], ['output', 'Output only']].map(([v, l]) => `<option value="${v}"${state.tokenMode === v ? ' selected' : ''}>${l}</option>`).join('');
    const body = { overview, activity, sessions, models, projects, limits, agents }[state.tab] || overview;
    app.innerHTML = `
      <header>
        <div class="title"><b>Agent Ledger</b><span class="muted">${scanMsg ? esc(scanMsg) : 'updated ' + ago(data.scannedAt)}</span><button class="link" data-act="tab" data-v="agents" title="Agents found on this computer">${data.status.filter((s) => s.detected).length} agents</button><button class="icon" data-act="refresh" title="Rescan logs">⟳</button></div>
        <div class="chips">${chips}</div>
        <div class="filters">
          <select data-act="range" title="Date range">${ranges}</select>
          <div class="seg"><button class="${state.metric === 'tokens' ? 'on' : ''}" data-act="metric" data-v="tokens">Tokens</button><button class="${state.metric === 'cost' ? 'on' : ''}" data-act="metric" data-v="cost">Cost</button></div>
          <select data-act="tokenMode" title="How tokens are counted">${modes}</select>
        </div>
        <nav>${TABS.map(([id, l]) => `<button class="${state.tab === id ? 'on' : ''}" data-act="tab" data-v="${id}">${l}</button>`).join('')}</nav>
      </header>
      <main>${body()}</main>`;
    window.scrollTo(0, scrollY);
  }

  // ---------- events ----------
  app.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const rect = t.closest('rect[data-day]');
    if (rect) { const d = rect.getAttribute('data-day'); state.selectedDay = state.selectedDay === d ? null : d; save(); render(); return; }
    const el = /** @type {HTMLElement|null} */ (t.closest('[data-act]'));
    if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
    const act = el.dataset.act;
    if (act === 'tab') { state.tab = el.dataset.v; window.scrollTo(0, 0); }
    else if (act === 'metric') state.metric = el.dataset.v;
    else if (act === 'toggleSrc') {
      const i = Number(el.dataset.i);
      const id = data.sources[i].id;
      state.hidden = state.hidden.includes(id) ? state.hidden.filter((x) => x !== id) : [...state.hidden, id];
      if (data.sources.every((x) => state.hidden.includes(x.id))) state.hidden = [];
    }
    else if (act === 'closeDay') state.selectedDay = null;
    else if (act === 'openFolder') { post('openFolder', { path: el.dataset.path }); return; }
    else if (act === 'toggleAgent') { post('toggleAgent', { id: el.dataset.id }); return; }
    else if (['refresh', 'openPanel', 'exportCsv', 'openSettings', 'showLog'].includes(act)) { post(act); return; }
    save(); render();
  });
  app.addEventListener('change', (e) => {
    const el = /** @type {HTMLSelectElement} */ (e.target);
    const act = el.dataset && el.dataset.act;
    if (!act || el.tagName !== 'SELECT') return;
    state[act] = el.value;
    save(); render();
  });
  let searchTimer;
  app.addEventListener('input', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (el.dataset.act !== 'search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.value; save(); render();
      const again = /** @type {HTMLInputElement|null} */ (app.querySelector('input[data-act="search"]'));
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 200);
  });

  // Floating tooltip for calendar cells (SVG <title> is slow and ugly).
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  app.addEventListener('mousemove', (e) => {
    const rect = /** @type {Element} */ (e.target).closest && /** @type {Element} */ (e.target).closest('rect[data-day]');
    if (!rect || !data) { tip.style.display = 'none'; return; }
    const k = rect.getAttribute('data-day');
    const rows = bySource().filter((r) => dayKey(r[TS]) === k);
    const t = sum(rows);
    const per = zeros(); for (const r of rows) per[r[SRC]] += val(r);
    tip.innerHTML = `<b>${esc(fmtDate(k))}</b><br>${rows.length ? `${fmtTok(t.tok)} tokens · ${fmtUsd(t.cost)}<br>${t.sessions.size} sessions · ${t.req} requests` + per.map((v, i) => v ? `<br>${dot(i)}${esc(data.sources[i].name)}: ${fmtVal(v)}` : '').join('') : 'No usage'}`;
    tip.style.display = 'block';
    const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 6);
    const y = e.clientY + 14 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 8 : e.clientY + 14;
    tip.style.left = Math.max(4, x) + 'px'; tip.style.top = y + 'px';
  });
  app.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = app.clientWidth;
    if (state.calSpan === 'auto' && data && (w < 420) !== (lastWidth < 420)) render();
    lastWidth = w;
  }).observe(app);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'data') { data = m.payload; scanMsg = ''; errorMsg = ''; render(); }
    else if (m.type === 'scanning') {
      scanMsg = m.message;
      const sub = app.querySelector('.title .muted');
      if (sub) sub.textContent = scanMsg; else if (!data) render();
    }
    else if (m.type === 'error') { errorMsg = m.message; render(); }
  });

  // re-render "updated x ago" every minute
  setInterval(() => { if (data && !scanMsg) { const sub = app.querySelector('.title .muted'); if (sub) sub.textContent = 'updated ' + ago(data.scannedAt); } }, 60000);

  render();
  post('ready');
})();
