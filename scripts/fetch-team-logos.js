'use strict';

// Downloads team logos (transparent PNG) into frontend/img/teams/.
//
//   node scripts/fetch-team-logos.js [--force]
//
// FotMob team ids verified via their suggest API. Images are for
// local/personal use only.

const fs = require('fs');
const path = require('path');
const players = require('../backend/data/players');

const OUT_DIR = path.join(__dirname, '..', 'frontend', 'public', 'img', 'teams');
const FORCE = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Catalog team name -> FotMob team id.
const TEAM_IDS = {
  'Man City': 8456,
  'Real Madrid': 8633,
  'Bayern Munich': 9823,
  'Paris SG': 9847,
  'Liverpool': 8650,
  'Inter Miami': 960720,
  'Arsenal': 9825,
  'Chelsea': 8455,
  'Man United': 10260,
  'Barcelona': 8634,
  'Atletico Madrid': 9906,
  'Inter Milan': 8636,
  'AC Milan': 8564,
  'Napoli': 9875,
  'Al-Nassr': 101918,
  'LAFC': 867280,
  'Dortmund': 9789,
  'France': 6723,
  'Argentina': 6706,
  'Brazil': 8256,
  'England': 8491,
  'Portugal': 8361,
  'Korea Republic': 7804,
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  const missing = [];

  for (const [name, id] of Object.entries(TEAM_IDS)) {
    const file = path.join(OUT_DIR, players.imageSlug(name) + '.png');
    if (!FORCE && fs.existsSync(file)) {
      ok++;
      continue;
    }
    const url = `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.length < 500) throw new Error(`HTTP ${res.status} / ${buf.length}B`);
      fs.writeFileSync(file, buf);
      ok++;
      console.log('ok', name);
    } catch (err) {
      missing.push(`${name} (${err.message})`);
    }
  }

  console.log(`done: ${ok}/${Object.keys(TEAM_IDS).length}`);
  if (missing.length) missing.forEach((m) => console.log('missing:', m));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
