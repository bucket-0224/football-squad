'use strict';

// Registers one throwaway account per existing team (curated + dynamic
// league teams) against a running backend, purely as a way to trigger real
// registration for every team in the system:
//   - each team's roster gets pulled into the catalog (players.registerDynamicTeam)
//   - each player's OVR gets computed once at that point (rollOvr in dynteams.js)
//   - each dynamic team's images start downloading to frontend/public/img/players/dyn/
//     in the background (dynteams.js's cacheDynImages, already rate-limited)
//
//   node scripts/seed-team-accounts.js [--base http://localhost:3000]
//
// Registrations run strictly sequentially (one at a time, awaited) with a
// pause between each — dynamic teams' image warming is fire-and-forgotten
// per-registration inside the backend, so spacing registrations out keeps
// the number of overlapping background image-fetch walks (and the load on
// TheSportsDB/Wikipedia) low instead of firing 200 at once.

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i !== -1 ? process.argv[i + 1] : 'http://localhost:3000';
})();
const DELAY_MS = 3000;
const PASSWORD = 'seedseed1234';

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20) || 'team';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function registerFor(team) {
  const username = ('seed_' + slugify(team)).slice(0, 16);
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      clubName: `${team} Seed`,
      team,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const [bootstrap, leagueTeams] = await Promise.all([
    fetchJson(`${BASE}/api/bootstrap`),
    fetchJson(`${BASE}/api/leagueteams`),
  ]);
  const curated = bootstrap.teams.map((t) => t.name);
  const dynamic = leagueTeams.teams.map((t) => t.name);
  const all = [...curated, ...dynamic];

  console.log(`[seed] ${curated.length} curated + ${dynamic.length} dynamic = ${all.length} teams total`);

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < all.length; i++) {
    const team = all[i];
    const tag = `[${i + 1}/${all.length}] ${team}`;
    try {
      const { ok, status, body } = await registerFor(team);
      if (ok) {
        okCount++;
        console.log(`${tag} -> OK (OVR ${body.user?.ratings?.OVR ?? '?'}, ${body.user?.owned?.length ?? 0} players)`);
      } else if (status === 409) {
        skipCount++;
        console.log(`${tag} -> already registered, skipping`);
      } else {
        failCount++;
        console.log(`${tag} -> FAILED (${status}) ${body.error || ''}`);
      }
    } catch (err) {
      failCount++;
      console.log(`${tag} -> ERROR ${err.message}`);
    }
    if (i < all.length - 1) await sleep(DELAY_MS);
  }

  console.log(`[seed] done. ok=${okCount} skip=${skipCount} fail=${failCount}`);
}

main().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
