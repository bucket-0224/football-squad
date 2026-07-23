'use strict';

// =====================================================================
// state
// =====================================================================

const state = {
  token: localStorage.getItem('fs_token') || null,
  me: null,
  teams: [],
  formations: {},
  tactics: {}, // id -> Korean label
  market: [],
  catalog: new Map(), // id -> player(+price)
  authMode: 'login',
  pickedTeam: null,
  pickSlot: null,
  squadMode: 'main', // 'main' 클럽 스쿼드 | 'pvp' 실전 스쿼드(뽑은 카드 전용)
  ws: null,
  wsReady: null,
  inMatch: false,
  spectating: false, // watching someone else's live match
};

function activeSquad() {
  return state.squadMode === 'pvp' ? state.me.pvpSquad : state.me.squad;
}
function activeRatings() {
  return state.squadMode === 'pvp' ? state.me.pvpRatings : state.me.ratings;
}
function activePoolIds() {
  return state.squadMode === 'pvp'
    ? state.me.drawn.filter((id) => state.me.owned.includes(id))
    : state.me.owned;
}

// Slot coordinates per formation: [x%, y% from bottom].
const COORDS = {
  '4-3-3': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [72, 46], [50, 42], [28, 46], [80, 72], [50, 80], [20, 72]],
  '4-4-2': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [84, 50], [62, 46], [38, 46], [16, 50], [62, 78], [38, 78]],
  '4-2-3-1': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [62, 38], [38, 38], [50, 58], [82, 64], [50, 82], [18, 64]],
  '3-5-2': [[50, 4], [72, 18], [50, 15], [28, 18], [88, 46], [66, 48], [50, 36], [34, 48], [12, 46], [62, 78], [38, 78]],
  '4-1-4-1': [[50, 4], [84, 22], [63, 17], [37, 17], [16, 22], [50, 34], [84, 54], [62, 50], [38, 50], [16, 54], [50, 80]],
};

const $ = (sel) => document.querySelector(sel);
const PLACEHOLDER_IMG = '/img/players/_placeholder.svg';

// ---- 선수 강화 (enhancement) ----

function upLevel(id) {
  return (state.me && state.me.upgrades && state.me.upgrades[id]) || 0;
}

// Owned card with the user's 강화 applied: +1 OVR and +1 per attribute per
// level (mirrors the server's players.upgraded).
function upgradedCard(p) {
  const lvl = p ? upLevel(p.id) : 0;
  if (!lvl) return p;
  const attrs = {};
  Object.keys(p.attrs || {}).forEach((k) => {
    attrs[k] = Math.min(99, p.attrs[k] + lvl);
  });
  return { ...p, ovr: Math.min(99, p.ovr + lvl), attrs, up: lvl };
}

// ---- FUT-style card builder ----

function tierOf(p) {
  if (p.enhanced) return 'tier-special';
  if (p.ovr >= 83) return 'tier-gold';
  if (p.ovr >= 75) return 'tier-silver';
  return 'tier-bronze';
}

function cardHTML(p, size, opts = {}) {
  const img = p.img || PLACEHOLDER_IMG;
  const stats =
    opts.stats && p.attrs
      ? `<div class="fc-stats">
          <span><b>${p.attrs.pace}</b> PAC</span><span><b>${p.attrs.shooting}</b> SHO</span><span><b>${p.attrs.passing}</b> PAS</span>
          <span><b>${p.attrs.dribbling}</b> DRI</span><span><b>${p.attrs.defending}</b> DEF</span><span><b>${p.attrs.physical}</b> PHY</span>
        </div>`
      : '';
  const club = p.teamLogo
    ? `<img class="fc-club" src="${p.teamLogo}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  const nat = p.flag ? `<span class="fc-nat">${p.flag}</span>` : '';
  return `
    <div class="fut-card sz-${size} ${tierOf(p)}">
      ${opts.flag ? `<span class="fc-flag">${opts.flag}</span>` : ''}
      ${opts.badge ? `<span class="fc-cap-badge">${opts.badge}</span>` : ''}
      <div class="fc-head">
        <span class="fc-ovr">${p.ovr}</span><span class="fc-pos">${p.pos}</span>
        ${club}${nat}${p.up ? `<span class="fc-up">+${p.up}</span>` : ''}
      </div>
      <div class="fc-photo">
        <img class="fc-img${/^https?:/.test(img) ? ' remote' : ''}" src="${img}" alt="" loading="lazy"
             onerror="this.onerror=null;this.classList.remove('remote');this.src='${PLACEHOLDER_IMG}'">
      </div>
      <div class="fc-name">${p.name}</div>
      ${stats}
    </div>`;
}

function emptySlotHTML(pos) {
  return `
    <div class="fut-card sz-xs empty">
      <span class="fc-plus">+</span>
      <span class="fc-pos-label">${pos}</span>
    </div>`;
}

// =====================================================================
// api helpers
// =====================================================================

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const base = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '';
  const res = await fetch(base + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me) logout(true);
    throw new Error(data.error || '요청에 실패했습니다.');
  }
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function setMe(user) {
  state.me = user;
  renderHeader();
}

// =====================================================================
// boot
// =====================================================================

async function loadBootstrap() {
  const data = await api('GET', '/api/bootstrap');
  state.teams = data.teams;
  state.leagues = data.leagues || [];
  state.clubChangeCost = data.clubChangeCost || 250;
  state.formations = data.formations;
  state.tactics = data.tactics || {};
  state.market = data.market;
  state.packs = data.packs;
  state.enhance = data.enhance || { maxLevel: 5, rates: [], costRate: 0.15 };
  state.roles = data.roles || {}; // roleId -> { label, pos: [...] }
  state.market.forEach((p) => state.catalog.set(p.id, p));
}

// full team lists of the tracked leagues (real clubs, fetched lazily)
async function loadLeagueTeams() {
  if (state.leagueTeams) return;
  try {
    const { teams } = await api('GET', '/api/leagueteams');
    state.leagueTeams = teams || [];
    renderTeamGrid();
  } catch {
    state.leagueTeams = null; // retry on next open
  }
}

async function boot() {
  await loadBootstrap();

  if (state.token) {
    try {
      const { user } = await api('GET', '/api/me');
      enterMain(user);
      return;
    } catch {
      state.token = null;
      localStorage.removeItem('fs_token');
    }
  }
  showAuth();
}

function showAuth() {
  $('#view-main').classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  renderTeamGrid();
}

function enterMain(user) {
  setMe(user);
  $('#view-auth').classList.add('hidden');
  $('#view-main').classList.remove('hidden');
  renderSquadTab();
  renderMarket();
}

function logout(silent) {
  if (state.token && !silent) api('POST', '/api/logout').catch(() => {});
  state.token = null;
  state.me = null;
  localStorage.removeItem('fs_token');
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  location.reload();
}

// =====================================================================
// auth view
// =====================================================================

function setAuthMode(mode) {
  state.authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#register-extra').classList.toggle('hidden', mode !== 'register');
  $('#auth-submit').textContent = mode === 'login' ? '로그인' : '회원가입';
  $('#auth-error').textContent = '';
}

function teamsInLeague(leagueId) {
  const curated = state.teams.filter((t) =>
    leagueId === 'national' ? t.type === 'national' : t.league === leagueId
  );
  if (leagueId === 'national') return curated;
  // every other real club of the league; clubs already registered (their
  // roster was fetched before) appear in the curated list, so drop dupes
  const known = new Set(state.teams.map((t) => t.name));
  const extra = (state.leagueTeams || [])
    .filter((t) => t.league === leagueId && !known.has(t.name))
    .map((t) => ({ ...t, type: 'club', dyn: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...curated, ...extra];
}

function teamCardHTML(t, selected) {
  const mark = t.logo
    ? `<img src="${t.logo}" alt="" style="width:18px;height:18px;object-fit:contain" onerror="this.remove()">`
    : `<span class="team-dot" style="background:${t.color || '#3b82f6'}"></span>`;
  const meta = t.dyn
    ? '클럽 · 실제 스쿼드'
    : `${t.type === 'club' ? '클럽' : '국가대표'} · OVR ${t.ovr}`;
  return `
    <span class="t-name">${mark}${t.name}</span>
    <span class="t-meta">${meta}</span>`;
}

function renderLeagueSelect(sel, leagueId, opts = {}) {
  sel.innerHTML = '';
  state.leagues
    .filter((lg) => (opts.clubsOnly ? lg.id !== 'national' : true))
    .forEach((lg) => {
      const opt = document.createElement('option');
      opt.value = lg.id;
      opt.textContent = lg.label;
      if (lg.id === leagueId) opt.selected = true;
      sel.appendChild(opt);
    });
}

function renderTeamGrid() {
  const grid = $('#team-grid');
  renderLeagueSelect($('#league-select'), state.pickedLeague || 'EPL');
  grid.innerHTML = '';
  teamsInLeague(state.pickedLeague || 'EPL').forEach((t) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'team-card' + (state.pickedTeam === t.name ? ' selected' : '');
    card.innerHTML = teamCardHTML(t);
    card.onclick = () => {
      state.pickedTeam = t.name;
      state.pickedDyn = !!t.dyn;
      renderTeamGrid();
    };
    grid.appendChild(card);
  });
}

$('#league-select').onchange = (e) => {
  state.pickedLeague = e.target.value;
  state.pickedTeam = null;
  renderTeamGrid();
};

$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => {
  setAuthMode('register');
  loadLeagueTeams();
};

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const errEl = $('#auth-error');
  errEl.textContent = '';
  try {
    let data;
    if (state.authMode === 'login') {
      data = await api('POST', '/api/login', { username, password });
    } else {
      if (!state.pickedTeam) throw new Error('시작 팀을 선택해 주세요.');
      if (state.pickedDyn) toast('실제 선수단을 불러오는 중입니다…');
      data = await api('POST', '/api/register', {
        username,
        password,
        clubName: $('#auth-clubname').value.trim(),
        team: state.pickedTeam,
      });
      // a dynamically fetched club adds new players to the catalog
      if (state.pickedDyn) await loadBootstrap();
    }
    state.token = data.token;
    localStorage.setItem('fs_token', data.token);
    enterMain(data.user);
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// =====================================================================
// header + tabs
// =====================================================================

function renderHeader() {
  const me = state.me;
  if (!me) return;
  $('#hdr-club').textContent = me.clubName;
  $('#hdr-ovr').textContent = 'OVR ' + me.ratings.OVR;
  $('#hdr-coins').textContent = me.coins.toLocaleString();
  $('#hdr-points').textContent = me.points;
  const unclaimed = (me.mailbox || []).filter((m) => !m.claimed).length;
  const badge = $('#mailbox-badge');
  badge.textContent = unclaimed;
  badge.classList.toggle('hidden', unclaimed === 0);
  const pending = (me.complaints || []).length;
  const cbadge = $('#complaints-badge');
  cbadge.textContent = pending;
  cbadge.classList.toggle('hidden', pending === 0);
}

$('#btn-logout').onclick = () => logout();
$('#btn-mailbox').onclick = () => openMailbox();
$('#btn-mail-close').onclick = () => closeMailbox();
$('#btn-complaints').onclick = () => openComplaints();
$('#btn-complaints-close').onclick = () => closeComplaints();
$('#btn-complaint-close').onclick = () => closeComplaint();

document.querySelectorAll('#main-tabs button').forEach((btn) => {
  btn.onclick = () => {
    if (state.inMatch && btn.dataset.tab !== 'match') {
      if (state.spectating) {
        // just watching — leave the broadcast and move on
        sendWs({ type: 'spectate_leave' });
        backToLobby();
      } else {
        toast('경기 중에는 이동할 수 없습니다.');
        return;
      }
    }
    document.querySelectorAll('#main-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    ['squad', 'market', 'packs', 'match', 'predict', 'rank', 'news'].forEach((t) => {
      $('#tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab);
    });
    if (btn.dataset.tab === 'squad') renderSquadTab();
    if (btn.dataset.tab === 'market') renderMarket();
    if (btn.dataset.tab === 'packs') renderPacks();
    if (btn.dataset.tab === 'rank') renderRank();
    if (btn.dataset.tab === 'news') renderNews();
    if (btn.dataset.tab === 'predict') startPredictPolling();
    else stopPredictPolling();
    if (btn.dataset.tab === 'match' && !state.inMatch) startSpectatePolling();
    else stopSpectatePolling();
  };
});

document.querySelectorAll('#rank-subtabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#rank-subtabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const sub = btn.dataset.subtab;
    $('#rank-sub-board').classList.toggle('hidden', sub !== 'board');
    $('#rank-sub-top').classList.toggle('hidden', sub !== 'top');
    $('#rank-sub-perf').classList.toggle('hidden', sub !== 'perf');
    if (sub === 'top') renderTopPerformers();
    if (sub === 'perf') renderTeamRecord();
  };
});

// =====================================================================
// squad tab
// =====================================================================

function renderSquadTab() {
  $('#mode-main').classList.toggle('active', state.squadMode === 'main');
  $('#mode-pvp').classList.toggle('active', state.squadMode === 'pvp');
  $('#pvp-note').classList.toggle('hidden', state.squadMode !== 'pvp');
  renderFormationSelect();
  renderTacticSelect();
  renderCaptainSelect();
  renderRoleSelect();
  renderPitch();
  renderRatings();
  renderOwnedList();
}

// FM 스타일 선수 유형(포지션별 역할) — 같은 포지션 안에서도 어떤 스타일로
//뛸지 선택. 역할이 2개 이상 존재하는 포지션의 선발 선수만 표시한다.
function renderRoleSelect() {
  const wrap = $('#role-picker');
  if (!wrap) return;
  const squad = activeSquad();
  const roleDefs = state.roles || {};
  const rows = squad.starters
    .map((id) => (id ? state.catalog.get(id) : null))
    .filter(Boolean)
    .map((p) => {
      const opts = Object.entries(roleDefs).filter(([, r]) => r.pos.includes(p.pos));
      if (opts.length < 2) return '';
      let current = squad.roles && squad.roles[p.id];
      if (!current) {
        const def = opts.find(([, r]) => r.isDefault);
        current = def ? def[0] : opts[0][0];
      }
      const chips = opts
        .map(
          ([roleId, r]) =>
            `<button type="button" class="role-chip${roleId === current ? ' active' : ''}" data-player="${p.id}" data-role="${roleId}">${r.label}</button>`
        )
        .join('');
      return `<div class="role-row"><span class="role-player">${p.name} <span class="dim small-text">${p.pos}</span></span><div class="role-chips">${chips}</div></div>`;
    })
    .filter(Boolean)
    .join('');
  wrap.innerHTML = rows || '<p class="dim small-text">선택 가능한 유형이 있는 선발 선수가 없습니다.</p>';
  wrap.querySelectorAll('.role-chip').forEach((btn) => {
    btn.onclick = () => {
      const roles = Object.assign({}, activeSquad().roles || {});
      roles[btn.dataset.player] = btn.dataset.role;
      saveSquad({ roles });
    };
  });
}

// 주장/부주장은 선발 명단 안에서만 지정 가능 — 목록은 항상 현재 스쿼드 기준.
function renderCaptainSelect() {
  const squad = activeSquad();
  const starters = squad.starters.filter(Boolean);
  const optionsHTML = (selected, exclude) => {
    const opts = ['<option value="">지정 안 함</option>'];
    starters
      .filter((id) => id !== exclude)
      .forEach((id) => {
        const p = state.catalog.get(id);
        if (!p) return;
        opts.push(`<option value="${id}"${id === selected ? ' selected' : ''}>${p.name}</option>`);
      });
    return opts.join('');
  };
  $('#captain-select').innerHTML = optionsHTML(squad.captain, squad.viceCaptain);
  $('#vice-select').innerHTML = optionsHTML(squad.viceCaptain, squad.captain);
}

$('#captain-select').onchange = (e) => saveSquad({ captain: e.target.value || null });
$('#vice-select').onchange = (e) => saveSquad({ viceCaptain: e.target.value || null });

$('#mode-main').onclick = () => {
  state.squadMode = 'main';
  renderSquadTab();
};
$('#mode-pvp').onclick = () => {
  state.squadMode = 'pvp';
  renderSquadTab();
};

function renderFormationSelect() {
  const sel = $('#formation-select');
  sel.innerHTML = '';
  Object.keys(state.formations).forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    if (f === activeSquad().formation) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderTacticSelect() {
  const sel = $('#tactic-select');
  sel.innerHTML = '';
  Object.entries(state.tactics).forEach(([id, label]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = '전술: ' + label;
    if (id === (activeSquad().tactic || 'balanced')) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function saveSquad(patch) {
  const squad = activeSquad();
  const body = {
    kind: state.squadMode,
    formation: squad.formation,
    starters: squad.starters,
    tactic: squad.tactic || 'balanced',
    ...patch,
  };
  const { user } = await api('PUT', '/api/squad', body);
  setMe(user);
  renderSquadTab();
}

$('#formation-select').onchange = async (e) => {
  const formation = e.target.value;
  const slots = state.formations[formation].length;
  // Keep assignments by index where possible; server re-validates.
  const starters = activeSquad().starters.slice(0, slots);
  while (starters.length < slots) starters.push(null);
  try {
    await saveSquad({ formation, starters });
  } catch (err) {
    toast(err.message);
    renderSquadTab();
  }
};

$('#tactic-select').onchange = async (e) => {
  try {
    await saveSquad({ tactic: e.target.value });
    toast('전술이 변경되었습니다: ' + state.tactics[e.target.value]);
  } catch (err) {
    toast(err.message);
    renderSquadTab();
  }
};

$('#btn-auto').onclick = async () => {
  try {
    const { user } = await api('POST', '/api/squad/auto', { kind: state.squadMode });
    setMe(user);
    renderSquadTab();
    toast('베스트 11이 자동 배치되었습니다.');
  } catch (err) {
    toast(err.message);
  }
};

function renderPitch() {
  const pitch = $('#pitch');
  pitch.querySelectorAll('.slot').forEach((s) => s.remove());
  const squad = activeSquad();
  const formation = squad.formation;
  const slots = state.formations[formation];
  const coords = COORDS[formation] || COORDS['4-3-3'];

  slots.forEach((pos, i) => {
    const id = squad.starters[i];
    const p = id ? upgradedCard(state.catalog.get(id)) : null;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'slot';
    el.style.left = coords[i][0] + '%';
    el.style.bottom = coords[i][1] + '%';
    const badge = id && id === squad.captain ? 'C' : id && id === squad.viceCaptain ? 'VC' : '';
    // out-of-position: the card converts to the slot (CAM->RB) at reduced OVR
    el.innerHTML = p ? cardHTML(convertedCard(p, pos), 'xs', { badge }) : emptySlotHTML(pos);
    el.onclick = () => openPicker(i, pos);
    pitch.appendChild(el);
  });
}

function renderRatings() {
  const r = activeRatings();
  $('#ratings-bar').innerHTML = [
    ['공격', r.ATT], ['미드필드', r.MID], ['수비', r.DEF], ['GK', r.GK],
    ['케미', r.chemistry + '%'], ['OVR', r.OVR, 'ovr'],
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="rating-cell ${cls || ''}"><div class="rc-label">${label}</div><div class="rc-value">${value}</div></div>`
    )
    .join('');
}

const POS_ORDER = { GK: 0, DEF: 1, MID: 2, ATT: 3 };
const OWNED_SORTS = {
  ovr: (a, b) => b.ovr - a.ovr,
  pos: (a, b) => (POS_ORDER[a.line] ?? 9) - (POS_ORDER[b.line] ?? 9) || b.ovr - a.ovr,
  name: (a, b) => a.name.localeCompare(b.name),
  price: (a, b) => (b.price || 0) - (a.price || 0),
};

