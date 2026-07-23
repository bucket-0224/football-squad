'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const store = require('../store');
const players = require('./players');

// ---------------------------------------------------------------------------
// Dynamic league teams: every club of the tracked leagues is selectable as a
// starting team. League memberships are built in (2025-26 season); picking a
// club fetches its badge and real player names once and caches the generated
// roster in the store.
//
// Roster sources (v2): the full first-team squad is parsed from the club's
// Wikipedia article ({{fs player}} rows — name, nationality, GK/DF/MF/FW),
// merged with TheSportsDB's lookup (free tier caps at 10 players, but those
// carry granular positions + cutout images). Only when Wikipedia fails does
// the roster fall back to the TSDB 10 + generated youth fillers.
// ---------------------------------------------------------------------------

const TSDB = 'https://www.thesportsdb.com/api/v1/json/3';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const ROSTER_V = 3; // bump to force cached rosters to re-fetch on boot

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// League members, minus the curated clubs that already ship with hand-tuned
// rosters (those stay selectable through the curated list).
const LEAGUE_TEAMS = {
  EPL: [
    'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton and Hove Albion',
    'Burnley', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds United',
    'Newcastle United', 'Nottingham Forest', 'Sunderland',
    'Tottenham Hotspur', 'West Ham United', 'Wolverhampton Wanderers',
  ],
  LaLiga: [
    'Athletic Bilbao', 'Celta Vigo', 'Deportivo Alaves', 'Elche', 'Espanyol',
    'Getafe', 'Girona', 'Levante', 'Mallorca', 'Osasuna', 'Rayo Vallecano',
    'Real Betis', 'Real Oviedo', 'Real Sociedad', 'Sevilla', 'Valencia',
    'Villarreal',
  ],
  Bundesliga: [
    'Bayer Leverkusen', 'RB Leipzig', 'Eintracht Frankfurt', 'SC Freiburg',
    'VfB Stuttgart', 'VfL Wolfsburg', 'Borussia Monchengladbach', 'Mainz 05',
    'FC Augsburg', 'Werder Bremen', 'FC Heidenheim', 'Union Berlin',
    'TSG Hoffenheim', 'FC St Pauli', 'FC Koln', 'Hamburger SV',
  ],
  SerieA: [
    'Juventus', 'AS Roma', 'Lazio', 'Atalanta', 'Fiorentina', 'Bologna',
    'Torino', 'Udinese', 'Genoa', 'Como', 'Hellas Verona', 'Cagliari',
    'Parma', 'Lecce', 'Pisa', 'Cremonese', 'Sassuolo',
  ],
  Ligue1: [
    'Marseille', 'Monaco', 'Lille', 'Lyon', 'Nice', 'Lens', 'Rennes',
    'Strasbourg', 'Toulouse', 'Nantes', 'Brest', 'Auxerre', 'Angers',
    'Le Havre', 'Metz', 'Paris FC', 'Lorient',
  ],
  MLS: [
    'LA Galaxy', 'Atlanta United', 'Austin FC', 'Charlotte FC',
    'Chicago Fire', 'FC Cincinnati', 'Colorado Rapids', 'Columbus Crew',
    'FC Dallas', 'DC United', 'Houston Dynamo', 'Sporting Kansas City',
    'Minnesota United', 'CF Montreal', 'Nashville SC',
    'New England Revolution', 'New York City FC', 'New York Red Bulls',
    'Orlando City', 'Philadelphia Union', 'Portland Timbers',
    'Real Salt Lake', 'San Diego FC', 'San Jose Earthquakes',
    'Seattle Sounders', 'St Louis City', 'Toronto FC', 'Vancouver Whitecaps',
  ],
  BrasilA: [
    'Flamengo', 'Palmeiras', 'Sao Paulo', 'Corinthians', 'Santos',
    'Botafogo', 'Fluminense', 'Vasco da Gama', 'Gremio', 'Internacional',
    'Atletico Mineiro', 'Cruzeiro', 'Bahia', 'Fortaleza', 'Sport Recife',
    'Vitoria', 'Juventude', 'Mirassol', 'Ceara', 'Red Bull Bragantino',
  ],
  KLeague: [
    'Ulsan HD', 'Jeonbuk Hyundai Motors', 'FC Seoul', 'Pohang Steelers',
    'Gangwon FC', 'Gwangju FC', 'Daejeon Hana Citizen', 'Jeju SK',
    'Suwon FC', 'FC Anyang', 'Gimcheon Sangmu', 'Bucheon FC 1995',
  ],
};

