'use strict';

// Downloads transparent player images into frontend/img/players/.
//
//   node scripts/fetch-player-images.js [--force]
//
// Source priority per player:
//  1. footyrenders.com — transparent full/upper-body renders in current kit.
//  2. TheSportsDB "cutout" — transparent upper-body photo.
//  3. Hand-verified sofifa.net ids (retired icons).
//  4. FotMob headshot (face only) as a last resort.
// A candidate only matches when its name tokens match the catalog name
// (small typo tolerance for accent spellings like Håland/Haaland), so
// common-name collisions fall back to the next source instead of silently
// using the wrong player.
//
// Images are for local/personal use only.

const fs = require('fs');
const path = require('path');
const players = require('../backend/data/players');

const OUT_DIR = path.join(__dirname, '..', 'frontend', 'img', 'players');
const FORCE = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0';
const FOOTY_DELAY_MS = 700;
const TSDB_DELAY_MS = 2100; // free-tier API allows ~30 req/min

// ---- name normalization ----------------------------------------------------

function normTokens(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o') // ø/đ/ß don't decompose via NFD
    .replace(/đ/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/['’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort();
}

function editDistance1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  // single substitution
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff <= 1;
  }
  // single insertion/deletion
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let used = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (!used) {
      used = true;
      j++;
    } else {
      return false;
    }
  }
  return true;
}

function tokenMatches(t, candTokens) {
  return candTokens.some((c) => (t.length >= 5 ? editDistance1(t, c) : t === c));
}

// exact: same token multiset (with typo tolerance)
function namesEqual(target, cand) {
  const ta = normTokens(target);
  const tb = normTokens(cand);
  return ta.length === tb.length && ta.every((t) => tokenMatches(t, tb));
}

// loose: target tokens all appear in candidate ("Alisson" in "Alisson Becker")
function namesSubset(target, cand) {
  const ta = normTokens(target);
  const tb = normTokens(cand);
  return ta.every((t) => tokenMatches(t, tb));
}

// ---- aliases / overrides ---------------------------------------------------

// Catalog name -> the name render/photo sites actually use.
const SEARCH_ALIAS = {
  'Mark Delgado': 'Marky Delgado', // TSDB spelling
  'Vinicius Jr': 'Vinicius Junior',
  'Neymar Jr': 'Neymar',
  'N Golo Kante': "N'Golo Kante",
  'Rodri': 'Rodrigo Hernandez',
  'Zidane (Icon)': 'Zinedine Zidane',
  'Maradona (Icon)': 'Diego Maradona',
  'Pele (Icon)': 'Pele',
  'Ronaldo R9 (Icon)': 'Ronaldo Nazario',
  // 레전드 아이콘 배치 — 실제 렌더/사진 검색용 이름으로 "(Icon)" 접미사만 벗김
  // (Cristiano Ronaldo/Luka Modric는 현역 로스터 사진을 IMG_ALIAS로 재사용하므로 제외)
  'Ronaldinho (Icon)': 'Ronaldinho',
  'Andres Iniesta (Icon)': 'Andres Iniesta',
  'Xavi Hernandez (Icon)': 'Xavi',
  'Andrea Pirlo (Icon)': 'Andrea Pirlo',
  'Paolo Maldini (Icon)': 'Paolo Maldini',
  'Franco Baresi (Icon)': 'Franco Baresi',
  'Franz Beckenbauer (Icon)': 'Franz Beckenbauer',
  'Johan Cruyff (Icon)': 'Johan Cruyff',
  'Eusebio (Icon)': 'Eusebio',
  'Alfredo Di Stefano (Icon)': 'Alfredo Di Stefano',
  'Ferenc Puskas (Icon)': 'Ferenc Puskas',
  'Garrincha (Icon)': 'Garrincha',
  'Zico (Icon)': 'Zico',
  'Romario (Icon)': 'Romario',
  'Cafu (Icon)': 'Cafu',
  'Roberto Carlos (Icon)': 'Roberto Carlos',
  'Marcelo (Icon)': 'Marcelo',
  'Philipp Lahm (Icon)': 'Philipp Lahm',
  'Fabio Cannavaro (Icon)': 'Fabio Cannavaro',
  'Rio Ferdinand (Icon)': 'Rio Ferdinand',
  'John Terry (Icon)': 'John Terry',
  'Vincent Kompany (Icon)': 'Vincent Kompany',
  'Steven Gerrard (Icon)': 'Steven Gerrard',
  'Frank Lampard (Icon)': 'Frank Lampard',
  'Patrick Vieira (Icon)': 'Patrick Vieira',
  'Michael Ballack (Icon)': 'Michael Ballack',
  'Xabi Alonso (Icon)': 'Xabi Alonso',
  'David Beckham (Icon)': 'David Beckham',
  'Thierry Henry (Icon)': 'Thierry Henry',
  'Didier Drogba (Icon)': 'Didier Drogba',
  'Samuel Eto o (Icon)': "Samuel Eto'o",
  'Wayne Rooney (Icon)': 'Wayne Rooney',
  'Robin van Persie (Icon)': 'Robin van Persie',
  'Ruud van Nistelrooy (Icon)': 'Ruud van Nistelrooy',
  'Gabriel Batistuta (Icon)': 'Gabriel Batistuta',
  'David Villa (Icon)': 'David Villa',
  'Alessandro Del Piero (Icon)': 'Alessandro Del Piero',
  'Francesco Totti (Icon)': 'Francesco Totti',
  'Raul Gonzalez (Icon)': 'Raul',
  'Kaka (Icon)': 'Kaka',
  'Michael Owen (Icon)': 'Michael Owen',
  'Gianluigi Buffon (Icon)': 'Gianluigi Buffon',
  'Iker Casillas (Icon)': 'Iker Casillas',
  'Peter Schmeichel (Icon)': 'Peter Schmeichel',
  'Oliver Kahn (Icon)': 'Oliver Kahn',
};