function renderOwnedList() {
  const list = $('#owned-list');
  const starters = new Set(activeSquad().starters.filter(Boolean));
  const q = ($('#owned-search').value || '').trim().toLowerCase();
  const lineFilter = $('#owned-line').value;
  const sortKey = $('#owned-sort').value || 'ovr';
  const pool = activePoolIds()
    .map((id) => upgradedCard(state.catalog.get(id)))
    .filter(Boolean);
  const owned = pool
    .filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!lineFilter || p.line === lineFilter))
    .sort(OWNED_SORTS[sortKey] || OWNED_SORTS.ovr);
  document.querySelector('.owned-col h3').firstChild.textContent =
    state.squadMode === 'pvp' ? '뽑은 선수 ' : '보유 선수 ';
  $('#owned-count').textContent = `(${owned.length}/${pool.length}명)`;
  if (state.squadMode === 'pvp' && !pool.length) {
    list.innerHTML = '<p class="dim">아직 뽑은 카드가 없습니다. 뽑기 탭에서 카드를 획득하세요!</p>';
    return;
  }
  list.innerHTML = '';
  if (!owned.length) {
    list.innerHTML = '<p class="dim">조건에 맞는 선수가 없습니다.</p>';
    return;
  }
  const mainStarters = new Set((state.me.squad.starters || []).filter(Boolean));
  const pvpStarters = new Set((state.me.pvpSquad.starters || []).filter(Boolean));
  owned.forEach((p) => {
    const isStarter = starters.has(p.id);
    const lvl = upLevel(p.id);
    const cell = document.createElement('div');
    cell.className = 'card-cell';
    cell.innerHTML = `
      ${cardHTML(p, 'sm', { flag: isStarter ? '선발' : '' })}
      <div class="cc-actions">
        <button class="btn ghost small enh-btn">⚡${lvl ? `+${lvl}` : '강화'}</button>
        <button class="btn ghost small sell-btn">판매 🪙${Math.round(p.price * 0.55).toLocaleString()}</button>
      </div>`;
    cell.querySelector('.enh-btn').onclick = () => openEnhance(p.id);
    cell.querySelector('.sell-btn').onclick = async () => {
      const inLineups = [
        mainStarters.has(p.id) ? '클럽 스쿼드 선발' : null,
        pvpStarters.has(p.id) ? '실전 스쿼드 선발' : null,
      ].filter(Boolean);
      const warn =
        (inLineups.length
          ? `\n⚠️ 현재 ${inLineups.join('과 ')}에 배치되어 있습니다. 판매하면 해당 자리는 빈 슬롯(유스 투입)이 됩니다.`
          : '') + (lvl ? `\n⚡ 강화 +${lvl} 단계도 함께 사라집니다.` : '');
      if (!confirm(`${p.name} 선수를 판매할까요?${warn}`)) return;
      try {
        const { user, coinsGained, perfBonusPct } = await api('POST', '/api/market/sell', { playerId: p.id });
        setMe(user);
        renderSquadTab();
        const bonus = perfBonusPct > 0 ? ` (실적 보너스 +${perfBonusPct}%)` : '';
        toast(`${p.name} 판매 완료 · 🪙${coinsGained.toLocaleString()}${bonus}`);
      } catch (err) {
        toast(err.message);
      }
    };
    list.appendChild(cell);
  });
}

$('#owned-search').oninput = renderOwnedList;
$('#owned-line').onchange = renderOwnedList;
$('#owned-sort').onchange = renderOwnedList;

// ---- picker modal ----

function fitClass(playerLine, slotLine) {
  if (playerLine === slotLine) return ['fit-good', '적합'];
  if (playerLine === 'GK' || slotLine === 'GK') return ['fit-bad', '부적합'];
  const adj =
    (playerLine === 'DEF' && slotLine === 'MID') ||
    (playerLine === 'MID' && slotLine === 'DEF') ||
    (playerLine === 'MID' && slotLine === 'ATT') ||
    (playerLine === 'ATT' && slotLine === 'MID');
  return adj ? ['fit-ok', '보통'] : ['fit-bad', '부적합'];
}

function slotLineOf(pos) {
  if (pos === 'GK') return 'GK';
  if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos)) return 'DEF';
  if (['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(pos)) return 'MID';
  return 'ATT';
}

// Out-of-position OVR penalty (mirrors the server): exact 0 · same line 2 ·
// adjacent line 6 · opposite line 10. The card converts to the slot position.
function posPenaltyClient(p, slotPos) {
  if (p.pos === slotPos) return 0;
  const a = p.line;
  const b = slotLineOf(slotPos);
  if (a === b) return 2;
  const adj =
    (a === 'DEF' && b === 'MID') ||
    (a === 'MID' && b === 'DEF') ||
    (a === 'MID' && b === 'ATT') ||
    (a === 'ATT' && b === 'MID');
  return adj ? 6 : 10;
}

function convertedCard(p, slotPos) {
  const pen = posPenaltyClient(p, slotPos);
  if (!pen) return p;
  return { ...p, pos: slotPos, ovr: Math.max(30, p.ovr - pen) };
}

function openPicker(slotIndex, pos) {
  state.pickSlot = slotIndex;
  $('#picker-title').textContent = `${pos} 슬롯에 배치할 선수 선택`;
  const line = slotLineOf(pos);
  const list = $('#picker-list');
  list.innerHTML = '';

  const currentId = activeSquad().starters[slotIndex];
  const owned = activePoolIds()
    .map((id) => upgradedCard(state.catalog.get(id)))
    .filter(Boolean)
    // GK 슬롯엔 골키퍼만, 필드 슬롯엔 골키퍼 배치 불가
    .filter((p) => (line === 'GK' ? p.line === 'GK' : p.line !== 'GK'))
    .sort((a, b) => {
      const fa = a.line === line ? 2 : 0;
      const fb = b.line === line ? 2 : 0;
      return fb - fa || b.ovr - a.ovr;
    });

  if (!owned.length) {
    list.innerHTML =
      line === 'GK'
        ? '<p class="dim">배치 가능한 골키퍼가 없습니다.</p>'
        : '<p class="dim">배치 가능한 선수가 없습니다.</p>';
  }

  owned.forEach((p) => {
    if (p.id === currentId) return;
    const [cls, label] = fitClass(p.line, line);
    const pen = posPenaltyClient(p, pos);
    const inSlot = activeSquad().starters.indexOf(p.id);
    const cell = document.createElement('div');
    cell.className = 'card-cell picker-cell';
    cell.innerHTML = `
      ${cardHTML(pen ? { ...p, ovr: Math.max(30, p.ovr - pen) } : p, 'sm', { flag: inSlot >= 0 ? '선발중' : '' })}
      <div class="cc-fit"><span class="fit-tag ${cls}">${label}${pen ? ` −${pen}` : ''}</span></div>`;
    cell.onclick = () => assignToSlot(slotIndex, p.id);
    list.appendChild(cell);
  });

  $('#picker-overlay').classList.remove('hidden');
}

async function assignToSlot(slotIndex, playerId) {
  const starters = [...activeSquad().starters];
  const existing = starters.indexOf(playerId);
  if (existing >= 0) starters[existing] = starters[slotIndex]; // swap
  starters[slotIndex] = playerId;
  await saveStarters(starters);
  closePicker();
}

async function saveStarters(starters) {
  try {
    await saveSquad({ starters });
  } catch (err) {
    toast(err.message);
  }
}

function closePicker() {
  $('#picker-overlay').classList.add('hidden');
  state.pickSlot = null;
}

$('#picker-close').onclick = closePicker;
$('#picker-overlay').onclick = (e) => {
  if (e.target === $('#picker-overlay')) closePicker();
};
$('#picker-clear').onclick = async () => {
  if (state.pickSlot === null) return;
  const starters = [...activeSquad().starters];
  starters[state.pickSlot] = null;
  await saveStarters(starters);
  closePicker();
};

// =====================================================================
// 선수 강화 modal
// =====================================================================

const enh = { id: null, busy: false };

function enhLine(text, cls) {
  const log = $('#enh-log');
  const el = document.createElement('div');
  el.className = 'nego-line ' + (cls || 'sys');
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function enhCostOf(base, level) {
  // mirrors the server: price * costRate * target level, min 50
  return Math.max(50, Math.round((base.price || 200) * state.enhance.costRate * level));
}

function renderEnhance() {
  const base = state.catalog.get(enh.id);
  if (!base) return;
  const lvl = upLevel(enh.id);
  const cfg = state.enhance;
  const cur = upgradedCard(base);
  $('#enh-card').innerHTML = cardHTML(cur, 'md', { stats: true });
  const stars = '★'.repeat(lvl) + '☆'.repeat(Math.max(0, cfg.maxLevel - lvl));
  $('#enh-level').innerHTML = `강화 단계 <span class="enh-stars">${stars}</span> <b>+${lvl}</b>`;
  const btn = $('#enh-try');
  if (lvl >= cfg.maxLevel) {
    $('#enh-next').innerHTML = '<span class="dim">✨ 최대 강화 단계에 도달했습니다.</span>';
    btn.disabled = true;
    btn.textContent = '강화 완료';
    return;
  }
  const next = lvl + 1;
  const cost = enhCostOf(base, next);
  const rate = Math.round((cfg.rates[next - 1] || 0) * 100);
  $('#enh-next').innerHTML =
    `+${next} 강화 시 OVR <b>${cur.ovr}</b> → <b>${Math.min(99, base.ovr + next)}</b> · ` +
    `성공 확률 <b>${rate}%</b> · 실패 시 코인만 소모`;
  const short = state.me.coins < cost;
  btn.disabled = short || enh.busy;
  btn.textContent = short ? `코인 부족 (🪙 ${cost.toLocaleString()} 필요)` : `⚡ 강화 시도 (🪙 ${cost.toLocaleString()})`;
}

function openEnhance(playerId) {
  enh.id = playerId;
  enh.busy = false;
  $('#enh-log').innerHTML = '';
  renderEnhance();
  $('#enh-overlay').classList.remove('hidden');
}

$('#enh-try').onclick = async () => {
  if (enh.busy || !enh.id) return;
  enh.busy = true;
  $('#enh-try').disabled = true;
  let r = null;
  try {
    r = await api('POST', '/api/players/enhance', { playerId: enh.id });
    setMe(r.user);
    renderSquadTab(); // cards on the pitch/list show the new level
  } catch (err) {
    enhLine(err.message, 'bad');
  }
  enh.busy = false;
  renderEnhance();
  if (r) {
    const card = $('#enh-card');
    card.classList.remove('enh-shake', 'enh-flash');
    void card.offsetWidth;
    if (r.success) {
      enhLine(`✨ 강화 성공! +${r.level} 단계 (−🪙${r.cost.toLocaleString()})`, 'good');
      card.classList.add('enh-flash');
    } else {
      enhLine(`💥 강화 실패… 단계는 유지됩니다 (−🪙${r.cost.toLocaleString()})`, 'bad');
      card.classList.add('enh-shake');
    }
  }
};

function closeEnhance() {
  $('#enh-overlay').classList.add('hidden');
  enh.id = null;
}

$('#enh-close').onclick = closeEnhance;
$('#enh-overlay').onclick = (e) => {
  if (e.target === $('#enh-overlay')) closeEnhance();
};

// =====================================================================
// market tab
// =====================================================================

let marketLimit = 60;
let marketObserver = null;

function renderMarket() {
  const q = $('#market-search').value.trim().toLowerCase();
  const line = $('#market-line').value;
  const enhancedOnly = $('#market-enhanced').checked;
  const buyoutOnly = $('#market-buyout').checked;
  const ownedSet = new Set(state.me ? state.me.owned : []);
  const list = $('#market-list');
  list.innerHTML = '';

  const filtered = state.market.filter((p) => {
    if (p.youth) return false; // club-only academy fillers aren't for sale
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (line && p.line !== line) return false;
    if (enhancedOnly && !p.enhanced) return false;
    if (buyoutOnly && p.team) return false; // 바이아웃(FA)만: 구단 있는 선수 제외
    return true;
  });

  filtered.slice(0, marketLimit).forEach((p) => {
    const owned = ownedSet.has(p.id);
    const cell = document.createElement('div');
    cell.className = 'card-cell';
    cell.innerHTML = `
      ${cardHTML(p, 'md', { stats: true, flag: p.team ? '' : 'FA' })}
      <div class="cc-price">🪙 ${p.price.toLocaleString()}</div>
      <div class="cc-actions">
        ${owned
          ? '<span class="starter-tag">보유중</span>'
          : `<button class="btn small primary nego-btn">${p.team ? '협상 시작' : '바이아웃 협상'}</button>`}
      </div>`;
    const negoBtn = cell.querySelector('.nego-btn');
    if (negoBtn) negoBtn.onclick = () => openNegotiation(p);
    list.appendChild(cell);
  });

  if (!list.children.length && !q) {
    list.innerHTML = '<p class="dim">조건에 맞는 선수가 없습니다.</p>';
  }

  // infinite scroll: reveal more cards as the user reaches the bottom
  if (marketObserver) marketObserver.disconnect();
  if (filtered.length > marketLimit) {
    const sentinel = document.createElement('div');
    sentinel.className = 'dim small-text market-more';
    sentinel.textContent = `⌄ 스크롤하면 ${filtered.length - marketLimit}명 더 표시됩니다`;
    list.appendChild(sentinel);
    marketObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        marketLimit += 60;
        renderMarket();
      }
    });
    marketObserver.observe(sentinel);
  }

  // fall back to the live player DB for names the local catalog doesn't have
  // (e.g. 최근 이적으로 빠져 있는 선수)
  if (q.length >= 2) {
    const row = document.createElement('div');
    row.className = 'market-remote-row';
    row.innerHTML = `<button class="btn ghost small">🔍 “${q}” 실제 선수 DB에서 검색</button>`;
    row.querySelector('button').onclick = () => remoteFindPlayers(q);
    list.appendChild(row);
  }
}

async function remoteFindPlayers(q) {
  toast('실제 선수 DB에서 검색 중…');
  try {
    const { players: found } = await api('GET', '/api/players/search?q=' + encodeURIComponent(q));
    let added = 0;
    (found || []).forEach((p) => {
      if (!state.catalog.has(p.id)) {
        state.catalog.set(p.id, p);
        state.market.push(p);
        added++;
      }
    });
    toast(
      found && found.length
        ? added
          ? `${found.length}명 발견 · ${added}명 새로 등록되었습니다`
          : '이미 모두 등록된 선수입니다'
        : '해당 이름의 선수를 찾지 못했습니다'
    );
    renderMarket();
  } catch (err) {
    toast(err.message);
  }
}

$('#market-search').oninput = () => {
  marketLimit = 60;
  renderMarket();
};
$('#market-line').onchange = () => {
  marketLimit = 60;
  renderMarket();
};
$('#market-enhanced').onchange = () => {
  marketLimit = 60;
  renderMarket();
};
$('#market-buyout').onchange = () => {
  marketLimit = 60;
  renderMarket();
};

// =====================================================================
// transfer negotiation modal
// =====================================================================

const nego = { player: null, state: null };

function negoLine(text, cls) {
  const log = $('#nego-log');
  const el = document.createElement('div');
  el.className = 'nego-line ' + (cls || 'sys');
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function renderNegoStage() {
  const st = nego.state;
  const clubEl = $('#nego-stage-club');
  const persEl = $('#nego-stage-personal');
  clubEl.classList.remove('active', 'done');
  persEl.classList.remove('active', 'done');
  const p = nego.player;

  if (!st) return;
  if (st.stage === 'club') clubEl.classList.add('active');
  else {
    clubEl.classList.add('done');
    persEl.classList.add('active');
  }
  // FA도 이제 1단계(바이아웃)부터 진행하므로 클럽 스테이지 표시는 항상 보이되,
  // 상대가 구단이 아니라 선수 본인일 때는 라벨만 바이아웃으로 바꾼다.
  clubEl.textContent = p.team ? '🏟 구단 합의' : '💰 바이아웃';

  const partyLogo =
    st.stage === 'club' && p.team && p.teamLogo ? `<img src="${p.teamLogo}" alt="">` : '';
  const partyName =
    st.stage === 'club'
      ? p.team
        ? `${p.team} 구단`
        : `${p.name} 측 (바이아웃)`
      : `${p.name} 에이전트`;
  $('#nego-party').innerHTML = `${partyLogo}<span>${partyName}</span>`;

  const dots = '●'.repeat(st.attemptsLeft) + '○'.repeat(3 - st.attemptsLeft);
  const feeLabel = p.team ? '이적료' : '바이아웃';
  const feePart = st.fee ? ` · 합의된 ${feeLabel} 🪙${st.fee.toLocaleString()}` : '';
  $('#nego-info').innerHTML =
    `시장 가치 🪙${st.marketValue.toLocaleString()}${feePart} · 남은 시도 <span class="attempts-dots">${dots}</span> · 보유 🪙${state.me.coins.toLocaleString()}`;
}

async function openNegotiation(player) {
  nego.player = player;
  $('#nego-log').innerHTML = '';
  $('#nego-amount').value = '';
  $('#nego-card-col').innerHTML = cardHTML(player, 'md', { stats: true });
  $('#nego-overlay').classList.remove('hidden');
  $('#nego-offer').disabled = false;
  $('#nego-amount').disabled = false;
  try {
    const r = await api('POST', '/api/transfer/start', { playerId: player.id });
    nego.state = r.negotiation;
    negoLine(r.message, 'sys');
    renderNegoStage();
    $('#nego-amount').focus();
  } catch (err) {
    negoLine(err.message, 'bad');
    $('#nego-offer').disabled = true;
  }
}

async function submitOffer() {
  const amount = Number($('#nego-amount').value);
  if (!amount || amount <= 0) return;
  negoLine(`🪙 ${amount.toLocaleString()} 제시`, 'me');
  $('#nego-amount').value = '';
  try {
    const r = await api('POST', '/api/transfer/offer', { amount });
    nego.state = r.negotiation;
    if (r.result === 'signed') {
      negoLine(r.message, 'good');
      setMe(r.user);
      renderMarket();
      endNegotiationInput();
    } else if (r.result === 'failed') {
      negoLine(r.message, 'bad');
      endNegotiationInput();
    } else {
      negoLine(r.message, r.result === 'accepted' ? 'good' : r.result === 'rejected' ? 'bad' : 'sys');
      renderNegoStage();
    }
  } catch (err) {
    negoLine(err.message, 'bad');
  }
}

function endNegotiationInput() {
  $('#nego-offer').disabled = true;
  $('#nego-amount').disabled = true;
  nego.state = null;
}

function closeNegotiation() {
  if (nego.state) api('POST', '/api/transfer/cancel').catch(() => {});
  nego.state = null;
  nego.player = null;
  $('#nego-overlay').classList.add('hidden');
}

$('#nego-offer').onclick = submitOffer;
$('#nego-amount').onkeydown = (e) => {
  if (e.key === 'Enter') submitOffer();
};
$('#nego-close').onclick = closeNegotiation;
$('#nego-overlay').onclick = (e) => {
  if (e.target === $('#nego-overlay')) closeNegotiation();
};

// =====================================================================
// packs (선수 뽑기)
// =====================================================================

const PACK_META = {
  bronze: { emoji: '🥉', desc: 'OVR 79 이하', cls: 'pack-bronze' },
  silver: { emoji: '🥈', desc: 'OVR 78~85', cls: 'pack-silver' },
  gold: { emoji: '🥇', desc: 'OVR 84 이상', cls: 'pack-gold' },
  special: { emoji: '💎', desc: 'OVR 86+ · 강화 카드 확률 UP', cls: 'pack-special' },
  icon: { emoji: '👑', desc: '레전드 아이콘 카드 확정', cls: 'pack-icon' },
};

let lastPackId = null;

function renderPacks() {
  const shelf = $('#pack-shelf');
  shelf.innerHTML = '';
  (state.packs || []).forEach((pk) => {
    const meta = PACK_META[pk.id] || { emoji: '🎁', desc: '', cls: '' };
    const tile = document.createElement('div');
    tile.className = 'pack-tile ' + meta.cls;
    tile.innerHTML = `
      <span class="pk-emoji">${meta.emoji}</span>
      <span class="pk-name">${pk.name}</span>
      <span class="pk-desc">${meta.desc}</span>
      <span class="pk-price">🪙 ${pk.price.toLocaleString()}</span>
      <span class="pk-actions">
        <button class="btn small primary pk-open1">1회 뽑기</button>
        <button class="btn small pk-open5">5연속 🪙${(pk.price * 5).toLocaleString()}</button>
      </span>`;
    tile.querySelector('.pk-open1').onclick = () => openPack(pk.id, 1);
    tile.querySelector('.pk-open5').onclick = () => openPack(pk.id, 5);
    shelf.appendChild(tile);
  });
}

let lastPackCount = 1;
let cereTimers = [];

// FC-style walkout for an 80+ pull: fireworks, then nation -> position ->
// club hints build up before the card reveals; the rest sit below by price.
function packCeremony(best, results) {
  cereTimers.forEach(clearTimeout);
  cereTimers = [];
  const cere = $('#pack-ceremony');
  const sparks = $('#cere-sparks');
  const p = best.player;
  cere.classList.remove('hidden');
  // fireworks burst
  sparks.innerHTML = '';
  const colors = ['#ffd76e', '#ff7a7a', '#7ab8ff', '#9dff8a', '#e19bff'];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.className = 'cere-spark';
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 120;
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
    sparks.appendChild(s);
  }
  const flag = $('#cere-flag');
  const pos = $('#cere-pos');
  const club = $('#cere-club');
  [flag, pos, club].forEach((el) => el.classList.remove('on'));
  flag.textContent = p.flag || '🌍';
  pos.textContent = p.pos;
  if (p.teamLogo) {
    club.src = p.teamLogo;
    club.style.display = '';
  } else {
    club.style.display = 'none';
  }
  cereTimers.push(setTimeout(() => flag.classList.add('on'), 500));
  cereTimers.push(setTimeout(() => pos.classList.add('on'), 1400));
  cereTimers.push(setTimeout(() => club.classList.add('on'), 2300));
  cereTimers.push(
    setTimeout(() => {
      cere.classList.add('hidden');
      const wrap = $('#pack-card-wrap');
      wrap.classList.remove('multi');
      wrap.innerHTML = cardHTML(p, 'md', { stats: true });
      const others = results
        .filter((x) => x !== best)
        .sort((a, b) => (b.player.price || 0) - (a.player.price || 0));
      $('#pack-rest').innerHTML = others.map((x) => cardHTML(x.player, 'sm')).join('');
    }, 3300)
  );
}