const LEAGUE_BASE_OVR = {
  EPL: 77, LaLiga: 76, Bundesliga: 75, SerieA: 75, Ligue1: 74,
  MLS: 69, BrasilA: 71, KLeague: 67,
};

// TSDB ids + full names, used to harvest badges league-by-league.
const LEAGUE_META = {
  EPL: { id: 4328, name: 'English Premier League' },
  LaLiga: { id: 4335, name: 'Spanish La Liga' },
  Bundesliga: { id: 4331, name: 'German Bundesliga' },
  SerieA: { id: 4332, name: 'Italian Serie A' },
  Ligue1: { id: 4334, name: 'French Ligue 1' },
  MLS: { id: 4346, name: 'American Major League Soccer' },
  BrasilA: { id: 4351, name: 'Brazilian Serie A' },
  KLeague: { id: 4689, name: 'South Korean K League 1' },
};

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, '');
}

const LEAGUE_OF = {};
Object.entries(LEAGUE_TEAMS).forEach(([lg, names]) =>
  names.forEach((n) => {
    LEAGUE_OF[norm(n)] = lg;
  })
);

async function tsdb(path) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(`${TSDB}/${path}`, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function db() {
  const d = store.get();
  if (!d.dynRosters) d.dynRosters = {};
  if (!d.dynMeta) d.dynMeta = {}; // normName -> { id, badge } from searchteams
  return d;
}

// The selectable list is static — no network, no free-tier caps. Badges come
// from the warmed cache and fill in progressively.
function listSelectable() {
  const meta = db().dynMeta;
  const out = [];
  Object.entries(LEAGUE_TEAMS).forEach(([league, names]) => {
    names.forEach((name) => {
      const m = meta[norm(name)];
      out.push({ name, league, logo: (m && m.badge) || null });
    });
  });
  return out;
}

// A few clubs share their name with teams from other sports, which breaks
// the name search — known-good TSDB soccer ids for those.
const META_OVERRIDES = {
  nottinghamforest: {
    id: '133720',
    badge: 'https://r2.thesportsdb.com/images/media/team/badge/sar2y41781740886.png',
  },
};

// Look a team up on TSDB and cache its id + badge.
async function fetchMeta(name) {
  const d = db();
  const key = norm(name);
  if (d.dynMeta[key] && d.dynMeta[key].id) return d.dynMeta[key];
  if (META_OVERRIDES[key]) {
    d.dynMeta[key] = { ...META_OVERRIDES[key] };
    store.save();
    return d.dynMeta[key];
  }
  const found = await tsdb(`searchteams.php?t=${encodeURIComponent(name)}`);
  const cands = ((found && found.teams) || []).filter((t) => t.strSport === 'Soccer');
  const team = cands.find((t) => norm(t.strTeam) === key) || cands[0];
  if (!team) return null;
  d.dynMeta[key] = { id: String(team.idTeam), badge: team.strBadge || null };
  store.save();
  return d.dynMeta[key];
}

// Fast pass: two calls per league (team search + recent results) yield most
// badges at once — every event carries both teams' badges and ids.
async function quickWarm() {
  const d = db();
  const wanted = new Map(); // norm(name) -> canonical name, still missing
  listSelectable().forEach((t) => {
    const k = norm(t.name);
    if (!d.dynMeta[k]) wanted.set(k, t.name);
  });
  if (!wanted.size) return;
  const put = (nameRaw, id, badge) => {
    if (!badge) return;
    const raw = norm(nameRaw);
    let key = wanted.has(raw) ? raw : null;
    if (!key && raw.length >= 7) {
      // spelling variants: 'FSV Mainz 05' vs 'Mainz 05', '1. FC Köln' vs 'FC Koln'
      for (const k of wanted.keys()) {
        if (k.length >= 7 && (raw.includes(k) || k.includes(raw))) {
          key = k;
          break;
        }
      }
    }
    if (!key) return;
    d.dynMeta[key] = { id: id ? String(id) : null, badge };
    wanted.delete(key);
  };
  for (const meta of Object.values(LEAGUE_META)) {
    const s = await tsdb(`search_all_teams.php?l=${encodeURIComponent(meta.name)}`);
    ((s && s.teams) || []).forEach((t) => put(t.strTeam, t.idTeam, t.strBadge));
    const ev = await tsdb(`eventspastleague.php?id=${meta.id}`);
    ((ev && ev.events) || []).forEach((e) => {
      put(e.strHomeTeam, e.idHomeTeam, e.strHomeTeamBadge);
      put(e.strAwayTeam, e.idAwayTeam, e.strAwayTeamBadge);
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
  store.save();
}

// Resolve every selectable team's badge: a quick league-by-league harvest
// first, then repeated sweeps over the stragglers. A sweep that resolves
// nothing means the free-tier rate limit kicked in — back off a minute and
// try again. Results persist, so this completes once and never runs again.
let warming = false;
async function warmBadges() {
  if (warming) return;
  warming = true;
  try {
    const d = db();
    await quickWarm();
    for (let sweep = 0; sweep < 20; sweep++) {
      const missing = listSelectable().filter((t) => !d.dynMeta[norm(t.name)]);
      if (!missing.length) break;
      let resolved = 0;
      for (const t of missing) {
        if (await fetchMeta(t.name)) resolved++;
        await new Promise((r) => setTimeout(r, 2600));
      }
      if (!resolved) await new Promise((r) => setTimeout(r, 60000));
    }
  } catch (err) {
    console.error('[dynteams] badge warm failed:', err.message);
  } finally {
    warming = false;
  }
}

// TSDB position text -> our position codes.
function mapPos(str) {
  const s = String(str || '').toLowerCase();
  if (/goal ?keeper/.test(s)) return 'GK';
  if (/right[- ]?(back|wing ?back)/.test(s)) return 'RB';
  if (/left[- ]?(back|wing ?back)/.test(s)) return 'LB';
  if (/centre[- ]?back|center[- ]?back|defender/.test(s)) return 'CB';
  if (/defensive mid/.test(s)) return 'CDM';
  if (/attacking mid/.test(s)) return 'CAM';
  if (/right (wing|mid)/.test(s)) return 'RW';
  if (/left (wing|mid)/.test(s)) return 'LW';
  if (/midfield/.test(s)) return 'CM';
  if (/centre[- ]?forward|center[- ]?forward|striker|forward/.test(s)) return 'ST';
  if (/wing/.test(s)) return 'RW';
  return 'CM';
}

const NATION_ISO = {
  england: 'EN', scotland: 'SCT', wales: 'GB', france: 'FR', spain: 'ES',
  germany: 'DE', italy: 'IT', portugal: 'PT', netherlands: 'NL', belgium: 'BE',
  brazil: 'BR', argentina: 'AR', uruguay: 'UY', colombia: 'CO', chile: 'CL',
  mexico: 'MX', 'united states': 'US', canada: 'CA', japan: 'JP',
  'south korea': 'KR', 'korea republic': 'KR', australia: 'AU', croatia: 'HR',
  serbia: 'RS', denmark: 'DK', sweden: 'SE', norway: 'NO', poland: 'PL',
  austria: 'AT', switzerland: 'CH', turkey: 'TR', morocco: 'MA', senegal: 'SN',
  nigeria: 'NG', ghana: 'GH', 'ivory coast': 'CI', cameroon: 'CM',
  egypt: 'EG', algeria: 'DZ', ecuador: 'EC', paraguay: 'PY',
};

// Wikipedia squad templates use IOC-style 3-letter nation codes.
const WIKI_NAT = {
  ENG: 'EN', SCO: 'SCT', WAL: 'GB', NIR: 'GB', IRL: 'IE', FRA: 'FR', ESP: 'ES',
  GER: 'DE', ITA: 'IT', POR: 'PT', NED: 'NL', BEL: 'BE', BRA: 'BR', ARG: 'AR',
  URU: 'UY', COL: 'CO', CHI: 'CL', MEX: 'MX', USA: 'US', CAN: 'CA', JPN: 'JP',
  KOR: 'KR', AUS: 'AU', CRO: 'HR', SRB: 'RS', DEN: 'DK', SWE: 'SE', NOR: 'NO',
  POL: 'PL', AUT: 'AT', SUI: 'CH', TUR: 'TR', MAR: 'MA', SEN: 'SN', NGA: 'NG',
  GHA: 'GH', CIV: 'CI', CMR: 'CM', EGY: 'EG', ALG: 'DZ', ECU: 'EC', PAR: 'PY',
  PER: 'PE', VEN: 'VE', BOL: 'BO', CZE: 'CZ', SVK: 'SK', UKR: 'UA', RUS: 'RU',
  ISL: 'IS', GRE: 'GR', HUN: 'HU', ROU: 'RO', BUL: 'BG', SVN: 'SI', BIH: 'BA',
  ALB: 'AL', MKD: 'MK', MNE: 'ME', KVX: 'XK', GEO: 'GE', ARM: 'AM', ISR: 'IL',
  IRN: 'IR', KSA: 'SA', QAT: 'QA', UAE: 'AE', TUN: 'TN', MLI: 'ML', BFA: 'BF',
  GAB: 'GA', COD: 'CD', CGO: 'CG', ANG: 'AO', MOZ: 'MZ', RSA: 'ZA', KEN: 'KE',
  ZIM: 'ZW', ZAM: 'ZM', CRC: 'CR', HON: 'HN', PAN: 'PA', JAM: 'JM', GUA: 'GT',
  TRI: 'TT', NZL: 'NZ', CHN: 'CN', THA: 'TH', VIE: 'VN', IDN: 'ID', MAS: 'MY',
  PHI: 'PH', IND: 'IN', UZB: 'UZ', KAZ: 'KZ', FIN: 'FI', EST: 'EE', LVA: 'LV',
  LTU: 'LT', CYP: 'CY', MLT: 'MT', LUX: 'LU', GNB: 'GW', GUI: 'GN', GAM: 'GM',
  TOG: 'TG', BEN: 'BJ', LBR: 'LR', SLE: 'SL', CPV: 'CV', MTN: 'MR', NIG: 'NE',
  TAN: 'TZ', UGA: 'UG', ETH: 'ET', DOM: 'DO', HAI: 'HT', CUB: 'CU', SUR: 'SR',
  GUY: 'GY', CUW: 'CW', SYR: 'SY', IRQ: 'IQ', JOR: 'JO', LIB: 'LB',
};

async function wikiApi(params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(WIKI + '?' + new URLSearchParams({ format: 'json', ...params }), {
      signal: ctl.signal,
      headers: { 'User-Agent': 'football-squad-game/1.0 (local dev)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// First {{fs start}}..{{fs end}} block = the current first-team squad (later
// blocks are "out on loan" / reserves). Rows: {name, line: GK|DF|MF|FW, nat}.
function parseSquadWikitext(wt) {
  let scope = wt;
  const start = wt.search(/\{\{fs start/i);
  if (start >= 0) {
    const end = wt.slice(start).search(/\{\{fs end/i);
    scope = end > 0 ? wt.slice(start, start + end) : wt.slice(start);
  }
  const rows = [...scope.matchAll(/\{\{(?:fs player|football squad player)\s*\|([^}]*)\}\}/gi)];
  const out = [];
  rows.forEach((m) => {
    // resolve [[A|B]] -> B BEFORE splitting params — piped links contain '|'
    // and a naive split leaves '[[A' fragments as names
    const body = m[1].replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
    const f = {};
    body.split('|').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) f[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
    });
    let name = String(f.name || '');
    name = name.replace(/[[\]]/g, ''); // belt & braces: never ship brackets
    name = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40) return;
    const posRaw = String(f.pos || '').toUpperCase();
    const line = /GK/.test(posRaw)
      ? 'GK'
      : /DF|DEF/.test(posRaw)
        ? 'DF'
        : /FW|FWD|ST/.test(posRaw)
          ? 'FW'
          : 'MF';
    out.push({ name, line, nat: WIKI_NAT[String(f.nat || '').toUpperCase()] || null });
  });
  return out;
}

// Resolve the club's Wikipedia article (many club names redirect straight to
// it; city-named clubs like "Santos" need the search fallback) and parse the
// full first-team squad out of it.
async function fetchWikiSquad(teamName) {
  const consider = (j) => {
    if (!j || !j.parse || !j.parse.wikitext) return null;
    const rows = parseSquadWikitext(j.parse.wikitext['*']);
    return rows.length >= 15 ? rows : null;
  };
  let best = consider(
    await wikiApi({ action: 'parse', page: teamName, prop: 'wikitext', redirects: 1 })
  );
  if (best) return best;
  const s = await wikiApi({
    action: 'query',
    list: 'search',
    srsearch: teamName + ' football club',
    srlimit: 4,
  });
  for (const hit of (s && s.query && s.query.search) || []) {
    await sleep(350); // stay well under the API's politeness limits
    best = consider(
      await wikiApi({ action: 'parse', page: hit.title, prop: 'wikitext', redirects: 1 })
    );
    if (best) return best;
  }
  return null;
}

const YOUTH_SURNAMES = [
  'Silva', 'Kim', 'Costa', 'Weber', 'Rossi', 'Dubois', 'Sato', 'Mensah',
  'Diaz', 'Kovac', 'Ivanov', 'Berg', 'Fischer', 'Moreau', 'Santos', 'Novak',
];

// Arrange a fetched squad into starting-XI order (GK, RB, CB, CB, LB, CM,
// CM, CM, RW, ST, LW) plus bench; the free API caps rosters at 10 players,
// so uncovered slots get generated youth academy players.
function arrangeRoster(list, baseOvr) {
  const used = new Set();
  let youthN = 0;
  const youth = (pos) => {
    youthN++;
    const nm = 'Y. ' + YOUTH_SURNAMES[(youthN * 5 + pos.length) % YOUTH_SURNAMES.length];
    return {
      name: nm,
      pos,
      ovr: Math.max(52, baseOvr - 5 - Math.floor(Math.random() * 4)),
      nation: null,
      img: null,
      youth: true,
    };
  };
  const take = (wanted, slotPos) => {
    let p = list.find((c) => !used.has(c) && wanted.includes(c.pos));
    // GK is a hard requirement; other slots can borrow any outfielder
    if (!p && slotPos !== 'GK') p = list.find((c) => !used.has(c) && c.pos !== 'GK');
    if (!p) return youth(slotPos);
    used.add(p);
    return p;
  };
  const xi = [
    take(['GK'], 'GK'),
    take(['RB'], 'RB'),
    take(['CB'], 'CB'),
    take(['CB'], 'CB'),
    take(['LB'], 'LB'),
    take(['CDM', 'CM'], 'CM'),
    take(['CM', 'CAM'], 'CM'),
    take(['CAM', 'CM', 'CDM'], 'CM'),
    take(['RW'], 'RW'),
    take(['ST'], 'ST'),
    take(['LW'], 'LW'),
  ];
  // keep the whole squad on the bench (a full Wikipedia squad is 20~30)
  const bench = list.filter((p) => !used.has(p)).slice(0, 19);
  while (xi.length + bench.length < 14) bench.push(youth(['GK', 'CB', 'CM', 'ST'][bench.length % 4]));
  return [...xi, ...bench];
}

// TSDB roster lookup: at most 10 rows on the free tier, but they carry
// granular positions and cutout images. Staff rows (the manager shows up in
// the player list!) are dropped.
const STAFF_RE = /manager|coach|assistant|goalkeeping|fitness|scout|director|physio|analyst|chairman|president/i;

async function fetchTsdbPlayers(teamId) {
  const data = await tsdb(`lookup_all_players.php?id=${teamId}`);
  return ((data && data.player) || [])
    .filter(
      (p) => p.strSport === 'Soccer' && p.strPlayer && !STAFF_RE.test(String(p.strPosition || ''))
    )
    .map((p) => ({
      name: p.strPlayer,
      pos: mapPos(p.strPosition),
      nation: NATION_ISO[String(p.strNationality || '').toLowerCase()] || null,
      // cutouts only: thumbs are photos with backgrounds, which never fit the
      // transparent upper-body framing of the cards
      img: p.strCutout || null,
    }));
}

// ---------------------------------------------------------------------------
// Dynamic player images: remote cutouts are downloaded once into
// frontend/img/players/dyn/ and cropped to the same upper-body framing the
// curated players use (scripts/crop-upper-body.py), so every card shares the
// same proportions. Failures just keep the remote URL (client CSS covers it).
// ---------------------------------------------------------------------------

const DYN_IMG_DIR = path.join(__dirname, '..', '..', 'frontend', 'img', 'players', 'dyn');
const CROP_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'crop-upper-body.py');
const IMG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0';

// ---- per-player image search (fallback for the team-lookup 10-player cap) --

function nameTokens(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort();
}

// target ⊆ candidate ("Richarlison" in "Richarlison de Andrade"); mononyms
// must match exactly — a bare "André" must not pick some "André Silva" render
function nameMatches(target, cand) {
  const ta = nameTokens(target);
  const tb = nameTokens(cand);
  if (!ta.length) return false;
  if (ta.length === 1) return tb.length === 1 && ta[0] === tb[0];
  const set = new Set(tb);
  return ta.every((t) => set.has(t));
}

let lastFooty = 0;
async function footySearchUrl(name) {
  const wait = lastFooty + 700 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFooty = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`https://www.footyrenders.com/?s=${encodeURIComponent(name)}`, {
      signal: ctl.signal,
      headers: { 'User-Agent': IMG_UA },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const decode = (s) =>
      s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
    const imgs = [...html.matchAll(/<img[^>]*>/g)]
      .map((m) => {
        const src = (m[0].match(/src="(https:\/\/www\.footyrenders\.com\/render\/[^"]+)"/) || [])[1];
        const alt = (m[0].match(/alt="([^"]*)"/) || [])[1];
        return src && alt ? { src, alt: decode(alt).replace(/football render/i, '').trim() } : null;
      })
      .filter(Boolean)
      // group renders list several names — never use those for a single player
      .filter((i) => !/[,&]/.test(i.alt));
    const pick = imgs.find((i) => nameMatches(i.alt, name)) || imgs.find((i) => nameMatches(name, i.alt));
    return pick ? pick.src.replace(/-\d+x\d+\.png$/, '.png') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tsdbCutoutSearch(name) {
  const data = await tsdb(`searchplayers.php?p=${encodeURIComponent(name)}`);
  const list = ((data && data.player) || []).filter((p) => p.strSport === 'Soccer');
  const cand = list.find((p) => p.strCutout && nameMatches(name, p.strPlayer));
  if (cand) return cand.strCutout;
  // mononym rescue ("Reinildo" -> "Reinildo Mandava"): only when the token
  // identifies exactly one player overall — common surnames stay ambiguous
  const tokens = nameTokens(name);
  if (tokens.length === 1) {
    const loose = list.filter((p) => nameTokens(p.strPlayer).includes(tokens[0]));
    if (loose.length === 1 && loose[0].strCutout) return loose[0].strCutout;
  }
  return null;
}

async function downloadTo(url, file) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return false; // error page / empty
    fs.writeFileSync(file, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function cropDir(dir) {
  return new Promise((resolve) => {
    execFile('python3', [CROP_SCRIPT, dir], { timeout: 60000 }, (err) => resolve(!err));
  });
}

// Localize every roster image. Rows that came without a cutout (the team
// lookup caps at 10 players) get a per-name search: footyrenders render
// first, TSDB cutout second. row.imgTried marks exhausted searches so boots
// don't re-hammer the APIs for players that simply have no image anywhere.
async function cacheDynImages(def) {
  fs.mkdirSync(DYN_IMG_DIR, { recursive: true });
  let changed = false;
  for (const row of def.players) {
    if (row.youth) continue;
    if (row.img && String(row.img).startsWith('/img/')) continue; // done
    const slug = norm(row.name).slice(0, 40) || 'p';
    const file = `${def.teamId}-${slug}.png`;
    const abs = path.join(DYN_IMG_DIR, file);
    if (fs.existsSync(abs)) {
      row.img = `/img/players/dyn/${file}`;
      changed = true;
      continue;
    }
    let url = row.img && /^https?:/.test(row.img) ? row.img : null;
    if (!url) {
      if (row.imgTried) continue; // searched before — nothing out there
      url = await footySearchUrl(row.name);
      if (!url) {
        await sleep(2100); // TSDB free tier: ~30 req/min
        url = await tsdbCutoutSearch(row.name).catch(() => null);
      }
      row.imgTried = true;
      changed = true; // persist the attempt even when it found nothing
    }
    if (url && (await downloadTo(url, abs))) {
      row.img = `/img/players/dyn/${file}`;
    }
    await sleep(250); // pace the image hosts
  }
  if (!changed) return;
  await cropDir(DYN_IMG_DIR); // idempotent: already-upper images pass through
  store.save(); // def rows live inside db.dynRosters
  players.registerDynamicTeam({ ...def, replace: true }); // push imgs into CATALOG
}

// Boot-time pass: finish the image hunt for every cached roster that still
// has unsearched players (one long background walk, heavily paced).
async function warmDynImages() {
  for (const def of Object.values(db().dynRosters)) {
    const pending = def.players.some(
      (p) => !p.youth && !(p.img && String(p.img).startsWith('/img/')) && !p.imgTried
    );
    if (!pending) continue;
    try {
      await cacheDynImages(def);
      const got = def.players.filter((p) => p.img && String(p.img).startsWith('/img/')).length;
      console.log(`[dynteams] images warmed: ${def.name} (${got}/${def.players.filter((p) => !p.youth).length})`);
    } catch (err) {
      console.error('[dynteams] image warm failed:', def.name, err.message);
    }
  }
}

// Build a v2 roster def: full Wikipedia squad merged with TSDB details.
async function buildRosterDef(teamName, meta, league) {
  const base = LEAGUE_BASE_OVR[league] || 70;
  const rollOvr = () => Math.max(55, Math.min(86, Math.round(base + (Math.random() * 10 - 5))));
  const tsdbList = await fetchTsdbPlayers(meta.id);
  const wiki = await fetchWikiSquad(teamName);

  let list;
  if (wiki && wiki.length) {
    // coarse Wikipedia lines spread across concrete positions round-robin
    const CYCLES = { DF: ['CB', 'CB', 'RB', 'LB'], MF: ['CM', 'CM', 'CDM', 'CAM'], FW: ['ST', 'RW', 'LW'] };
    const cycleN = { DF: 0, MF: 0, FW: 0 };
    const byKey = new Map(tsdbList.map((p) => [norm(p.name), p]));
    list = wiki.slice(0, 30).map((w) => {
      const t = byKey.get(norm(w.name)); // TSDB match: real position + cutout
      const pos = t ? t.pos : w.line === 'GK' ? 'GK' : CYCLES[w.line][cycleN[w.line]++ % CYCLES[w.line].length];
      return {
        name: w.name,
        pos,
        ovr: rollOvr(),
        nation: w.nat || (t && t.nation) || null,
        img: (t && t.img) || null,
      };
    });
    // TSDB players missing from the parsed squad still make the roster
    const listed = new Set(list.map((r) => norm(r.name)));
    tsdbList.forEach((t) => {
      if (!listed.has(norm(t.name))) list.push({ ...t, ovr: rollOvr() });
    });
  } else {
    // Wikipedia miss: old behaviour (TSDB 10 + youth fillers)
    list = tsdbList.map((t) => ({ ...t, ovr: rollOvr() }));
  }

  return {
    teamId: meta.id,
    name: teamName,
    league,
    logo: meta.badge || null,
    v: ROSTER_V,
    players: arrangeRoster(list, base).slice(0, 30),
  };
}

// Fetch (or restore) a club's roster and register it as a playable team.
// Cached rosters from before ROSTER_V are re-fetched (fuller squads); if the
// re-fetch fails the stale roster keeps working. Returns the team name.
async function ensureRoster(teamName) {
  const key = norm(teamName);
  const league = LEAGUE_OF[key];
  if (!league) throw new Error('not a selectable league team: ' + teamName);
  const d = db();
  let def = d.dynRosters[key];
  if (!def || def.v !== ROSTER_V) {
    try {
      const meta = await fetchMeta(teamName);
      if (!meta) throw new Error('team lookup failed: ' + teamName);
      def = await buildRosterDef(teamName, meta, league);
      d.dynRosters[key] = def;
      store.save();
      // localize + upper-body-crop the cutouts in the background
      cacheDynImages(def).catch((err) =>
        console.error('[dynteams] image cache failed:', teamName, err.message)
      );
    } catch (err) {
      if (!def) throw err;
      console.error('[dynteams] roster refresh failed, keeping stale:', teamName, err.message);
    }
  }
  players.registerDynamicTeam({ ...def, replace: true });
  return def.name;
}

// Boot-time pass: re-fetch every cached roster from before ROSTER_V and top
// up the rosters of users based at those clubs with the newly added players.
async function refreshRosters() {
  const d = db();
  const stale = Object.values(d.dynRosters).filter((def) => def.v !== ROSTER_V);
  for (const old of stale) {
    try {
      const name = await ensureRoster(old.name);
      const team = players.TEAMS[name];
      if (team) {
        Object.values(store.get().users).forEach((u) => {
          if (u.baseTeam !== name) return;
          const ownedSet = new Set(u.owned);
          team.playerIds.forEach((id) => {
            if (!ownedSet.has(id)) u.owned.push(id);
          });
          store.putUser(u);
        });
      }
      console.log(`[dynteams] roster refreshed: ${name} (${(players.TEAMS[name] || {}).playerIds.length}명)`);
    } catch (err) {
      console.error('[dynteams] roster refresh failed:', old.name, err.message);
    }
    await sleep(1500); // pace the external APIs
  }
}

// Search the external player DB (누락 선수 대응: 최근 이적 등 큐레이션에 없는
// 선수를 찾아 구매 가능하게 등록). OVR is estimated from the player's club.
async function searchPlayersRemote(q) {
  const data = await tsdb(`searchplayers.php?p=${encodeURIComponent(q)}`);
  const raw = ((data && data.player) || []).filter(
    (p) => p.strSport === 'Soccer' && p.strPlayer && p.idPlayer
  );
  const d = db();
  if (!d.dynPlayers) d.dynPlayers = {};
  const out = [];
  const CURATED_BASE = { manchesterunited: 80, tottenhamhotspur: 79 };
  for (const p of raw.slice(0, 8)) {
    const id = 's' + p.idPlayer;
    if (!players.getPlayer(id)) {
      const teamKey = norm(p.strTeam);
      const lgKey = LEAGUE_OF[teamKey];
      const base =
        (lgKey && LEAGUE_BASE_OVR[lgKey]) || CURATED_BASE[teamKey] || (CURATED_SET_HAS(teamKey) ? 80 : 73);
      const def = {
        tsdbId: String(p.idPlayer),
        name: p.strPlayer,
        pos: mapPos(p.strPosition),
        ovr: Math.max(58, Math.min(88, Math.round(base + 2 + (Math.random() * 8 - 4)))),
        nation: NATION_ISO[String(p.strNationality || '').toLowerCase()] || null,
        img: p.strCutout || p.strThumb || null,
        team: p.strTeam || null,
      };
      d.dynPlayers[def.tsdbId] = def;
      store.save();
      players.registerSoloPlayer(def);
    }
    out.push(players.publicPlayer(id));
  }
  return out.filter(Boolean);
}

// curated clubs known to the game (players from them rate higher)
const CURATED_NAMES = [
  'Man City', 'Manchester City', 'Real Madrid', 'Bayern Munich', 'Paris SG',
  'Paris Saint-Germain', 'Liverpool', 'Inter Miami', 'Arsenal', 'Chelsea',
  'Man United', 'Manchester United', 'Barcelona', 'Atletico Madrid',
  'Inter Milan', 'AC Milan', 'Napoli', 'Al-Nassr', 'Borussia Dortmund', 'LAFC',
].map((n) => norm(n));
function CURATED_SET_HAS(key) {
  return CURATED_NAMES.includes(key);
}

// Repo-shipped badge/id seed: fresh deploys (empty db) get every league
// club's TSDB id + local badge instantly, instead of re-warming 142 teams
// through the rate-limited API on every boot.
function seedMeta() {
  let seed;
  try {
    seed = require('./dynmeta-seed.json');
  } catch {
    return;
  }
  const d = db();
  let n = 0;
  Object.entries(seed).forEach(([key, m]) => {
    const cur = d.dynMeta[key];
    // fill gaps; also swap a remote badge URL for the bundled local file
    if (!cur || (!cur.badge && m.badge) || (m.badge && String(m.badge).startsWith('/img/') && cur.badge && /^https?:/.test(cur.badge))) {
      d.dynMeta[key] = { ...cur, ...m };
      n++;
    }
  });
  if (n) store.save();
}

// Re-register persisted dynamic teams/players after a server restart, so the
// ids the users own keep resolving.
function restore() {
  seedMeta();
  const d = db();
  Object.values(d.dynRosters).forEach((def) => {
    try {
      players.registerDynamicTeam(def);
    } catch (err) {
      console.error('[dynteams] restore failed for', def.name, err.message);
    }
  });
  Object.values(d.dynPlayers || {}).forEach((def) => {
    try {
      players.registerSoloPlayer(def);
    } catch (err) {
      console.error('[dynteams] player restore failed for', def.name, err.message);
    }
  });
}

module.exports = {
  listSelectable,
  ensureRoster,
  restore,
  refreshRosters,
  warmDynImages,
  warmBadges,
  searchPlayersRemote,
};
