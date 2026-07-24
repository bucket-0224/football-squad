'use strict';

// Warms every dynamic (non-curated) team's roster cache on a running
// backend via the admin API — populates dynRosters (and therefore the
// OVR shown in /api/leagueteams) without creating a throwaway user
// account per team, unlike scripts/seed-team-accounts.js.
//
//   node scripts/warm-team-ovrs.js --base <api-base> --key <ADMIN_KEY>
//
// Runs strictly sequentially with a pause between calls — each call's
// own roster fetch already paces its background image-caching walk, but
// spacing the calls out keeps overlapping walks (and load on
// TheSportsDB/Wikipedia) low.

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i !== -1 ? process.argv[i + 1] : 'http://localhost:3000';
})();
const ADMIN_KEY = (() => {
  const i = process.argv.indexOf('--key');
  return i !== -1 ? process.argv[i + 1] : process.env.ADMIN_KEY;
})();
const DELAY_MS = 2500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function warmTeam(team) {
  const res = await fetch(`${BASE}/api/admin/warm-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ team }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  if (!ADMIN_KEY) {
    console.error('[warm] missing --key (or ADMIN_KEY env var)');
    process.exit(1);
  }
  const [leagueTeams, current] = await Promise.all([
    fetchJson(`${BASE}/api/leagueteams`),
    fetchJson(`${BASE}/api/leagueteams`),
  ]);
  const already = new Set(current.teams.filter((t) => t.ovr != null).map((t) => t.name));
  const targets = leagueTeams.teams.filter((t) => !already.has(t.name));

  console.log(`[warm] ${leagueTeams.teams.length} dynamic teams total, ${already.size} already warmed, ${targets.length} to go`);

  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const team = targets[i].name;
    const tag = `[${i + 1}/${targets.length}] ${team}`;
    try {
      const { ok, status, body } = await warmTeam(team);
      if (ok) {
        okCount++;
        console.log(`${tag} -> OK`);
      } else {
        failCount++;
        console.log(`${tag} -> FAILED (${status}) ${body.error || ''}`);
      }
    } catch (err) {
      failCount++;
      console.log(`${tag} -> ERROR ${err.message}`);
    }
    if (i < targets.length - 1) await sleep(DELAY_MS);
  }
  console.log(`[warm] done. ok=${okCount} fail=${failCount}`);
}

main().catch((err) => {
  console.error('[warm] fatal:', err);
  process.exit(1);
});