async function openPack(packId, count = 1) {
  lastPackId = packId;
  lastPackCount = count;
  try {
    const r = await api('POST', '/api/packs/open', { pack: packId, count });
    setMe(r.user);
    const results = r.results || [r];
    const wrap = $('#pack-card-wrap');
    const rest = $('#pack-rest');
    wrap.innerHTML = ''; // reset so the flip animation replays
    rest.innerHTML = '';
    $('#pack-ceremony').classList.add('hidden');
    void wrap.offsetWidth;
    const best = results.reduce((a, x) => (x.player.ovr > a.player.ovr ? x : a), results[0]);
    if (best.player.ovr >= 80) {
      // 80+ 워크아웃 (단독 뽑기 포함): fireworks -> nation -> position ->
      // club -> reveal. 1등만 크게 부각되고 나머지는 아래 줄에 살짝 작게.
      wrap.classList.remove('multi');
      packCeremony(best, results);
    } else {
      // 눈에 띄는 카드가 없으면 그냥 가로 한 줄 나열 (가격순)
      wrap.classList.toggle('multi', results.length > 1);
      const sorted = [...results].sort((a, b) => (b.player.price || 0) - (a.player.price || 0));
      wrap.innerHTML = sorted
        .map((x) => cardHTML(x.player, results.length > 1 ? 'sm' : 'md', { stats: results.length === 1 }))
        .join('');
    }
    const resultEl = $('#pack-result-text');
    if (results.length === 1) {
      const one = results[0];
      if (one.duplicate) {
        resultEl.innerHTML = `${one.player.name} — 이미 보유 중!<span class="sub">🪙 ${one.refund.toLocaleString()} 코인으로 전환되었습니다</span>`;
      } else if (one.unlocked) {
        resultEl.innerHTML = `${one.player.name} — 실전 스쿼드 사용권 획득!<span class="sub">이미 보유한 선수지만 이제 실전(랭크) 스쿼드에 배치할 수 있습니다</span>`;
      } else {
        const rare = one.player.enhanced ? '💎 잭팟! ' : '';
        resultEl.innerHTML = `${rare}${one.player.name} 영입!<span class="sub">${one.player.pos} · OVR ${one.player.ovr} · 실전 스쿼드 배치 가능</span>`;
      }
    } else {
      const fresh = results.filter((x) => !x.duplicate && !x.unlocked).length;
      const unlocked = results.filter((x) => x.unlocked).length;
      const refund = results.reduce((s, x) => s + (x.refund || 0), 0);
      const jack = results.some((x) => x.player.enhanced) ? '💎 잭팟 포함! ' : '';
      resultEl.innerHTML =
        `${jack}${results.length}장 개봉 완료<span class="sub">신규 영입 ${fresh}명 · 사용권 해금 ${unlocked}명 · 중복 환급 🪙${refund.toLocaleString()}</span>`;
    }
    $('#pack-reveal').classList.remove('hidden');
  } catch (err) {
    toast(err.message);
  }
}

$('#btn-pack-again').onclick = () => {
  if (lastPackId) openPack(lastPackId, lastPackCount);
};
$('#btn-pack-close').onclick = () => $('#pack-reveal').classList.add('hidden');

// =====================================================================
// club change (승점 250)
// =====================================================================

let clubLeague = 'EPL';

function renderClubGrid() {
  renderLeagueSelect($('#club-league-select'), clubLeague, { clubsOnly: true });
  const grid = $('#club-grid');
  grid.innerHTML = '';
  teamsInLeague(clubLeague)
    .filter((t) => t.type === 'club')
    .forEach((t) => {
      const isCurrent = t.name === state.me.baseTeam;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'team-card' + (isCurrent ? ' selected' : '');
      card.innerHTML =
        teamCardHTML(t) + (isCurrent ? '<span class="starter-tag">현재 클럽</span>' : '');
      card.onclick = async () => {
        if (isCurrent) return;
        if (
          !confirm(
            `${t.name}(으)로 클럽을 변경할까요?\n승점 ${state.clubChangeCost}이 차감되고 기존 클럽 선수단은 떠납니다. (뽑은 카드·영입 선수는 유지)`
          )
        )
          return;
        try {
          if (t.dyn) toast('실제 선수단을 불러오는 중입니다…');
          const { user } = await api('POST', '/api/club/change', { team: t.name });
          if (t.dyn) await loadBootstrap();
          setMe(user);
          $('#club-overlay').classList.add('hidden');
          renderSquadTab();
          toast(`${t.name}(으)로 클럽을 변경했습니다!`);
        } catch (err) {
          toast(err.message);
        }
      };
      grid.appendChild(card);
    });
}

$('#btn-club-change').onclick = async () => {
  clubLeague = (state.teams.find((t) => t.name === state.me.baseTeam) || {}).league || 'EPL';
  renderClubGrid();
  $('#club-overlay').classList.remove('hidden');
  await loadLeagueTeams();
  renderClubGrid();
};
$('#club-league-select').onchange = (e) => {
  clubLeague = e.target.value;
  renderClubGrid();
};
$('#club-close').onclick = () => $('#club-overlay').classList.add('hidden');
$('#club-overlay').onclick = (e) => {
  if (e.target === $('#club-overlay')) $('#club-overlay').classList.add('hidden');
};

// =====================================================================
// predictions (승부 예측)
// =====================================================================

let predictTimer = null;

function startPredictPolling() {
  renderPredictions();
  clearInterval(predictTimer);
  predictTimer = setInterval(renderPredictions, 8000);
}
function stopPredictPolling() {
  clearInterval(predictTimer);
  predictTimer = null;
}

$('#btn-predict-refresh').onclick = () => {
  renderPredictions();
  toast('예측 보드를 새로고침했습니다');
};

function fixtureTeamHTML(name, logo) {
  const img = logo ? `<img src="${logo}" alt="" onerror="this.remove()">` : '';
  return `<span class="fx-team">${img}${name}</span>`;
}

const PICK_LABEL = { home: '홈 승', draw: '무승부', away: '원정 승' };

// Real-fixture kickoff label: countdown when close, local date/time otherwise.
function kickoffLabel(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '킥오프';
  if (diff < 3600e3) return `⏱ ${Math.max(1, Math.ceil(diff / 60000))}분 후 킥오프`;
  return (
    new Date(ms).toLocaleString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' 킥오프'
  );
}

function renderFixture(fx, live) {
  const el = document.createElement('div');
  el.className = 'fixture';
  const topRight =
    fx.status === 'done' && fx.result
      ? `<span class="fx-score">${fx.result.score.home} - ${fx.result.score.away}</span>`
      : fx.status === 'live'
        ? `<span class="fx-score fx-live">${
            fx.live ? `${fx.live.home} - ${fx.live.away}` : '⚽'
          }</span><span class="fx-count fx-live-min">${fx.elapsedMin != null ? fx.elapsedMin + "'" : '진행 중'}</span>`
        : `<span class="fx-count">${kickoffLabel(fx.kickoffAt)}</span>`;
  el.innerHTML = `
    <div class="fx-top">
      <span class="fx-league">${fx.leagueLabel}</span>
      ${fixtureTeamHTML(fx.home, fx.homeLogo)}
      <span class="fx-vs">vs</span>
      ${fixtureTeamHTML(fx.away, fx.awayLogo)}
      ${topRight}
    </div>`;

  const actions = document.createElement('div');
  actions.className = 'fx-actions';

  if (fx.status === 'done' && fx.result) {
    const outcomeKo = PICK_LABEL[fx.result.outcome];
    let mine = '<span class="dim small-text">참여하지 않음</span>';
    if (fx.myBet) {
      const betTxt =
        PICK_LABEL[fx.myBet.pick] +
        (fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : '');
      mine = `<span class="fx-bet-tag">내 예측: ${betTxt}</span>
              <span class="fx-reward">+${(fx.myBet.reward || 0).toLocaleString()} 코인</span>`;
    }
    actions.innerHTML = `<span class="dim small-text">결과: ${outcomeKo}</span>${mine}`;
  } else if (fx.status !== 'open') {
    // kicked off: betting closed until the real result comes in
    const mine = fx.myBet
      ? `<span class="fx-bet-tag">내 예측: ${PICK_LABEL[fx.myBet.pick]}${
          fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : ''
        }</span>`
      : '<span class="dim small-text">참여하지 않음</span>';
    actions.innerHTML = `<span class="dim small-text">경기 종료 후 자동 정산됩니다</span>${mine}`;
  } else {
    // pick buttons + optional score
    ['home', 'draw', 'away'].forEach((pick) => {
      const b = document.createElement('button');
      b.className =
        'btn small fx-pick' + (fx.myBet && fx.myBet.pick === pick ? ' picked' : '');
      b.textContent = PICK_LABEL[pick];
      b.onclick = async () => {
        const sh = el.querySelector('.fx-sh').value;
        const sa = el.querySelector('.fx-sa').value;
        const score = sh !== '' && sa !== '' ? { home: sh, away: sa } : null;
        try {
          await api('POST', '/api/predictions/bet', { fixtureId: fx.id, pick, score });
          toast('예측 완료! 실제 경기 종료 후 자동 정산됩니다.');
          renderPredictions();
        } catch (err) {
          toast(err.message);
        }
      };
      actions.appendChild(b);
    });
    const scoreWrap = document.createElement('span');
    scoreWrap.innerHTML = `
      <input class="fx-score-in fx-sh" type="number" min="0" max="9" placeholder="홈"
        value="${fx.myBet && fx.myBet.score ? fx.myBet.score.home : ''}"> :
      <input class="fx-score-in fx-sa" type="number" min="0" max="9" placeholder="원정"
        value="${fx.myBet && fx.myBet.score ? fx.myBet.score.away : ''}">
      <span class="dim small-text">(선택) 정확한 스코어</span>`;
    actions.appendChild(scoreWrap);
    if (fx.myBet) {
      const tag = document.createElement('span');
      tag.className = 'fx-bet-tag';
      tag.textContent = `내 예측: ${PICK_LABEL[fx.myBet.pick]}${fx.myBet.score ? ` (${fx.myBet.score.home}-${fx.myBet.score.away})` : ''}`;
      actions.appendChild(tag);
    }
  }
  el.appendChild(actions);
  return el;
}

async function renderPredictions() {
  try {
    const data = await api('GET', '/api/predictions');
    const list = $('#predict-list');
    list.innerHTML = '';
    if (!data.current.length) {
      list.innerHTML = '<p class="dim">실제 경기 일정을 불러오는 중입니다… 잠시 후 자동 갱신됩니다.</p>';
    } else {
      data.current.forEach((fx) => list.appendChild(renderFixture(fx, true)));
    }
    const last = $('#predict-last');
    last.innerHTML = '';
    if (!data.last.length) {
      last.innerHTML = '<p class="dim">아직 정산된 경기가 없습니다.</p>';
    } else {
      data.last.forEach((fx) => last.appendChild(renderFixture(fx, false)));
    }
    // 헤더 코인 갱신 (보상 반영)
    const { user } = await api('GET', '/api/me');
    setMe(user);
  } catch (err) {
    toast(err.message);
  }
}

// =====================================================================
// match tab (websocket)
// =====================================================================

