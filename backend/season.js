'use strict';

const store = require('./store');

const SEASON_MS = 30 * 24 * 60 * 60 * 1000; // 30 realtime days
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly rollover check

// Snapshot the top finishers before a season resets, for the "지난 시즌" card.
function snapshotTop(users, n = 3) {
  return users
    .slice()
    .sort((a, b) => b.points - a.points || b.record.w - a.record.w)
    .slice(0, n)
    .map((u) => ({
      username: u.username,
      clubName: u.clubName || u.baseTeam,
      points: u.points,
      record: u.record,
    }));
}

function rollover(season) {
  const users = store.allUsers();
  store.pushSeasonHistory({
    number: season.number,
    endedAt: Date.now(),
    top: snapshotTop(users),
  });
  users.forEach((u) => {
    u.points = 0;
    u.record = { w: 0, d: 0, l: 0 };
    u.playerStats = {};
    store.putUser(u);
  });
  return { number: season.number + 1, startedAt: Date.now() };
}

function checkRollover() {
  let season = store.getSeason();
  // loop in case the process was down across more than one full season
  while (Date.now() - season.startedAt >= SEASON_MS) {
    season = rollover(season);
    store.saveSeason(season);
  }
}

function getSeasonStatus() {
  const season = store.getSeason();
  const endsAt = season.startedAt + SEASON_MS;
  return {
    number: season.number,
    startedAt: season.startedAt,
    endsAt,
    daysRemaining: Math.max(0, Math.ceil((endsAt - Date.now()) / (24 * 60 * 60 * 1000))),
  };
}

function init() {
  checkRollover(); // covers downtime spanning a season boundary
  setInterval(checkRollover, CHECK_INTERVAL_MS);
}

module.exports = { init, getSeasonStatus };