// Hand-picked image URLs (e.g. a more dynamic render than the newest one, or
// an individual shot where footyrenders only has a group render). Checked
// before every other source.
const IMAGE_OVERRIDES = {
  'Jude Bellingham': 'https://www.footyrenders.com/render/jude-bellingham-53.png',
  'Nico Williams': 'https://www.footyrenders.com/render/nico-williams-2.png',
  'Goncalo Inacio': 'https://r2.thesportsdb.com/images/media/player/cutout/m00erp1762291029.png',
  // newest Gakpo render is an arm-in-the-air pose that crops badly
  'Cody Gakpo': 'https://www.footyrenders.com/render/cody-gakpo-7.png',
  // neither footyrenders nor the name-search TSDB/sofifa/fotmob lookups below
  // resolve these two (Eusebio's plain-name search collides with an unrelated
  // active player; Baresi has no footyrenders page) — verified TSDB ids
  // (Eusébio 34168257, Franco Baresi 34167230) plugged in directly instead.
  'Eusebio (Icon)': 'https://r2.thesportsdb.com/images/media/player/cutout/07nrh61594070570.png',
  'Franco Baresi (Icon)': 'https://r2.thesportsdb.com/images/media/player/thumb/zvrjkx1558781898.jpg',
};

// Direct TheSportsDB player ids where search can't find them.
const TSDB_IDS = {
  'Pele (Icon)': 34164201,
  'Maradona (Icon)': 34162040,
};

// Players FotMob suggest can't resolve correctly: [sofifaId, fifaVersion].
const SOFIFA_OVERRIDES = {
  'Ronaldo R9 (Icon)': [37576, 24],
  'Zidane (Icon)': [1397, 23],
  'Pele (Icon)': [237067, 24],
  'Maradona (Icon)': [190042, 21],
  'Danilo': [199304, 24],
};

const FOTMOB_ALIAS = {
  'Vinicius Jr': 'Vinicius Junior',
  'Neymar Jr': 'Neymar',
  'N Golo Kante': "N'Golo Kante",
  'Alisson': 'Alisson Becker',
  'Gabriel Magalhaes': 'Gabriel', // FotMob mononym for the Arsenal CB
};

// ---- http helpers ----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) return false; // error pages / empty placeholders
  fs.writeFileSync(file, buf);
  return true;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

// ---- footyrenders ----------------------------------------------------------

let lastFooty = 0;
async function footyRenderUrl(name) {
  const target = SEARCH_ALIAS[name] || name;
  const wait = lastFooty + FOOTY_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastFooty = Date.now();

  const html = await getText(
    `https://www.footyrenders.com/?s=${encodeURIComponent(target)}`
  );
  // thumbnails: <img ... src=".../render/slug-N-WxH.png" ... alt="Name football render">
  const imgs = [...html.matchAll(/<img[^>]*>/g)]
    .map((m) => {
      const tag = m[0];
      const src = (tag.match(/src="(https:\/\/www\.footyrenders\.com\/render\/[^"]+)"/) || [])[1];
      const alt = (tag.match(/alt="([^"]*)"/) || [])[1];
      return src && alt ? { src, alt: decodeEntities(alt).replace(/football render/i, '').trim() } : null;
    })
    .filter(Boolean)
    // group renders list several names — never use those for a single player
    .filter((i) => !/[,&]/.test(i.alt));

  // Prefer an exact name match; fall back to "target tokens ⊆ render name".
  const pick =
    imgs.find((i) => namesEqual(target, i.alt)) ||
    imgs.find((i) => namesSubset(target, i.alt));
  if (!pick) return null;
  // strip the -WxH thumbnail suffix for the full-size render
  return pick.src.replace(/-\d+x\d+\.png$/, '.png');
}