function ensureWs() {
  if (state.ws && state.ws.readyState === 1 && state.ws.authed) {
    return Promise.resolve(state.ws);
  }
  if (state.wsReady) return state.wsReady;

  state.wsReady = new Promise((resolve, reject) => {
    const wsBase = window.APP_CONFIG && window.APP_CONFIG.WS_BASE;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(wsBase ? `${wsBase}/ws` : `${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.authed = false;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'authed') {
        ws.authed = true;
        state.wsReady = null;
        resolve(ws);
      }
      handleWsMessage(msg);
    };
    ws.onerror = () => {
      state.wsReady = null;
      reject(new Error('서버에 연결할 수 없습니다.'));
    };
    ws.onclose = () => {
      state.wsReady = null;
      if (state.ws === ws) state.ws = null;
      if (state.inMatch) {
        state.inMatch = false;
        toast('서버와의 연결이 끊어졌습니다.');
        backToLobby();
      }
      setQueueUi(false);
    };
  });
  return state.wsReady;
}

function setQueueUi(queued) {
  $('#queue-status').classList.toggle('hidden', !queued);
  $('#btn-queue').disabled = queued;
  $('#btn-queue-ai').disabled = queued;
}

async function sendWs(msg) {
  try {
    const ws = await ensureWs();
    ws.send(JSON.stringify(msg));
  } catch (err) {
    $('#match-error').textContent = err.message;
  }
}

$('#btn-queue').onclick = () => {
  // ranked uses the PvP squad: warn when youth stand-ins would have to play
  const empty = (state.me.pvpSquad.starters || []).filter((id) => !id).length;
  if (
    empty > 0 &&
    !confirm(
      `실전 스쿼드에 빈 슬롯이 ${empty}개 있습니다.\n빈 자리는 유스 선수(OVR 40)가 대신 출전합니다. 그래도 참가할까요?`
    )
  ) {
    return;
  }
  $('#match-error').textContent = '';
  sendWs({ type: 'queue' });
};
$('#btn-queue-ai').onclick = () => {
  $('#match-error').textContent = '';
  sendWs({ type: 'queue_ai' });
};
$('#btn-cancel-queue').onclick = () => sendWs({ type: 'cancel' });
$('#btn-back-lobby').onclick = () => backToLobby();
$('#result-overlay').onclick = (e) => {
  if (e.target === $('#result-overlay')) backToLobby();
};

function backToLobby() {
  state.inMatch = false;
  state.spectating = false;
  vizStop();
  $('#match-live').classList.add('hidden');
  $('#match-lobby').classList.remove('hidden');
  $('#result-overlay').classList.add('hidden');
  setQueueUi(false);
  if (!$('#tab-match').classList.contains('hidden')) startSpectatePolling();
}

// =====================================================================
// 관전 (spectator mode)
// =====================================================================

let spectateTimer = null;

function startSpectatePolling() {
  refreshSpectateList();
  clearInterval(spectateTimer);
  spectateTimer = setInterval(refreshSpectateList, 6000);
}

function stopSpectatePolling() {
  clearInterval(spectateTimer);
  spectateTimer = null;
}

function refreshSpectateList() {
  if (state.inMatch) return;
  sendWs({ type: 'spectate_list' });
}

function renderSpectateList(matches) {
  const list = $('#spectate-list');
  if (!matches || !matches.length) {
    list.innerHTML = '<p class="dim small-text">진행 중인 경기가 없습니다.</p>';
    return;
  }
  list.innerHTML = '';
  matches.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'spec-row';
    row.innerHTML = `
      <span class="spec-mode">${m.mode === 'pvp' ? '랭크' : 'AI전'}</span>
      <span class="spec-names">${m.home} <b>${m.score.home} - ${m.score.away}</b> ${m.away}</span>
      <span class="dim small-text">${m.display}</span>
      <button class="btn small primary">관전</button>`;
    row.querySelector('button').onclick = () => sendWs({ type: 'spectate', matchId: m.id });
    list.appendChild(row);
  });
}

$('#btn-spectate-leave').onclick = () => {
  sendWs({ type: 'spectate_leave' });
  backToLobby();
};

// =====================================================================
// 작전 타임: pause the live match, swap positions / substitute players
// =====================================================================

const pauseUi = { formation: null, starters: [], poolKind: 'owned', sel: null };

$('#btn-pause').onclick = () => sendWs({ type: 'pause' });
$('#pp-resume').onclick = () => sendWs({ type: 'resume' });
$('#pp-apply').onclick = () => {
  sendWs({ type: 'update_squad', formation: pauseUi.formation, starters: pauseUi.starters });
};
$('#pp-formation').onchange = (e) => {
  pauseUi.formation = e.target.value;
  renderPausePanel();
};

function setupPausePanel(formation, starters, poolKind) {
  pauseUi.formation = formation;
  pauseUi.starters = [...starters];
  pauseUi.poolKind = poolKind || 'owned';
  pauseUi.sel = null;
  const fsel = $('#pp-formation');
  fsel.innerHTML = '';
  Object.keys(state.formations).forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    if (f === pauseUi.formation) opt.selected = true;
    fsel.appendChild(opt);
  });
  renderPausePanel();
}

// The panel sits beside the pitch at all times; it only becomes interactive
// during your own 작전 타임.
function initPausePanel(mode) {
  const kind = mode === 'pvp' ? 'pvpSquad' : 'squad';
  const sq = (state.me && state.me[kind]) || { formation: '4-3-3', starters: new Array(11).fill(null) };
  setupPausePanel(sq.formation, sq.starters, mode === 'pvp' ? 'drawn' : 'owned');
  $('#pause-panel').classList.add('disabled');
}

function openPausePanel(msg) {
  setupPausePanel(msg.squad.formation, msg.squad.starters, msg.poolKind);
  $('#pause-panel').classList.remove('disabled');
}

function ppItem(label, p, extra) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pp-list-item' + (extra && extra.selected ? ' selected' : '');
  b.innerHTML = `
    <span class="pp-pos">${label}</span>
    <span>${p ? p.name : '<span class="dim">빈 슬롯</span>'}</span>
    <span class="pp-ovr">${p ? p.ovr : ''}</span>`;
  return b;
}

function renderPausePanel() {
  const slots = state.formations[pauseUi.formation] || [];
  const xi = $('#pp-xi');
  xi.innerHTML = '';
  slots.forEach((pos, i) => {
    const p = pauseUi.starters[i] ? upgradedCard(state.catalog.get(pauseUi.starters[i])) : null;
    const item = ppItem(pos, p, { selected: pauseUi.sel === i });
    item.onclick = () => {
      if (pauseUi.sel === null) {
        pauseUi.sel = i;
      } else if (pauseUi.sel === i) {
        pauseUi.sel = null;
      } else {
        // swap positions within the XI
        const t = pauseUi.starters[pauseUi.sel];
        pauseUi.starters[pauseUi.sel] = pauseUi.starters[i];
        pauseUi.starters[i] = t;
        pauseUi.sel = null;
      }
      renderPausePanel();
    };
    xi.appendChild(item);
  });

  const inXi = new Set(pauseUi.starters.filter(Boolean));
  const bench = ((state.me && state.me[pauseUi.poolKind]) || [])
    .filter((id) => !inXi.has(id))
    .map((id) => upgradedCard(state.catalog.get(id)))
    .filter(Boolean)
    .sort((a, b) => b.ovr - a.ovr)
    .slice(0, 40);
  const benchEl = $('#pp-bench');
  benchEl.innerHTML = '';
  if (!bench.length) {
    benchEl.innerHTML = '<p class="dim small-text">교체 투입할 수 있는 선수가 없습니다.</p>';
  }
  bench.forEach((p) => {
    const item = ppItem(p.pos, p);
    item.onclick = () => {
      if (pauseUi.sel === null) {
        toast('먼저 교체할 선발 선수를 선택하세요.');
        return;
      }
      pauseUi.starters[pauseUi.sel] = p.id; // substitution
      pauseUi.sel = null;
      renderPausePanel();
    };
    benchEl.appendChild(item);
  });
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'queued':
      setQueueUi(true);
      break;
    case 'cancelled':
      setQueueUi(false);
      break;
    case 'error':
      setQueueUi(false);
      $('#match-error').textContent = msg.error;
      toast(msg.error);
      break;
    case 'match_start':
      startLiveMatch(msg);
      break;
    case 'spectate_list':
      renderSpectateList(msg.matches);
      break;
    case 'tick':
      viz.minute = Math.min(90, msg.minute);
      viz.srvMin = msg.minute; // 시계 상한: 애니메이션이 따라잡을 목표
      // scoreboard clock/score follow the ANIMATION (see vizFrame); mirror
      // the server values directly only when the top view isn't running.
      if (!viz.raf) {
        $('#sb-minute').textContent = msg.display || msg.minute + "'";
        $('#sb-score').textContent = `${msg.score.home} - ${msg.score.away}`;
      }
      vizOnTick();
      break;
    case 'event':
      // queue events so each scripted play finishes before the next starts
      if (viz.raf) viz.queue.push(msg.event);
      else addFeedItem(msg.event.minute + "'", msg.event.text, msg.event.type);
      break;
    case 'phase':
      if (msg.half && viz.raf) {
        // half time text/toast must wait for the actual on-screen swap
        // (below, when pendingHalf fires) — showing it the instant the
        // server hits minute 45 popped it early while the animation was
        // still finishing the first half's backlog.
        viz.pendingHalf = true;
        viz.pendingHalfText = msg.text;
      } else {
        addFeedItem('', msg.text, 'phase');
        showEventBanner(msg.text, 'phase', 2600);
      }
      break;
    case 'paused':
      viz.paused = true;
      $('#btn-pause').disabled = true;
      $('#pause-left').textContent = msg.pausesLeft[state.mySide || 'home'];
      $('#pause-status').textContent = msg.yours
        ? `작전 타임 — 최대 ${msg.timeoutSec}초 안에 재개됩니다`
        : '상대 팀 작전 타임 중…';
      if (msg.yours && msg.squad) openPausePanel(msg);
      break;
    case 'resumed':
      viz.paused = false;
      $('#pause-panel').classList.add('disabled');
      $('#pause-status').textContent = '';
      $('#pause-left').textContent = msg.pausesLeft[state.mySide || 'home'];
      $('#btn-pause').disabled = msg.pausesLeft[state.mySide || 'home'] <= 0;
      break;
    case 'squad_updated': {
      const tn = state.matchTacticNames || { home: '', away: '' };
      $('#sb-home-ovr').textContent =
        `OVR ${msg.home.ratings.OVR} · ${msg.home.ratings.formation} · ${tn.home}`;
      $('#sb-away-ovr').textContent =
        `OVR ${msg.away.ratings.OVR} · ${msg.away.ratings.formation} · ${tn.away}`;
      viz.possHome = msg.possession.home;
      vizUpdateSide('home', msg.home.ratings.formation, msg.home.players);
      vizUpdateSide('away', msg.away.ratings.formation, msg.away.players);
      if (msg.side === (state.mySide || 'home')) {
        toast('스쿼드 변경 적용! 남은 경기가 새 전력으로 진행됩니다.');
        addFeedItem('', `🔁 ${msg.side === 'home' ? '홈' : '원정'} 팀 스쿼드 변경`, 'phase');
      } else {
        addFeedItem('', `🔁 상대 팀이 스쿼드를 변경했습니다`, 'phase');
      }
      break;
    }
    case 'result':
      // hold the result screen until queued plays (and the goal flash) finish
      if (viz.raf) viz.pendingResult = msg;
      else showResult(msg);
      break;
  }
}

function startLiveMatch(msg) {
  state.inMatch = true;
  state.spectating = !!msg.spectate;
  state.mySide = msg.youAre || 'home';
  state.matchTacticNames = { home: msg.home.tacticName || '', away: msg.away.tacticName || '' };
  setQueueUi(false);
  stopSpectatePolling();
  $('#match-lobby').classList.add('hidden');
  $('#match-live').classList.remove('hidden');
  $('#result-overlay').classList.add('hidden');
  $('#match-feed').innerHTML = '';
  // 관전: no 작전 타임 controls, just the broadcast
  $('.pause-bar').classList.toggle('hidden', state.spectating);
  $('#spectate-bar').classList.toggle('hidden', !state.spectating);
  $('#pause-panel').classList.toggle('hidden', state.spectating);
  // 작전 타임 UI reset (panel is always visible, inactive until paused)
  $('#pause-left').textContent = '2';
  $('#btn-pause').disabled = false;
  $('#pause-status').textContent = '';
  if (!state.spectating) initPausePanel(msg.mode);

  $('#sb-home-name').textContent = msg.home.name;
  $('#sb-away-name').textContent = msg.away.name;
  $('#sb-home-ovr').textContent =
    `OVR ${msg.home.ratings.OVR} · ${msg.home.ratings.formation} · ${msg.home.tacticName || ''}`;
  $('#sb-away-ovr').textContent =
    `OVR ${msg.away.ratings.OVR} · ${msg.away.ratings.formation} · ${msg.away.tacticName || ''}`;
  $('#sb-score').textContent = '0 - 0';
  $('#sb-minute').textContent = "0'";

  $('#poss-home').style.width = msg.possession.home + '%';
  $('#poss-home-num').textContent = `${msg.home.name} ${msg.possession.home}%`;
  $('#poss-away-num').textContent = `${msg.possession.away}% ${msg.away.name}`;

  vizStart(msg);
  if (state.spectating) {
    // joined mid-match: sync the clock and score, then ride the live stream
    viz.minute = Math.min(90, msg.minute || 0);
    viz.srvMin = msg.minute || 0;
    viz.dispMin = msg.minute || 0;
    $('#sb-minute').textContent = msg.display || `${msg.minute || 0}'`;
    if (msg.score) $('#sb-score').textContent = `${msg.score.home} - ${msg.score.away}`;
    addFeedItem('', `👀 관전 시작 — ${msg.home.name} vs ${msg.away.name} (${msg.display || "0'"})`, 'phase');
  } else {
    addFeedItem('', `📣 경기 시작! ${msg.home.name} vs ${msg.away.name}`, 'phase');
  }
}

// =====================================================================
// top-view live match visualization (canvas)
// =====================================================================

const viz = {
  raf: null,
  players: [],
  ball: null,
  ballAngle: 0,
  possession: 'home',
  carrier: null, // player object currently on the ball
  script: [], // ball flights in the air [{x, y, speed, wait, onDone}]
  queue: [], // server events waiting to be played out
  attack: null, // active event steering live play {e, timeLeft, hurry}
  runner: null, // player sprinting to meet a pass in flight
  pendingResult: null, // result msg held until queued plays finish
  tactics: { home: 'balanced', away: 'balanced' },
  line: { home: 140, away: 140 }, // smoothed defensive line height per team
  breakT: { home: 0, away: 0 }, // counter-attack boost seconds remaining
  passTimer: 0.8,
  possHome: 50,
  collect: false, // carrier is running to pick up a dead ball
  stealCd: 0, // seconds until the next steal is allowed (kills scrums)
  chanceCd: 0, // open-play 1:1 finish cooldown (no shot spam)
  offsideCd: 0, // seconds until the next offside call is allowed
  goalKick: false, // 골킥 재개: GK builds up freely from his box, no pressing
  kickoff: null, // kickoff staging {side, t, taker}: teams reset, taker steps up
  paused: false, // 작전 타임: the whole sim freezes, only drawing continues
  flip: false, // true when this client is the away side (their team at bottom)
  secondHalf: false, // 진영 교대: mirrors the rendering after half time
  duel: null, // pending foul: the offender hunts the carrier, whistle on contact
  pendingHalf: false, // 하프타임 대기: staged once the current play drains
  pendingHalfText: null, // banner/feed text held until the swap actually fires
  names: { home: '', away: '' },
  minute: 0, // latest server minute, used for commentary timestamps
  srvMin: 0, // raw server minute incl. stoppage (91, 92, ...)
  dispMin: 0, // 화면 시계: 지금 보이는 플레이를 따라가는 분 (시뮬 기준 싱크)
  shownMin: -1, // last minute written to the scoreboard
  matchStartTs: 0, // rAF timestamp of the first frame — anchors the 3분 cap
  possTime: { home: 0, away: 0 }, // measured live possession seconds
  possUiT: 0,
  comCd: 0, // commentary throttle
  flash: null,
  lastTs: 0,
  now: 0, // frame clock (rAF timestamp) shared by flights and the goal flash
};

function vizName(p) {
  return (p && p.label) || '선수';
}

// Live commentary line in the feed (throttled so it never floods). No minute
// label: the animation trails the server clock, so a timestamp would clash
// with the queued event lines around it.
function vizSay(text) {
  if (viz.comCd > 0) return;
  viz.comCd = 1.5;
  addFeedItem('', text, 'live');
}

// Map a 40..99 attribute onto a 0.8..1.25 multiplier for on-pitch behaviour.
function vizAttr(v) {
  return 0.8 + ((Math.max(40, Math.min(99, v || 55)) - 40) / 59) * 0.45;
}

function vizShortName(name) {
  if (!name) return '';
  const last = String(name).trim().split(/\s+/).pop();
  return last.length > 10 ? last.slice(0, 9) + '…' : last;
}

// On-pitch behaviour per tactic id (matches server TACTICS keys).
// line: defensive line height bias (px) · press: pressers when defending ·
// engage: how far from own goal the team keeps pressing (low block = small) ·
// tempo: passing rate · runFreq: off-ball runs · carrier: dribble pace ·
// longShot: share of non-goal chances taken from distance · shootFrom:
// finishing range — shots only fly once the ball is worked this close
const VIZ_TACT = {
  attacking: { line: 70, press: 2, engage: 2000, tempo: 1.25, runFreq: 1.7, carrier: 1.15, longShot: 0.2, shootFrom: 185 },
  balanced: { line: 0, press: 1, engage: 520, tempo: 1.0, runFreq: 1.0, carrier: 1.0, longShot: 0.3, shootFrom: 170 },
  defensive: { line: -60, press: 1, engage: 330, tempo: 0.85, runFreq: 0.6, carrier: 0.9, longShot: 0.45, shootFrom: 155 },
  counter: { line: -40, press: 1, engage: 400, tempo: 1.1, runFreq: 1.2, carrier: 1.1, longShot: 0.35, shootFrom: 170 },
};

// Ball distance from a side's own goal line.
function vizBallDistOwn(side) {
  return side === 'home' ? viz.ball.x - VIZ.M : VIZ.W - VIZ.M - viz.ball.x;
}

function vizTact(side) {
  return VIZ_TACT[viz.tactics[side]] || VIZ_TACT.balanced;
}

// Rule-correct kickoff staging: the home side takes the opening kickoff, the
// conceding side restarts after a goal, the away side opens the second half.
// Both teams drop back to their formation spots while the taker steps up to
// the centre spot; the release plays the kickoff pass backwards.
function vizStageKickoff(side) {
  const team = vizTeam(side);
  viz.possession = side;
  viz.carrier = null;
  viz.runner = null;
  viz.collect = false;
  // quicker restart when queued plays are waiting to be shown
  const taker =
    [team[9], team[8], team[6]].find((p) => p && !p.off) || team.find((p) => !p.gk && !p.off);
  viz.kickoff = { side, t: viz.queue.length ? 0.7 : 1.4, taker };
}

// Possession change in one place so counter teams get their break boost.
function vizTakeover(side, carrier) {
  if (viz.possession !== side && viz.tactics[side] === 'counter') viz.breakT[side] = 2.5;
  viz.possession = side;
  viz.carrier = carrier;
  viz.goalKick = false; // any change of hands ends a goal-kick restart
  viz.stealCd = 0.9; // possession settles — no instant counter-steal ping-pong
  // won near the own goal: get rid of it quickly, don't dribble around the box
  if (vizBallDistOwn(side) < 190) viz.passTimer = Math.min(viz.passTimer, 0.25);
}

const VIZ = { W: 860, H: 520, M: 34 };
// 전체 재생 시간 상한: 이벤트를 절대 건너뛰지 않되, 큐에 쌓인 백로그(실제
// 시뮬레이션 데이터)로 남은 재생 시간을 추정해 최대 VIZ_TIME_CAP_SEC 안에는
// 경기가 끝나도록 배속을 조절한다 (평소엔 1배속, 밀릴 때만 최대 VIZ_MAX_SPEED).
const VIZ_TIME_CAP_SEC = 180;
const VIZ_MAX_SPEED = 4;
const VIZ_AVG_EVENT_SEC = 2.4; // 큐에 쌓인 이벤트 하나가 다 재생되는 데 걸리는 평균 시간
// Penalty box size — single source of truth shared by the box drawn on the
// canvas (vizFrame's strokeRect) and the in/out-of-box check below. Depth is
// measured inward from the goal line, width is centered on the goal.
const BOX_DEPTH = 100;
const BOX_WIDTH = 200;

const ballImg = new Image();
ballImg.src = '/img/ball.png';

// Vertical editor coords [x%, y% from own goal] -> top view (home attacks →).
function vizSpot(coord, isHome) {
  const [xv, yv] = coord;
  const halfW = VIZ.W / 2 - VIZ.M - 14;
  let x = VIZ.M + (yv / 100) * halfW;
  let y = VIZ.M + (xv / 100) * (VIZ.H - 2 * VIZ.M);
  if (!isHome) {
    x = VIZ.W - x;
    y = VIZ.H - y;
  }
  return { x, y };
}

function vizStart(msg) {
  vizStop();
  const canvas = $('#pitch2d');
  if (!canvas) return;
  viz.players = [];
  ['home', 'away'].forEach((side) => {
    const isHome = side === 'home';
    const formation = msg[side].ratings.formation;
    const coords = COORDS[formation] || COORDS['4-3-3'];
    const lineup = msg[side].players || [];
    coords.forEach((c, i) => {
      const base = vizSpot(c, isHome);
      const card = lineup[i];
      const a = (card && card.attrs) || {};
      viz.players.push({
        num: i + 1,
        gk: i === 0,
        off: false, // 퇴장 (경고 누적): walks off, out of all play
        isHome,
        label: vizShortName(card && card.name),
        // card attributes drive movement, passing and duels on the pitch
        paceMul: vizAttr(a.pace),
        dribMul: vizAttr(a.dribbling),
        passMul: vizAttr(a.passing),
        defMul: vizAttr(a.defending),
        shotMul: vizAttr(a.shooting),
        baseX: base.x,
        baseY: base.y,
        x: base.x,
        y: base.y,
        vx: 0,
        vy: 0,
        run: null, // active off-the-ball sprint {tx, ty, until}
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 0.8,
      });
    });
  });
  viz.ball = { x: VIZ.W / 2, y: VIZ.H / 2 };
  viz.ballAngle = 0;
  viz.script = [];
  viz.queue = [];
  viz.attack = null;
  viz.runner = null;
  viz.pendingResult = null;
  viz.tactics = {
    home: msg.home.tactic || 'balanced',
    away: msg.away.tactic || 'balanced',
  };
  viz.line = { home: 140, away: 140 };
  viz.breakT = { home: 0, away: 0 };
  viz.paused = false;
  vizComputeDepthOffsets();
  viz.passTimer = 0.6;
  viz.possHome = msg.possession.home;
  if (msg.spectate) {
    // mid-match join: server truth only has aggregate possession%/score, not
    // exact live positions, so skip the kickoff walk-up ceremony (which makes
    // a match already in progress look like it's just restarting) and hand
    // the ball straight to a plausible current holder on the leading side.
    const possSide = msg.possession.home >= msg.possession.away ? 'home' : 'away';
    const holder = vizMidfielder(possSide);
    viz.possession = possSide;
    viz.carrier = holder;
    viz.ball.x = holder.x;
    viz.ball.y = holder.y;
    viz.passTimer = 0.3;
  } else {
    vizStageKickoff('home'); // rule: the home side takes the opening kickoff
  }
  viz.collect = false;
  viz.stealCd = 0;
  viz.chanceCd = 0;
  viz.offsideCd = 0;
  viz.goalKick = false;
  viz.flip = msg.youAre === 'away';
  viz.secondHalf = false;
  viz.duel = null;
  viz.pendingHalf = false;
  viz.pendingHalfText = null;
  viz.names = { home: msg.home.name || '홈', away: msg.away.name || '어웨이' };
  viz.minute = 0;
  viz.srvMin = 0;
  viz.dispMin = 0;
  viz.shownMin = -1;
  viz.possTime = { home: 0, away: 0 };
  viz.possUiT = 0;
  viz.comCd = 0;
  viz.flash = null;
  viz.lastTs = 0;
  viz.matchStartTs = 0;
  const banner = $('#event-banner');
  if (banner) banner.classList.remove('show');
  viz.raf = requestAnimationFrame(vizFrame);
}

function vizStop() {
  if (viz.raf) cancelAnimationFrame(viz.raf);
  viz.raf = null;
}

// Relative depth within each line so formations keep their internal shape
// (e.g. the CDM sits behind the CMs) as the lines slide up and down.
function vizComputeDepthOffsets() {
  ['home', 'away'].forEach((side) => {
    const team = viz.players.filter((p) => p.isHome === (side === 'home'));
    if (!team.length) return;
    const distOwn = (p) => (side === 'home' ? p.baseX - VIZ.M : VIZ.W - VIZ.M - p.baseX);
    [1, 2, 3].forEach((role) => {
      const grp = team.filter((p) => !p.gk && (p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3) === role);
      const avg = grp.reduce((s, p) => s + distOwn(p), 0) / (grp.length || 1);
      grp.forEach((p) => {
        p.depthOff = distOwn(p) - avg;
      });
    });
    team[0].depthOff = 0;
  });
}

// Live squad change (작전 타임): re-anchor a side's dots to the new formation
// and swap in the new players' names/attributes. Positions flow over thanks
// to the inertial movement — no teleports.
function vizUpdateSide(side, formation, lineup) {
  if (!viz.players.length) return;
  const isHome = side === 'home';
  const coords = COORDS[formation] || COORDS['4-3-3'];
  vizTeam(side).forEach((p, i) => {
    const base = vizSpot(coords[i] || coords[coords.length - 1], isHome);
    p.baseX = base.x;
    p.baseY = base.y;
    const card = lineup && lineup[i];
    const a = (card && card.attrs) || {};
    p.label = vizShortName(card && card.name);
    p.paceMul = vizAttr(a.pace);
    p.dribMul = vizAttr(a.dribbling);
    p.passMul = vizAttr(a.passing);
    p.defMul = vizAttr(a.defending);
    p.shotMul = vizAttr(a.shooting);
  });
  vizComputeDepthOffsets();
}

// ---- helpers ----

function vizTeam(side) {
  return viz.players.filter((p) => p.isHome === (side === 'home'));
}

function vizDir(side) {
  return side === 'home' ? 1 : -1; // attacking direction on x
}

function vizGoalX(attackingSide) {
  return attackingSide === 'home' ? VIZ.W - VIZ.M : VIZ.M;
}

// Rectangular box containment — matches the drawn penalty box exactly
// (BOX_DEPTH inward from the goal line, ±BOX_WIDTH/2 either side of centre).
// A euclidean radius from the goal was used here before, which doesn't match
// a rectangle: it let penalty calls fire well outside the box on straight-on
// approaches beyond BOX_DEPTH, and (in the other direction) missed genuine
// box entries from a wide angle.
function vizInBox(side, x, y) {
  const dir = vizDir(side);
  const depth = (vizGoalX(side) - x) * dir;
  return depth <= BOX_DEPTH && Math.abs(y - VIZ.H / 2) <= BOX_WIDTH / 2;
}

function vizMidfielder(side) {
  const team = vizTeam(side);
  return (
    [team[6], team[5], team[1]].find((p) => p && !p.off) ||
    team.find((p) => !p.gk && !p.off) ||
    team[1]
  );
}

function vizNearest(side, x, y, exclude) {
  let best = null;
  let bd = Infinity;
  vizTeam(side).forEach((p) => {
    if (p === exclude || p.gk || p.off) return;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  });
  return best;
}

function vizPush(x, y, speed, opts = {}) {
  viz.script.push({
    x,
    y,
    speed,
    wait: opts.wait || 0,
    onDone: opts.onDone,
    track: opts.track || null,
    // the flight won't launch until this player reaches the ball — crosses
    // and set-piece deliveries are struck by someone, never from empty space
    holdFor: opts.holdFor || null,
    holdT: 2.5,
  });
}

// Ball played into space, its pace matched so the runner arrives with it.
function vizThroughBall(target, runner, opts = {}) {
  const b = viz.ball;
  const d = Math.hypot(target.x - b.x, target.y - b.y);
  const rd = Math.hypot(target.x - runner.x, target.y - runner.y);
  const runnerTime = rd / (170 * (runner.paceMul || 1));
  const speed = Math.max(240, Math.min(560, d / Math.max(0.35, runnerTime * 0.9)));
  viz.runner = runner;
  vizPush(target.x, target.y, speed, opts);
}

// Final-third penetration (침투 시퀀스): either a through-ball in behind the
// line or wide play followed by a cutback — goals are worked, not launched.
function vizPenetrate(atk) {
  const side = atk.e.team;
  const dir = vizDir(side);
  const gx = vizGoalX(side);
  const gy = VIZ.H / 2;
  const team = vizTeam(side);
  const forwards = team.filter((p) => !p.gk && !p.off && p.num >= 9);
  const runner1 =
    forwards[Math.floor(Math.random() * forwards.length)] ||
    team.filter((p) => !p.gk && !p.off).pop();
  atk.phase = 'finish';
  if (Math.random() < 0.55) {
    // through-ball into the half-space behind the back line
    const target = {
      x: Math.max(VIZ.M + 16, Math.min(VIZ.W - VIZ.M - 16, gx - dir * (46 + Math.random() * 70))),
      y: gy + (Math.random() < 0.5 ? -1 : 1) * (26 + Math.random() * 80),
    };
    vizSay(`${vizName(viz.carrier)}의 침투 스루패스 — ${vizName(runner1)}, 뒷공간 돌파!`);
    vizThroughBall(target, runner1, {
      onDone: () => {
        viz.carrier = runner1;
        viz.runner = null;
        viz.passTimer = 0.3;
      },
    });
  } else {
    // wide overlap, then a low cutback across the box for a late runner
    const wideY = viz.ball.y < gy ? VIZ.M + 46 : VIZ.H - VIZ.M - 46;
    let wide = runner1;
    team.forEach((p) => {
      if (!p.gk && !p.off && p !== viz.carrier && Math.abs(p.y - wideY) < Math.abs(wide.y - wideY))
        wide = p;
    });
    const corner1 = {
      x: Math.max(VIZ.M + 16, Math.min(VIZ.W - VIZ.M - 16, gx - dir * (26 + Math.random() * 30))),
      y: wideY,
    };
    vizSay(`측면 공략 — ${vizName(wide)}에게 벌려줍니다`);
    vizThroughBall(corner1, wide, {
      onDone: () => {
        viz.carrier = wide;
        const late = forwards.find((p) => p !== wide) || runner1;
        const cut = { x: gx - dir * (52 + Math.random() * 40), y: gy + (Math.random() * 56 - 28) };
        vizSay(`${vizName(wide)}의 컷백!`);
        vizThroughBall(cut, late, {
          wait: 0.25,
          holdFor: wide, // the crosser must reach the ball before it flies
          onDone: () => {
            viz.carrier = late;
            viz.runner = null;
            viz.passTimer = 0.25;
          },
        });
      },
    });
  }
}

// Pass from the carrier to a weighted-random teammate. Ordinary passes are
// "tracked": the ball homes onto its receiver, so it can never overshoot.
// Counter breaks launch one long ball in behind; deep possession with no
// chance on recycles backwards like a real probing attack.
function vizSchedulePass() {
  const side = viz.possession;
  const carrier = viz.carrier;
  if (!carrier) return;
  const dir = vizDir(side);
  const mates = vizTeam(side).filter((p) => p !== carrier && !p.gk && !p.off);
  if (!mates.length) return;
  const tact = vizTact(side);
  const attackMode = viz.attack && viz.attack.e.team === side;
  const breaking = viz.breakT[side] > 0;
  const gx = vizGoalX(side);

  // 골킥 재개: 키퍼의 첫 배급은 자유 전개 — 깊은 위치라도 강제로 걷어내지
  // 않고, 짧은 빌드업/롱킥을 일반 배급 가중치로 고른다
  const gkRestart = viz.goalKick && carrier.gk;
  if (gkRestart) viz.goalKick = false;

  // 수비 본분: deep in the own third the ball is cleared upfield, never
  // dribbled around the box — same long ball a counter break uses
  if (breaking || (!attackMode && !gkRestart && vizBallDistOwn(side) < 190)) {
    let out = mates[0];
    mates.forEach((p) => {
      if ((p.x - out.x) * dir > 0) out = p;
    });
    // 롱볼 타깃이 최종 수비수 라인 뒤에 서 있었다면 오프사이드
    if (vizOffsideCheck(side, out)) {
      vizOffsidePass(side, out);
      return;
    }
    const target = {
      x: Math.max(VIZ.M + 30, Math.min(VIZ.W - VIZ.M - 30, out.x + dir * (90 + Math.random() * 70))),
      y: Math.max(VIZ.M + 20, Math.min(VIZ.H - VIZ.M - 20, out.y + (Math.random() * 60 - 30))),
    };
    vizSay(
      breaking
        ? `역습 전개! ${vizName(carrier)}의 롱볼 — ${vizName(out)} 질주`
        : `${vizName(carrier)}, 위험 지역에서 길게 걷어냅니다`
    );
    vizThroughBall(target, out, {
      onDone: () => {
        viz.carrier = out;
        viz.runner = null;
        viz.passTimer = 0.5;
      },
    });
    return;
  }

  // 볼배급 체인: defenders feed midfield, midfield feeds the front line,
  // forwards keep it between the lines — build-up flows DEF -> MID -> ATT
  const roleOf = (p) => (p.gk || p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3);
  const CHAIN = {
    1: { 1: 0.7, 2: 1.5, 3: 0.6 },
    2: { 1: 0.6, 2: 1.0, 3: 1.4 },
    3: { 1: 0.3, 2: 1.1, 3: 1.3 },
  };
  const chain = CHAIN[roleOf(carrier)];

  // probing: ball already deep with no chance on -> recycle backwards
  const recycle = !attackMode && Math.abs(gx - carrier.x) < 250;
  const weighted = mates.map((p) => {
    const fwd = ((p.x - carrier.x) * dir + 140) / 140;
    const back = ((carrier.x - p.x) * dir + 160) / 160;
    const dist = Math.hypot(p.x - carrier.x, p.y - carrier.y);
    const distW = dist < 60 ? 0.3 : dist > 340 ? 0.4 : 1;
    let w = Math.max(0.1, recycle ? back : fwd) * distW * chain[roleOf(p)];
    if (attackMode) {
      // funnel the ball toward the goal, almost never backwards
      w *= 1.6 - Math.min(1, Math.abs(gx - p.x) / (VIZ.W - 2 * VIZ.M));
      if ((p.x - carrier.x) * dir < 0) w *= 0.25;
    }
    return { p, w };
  });
  // 백패스 룰: 압박 해소용으로 키퍼에게 내려놓을 수 있다 — 단, 키퍼는 백패스에
  // 손을 쓸 수 없으므로 받는 즉시 발로 처리한다 (수신 onDone에서 강제)
  const ownGK = vizTeam(side)[0];
  if (
    !attackMode &&
    !carrier.gk &&
    ownGK &&
    !ownGK.off &&
    vizBallDistOwn(side) < 420 &&
    (carrier.x - ownGK.x) * dir > 60
  ) {
    weighted.push({ p: ownGK, w: 0.35 });
  }
  const total = weighted.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * total;
  let receiver = weighted[weighted.length - 1].p;
  for (const o of weighted) {
    r -= o.w;
    if (r <= 0) {
      receiver = o.p;
      break;
    }
  }
  // 패스 릴리스 순간 리시버가 오프사이드 위치면 휘슬 (골킥 재개는 규칙상 제외)
  if (!gkRestart && vizOffsideCheck(side, receiver)) {
    vizOffsidePass(side, receiver);
    return;
  }
  viz.runner = receiver;
  if (Math.random() < 0.3) {
    const verb = ['패스 연결', '짧게 이어갑니다', '전진 패스', '방향 전환'][
      Math.floor(Math.random() * 4)
    ];
    vizSay(`${vizName(carrier)} → ${vizName(receiver)}, ${verb}`);
  }
  const passSpd = (300 + Math.random() * 140) * (carrier.passMul || 1);
  vizPush(receiver.x, receiver.y, passSpd, {
    track: receiver, // home onto the receiver — the pass cannot miss them
    onDone: () => {
      viz.carrier = receiver;
      viz.runner = null;
      if (receiver.gk) {
        // 백패스 룰: 키퍼는 발밑으로 받은 공을 손으로 잡을 수 없다 — 잡지 않고
        // 곧바로 발로 처리한다 (깊으면 걷어내기, 아니면 짧은 전개)
        viz.comCd = 0;
        vizSay(`${vizName(receiver)}, 백패스는 손을 쓸 수 없습니다 — 발로 처리`);
        viz.passTimer = 0.45;
      } else {
        viz.passTimer =
          (attackMode ? 0.4 + Math.random() * 0.4 : 0.6 + Math.random()) / tact.tempo;
      }
    },
  });
}

// 오프사이드 (viz 자체 판정): 패스 릴리스 순간 리시버가 최종 아웃필드
// 수비수보다, 그리고 공보다 상대 골문 쪽에 있으면 휘슬 — 수비팀 프리킥으로
// 재개한다. 서버 이벤트 전개 중에는 판정하지 않는다 (결과가 정해진 공격이
// 스톨되면 안 됨). 자기 진영에서는 오프사이드가 성립하지 않는다.
function vizOffsideCheck(side, receiver) {
  if (viz.attack || viz.offsideCd > 0 || !receiver) return false;
  const defSide = side === 'home' ? 'away' : 'home';
  const dir = vizDir(side);
  let last = null; // 최종 수비수 (키퍼·퇴장 선수 제외, 자기 골문에 가장 가까운 선수)
  vizTeam(defSide).forEach((p) => {
    if (p.gk || p.off) return; // 퇴장한 선수는 터치라인 밖에 서 있으므로 제외
    if (!last || (p.x - last.x) * dir > 0) last = p;
  });
  if (!last) return false;
  const inOppHalf = dir > 0 ? receiver.x > VIZ.W / 2 : receiver.x < VIZ.W / 2;
  const beyondLine = (receiver.x - last.x) * dir > 10;
  const beyondBall = (receiver.x - viz.ball.x) * dir > 0;
  return inOppHalf && beyondLine && beyondBall;
}

// The offside pass still flies (the flag goes up as it's received), then the
// defending team restarts with a free kick from the offside spot.
function vizOffsidePass(side, receiver) {
  const defSide = side === 'home' ? 'away' : 'home';
  viz.offsideCd = 9;
  viz.runner = receiver;
  vizPush(receiver.x, receiver.y, 340, {
    track: receiver,
    onDone: () => {
      viz.comCd = 0;
      vizSay(`부심 깃발이 올라갑니다 — ${vizName(receiver)} 오프사이드!`);
      showEventBanner(`🚩 오프사이드 — ${vizName(receiver)}`, 'offside', 2200);
      viz.carrier = null;
      viz.runner = vizNearest(defSide, viz.ball.x, viz.ball.y); // 키커가 걸어온다
      vizPush(viz.ball.x, viz.ball.y, 1, {
        wait: 1.0, // 그 지점에서 수비팀 프리킥으로 재개
        onDone: () => {
          viz.runner = null;
          vizTakeover(defSide, vizNearest(defSide, viz.ball.x, viz.ball.y));
          viz.passTimer = 0.6;
        },
      });
    },
  });
}

// Open-play 1:1 finish: a carrier who dribbles past the back line doesn't
// just recycle the ball — he strikes it. Only server events may change the
// score, so the ambient chance always ends with the keeper gathering.
function vizAmbientShot(side) {
  const defSide = side === 'home' ? 'away' : 'home';
  const defGK = vizTeam(defSide)[0];
  const shooter = viz.carrier;
  if (!shooter || !defGK) return;
  viz.comCd = 0;
  vizSay(`${vizName(shooter)}, 1:1 찬스 — 슈팅!`);
  viz.carrier = null;
  viz.runner = null;
  vizPush(defGK.x, defGK.y, Math.round(540 * (shooter.shotMul || 1)), {
    track: defGK, // struck at goal, smothered by the keeper
    onDone: () => {
      viz.comCd = 0;
      vizSay(`${vizName(defGK)}, 침착하게 막아냅니다`);
      vizTakeover(defSide, defGK);
      viz.passTimer = 1.0;
    },
  });
}

// Dequeued server event: instead of scripting a canned buildup, steer the
// live play — the event team wins the ball where it is and attacks until in
// range, then vizShoot resolves the outcome. No teleports, no hard cuts.
function vizBeginEvent(e) {
  if (!viz.ball) return;
  const b = viz.ball;
  const feed = () => addFeedItem(e.minute + "'", e.text, e.type);

  if (e.type === 'card' || e.type === 'foul') {
    // fouls only happen in real duels: the offending side hunts the carrier
    // and the whistle blows on contact — outside the boxes it's a free kick
    // (in-box fouls arrive as penalty events and are staged separately)
    const fkSide = e.type === 'foul' ? e.team : e.team === 'home' ? 'away' : 'home';
    if (viz.possession !== fkSide) {
      vizTakeover(fkSide, vizNearest(fkSide, b.x, b.y));
      viz.passTimer = 1.2; // keep the ball on the foot for the tackle to arrive
    }
    viz.duel = {
      e,
      fkSide,
      t: viz.queue.length ? 1.3 : 2.6,
      // 어드밴티지: 카드가 아닌 일반 파울은 40% 확률로 플레이 온 후보 —
      // 실제 발동은 접촉 순간 파울당한 팀이 유리한 위치일 때만
      advantage: e.type === 'foul' && Math.random() < 0.4,
    };
    return;
  }

  if (e.type === 'throwin') {
    // ball rolls out over the nearest touchline at (roughly) where it was —
    // the thrower must step OUT to that spot and throw from the line
    const outY = b.y < VIZ.H / 2 ? VIZ.M - 10 : VIZ.H - VIZ.M + 10;
    const outX = Math.max(VIZ.M + 20, Math.min(VIZ.W - VIZ.M - 20, b.x + (Math.random() * 40 - 20)));
    viz.carrier = null;
    viz.runner = null;
    const thrower = vizNearest(e.team, outX, outY);
    // 규칙: 스로인은 상대가 마지막으로 건드린 공이 나가야 주어진다 — 상대
    // 선수 몸에 맞고 굴절돼 나가는 장면을 먼저 연출 (그냥 굴러 나가면 자기
    // 공을 자기가 던지는 모순이 생긴다)
    const oppSide = e.team === 'home' ? 'away' : 'home';
    const deflector = vizNearest(oppSide, b.x, b.y);
    if (deflector) {
      vizPush(deflector.x, deflector.y, 300, {
        track: deflector,
        onDone: () => {
          viz.comCd = 0;
          vizSay(`${vizName(deflector)}, 몸에 맞고 밖으로 나갑니다`);
        },
      });
    }
    vizPush(outX, outY, 260, { onDone: feed });
    // the throw only flies once the thrower reaches the ball out of bounds
    vizPush(outX + (Math.random() * 80 - 40), outY < VIZ.H / 2 ? VIZ.M + 55 : VIZ.H - VIZ.M - 55, 300, {
      wait: 0.4,
      holdFor: thrower,
      onDone: () => {
        viz.runner = null;
        viz.comCd = 0;
        vizSay(`${vizName(thrower)}, 스로인으로 연결`);
        vizTakeover(e.team, vizNearest(e.team, viz.ball.x, viz.ball.y));
        viz.passTimer = 0.5;
      },
    });
    return;
  }

  const hurry = 1 + Math.min(2.2, viz.queue.length * 0.6);
  viz.attack = {
    e,
    hurry,
    timeLeft: 7 / hurry,
    phase: 'advance', // advance -> (penetrate ->) finish
    // some saved/missed chances are honest long-range efforts; goals are
    // always worked into the box first
    longShot: e.type !== 'goal' && !e.via && Math.random() < vizTact(e.team).longShot,
  };

  // penalties are worked into the box first: the tackle happens inside the
  // area, then the ceremony (spot, run-up, outcome) is staged by vizShoot
  if (viz.possession !== e.team) {
    // natural turnover: nearest event-team player tackles at the ball
    vizTakeover(e.team, vizNearest(e.team, viz.ball.x, viz.ball.y));
    viz.passTimer = 0.3;
  }
}

// Resolve the active event's outcome with ball flights from the live position.
// Feed lines and the scoreboard update exactly when the ball gets there.
function vizShoot(atk) {
  const e = atk.e;
  const side = e.team;
  const dir = vizDir(side);
  const gx = vizGoalX(side);
  const gy = VIZ.H / 2;
  const defSide = side === 'home' ? 'away' : 'home';
  const defGK = vizTeam(defSide)[0];
  const feed = () => addFeedItem(e.minute + "'", e.text, e.type);
  const done = () => {
    viz.attack = null;
  };
  const shooter = viz.carrier || vizTeam(side)[9] || vizTeam(side)[8];
  const shotSpd = Math.round(600 * ((shooter && shooter.shotMul) || 1));
  viz.runner = null;

  // set pieces: place the ball, let the taker stand over it, then strike
  if (e.via === 'penalty') {
    atk.ceremony = true; // freezes pressing while the kick is prepared
    viz.carrier = null;
    viz.runner = shooter;
    vizPush(gx - dir * 66, gy, 300, { wait: 0.3 }); // ball carried to the spot
    vizPush(gx - dir * 66, gy, 1, {
      wait: 1.2, // run-up
      onDone: () => {
        viz.runner = null;
      },
    });
  } else if (e.via === 'freekick') {
    atk.ceremony = true;
    viz.carrier = null;
    viz.runner = shooter;
    // 수비벽: 공에서 가장 가까운 수비수 3명이 공-골문 사이 10보 거리에 선다
    atk.wall = vizTeam(defSide)
      .filter((p) => !p.gk && !p.off)
      .sort(
        (a, b) =>
          Math.hypot(a.x - viz.ball.x, a.y - viz.ball.y) -
          Math.hypot(b.x - viz.ball.x, b.y - viz.ball.y)
      )
      .slice(0, 3);
    vizPush(viz.ball.x, viz.ball.y, 1, {
      wait: 1.4, // wall forms, taker sets the ball
      onDone: () => {
        viz.runner = null;
      },
    });
  }

  switch (e.type) {
    case 'goal':
      vizPush(gx + dir * 10, gy + (Math.random() * 52 - 26), shotSpd, {
        wait: 0.18,
        onDone: () => {
          viz.flash = { text: '⚽ GOAL!', until: viz.now + 1500 };
          viz.carrier = null;
          feed();
          showEventBanner(`⚽ ${e.player} 골!${e.assist ? ` (도움: ${e.assist})` : ''}`, 'goal', 3000);
          if (e.score) $('#sb-score').textContent = `${e.score.home} - ${e.score.away}`;
        },
      });
      // rule: the conceding side restarts with a kickoff from the centre spot
      vizPush(VIZ.W / 2, VIZ.H / 2, 250, {
        wait: 1.2,
        onDone: () => {
          done();
          vizStageKickoff(defSide);
        },
      });
      break;
    case 'disallowed': {
      // VAR: 공은 골망을 가르지만 판독 끝에 득점이 취소된다 — 스코어 불변,
      // 오프사이드 취소이므로 수비팀이 박스에서 자유 재개
      vizPush(gx + dir * 10, gy + (Math.random() * 52 - 26), shotSpd, {
        wait: 0.18,
        onDone: () => {
          viz.flash = { text: '🖥 VAR 판독 중…', until: viz.now + 1800 };
          viz.carrier = null;
        },
      });
      vizPush(gx - dir * (34 + Math.random() * 26), gy + (Math.random() * 40 - 20), 240, {
        wait: 2.0, // 판독 대기 후 공을 꺼내온다
        onDone: () => {
          feed();
          viz.flash = { text: '❌ 득점 취소', until: viz.now + 1400 };
          showEventBanner(`🚩 오프사이드 — ${e.player} 득점 취소`, 'offside', 2600);
          done();
          vizTakeover(defSide, defGK);
          viz.goalKick = true;
          viz.passTimer = 1.0;
        },
      });
      break;
    }
    case 'save':
      vizPush(gx - dir * 8, gy + (Math.random() * 46 - 23), shotSpd, {
        wait: 0.15,
        onDone: () => {
          feed();
          done();
          vizTakeover(defSide, defGK);
          viz.passTimer = 0.9;
        },
      });
      break;
    case 'miss': {
      vizPush(gx + dir * 14, gy + (Math.random() < 0.5 ? -1 : 1) * (52 + Math.random() * 40), shotSpd, {
        wait: 0.15,
        onDone: feed,
      });
      // 골킥: 공격팀 마지막 터치로 골라인 아웃 — 공을 페널티 박스 안에 놓으면
      // 키퍼가 걸어가 회수한 뒤 자기 재량으로 전개한다 (짧은 빌드업이든
      // 롱킥이든 일반 배급 로직이 고른다)
      vizPush(gx - dir * (30 + Math.random() * 34), gy + (Math.random() * 60 - 30), 260, {
        wait: 0.6,
        onDone: () => {
          done();
          vizTakeover(defSide, defGK);
          viz.goalKick = true; // 첫 배급까지 압박 금지 + 강제 걷어내기 해제
          viz.passTimer = 1.0;
        },
      });
      break;
    }
    case 'corner': {
      // 규칙: 수비 진영에서 수비수가 마지막으로 터치하고 골라인을 넘어야 코너킥.
      // 슛이 수비수 몸에 맞고(굴절) 자기 골라인 밖으로 나가는 장면으로 연출.
      // 전개 실패 폴백(타임아웃)으로 공이 박스 근처까지 못 간 채 도착했다면
      // 코너 연출을 생략한다 — 미드필드/자기 진영에서 코너 모션이 튀어나오는
      // 장면 방지 (피드에는 이벤트만 남긴다)
      if (Math.hypot(gx - viz.ball.x, gy - viz.ball.y) > 420) {
        feed();
        done();
        break;
      }
      // Law 17: 수비 마지막 터치 + 골라인 아웃 → 나간 지점에서 가까운 코너
      // 아크에서 재개. 세트피스 동안 압박 동결(9.15m 룰), 양 팀은 박스에서
      // 자리싸움(타깃 루프의 코너 포지셔닝), 키퍼는 골라인에 선다.
      atk.ceremony = true;
      const cy = viz.ball.y < VIZ.H / 2 ? VIZ.M : VIZ.H - VIZ.M; // near-side corner
      const blocker = vizNearest(defSide, gx - dir * 40, gy) || defGK;
      vizPush(blocker.x, blocker.y, shotSpd, {
        wait: 0.12,
        track: blocker, // the shot homes onto the defender's block
        onDone: () => {
          viz.comCd = 0;
          vizSay(`${vizName(blocker)}, 몸을 던져 막아냅니다 — 굴절!`);
        },
      });
      // deflection dribbles out over the byline near the corner
      vizPush(gx + dir * 6, cy < gy ? VIZ.M + 20 : VIZ.H - VIZ.M - 20, 300, { onDone: feed });
      vizPush(gx - dir * 2, cy, 220, { wait: 0.3 }); // ball placed inside the arc
      const taker = vizNearest(side, gx, cy);
      atk.taker = taker; // 박스 포지셔닝에서 제외 (아크로 가야 하는 선수)

      // 세컨드 볼: 떨어진 지점에서 가까운 선수가 먼저 줍는다 (양 팀 50/50 —
      // 걷어낸 팀이 소유를 자동 회수하지 않는다)
      const secondBall = () => {
        let best = null;
        let bd = Infinity;
        viz.players.forEach((pl) => {
          if (pl.gk || pl.off) return;
          const dd = (pl.x - viz.ball.x) ** 2 + (pl.y - viz.ball.y) ** 2;
          if (dd < bd) {
            bd = dd;
            best = pl;
          }
        });
        done();
        vizTakeover(best && best.isHome ? 'home' : 'away', best || vizTeam(defSide)[1]);
        viz.passTimer = 0.6;
      };

      // 딜리버리 헤더 경합: 클리어(세컨드볼) 25% / 클리어 아웃→공격 스로인 20%
      // / 키퍼 캐치 18% / 키퍼 펀칭(세컨드볼) 12% / 헤더 아웃→골킥 25%
      const resolveDelivery = () => {
        const roll = Math.random();
        if (roll < 0.25) {
          const clearer = vizNearest(defSide, viz.ball.x, viz.ball.y);
          viz.comCd = 0;
          vizSay(`${vizName(clearer)}, 헤더로 걷어냅니다!`);
          vizPush(gx - dir * (180 + Math.random() * 120), gy + (Math.random() * 160 - 80), 380, {
            onDone: secondBall,
          });
        } else if (roll < 0.45) {
          // 규칙: 수비가 걷어낸 공이 터치라인을 넘으면 공격팀 스로인
          const clearer = vizNearest(defSide, viz.ball.x, viz.ball.y);
          viz.comCd = 0;
          vizSay(`${vizName(clearer)}, 급하게 걷어낸 공이 터치라인 밖으로!`);
          atk.ceremony = false; // 세트피스 해제 — 선수들 재정렬
          const outY2 = Math.random() < 0.5 ? VIZ.M - 10 : VIZ.H - VIZ.M + 10;
          const outX2 = gx - dir * (90 + Math.random() * 120);
          vizPush(outX2, outY2, 360);
          const thrower2 = vizNearest(side, outX2, outY2);
          vizPush(
            outX2 + (Math.random() * 60 - 30),
            outY2 < VIZ.H / 2 ? VIZ.M + 50 : VIZ.H - VIZ.M - 50,
            300,
            {
              wait: 0.3,
              holdFor: thrower2, // 공격팀이 나가서 던진다 (수비 마지막 터치)
              onDone: () => {
                done();
                vizTakeover(side, vizNearest(side, viz.ball.x, viz.ball.y));
                viz.passTimer = 0.6;
              },
            }
          );
        } else if (roll < 0.63) {
          viz.comCd = 0;
          vizSay(`${vizName(defGK)}, 나와서 크로스를 잡아냅니다`);
          vizPush(defGK.x, defGK.y, 320, {
            track: defGK,
            onDone: () => {
              done();
              vizTakeover(defSide, defGK);
              viz.passTimer = 0.9;
            },
          });
        } else if (roll < 0.75) {
          // 키퍼 펀칭: 박스 밖으로 쳐내고 세컨드 볼 경합 — 펀칭한 팀 소유가
          // 자동으로 되는 게 아니다
          viz.comCd = 0;
          vizSay(`${vizName(defGK)}, 주먹으로 쳐냅니다 — 펀칭!`);
          vizPush(defGK.x, defGK.y, 320, { track: defGK });
          vizPush(gx - dir * (140 + Math.random() * 80), gy + (Math.random() * 140 - 70), 420, {
            onDone: secondBall,
          });
        } else {
          // 공격 헤더가 골문 위로 — 골라인 아웃, 규칙대로 골킥 재개
          const header = vizNearest(side, viz.ball.x, viz.ball.y, taker);
          viz.comCd = 0;
          vizSay(`${vizName(header)}의 헤더 — 골문을 살짝 넘어갑니다!`);
          vizPush(gx + dir * 12, gy + (Math.random() < 0.5 ? -1 : 1) * (48 + Math.random() * 36), 420);
          vizPush(gx - dir * (30 + Math.random() * 30), gy + (Math.random() * 50 - 25), 240, {
            wait: 0.5,
            onDone: () => {
              done();
              vizTakeover(defSide, defGK);
              viz.goalKick = true;
              viz.passTimer = 1.0;
            },
          });
        }
      };

      if (Math.random() < 0.25) {
        // 숏코너: 지원 온 동료와 짧게 주고받은 뒤 크로스 (EPL 단골 패턴)
        const support = vizNearest(side, gx - dir * 90, cy, taker) || taker;
        const sy = cy < gy ? cy + 44 : cy - 44;
        vizPush(gx - dir * (70 + Math.random() * 20), sy, 300, {
          wait: 0.8,
          holdFor: taker,
          onDone: () => {
            viz.comCd = 0;
            vizSay('숏코너 — 짧게 전개합니다');
          },
        });
        vizPush(gx - dir * 60, gy + (Math.random() * 60 - 30), 430, {
          wait: 0.35,
          holdFor: support,
          onDone: resolveDelivery,
        });
      } else {
        // delivery into the crowded box once the taker is over the ball
        // (박스 셋업이 끝날 시간을 주고 크로스가 올라간다)
        vizPush(gx - dir * 60, gy + (Math.random() * 60 - 30), 430, {
          wait: 0.9,
          holdFor: taker,
          onDone: resolveDelivery,
        });
      }
      break;
    }
    default:
      feed();
      done();
      break;
  }
}

// One server tick = one match minute: nudge possession toward the expected split.
function vizOnTick() {
  if (viz.script.length || viz.queue.length || viz.attack || viz.kickoff || viz.duel) return;
  const wantHome = Math.random() * 100 < viz.possHome;
  const want = wantHome ? 'home' : 'away';
  if (want !== viz.possession && Math.random() < 0.45) {
    // turnover: nearest opponent steals the ball
    vizTakeover(want, vizNearest(want, viz.ball.x, viz.ball.y));
    viz.passTimer = 0.4;
    if (viz.carrier) vizSay(`${vizName(viz.carrier)}, 패스 차단`);
  }
}

function vizFrame(ts) {
  const canvas = $('#pitch2d');
  if (!canvas || !state.inMatch) {
    viz.raf = null;
    return;
  }
  // 작전 타임: wallDt collapses to 0 so every timer/movement freezes in place
  const wallDt = viz.paused ? 0 : viz.lastTs ? Math.min((ts - viz.lastTs) / 1000, 0.05) : 0.016;
  viz.lastTs = ts;
  viz.now = ts;
  if (!viz.matchStartTs) viz.matchStartTs = ts;

  // 백로그 배속: 큐에 쌓인 이벤트 수(실제 시뮬레이션 데이터)로 남은 재생
  // 시간을 추정해, 전체 경기가 VIZ_TIME_CAP_SEC(최대 3분) 안에 끝나도록
  // 배속을 조절한다. 이벤트를 건너뛰지 않고 전부 재생하되 재생 속도만
  // 균일하게 높인다 — 시계와 실제 선수/공 움직임이 항상 같은 dt를
  // 공유하므로 시계만 앞서가는 어긋남이 생기지 않는다.
  const elapsedSec = (ts - viz.matchStartTs) / 1000;
  const backlogSec =
    viz.queue.length * VIZ_AVG_EVENT_SEC + (viz.attack ? Math.max(0, viz.attack.timeLeft) : 0);
  const projectedSec = elapsedSec + backlogSec;
  const speedMul =
    projectedSec > VIZ_TIME_CAP_SEC ? Math.min(VIZ_MAX_SPEED, projectedSec / VIZ_TIME_CAP_SEC) : 1;
  const dt = wallDt * speedMul;
  const ctx = canvas.getContext('2d');
  const { W, H, M } = VIZ;

  // ---- 경기 시계: 서버 틱이 아니라 '지금 화면에 보이는 플레이'를 따라간다 ----
  // 목표 분 = 현재 전개 중인 이벤트의 분 (없으면 서버 분까지 자유 진행).
  // dt가 이미 배속을 반영하므로 시계도 같은 배속으로만 따라잡는다.
  const minTarget = viz.attack
    ? viz.attack.e.minute
    : viz.duel
      ? viz.duel.e.minute
      : viz.queue.length
        ? viz.queue[0].minute
        : viz.srvMin;
  if (minTarget > viz.dispMin) {
    const rate = 1.54; // 기본 1분/0.65초 — 서버 TICK_MS(650ms)와 동일한 페이스
    viz.dispMin = Math.min(minTarget, viz.dispMin + rate * dt);
  }
  const shownMin = Math.floor(viz.dispMin);
  if (shownMin !== viz.shownMin) {
    viz.shownMin = shownMin;
    $('#sb-minute').textContent = shownMin <= 90 ? `${shownMin}'` : `90+${shownMin - 90}'`;
  }

  // ---- live possession: measured from actual time on the ball ----
  viz.possTime[viz.possession] += dt;
  viz.comCd = Math.max(0, viz.comCd - dt);
  viz.possUiT += dt;
  if (viz.possUiT >= 0.5) {
    viz.possUiT = 0;
    const tot = viz.possTime.home + viz.possTime.away || 1;
    const ph = Math.round((viz.possTime.home / tot) * 100);
    $('#poss-home').style.width = ph + '%';
    $('#poss-home-num').textContent = `${viz.names.home} ${ph}%`;
    $('#poss-away-num').textContent = `${100 - ph}% ${viz.names.away}`;
  }

  // ---- pending foul: whistle only on real contact, outside the boxes ----
  if (viz.duel && !viz.paused) {
    const d = viz.duel;
    d.t -= dt;
    const offSide = d.fkSide === 'home' ? 'away' : 'home';
    d.chaser = vizNearest(offSide, viz.ball.x, viz.ball.y);
    const bx = viz.ball.x;
    const outsideBoxes = bx > M + 104 && bx < W - M - 104;
    const contact =
      !viz.script.length &&
      d.chaser &&
      Math.hypot(d.chaser.x - viz.ball.x, d.chaser.y - viz.ball.y) < 18;
    // 어드밴티지: 접촉이 났지만 파울당한 팀이 상대 진영에서 공을 계속 소유하고
    // 있으면 휘슬 대신 플레이 온 (카드는 반드시 경기를 멈춘다)
    const advOk =
      d.advantage &&
      viz.possession === d.fkSide &&
      vizBallDistOwn(d.fkSide) > (W - 2 * M) / 2;
    if (contact && outsideBoxes && advOk) {
      viz.duel = null;
      addFeedItem(d.e.minute + "'", d.e.text, d.e.type);
      viz.comCd = 0;
      vizSay('심판, 어드밴티지 선언 — 플레이 온!');
    }
    // the whistle only blows with the ball in play on the ground — a timeout
    // during a pass waits for the ball to land first
    else if ((contact && outsideBoxes) || (d.t <= 0 && !viz.script.length)) {
      viz.duel = null;
      addFeedItem(d.e.minute + "'", d.e.text, d.e.type);
      viz.comCd = 0;
      if (d.e.red) {
        // 경고 누적 퇴장: 카드 받은 선수가 터치라인 밖으로 걸어 나간다
        const short = vizShortName(d.e.player);
        const dot =
          vizTeam(d.e.team).find((pl) => !pl.off && !pl.gk && pl.label === short) ||
          (d.chaser && !d.chaser.gk ? d.chaser : null);
        if (dot) dot.off = true;
        vizSay(`🟥 ${vizName(dot) || d.e.player}, 퇴장! 팀은 10명으로 싸웁니다`);
        showEventBanner(`🟥 레드카드 — ${d.e.player}`, 'red', 3000);
      } else if (d.e.type === 'card') {
        vizSay(`${vizName(d.chaser)}의 거친 태클 — 휘슬이 울립니다`);
        showEventBanner(`🟨 옐로카드 — ${d.e.player}`, 'yellow', 2200);
      } else {
        vizSay(`${vizName(d.chaser)}의 거친 태클 — 휘슬이 울립니다`);
      }
      viz.carrier = null;
      viz.runner = vizNearest(d.fkSide, viz.ball.x, viz.ball.y);
      vizPush(viz.ball.x, viz.ball.y, 1, {
        wait: viz.queue.length ? 0.5 : 1.1,
        onDone: () => {
          viz.runner = null;
          vizTakeover(d.fkSide, vizNearest(d.fkSide, viz.ball.x, viz.ball.y));
          viz.passTimer = 0.4;
        },
      });
    }
  }

  // ---- kickoff staging: hold play until teams reset and the taker steps up ----
  if (viz.kickoff && !viz.paused) {
    const ko = viz.kickoff;
    ko.t -= dt;
    const taker = ko.taker;
    if (ko.t <= 0 && Math.hypot(taker.x - viz.ball.x, taker.y - viz.ball.y) < 34) {
      viz.kickoff = null;
      viz.carrier = taker;
      viz.comCd = 0; // a kickoff always gets its commentary line
      vizSay(`${viz.names[ko.side]} 킥오프 — 경기 재개`);
      // the kickoff pass goes backwards to a midfielder
      const recv = vizMidfielder(ko.side);
      viz.runner = recv;
      vizPush(recv.x, recv.y, 300, {
        track: recv,
        onDone: () => {
          viz.carrier = recv;
          viz.runner = null;
          viz.passTimer = 0.7;
        },
      });
    }
  }

  // ---- event pipeline: hand the next server event to the live play ----
  if (viz.attack) {
    viz.attack.timeLeft -= dt;
    // safety: if the play somehow stalls with the ball loose, resolve from
    // here (corners get extra grace — they must reach the opponent's end)
    const stallAt = viz.attack.e.type === 'corner' ? -8 : -2;
    if (viz.attack.timeLeft <= stallAt && !viz.script.length) vizShoot(viz.attack);
  } else if (!viz.script.length && !viz.kickoff && !viz.paused && !viz.duel) {
    if (viz.pendingHalf && (!viz.queue.length || viz.queue[0].minute > 45)) {
      // 하프타임: 전반 플레이가 모두 끝난 뒤 진영 교대 + 어웨이 킥오프
      viz.pendingHalf = false;
      if (viz.pendingHalfText) {
        addFeedItem('', viz.pendingHalfText, 'phase');
        showEventBanner(viz.pendingHalfText, 'phase', 2600);
        viz.pendingHalfText = null;
      }
      viz.carrier = null;
      viz.runner = null;
      vizPush(VIZ.W / 2, VIZ.H / 2, 300, {
        onDone: () => {
          viz.secondHalf = true; // 진영 교대: the view mirrors for 후반전
          vizStageKickoff('away');
        },
      });
    } else if (viz.queue.length) {
      vizBeginEvent(viz.queue.shift());
    } else {
      viz.runner = null;
      if (viz.pendingResult && (!viz.flash || viz.now > viz.flash.until)) {
        const res = viz.pendingResult;
        viz.pendingResult = null;
        showResult(res);
      }
    }
  }

  // ---- ball movement ----
  const b = viz.ball;
  let ballSpeed = 0;
  if (viz.paused) {
    // frozen — nothing moves, nothing resolves
  } else if (viz.script.length) {
    const step = viz.script[0];
    if (step.wait > 0) {
      step.wait -= dt;
    } else if (
      step.holdFor &&
      step.holdT > 0 &&
      Math.hypot(step.holdFor.x - b.x, step.holdFor.y - b.y) > 26
    ) {
      step.holdT -= dt; // ball waits for its striker to arrive
    } else {
      step.holdFor = null;
      if (step.track) {
        // tracked pass: home onto the receiver's current position
        step.x = step.track.x;
        step.y = step.track.y;
      }
      const dx = step.x - b.x;
      const dy = step.y - b.y;
      const d = Math.hypot(dx, dy);
      const move = step.speed * dt;
      ballSpeed = step.speed;
      // speed<=2 steps are dead-ball pauses: they end with their wait, they
      // never crawl across the pitch even if the ball drifted meanwhile
      if (d <= move + 2 || step.speed <= 2) {
        b.x = step.x;
        b.y = step.y;
        viz.script.shift();
        if (step.onDone) step.onDone();
      } else {
        b.x += (dx / d) * move;
        b.y += (dy / d) * move;
      }
    }
  } else if (viz.carrier) {
    const side = viz.possession;
    const dir = vizDir(side);
    const carryX = viz.carrier.x + dir * 12;
    const carryY = viz.carrier.y;
    const gap = Math.hypot(carryX - b.x, carryY - b.y);
    viz.collect = gap > 34;
    if (viz.collect) {
      // dead ball: the new carrier runs over to collect it — the ball never
      // teleports to a player, the player comes to the ball
      ballSpeed = 0;
    } else {
      // dribble: carry the ball with a hard speed cap (no snapping)
      let mx = (carryX - b.x) * Math.min(1, dt * 9);
      let my = (carryY - b.y) * Math.min(1, dt * 9);
      const m = Math.hypot(mx, my);
      const cap = 430 * dt;
      if (m > cap) {
        mx *= cap / m;
        my *= cap / m;
      }
      b.x += mx;
      b.y += my;
      // in open play the ball never crosses the lines (no phantom own goals)
      b.x = Math.max(M + 4, Math.min(W - M - 4, b.x));
      b.y = Math.max(M + 4, Math.min(H - M - 4, b.y));
      ballSpeed = 60;
      const atk = viz.attack && viz.attack.e.team === side ? viz.attack : null;
      if (atk) {
        // chasing an outcome: advance -> penetrate the box -> finish
        const gDist = Math.hypot(vizGoalX(side) - b.x, H / 2 - b.y);
        if (atk.e.via === 'freekick') {
          // a direct free kick can never be given from inside the box (a
          // box foul is always a penalty by rule) — mirrors the penalty
          // branch below, just inverted: require gDist AND being outside
          // vizInBox before staging the shot.
          if (gDist < 280 && !vizInBox(side, b.x, b.y)) {
            vizShoot(atk);
          } else if (atk.timeLeft <= 0) {
            // safety valve so a stuck build-up can't stall forever — snap
            // the ball just outside the box first, same as the penalty
            // valve does for "just inside", so the fallback can never
            // resolve from inside the box or some arbitrary distance.
            const dir2 = vizDir(side);
            b.x = vizGoalX(side) - dir2 * (BOX_DEPTH + 30);
            b.y = H / 2;
            vizShoot(atk);
          } else {
            viz.passTimer -= dt * 1.3 * atk.hurry;
            if (viz.passTimer <= 0) vizSchedulePass();
          }
        } else if (atk.e.via === 'penalty') {
          // carried into the box, brought down by the tackle -> penalty.
          // Must be a genuine rectangular box entry (vizInBox), not the old
          // circular "within 140 of the goal centre" radius — that circle
          // reached past the box's actual 100-unit depth on a straight-on
          // approach, which is exactly how a penalty could fire outside it.
          if (vizInBox(side, b.x, b.y)) {
            viz.comCd = 0;
            vizSay(`${vizName(viz.carrier)}, 박스 안에서 넘어집니다! 페널티킥!`);
            vizShoot(atk);
          } else if (atk.timeLeft <= 0) {
            // safety valve so a stuck build-up can't stall forever — snap
            // the ball just inside the box first so the call still reads
            // as a genuine in-box moment, never one given from outside it
            const dir2 = vizDir(side);
            b.x = vizGoalX(side) - dir2 * (BOX_DEPTH - 10);
            b.y = H / 2;
            viz.comCd = 0;
            vizSay(`${vizName(viz.carrier)}, 박스 안에서 넘어집니다! 페널티킥!`);
            vizShoot(atk);
          } else {
            viz.passTimer -= dt * 1.3 * atk.hurry;
            if (viz.passTimer <= 0) vizSchedulePass();
          }
        } else if (atk.e.type === 'corner') {
          // 규칙: 코너킥은 상대 골라인을 넘어야 한다 — 공이 상대 진영 깊숙이
          // 전개된 뒤에만 굴절 아웃을 스테이징 (시간이 밀려도 전진할 때까지 유예)
          if (gDist < 320 || atk.timeLeft <= -6) vizShoot(atk);
          else {
            viz.passTimer -= dt * 1.3 * atk.hurry;
            if (viz.passTimer <= 0) vizSchedulePass();
          }
        } else if (atk.timeLeft <= 0) {
          vizShoot(atk); // out of time: resolve from wherever
        } else if (atk.longShot && gDist < 300) {
          vizShoot(atk); // deliberate long-range effort
        } else if (atk.phase !== 'finish' && gDist < 290) {
          vizPenetrate(atk); // work it into the box: 침투 or wide + cutback
        } else if (atk.phase === 'finish' && gDist < vizTact(side).shootFrom) {
          viz.passTimer -= dt * 2; // one touch to set it, then strike
          if (viz.passTimer <= 0) vizShoot(atk);
        } else {
          viz.passTimer -= dt * 1.3 * atk.hurry; // quicker combinations
          if (viz.passTimer <= 0) vizSchedulePass();
        }
      } else {
        // 1:1 마무리: 드리블로 상대 수비 라인을 넘어 골문 앞까지 왔으면
        // 흘리지 않고 슈팅 모션을 가져간다 (결과는 키퍼 세이브 연출)
        const oppLine = side === 'home' ? W - M - viz.line.away : M + viz.line.home;
        const beyond = side === 'home' ? b.x > oppLine + 8 : b.x < oppLine - 8;
        const gDist = Math.hypot(vizGoalX(side) - b.x, H / 2 - b.y);
        if (
          beyond &&
          gDist < 240 &&
          viz.chanceCd <= 0 &&
          !viz.carrier.gk &&
          !viz.duel &&
          !viz.kickoff
        ) {
          viz.chanceCd = 7; // 남발 방지
          vizAmbientShot(side);
        } else {
          // keepers and defenders release the ball quickly; forwards hold it up
          const holdUp = viz.carrier.gk ? 2.2 : viz.carrier.num <= 5 ? 1.5 : 1;
          viz.passTimer -= dt * vizTact(side).tempo * holdUp;
          if (viz.passTimer <= 0) vizSchedulePass();
        }
      }
    }
  } else {
    viz.collect = false;
  }
  viz.ballAngle += (ballSpeed / 14) * dt;

  // ---- defensive line height per team (smoothed): tactics visibly raise or
  // drop the line; possession pushes it up, the ball pins it back ----
  const lineTarget = (side) => {
    const tact = vizTact(side);
    const ballDist = vizBallDistOwn(side);
    const hasBall = viz.possession === side;
    const raw = ballDist * 0.5 + 40 + tact.line * 0.8 + (hasBall ? 60 : -10);
    return Math.max(64, Math.min(430, raw));
  };
  ['home', 'away'].forEach((s) => {
    viz.line[s] += (lineTarget(s) - viz.line[s]) * Math.min(1, dt * 1.3);
    viz.breakT[s] = Math.max(0, viz.breakT[s] - dt);
  });
  viz.stealCd = Math.max(0, viz.stealCd - dt);
  viz.chanceCd = Math.max(0, viz.chanceCd - dt);
  viz.offsideCd = Math.max(0, viz.offsideCd - dt);

  // ---- player targets ----
  const defendSide = viz.possession === 'home' ? 'away' : 'home';
  const presser = viz.carrier ? vizNearest(defendSide, b.x, b.y) : null;
  const presser2 =
    presser && vizTact(defendSide).press >= 2 ? vizNearest(defendSide, b.x, b.y, presser) : null;
  const t = ts / 1000;
  const ballDy = b.y - H / 2;
  const setPiece = viz.attack && viz.attack.ceremony; // penalty/freekick ceremony
  // low block: a team stops pressing once the ball is past its engage range
  const pressEngaged = vizBallDistOwn(defendSide) < vizTact(defendSide).engage;
  viz.players.forEach((p) => {
    const mySide = p.isHome ? 'home' : 'away';
    const attacking = viz.possession === mySide;
    const dir = p.isHome ? 1 : -1;
    const ox = p.isHome ? M : W - M; // own goal line x
    const role = p.gk ? 0 : p.num <= 5 ? 1 : p.num <= 8 ? 2 : 3; // GK/DEF/MID/ATT
    const tact = vizTact(mySide);
    const line = viz.line[mySide];
    const oppLineAbs = p.isHome ? W - M - viz.line.away : M + viz.line.home;

    // anchors hang off the moving defensive line, so the whole block visibly
    // pushes up or drops off with tactics and possession
    const roamX = Math.sin(t * p.speed + p.phase) * 10;
    const roamY = Math.cos(t * p.speed * 0.8 + p.phase * 1.7) * 10;
    const gapDM = attacking ? 120 : 92; // block stretches with the ball, compact without
    let tx;
    let ty;
    if (p.gk) {
      tx = ox + dir * Math.max(12, Math.min(56, line * 0.22));
      ty = H / 2 + ballDy * 0.12;
    } else if (role === 1) {
      // flat back four on the line; fullbacks push on in possession
      const isWide = Math.abs(p.baseY - H / 2) > 100;
      tx = ox + dir * (line + p.depthOff * 0.4 + (attacking && isWide ? 46 : 0));
      ty = p.baseY + ballDy * (attacking ? 0.2 : 0.34);
    } else if (role === 2) {
      tx = ox + dir * (line + gapDM + p.depthOff);
      ty = p.baseY + ballDy * (attacking ? 0.22 : 0.34);
    } else if (attacking) {
      // strikers ride the opponent's back line, waiting to run in behind
      tx = oppLineAbs - dir * 16;
      ty = p.baseY + ballDy * 0.24;
    } else {
      // out of possession the front line stays high as the counter outlet
      tx = ox + dir * (line + gapDM + 85 + p.depthOff * 0.5);
      ty = p.baseY + ballDy * 0.3;
    }
    tx += roamX;
    ty += roamY;
    let sp = 105 * p.paceMul; // positioning jog, quicker for pacey players

    // off-the-ball sprints, more often for attacking tactics
    if (
      !p.gk &&
      !p.off &&
      attacking &&
      !p.run &&
      p !== viz.carrier &&
      Math.random() < dt * 0.12 * tact.runFreq
    ) {
      p.run = {
        tx: Math.max(M, Math.min(W - M, p.x + dir * (70 + Math.random() * 90))),
        ty: Math.max(M, Math.min(H - M, p.y + (Math.random() * 120 - 60))),
        until: t + 2.5,
      };
    }
    if (p.run && (!attacking || t > p.run.until || Math.hypot(p.x - p.run.tx, p.y - p.run.ty) < 10)) {
      p.run = null;
    }

    if (p.off) {
      // 퇴장: 가까운 터치라인 밖으로 걸어 나가 경기에서 빠진다 (10인 플레이)
      tx = p.x;
      ty = p.y < H / 2 ? M - 8 : H - M + 8;
      sp = 90;
    } else if (viz.kickoff) {
      // kickoff reset: everyone back to their formation spot in their own
      // half; the taker walks up to the centre spot
      if (p === viz.kickoff.taker) {
        tx = W / 2 - dir * 14;
        ty = H / 2;
      } else {
        tx = p.baseX;
        ty = p.baseY;
      }
      sp = 150 * p.paceMul;
    } else if (p === viz.carrier && !viz.script.length) {
      if (viz.collect) {
        // sprint to pick up the dead ball
        tx = b.x;
        ty = b.y;
        sp = 175 * p.paceMul;
      } else if (p.gk) {
        // keepers distribute from their spot — they never dribble upfield
        sp = 120 * p.paceMul;
      } else {
        // carrier drives at goal; pace from card stats, tactic and breaks
        const boost =
          tact.carrier *
          (viz.breakT[mySide] > 0 ? 1.35 : 1) *
          (viz.attack && viz.attack.e.team === mySide ? 1.25 : 1);
        if (viz.attack && viz.attack.e.team === mySide) {
          const ang = Math.atan2(H / 2 - p.y, vizGoalX(mySide) - p.x);
          tx = p.x + Math.cos(ang) * 44;
          ty = p.y + Math.sin(ang) * 44;
        } else {
          tx = p.x + dir * 44;
          ty = p.y + Math.sin(t * 2 + p.phase) * 18;
        }
        sp = 100 * (0.55 * p.dribMul + 0.45 * p.paceMul) * boost;
      }
    } else if (viz.script.length && viz.script[0].holdFor === p) {
      // hurry over to strike the waiting ball (crosser / corner taker)
      tx = b.x;
      ty = b.y;
      sp = 180 * p.paceMul;
    } else if (viz.script.length && p === viz.runner) {
      // sprint to where the ball is going to land, not where it is (침투런)
      tx = viz.script[0].x;
      ty = viz.script[0].y;
      sp = 175 * p.paceMul;
    } else if (viz.duel && p === viz.duel.chaser) {
      // committed tackle run — this is the player about to give the foul away
      tx = b.x;
      ty = b.y;
      sp = 190 * p.paceMul;
    } else if (
      setPiece &&
      viz.attack.e.via === 'freekick' &&
      viz.attack.wall &&
      viz.attack.wall.indexOf(p) >= 0
    ) {
      // 수비벽: 공과 자기 골문 사이에 어깨를 맞대고 늘어선다
      const wgx = vizGoalX(viz.attack.e.team);
      const wang = Math.atan2(H / 2 - b.y, wgx - b.x);
      const wi = (viz.attack.wall.indexOf(p) - 1) * 15; // -15, 0, +15 어깨 간격
      tx = b.x + Math.cos(wang) * 62 + Math.cos(wang + Math.PI / 2) * wi;
      ty = b.y + Math.sin(wang) * 62 + Math.sin(wang + Math.PI / 2) * wi;
      sp = 175 * p.paceMul;
    } else if (setPiece && viz.attack.e.via === 'penalty' && p !== viz.runner && !p.gk) {
      // 페널티 규칙: 키커와 골키퍼 외 전원은 페널티 박스 밖에서 대기
      const pgx = vizGoalX(viz.attack.e.team);
      const pdir = viz.attack.e.team === 'home' ? 1 : -1;
      if (Math.abs(pgx - tx) < 128 && Math.abs(ty - H / 2) < 112) {
        tx = pgx - pdir * (132 + Math.abs(p.depthOff || 0) * 0.3);
      }
    } else if (setPiece && viz.attack.e.type === 'corner' && p !== viz.attack.taker) {
      // 코너킥 세트피스 (Law 17): 공격진은 박스 안으로 쇄도 대기, 수비는
      // 골사이드 마킹, 키퍼는 골라인 — 아크 주변(9.15m)은 비워둔다
      const ce = viz.attack.e;
      const cgx = vizGoalX(ce.team);
      const cdir = ce.team === 'home' ? 1 : -1;
      const isAtk = (p.isHome ? 'home' : 'away') === ce.team;
      const SPOTS = [[56, -40], [44, -4], [58, 36], [30, -18], [36, 24], [70, 8], [26, 44]];
      if (!isAtk && p.gk) {
        tx = cgx - cdir * 10; // 키퍼는 골라인에
        ty = H / 2;
      } else if (isAtk && !p.gk && p.num >= 6) {
        const s = SPOTS[p.num % SPOTS.length]; // 공격진 박스 침투 대기
        tx = cgx - cdir * s[0];
        ty = H / 2 + s[1];
      } else if (!isAtk && !p.gk && p.num <= 8) {
        const s = SPOTS[(p.num + 3) % SPOTS.length]; // 같은 스팟을 골사이드에서 마킹
        tx = cgx - cdir * Math.max(14, s[0] - 12);
        ty = H / 2 + s[1] * 0.8;
      }
      // 나머지(공격팀 수비수 · 수비팀 공격수)는 박스 밖 대기/역습 대비
    } else if ((p === presser || p === presser2) && !setPiece && !viz.goalKick && pressEngaged) {
      tx = b.x;
      ty = b.y;
      sp = 165 * p.paceMul * (0.7 + 0.3 * p.defMul);
    } else if (p.run) {
      tx = p.run.tx;
      ty = p.run.ty;
      sp = 160 * p.paceMul;
    } else if (viz.attack && viz.attack.phase !== 'advance' && attacking && role === 3 && !setPiece) {
      // forwards flood the box once the penetration starts
      tx += (b.x - tx) * 0.5;
      ty += (b.y - ty) * 0.3;
      sp = 150 * p.paceMul;
    }

    // clamp targets to the pitch
    tx = Math.max(M - 6, Math.min(W - M + 6, tx));
    ty = Math.max(M - 6, Math.min(H - M + 6, ty));

    // inertial movement: accelerate toward the target, capped by pace — no
    // instant direction flips, players curve into position
    const ddx = tx - p.x;
    const ddy = ty - p.y;
    const dd = Math.hypot(ddx, ddy) || 1;
    const arrive = Math.min(sp, dd * 4); // decelerate close to the target
    p.vx += ((ddx / dd) * arrive - p.vx) * Math.min(1, dt * 5);
    p.vy += ((ddy / dd) * arrive - p.vy) * Math.min(1, dt * 5);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.x = Math.max(M - 8, Math.min(W - M + 8, p.x));
    p.y = Math.max(M - 8, Math.min(H - M + 8, p.y));
  });

  // pressing steal: a defender who catches the dribbling carrier wins the
  // ball — better defenders steal more, better dribblers keep it longer
  // (suspended while an event attack must keep possession)
  if (!viz.script.length && !viz.attack && !viz.duel && !viz.collect && !viz.goalKick && viz.stealCd <= 0 && viz.carrier && presser) {
    const pd = Math.hypot(presser.x - b.x, presser.y - b.y);
    if (pd < 18 && Math.random() < (dt * 2.2 * presser.defMul) / viz.carrier.dribMul) {
      vizTakeover(defendSide, presser);
      viz.passTimer = 0.5 + Math.random() * 0.7;
      vizSay(`${vizName(presser)}, 볼 탈취!`);
    }
  }

  // ---- draw ----
  // the sim runs in landscape coords; the screen shows the pitch portrait
  // with this client's team at the bottom attacking upward. Away clients get
  // the opposite rotation so their own team is always the bottom one.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  const flipped = viz.flip !== viz.secondHalf; // 후반전엔 진영이 뒤바뀐다
  if (flipped) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  const textRot = flipped ? -Math.PI / 2 : Math.PI / 2;

  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? '#1e7a3c' : '#226f3a';
    ctx.fillRect((W / 8) * i, 0, W / 8, H);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(M, M, W - 2 * M, H - 2 * M);
  ctx.beginPath();
  ctx.moveTo(W / 2, M);
  ctx.lineTo(W / 2, H - M);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 56, 0, Math.PI * 2);
  ctx.stroke();
  const boxH = BOX_WIDTH;
  const boxW = BOX_DEPTH;
  ctx.strokeRect(M, (H - boxH) / 2, boxW, boxH);
  ctx.strokeRect(W - M - boxW, (H - boxH) / 2, boxW, boxH);
  const goalH = 70;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(M - 7, (H - goalH) / 2, 7, goalH);
  ctx.fillRect(W - M, (H - goalH) / 2, 7, goalH);

  // players (text counter-rotated so numbers and names read horizontally)
  viz.players.forEach((p) => {
    // sent-off players disappear once they reach the touchline
    if (p.off && (p.y <= M - 2 || p.y >= H - M + 2)) return;
    const isCarrier = p === viz.carrier && !viz.script.length;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = p.isHome ? (p.gk ? '#1d4ed8' : '#3b82f6') : p.gk ? '#b91c1c' : '#ef4444';
    ctx.fill();
    ctx.lineWidth = isCarrier ? 3 : 1.5;
    ctx.strokeStyle = isCarrier ? '#ffd76e' : 'rgba(255,255,255,.85)';
    ctx.stroke();
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(textRot);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.num), 0, 0.5);
    if (p.label) {
      ctx.font = '9px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText(p.label, 0, 21);
    }
    ctx.restore();
  });

  // ball (sprite with spin, fallback to a plain circle until loaded)
  const R = 9;
  if (ballImg.complete && ballImg.naturalWidth) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(viz.ballAngle);
    ctx.drawImage(ballImg, -R, -R, R * 2, R * 2);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();

  // goal flash drawn in screen space so the banner reads horizontally
  if (viz.flash && viz.now < viz.flash.until) {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, canvas.height / 2 - 46, canvas.width, 92);
    ctx.fillStyle = '#ffd76e';
    ctx.font = '900 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(viz.flash.text, canvas.width / 2, canvas.height / 2);
  }

  viz.raf = requestAnimationFrame(vizFrame);
}

function addFeedItem(minute, text, type) {
  const feed = $('#match-feed');
  const item = document.createElement('div');
  item.className = 'feed-item ' + (type || '');
  item.innerHTML = `<span class="fi-min">${minute}</span><span>${text}</span>`;
  feed.appendChild(item);
  feed.scrollTop = feed.scrollHeight;
}

// ---- FM 스타일 이벤트 배너: 전술판 위에 겹쳐지는 한 줄 토스트 ----
// 중요 이벤트(골/카드/오프사이드/하프타임 등)만 선별적으로 띄운다 —
// save/miss/corner 같은 잔잔한 플레이는 #match-feed 스크롤로만 남긴다.
let bannerTimer = null;
function showEventBanner(text, kind, ms) {
  const el = $('#event-banner');
  if (!el) return;
  clearTimeout(bannerTimer);
  el.className = 'eb-' + (kind || 'info');
  el.textContent = text;
  // restart the CSS animation even if the same kind fires twice in a row
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  bannerTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
}

async function showResult(msg) {
  state.inMatch = false;
  addFeedItem('FT', `📣 경기 종료 (${msg.score.home} - ${msg.score.away})`, 'phase');

  const banner = $('#result-banner');
  const labels = { win: '🎉 승리!', loss: '😢 패배', draw: '🤝 무승부' };
  banner.textContent = labels[msg.outcome] || '경기 종료';
  banner.className = msg.outcome || '';
  document.querySelector('.result-modal').className = 'result-modal ' + (msg.outcome || '');

  $('#result-score').innerHTML =
    `<span>${msg.home}</span><b>${msg.score.home} - ${msg.score.away}</b><span>${msg.away}</span>`;
  const reward = msg.reward
    ? `<br>보상: 🪙 ${msg.reward.coins.toLocaleString()} · 승점 +${msg.reward.points}`
    : '';
  $('#result-detail').innerHTML =
    `xG ${msg.xg.home} : ${msg.xg.away} · 점유율 ${msg.possession.home}% : ${msg.possession.away}%${reward}`;
  $('#result-overlay').classList.remove('hidden');

  try {
    const { user } = await api('GET', '/api/me');
    setMe(user);
  } catch {}
}