// ---- TheSportsDB cutouts ---------------------------------------------------

let lastTsdb = 0;
async function tsdbGet(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastTsdb + TSDB_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastTsdb = Date.now();
    try {
      return await getJson(url);
    } catch (err) {
      if (!/429/.test(err.message)) throw err;
      await sleep(10000);
    }
  }
  throw new Error('rate limited');
}

async function tsdbCutoutUrl(name) {
  if (TSDB_IDS[name]) {
    const d = await tsdbGet(
      `https://www.thesportsdb.com/api/v1/json/3/lookupplayer.php?id=${TSDB_IDS[name]}`
    );
    const p = (d.players || d.player || [])[0];
    return (p && p.strCutout) || null;
  }
  const target = SEARCH_ALIAS[name] || name;
  const d = await tsdbGet(
    `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(target)}`
  );
  const cands = (d.player || []).filter(
    (p) => p.strSport === 'Soccer' && p.strCutout && namesSubset(target, p.strPlayer)
  );
  return cands.length ? cands[0].strCutout : null;
}

// ---- FotMob headshots (last resort) ----------------------------------------

async function fotmobFindIds(name) {
  const target = FOTMOB_ALIAS[name] || name;
  const tokens = target.split(/\s+/);
  const terms = [...new Set([target, tokens[tokens.length - 1], tokens[0]])].filter(
    (t) => t.length >= 3
  );
  const byId = new Map();
  for (const term of terms) {
    let data;
    try {
      data = await getJson(
        `https://apigw.fotmob.com/searchapi/suggest?term=${encodeURIComponent(term)}&lang=en`
      );
    } catch {
      continue;
    }
    const options = (data.squadMemberSuggest || []).flatMap((g) => g.options || []);
    options
      .filter((o) => o.text && namesEqual(target, o.text.split('|')[0]))
      .forEach((o) => {
        const id = o.text.split('|')[1];
        byId.set(id, Math.max(byId.get(id) || 0, o.score || 0));
      });
  }
  return [...byId.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ---- per-player pipeline ---------------------------------------------------

async function fetchOne(name, slug) {
  const file = path.join(OUT_DIR, slug + '.png');
  if (!FORCE && fs.existsSync(file)) return 'cached';

  // 0. hand-picked override
  if (IMAGE_OVERRIDES[name] && (await download(IMAGE_OVERRIDES[name], file))) {
    return 'render';
  }

  // 1. footyrenders full-body render
  try {
    const url = await footyRenderUrl(name);
    if (url && (await download(url, file))) return 'render';
  } catch {
    /* fall through */
  }

  // 2. TheSportsDB upper-body cutout
  try {
    const cutout = await tsdbCutoutUrl(name);
    if (cutout && (await download(cutout, file))) return 'cutout';
  } catch {
    /* fall through */
  }

  // 3. verified sofifa face
  const icon = SOFIFA_OVERRIDES[name];
  if (icon) {
    const [id, ver] = icon;
    const padded = String(id).padStart(6, '0');
    const url = `https://cdn.sofifa.net/players/${padded.slice(0, 3)}/${padded.slice(3)}/${ver}_240.png`;
    if (await download(url, file)) return 'face';
  }

  // 4. fotmob face
  const ids = await fotmobFindIds(name);
  for (const id of ids.slice(0, 4)) {
    const url = `https://images.fotmob.com/image_resources/playerimages/${id}.png`;
    if (await download(url, file)) return 'face';
  }
  return 'missing';
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const bySlug = new Map();
  Object.values(players.CATALOG).forEach((p) => {
    bySlug.set(players.imageSlug(p.name), players.canonicalImageName(p.name));
  });

  console.log(`fetching ${bySlug.size} unique player images -> ${OUT_DIR}`);
  const counts = { render: 0, cutout: 0, face: 0, cached: 0, missing: 0 };
  const notRender = [];

  let n = 0;
  for (const [slug, name] of bySlug.entries()) {
    try {
      const r = await fetchOne(name, slug);
      counts[r]++;
      if (r === 'cutout' || r === 'face') notRender.push(`${name} (${r})`);
      if (r === 'missing') notRender.push(`${name} (MISSING)`);
    } catch (err) {
      counts.missing++;
      notRender.push(`${name} (${err.message})`);
    }
    if (++n % 20 === 0) console.log('  ...', n, counts);
  }

  console.log('done:', counts);
  if (notRender.length) console.log('not full renders:\n  ' + notRender.sort().join('\n  '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