// =====================================================================
// rank tab
// =====================================================================

async function renderRank() {
  try {
    const [{ leaderboard }, { matches }] = await Promise.all([
      api('GET', '/api/leaderboard'),
      api('GET', '/api/matches'),
    ]);

    const tbody = $('#leaderboard-table tbody');
    tbody.innerHTML = leaderboard
      .map(
        (row, i) => `
        <tr${row.username === state.me.username ? ' style="color:var(--gold)"' : ''}>
          <td>${i + 1}</td>
          <td>${escapeHtml(row.clubName)} <span class="dim small-text">(${escapeHtml(row.username)})</span></td>
          <td class="num">${row.points}</td>
          <td>${row.record.w}-${row.record.d}-${row.record.l}</td>
          <td>${row.ovr}</td>
          <td>${row.username === state.me.username ? '' : `<button type="button" class="btn ghost small oppo-view-btn" data-username="${escapeHtml(row.username)}">🔍 스쿼드</button>`}</td>
        </tr>`
      )
      .join('');
    tbody.querySelectorAll('.oppo-view-btn').forEach((btn) => {
      btn.onclick = () => openOpponentSquad(btn.dataset.username);
    });

    const hist = $('#history-list');
    if (!matches.length) {
      hist.innerHTML = '<p class="dim">아직 경기 기록이 없습니다.</p>';
    } else {
      hist.innerHTML = matches
        .map((m) => {
          const isHome = m.homeUserId === state.me.id;
          const my = isHome ? m.score.home : m.score.away;
          const opp = isHome ? m.score.away : m.score.home;
          const oppName = isHome ? m.awayName : m.homeName;
          const outcome = my > opp ? 'win' : my < opp ? 'loss' : 'draw';
          const label = { win: '승', loss: '패', draw: '무' }[outcome];
          const date = new Date(m.at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
          return `
          <div class="history-row">
            <span class="h-outcome ${outcome}">${label}</span>
            <span>vs ${oppName}</span>
            <span class="h-score">${my} - ${opp}</span>
            <span class="dim small-text">${m.mode === 'ai' ? 'AI전' : '랭크'} · ${date}</span>
          </div>`;
        })
        .join('');
    }
  } catch (err) {
    toast(err.message);
  }
}

// =====================================================================
// 상대 스쿼드 보기 / 전략 복사 (랭킹 탭)
// =====================================================================

let oppoView = null; // last-fetched opponent squad, kept for the copy button

async function openOpponentSquad(username) {
  try {
    const view = await api('GET', `/api/user/${encodeURIComponent(username)}/squad`);
    oppoView = view;
    $('#oppo-title').textContent = `🔍 ${view.clubName} (${view.username}) 스쿼드`;
    $('#oppo-info').textContent =
      `${view.formation} · 전술: ${state.tactics[view.tactic] || view.tactic} · OVR ${view.ratings.OVR}`;
    const oppoPitch = $('#oppo-pitch');
    oppoPitch.querySelectorAll('.slot').forEach((s) => s.remove());
    const slotPos = state.formations[view.formation] || [];
    const coords = COORDS[view.formation] || COORDS['4-3-3'];
    view.starterDetails.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.style.left = (coords[i] ? coords[i][0] : 50) + '%';
      el.style.bottom = (coords[i] ? coords[i][1] : 50) + '%';
      if (!p) {
        el.innerHTML = emptySlotHTML(slotPos[i] || '');
        oppoPitch.appendChild(el);
        return;
      }
      const pid = view.starters[i];
      const roleId = view.roles[pid];
      const roleLabel = roleId && state.roles[roleId] ? state.roles[roleId].label : '';
      const badge = pid === view.captain ? 'C' : pid === view.viceCaptain ? 'VC' : '';
      el.innerHTML = cardHTML(p, 'xs', { badge });
      el.title = roleLabel ? `${p.name} · ${roleLabel}` : p.name;
      oppoPitch.appendChild(el);
    });
    $('#oppo-overlay').classList.remove('hidden');
  } catch (err) {
    toast(err.message);
  }
}

function closeOpponentSquad() {
  $('#oppo-overlay').classList.add('hidden');
  oppoView = null;
}

$('#btn-oppo-close').onclick = () => closeOpponentSquad();

$('#oppo-copy').onclick = async () => {
  if (!oppoView) return;
  try {
    // 1) switch to their formation/tactic, keeping my current starters by
    // index where possible (same approach as the formation-select handler)
    const slots = state.formations[oppoView.formation].length;
    const curStarters = activeSquad().starters.slice(0, slots);
    while (curStarters.length < slots) curStarters.push(null);
    await saveSquad({ formation: oppoView.formation, starters: curStarters, tactic: oppoView.tactic });
    // 2) auto-fill the best XI from MY OWN roster in that formation (their
    // exact players usually aren't mine to place)
    const { user } = await api('POST', '/api/squad/auto', { kind: state.squadMode });
    setMe(user);
    // 3) re-apply their per-slot player "type" (role) onto whoever now sits
    // in that slot on my side, skipping roles that don't fit my player's pos
    const mySquad = state.squadMode === 'pvp' ? user.pvpSquad : user.squad;
    const roleBySlot = oppoView.starters.map((pid) => oppoView.roles[pid] || null);
    const myRoles = {};
    mySquad.starters.forEach((pid, i) => {
      if (!pid || !roleBySlot[i]) return;
      const p = state.catalog.get(pid);
      const role = state.roles[roleBySlot[i]];
      if (p && role && role.pos.includes(p.pos)) myRoles[pid] = roleBySlot[i];
    });
    await saveSquad({ roles: myRoles });
    closeOpponentSquad();
    toast('전략을 복사했습니다! (포메이션·전술·유형 — 보유 선수로 자동 배치)');
  } catch (err) {
    toast(err.message);
  }
};

// ---- 득점왕 · 도움왕 (육각형 능력치 차트) ----

const HEX_ATTRS = [
  ['pace', 'PAC'],
  ['shooting', 'SHO'],
  ['passing', 'PAS'],
  ['dribbling', 'DRI'],
  ['defending', 'DEF'],
  ['physical', 'PHY'],
];

function hexChartSVG(attrs) {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 30;
  const n = HEX_ATTRS.length;
  const angleFor = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, r) => {
    const a = angleFor(i);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const rings = [0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const pts = HEX_ATTRS.map((_, i) => pt(i, maxR * frac).join(',')).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="var(--border)" stroke-width="1" />`;
    })
    .join('');
  const spokes = HEX_ATTRS.map((_, i) => {
    const [x, y] = pt(i, maxR);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="1" />`;
  }).join('');
  const dataPts = HEX_ATTRS.map(([key], i) => {
    const v = Math.max(0, Math.min(99, (attrs && attrs[key]) || 0));
    return pt(i, (v / 99) * maxR).join(',');
  }).join(' ');
  const labels = HEX_ATTRS.map(([key, label], i) => {
    const [x, y] = pt(i, maxR + 18);
    const v = (attrs && attrs[key]) || 0;
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" class="hex-label">${label} ${v}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 ${size} ${size}" class="hex-chart" role="img" aria-label="선수 능력치 육각형 차트">
      ${rings}
      ${spokes}
      <polygon points="${dataPts}" fill="var(--blue)" fill-opacity="0.32" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round" />
      ${labels}
    </svg>`;
}

// Best individual performance among MY owned players for a given stat field
// (동률이면 다른 지표 -> 이름 순).
function topPerformer(field, otherField) {
  const stats = (state.me && state.me.playerStats) || {};
  const entries = Object.entries(stats).filter(([, s]) => (s[field] || 0) > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    const diff = b[1][field] - a[1][field];
    if (diff) return diff;
    const diff2 = (b[1][otherField] || 0) - (a[1][otherField] || 0);
    if (diff2) return diff2;
    const pa = state.catalog.get(a[0]);
    const pb = state.catalog.get(b[0]);
    return pa && pb ? pa.name.localeCompare(pb.name) : 0;
  });
  const [id, stat] = entries[0];
  return { id, stat };
}

function perfCardHTML(title, icon, entry) {
  if (!entry) {
    return `<div class="perf-card"><h4>${icon} ${title}</h4><p class="dim">이번 시즌 기록이 없습니다.</p></div>`;
  }
  const p = upgradedCard(state.catalog.get(entry.id));
  if (!p) return '';
  return `
    <div class="perf-card">
      <h4>${icon} ${title}</h4>
      <div class="perf-body">
        ${cardHTML(p, 'sm', { stats: true })}
        <div class="perf-chart">
          ${hexChartSVG(p.attrs)}
          <div class="perf-stat dim small-text">⚽ ${entry.stat.goals || 0}골 · 🅰️ ${entry.stat.assists || 0}도움</div>
        </div>
      </div>
    </div>`;
}

function renderTopPerformers() {
  const scorer = topPerformer('goals', 'assists');
  const assister = topPerformer('assists', 'goals');
  $('#top-performers').innerHTML =
    perfCardHTML('득점왕', '👑', scorer) + perfCardHTML('도움왕', '🎯', assister);
}

// =====================================================================
// team record tab (시즌 현황)
// =====================================================================

async function renderTeamRecord() {
  try {
    const [{ season, history }, { leaderboard }] = await Promise.all([
      api('GET', '/api/season'),
      api('GET', '/api/leaderboard'),
    ]);
    const myIdx = leaderboard.findIndex((r) => r.username === state.me.username);
    const top5 = leaderboard.slice(0, 5);
    const lastSeason = history[0];
    const lastTop = lastSeason && lastSeason.top[0];
    $('#team-record').innerHTML = `
      <div class="season-banner">
        <div><span class="season-num">시즌 ${season.number}</span></div>
        <div class="dim">${season.daysRemaining}일 후 시즌 종료 (30일 주기)</div>
      </div>
      <div class="team-grid">
        <div class="team-block">
          <h4>내 성적</h4>
          <div id="team-my-rating" class="rating-cell-row">
            <div class="rating-cell"><div class="rc-label">순위</div><div class="rc-value">${myIdx >= 0 ? '#' + (myIdx + 1) : '-'}</div></div>
            <div class="rating-cell ovr"><div class="rc-label">승점</div><div class="rc-value">${state.me.points}</div></div>
            <div class="rating-cell"><div class="rc-label">전적</div><div class="rc-value">${state.me.record.w}-${state.me.record.d}-${state.me.record.l}</div></div>
          </div>
        </div>
        <div class="team-block">
          <h4>이번 시즌 TOP 5</h4>
          <ol class="mini-board">
            ${top5
              .map(
                (r) => `<li${r.username === state.me.username ? ' style="color:var(--gold)"' : ''}>${r.clubName} <span class="dim small-text">(${r.username})</span> — ${r.points}점</li>`
              )
              .join('') || '<li class="dim">기록 없음</li>'}
          </ol>
        </div>
        <div class="team-block">
          <h4>지난 시즌 우승</h4>
          <p>${lastTop ? `${lastTop.clubName} <span class="dim small-text">(${lastTop.username})</span> — ${lastTop.points}점` : '<span class="dim">아직 종료된 시즌이 없습니다.</span>'}</p>
        </div>
      </div>`;
  } catch (err) {
    toast(err.message);
  }
}

// =====================================================================
// 뉴스 (전체 유저 최근 경기 결과)
// =====================================================================

// 매치당 하나의 리포트 형식(속보/영상/라디오)을 매치 id로 결정 — 새로고침해도
// 같은 경기는 같은 형식을 유지하고, 목록 전체가 같은 모양으로 단조롭지 않게 한다.
const NEWS_FORMATS = [
  { tag: '속보', cls: 'breaking' },
  { tag: '📺 하이라이트', cls: 'video' },
  { tag: '📻 라디오 중계', cls: 'radio' },
];
function newsFormatFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NEWS_FORMATS[h % NEWS_FORMATS.length];
}

// 실제 경기 데이터(점수차·점유율·xG) 기반의 한 줄 코멘트 — 포맷별로 말투만 다르게.
function newsBlurb(m, fmt, winnerName, loserName) {
  const margin = Math.abs(m.score.home - m.score.away);
  const poss = m.possession || { home: 50, away: 50 };
  const dominance = Math.max(poss.home, poss.away);
  let line;
  if (margin === 0) {
    line = `양 팀 모두 승점을 하나씩 나눠 가졌다`;
  } else if (margin >= 3) {
    line = `${winnerName}가 시종일관 경기를 압도하며 완승을 거뒀다`;
  } else if (dominance >= 58) {
    line = `${winnerName}가 볼 점유를 앞세워 ${loserName}을(를) 무너뜨렸다`;
  } else {
    line = `${winnerName}가 접전 끝에 ${loserName}을(를) 힘겹게 꺾었다`;
  }
  if (fmt.cls === 'radio') return `"${line}" — 현장 라디오 코멘트`;
  if (fmt.cls === 'video') return `${line} · 하이라이트 리포트`;
  return line;
}

async function renderNews() {
  try {
    const { matches } = await api('GET', '/api/news');
    $('#news-list').innerHTML = matches
      .map((m) => {
        const winner = m.score.home === m.score.away ? null : m.score.home > m.score.away ? 'home' : 'away';
        const home = escapeHtml(m.homeName);
        const away = escapeHtml(m.awayName);
        const teams =
          winner === 'home'
            ? `<b>${home}</b> ${m.score.home} - ${m.score.away} ${away}`
            : winner === 'away'
              ? `${home} ${m.score.home} - ${m.score.away} <b>${away}</b>`
              : `${home} ${m.score.home} - ${m.score.away} ${away} (무승부)`;
        const fmt = newsFormatFor(m.id);
        const winnerName = winner === 'home' ? home : winner === 'away' ? away : null;
        const loserName = winner === 'home' ? away : winner === 'away' ? home : null;
        const blurb = newsBlurb(m, fmt, winnerName, loserName);
        return `
        <div class="news-item">
          <div class="news-head">
            <span class="news-badge ${fmt.cls}">${fmt.tag}</span>
            <span class="news-date">${new Date(m.at).toLocaleString()}</span>
          </div>
          <div class="news-teams">${teams}</div>
          <div class="news-blurb">${blurb}</div>
        </div>`;
      })
      .join('');
  } catch (err) {
    toast(err.message);
  }
}

// =====================================================================
// 선수 불만 (complaint) 모달
// =====================================================================

function openComplaint(complaint) {
  const p = state.catalog.get(complaint.playerId);
  $('#complaint-card-col').innerHTML = p ? cardHTML(upgradedCard(p), 'md', { stats: true }) : '';
  $('#complaint-prompt').textContent = (p ? p.name + ' — ' : '') + complaint.prompt;
  $('#complaint-choices').innerHTML = complaint.choices
    .map(
      (c) =>
        `<button type="button" class="btn" data-choice="${c.id}">${c.label}${c.costCoins ? ` (🪙${c.costCoins})` : ''}</button>`
    )
    .join('');
  $('#complaint-choices')
    .querySelectorAll('button')
    .forEach((btn) => {
      btn.onclick = async () => {
        try {
          const r = await api('POST', '/api/complaint/resolve', {
            complaintId: complaint.id,
            choiceId: btn.dataset.choice,
          });
          setMe(r.user);
          toast(r.satisfied ? '선수가 만족했습니다. 헌신도가 상승했습니다.' : '선수의 반응이 미온적입니다.');
          closeComplaint();
          renderComplaintsList();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  $('#complaint-overlay').classList.remove('hidden');
}

function closeComplaint() {
  $('#complaint-overlay').classList.add('hidden');
}

// =====================================================================
// 선수 불만 알림 목록 (여러 건 누적) 모달
// =====================================================================

function openComplaints() {
  renderComplaintsList();
  $('#complaints-overlay').classList.remove('hidden');
}

function closeComplaints() {
  $('#complaints-overlay').classList.add('hidden');
}

function renderComplaintsList() {
  const complaints = state.me.complaints || [];
  const list = $('#complaints-list');
  if (!complaints.length) {
    list.innerHTML = '<p class="dim">쌓인 불만이 없습니다.</p>';
    return;
  }
  list.innerHTML = complaints
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((c) => {
      const p = state.catalog.get(c.playerId);
      return `
      <div class="mail-item" data-id="${c.id}">
        <div class="mail-body">
          <div class="mail-msg">${p ? escapeHtml(p.name) + ' — ' : ''}${escapeHtml(c.prompt)}</div>
          <div class="mail-date">${new Date(c.createdAt).toLocaleString()}</div>
        </div>
        <button type="button" class="btn small primary" data-talk>면담</button>
      </div>`;
    })
    .join('');
  list.querySelectorAll('[data-talk]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.closest('.mail-item').dataset.id;
      const complaint = complaints.find((c) => c.id === id);
      if (complaint) openComplaint(complaint);
    };
  });
}

// =====================================================================
// 우편함 (mailbox) 모달
// =====================================================================

function openMailbox() {
  renderMailList();
  $('#mail-overlay').classList.remove('hidden');
}

function closeMailbox() {
  $('#mail-overlay').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMailList() {
  const mail = (state.me.mailbox || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  $('#mail-list').innerHTML = mail
    .map(
      (m) => `
      <div class="mail-item ${m.claimed ? 'claimed' : ''}" data-id="${m.id}">
        <div class="mail-body">
          ${m.coins ? `<div class="mail-coins">🪙 ${m.coins.toLocaleString()}</div>` : ''}
          ${m.message ? `<div class="mail-msg">${escapeHtml(m.message)}</div>` : ''}
          <div class="mail-date">${new Date(m.createdAt).toLocaleString()}</div>
        </div>
        ${
          m.claimed
            ? '<span class="dim small-text">수령완료</span>'
            : '<button type="button" class="btn small primary" data-claim>수령</button>'
        }
      </div>`
    )
    .join('');
  $('#mail-list')
    .querySelectorAll('[data-claim]')
    .forEach((btn) => {
      btn.onclick = async () => {
        const mailId = btn.closest('.mail-item').dataset.id;
        try {
          const r = await api('POST', '/api/mailbox/claim', { mailId });
          setMe(r.user);
          renderMailList();
          toast('우편을 수령했습니다.');
        } catch (err) {
          toast(err.message);
        }
      };
    });
}

// =====================================================================

boot().catch((err) => {
  document.body.innerHTML = `<p style="padding:40px;color:#f85149">초기화 실패: ${err.message}</p>`;
});
