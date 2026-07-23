'use strict';

// Each formation defines 11 ordered slots. Slot order is fixed so the client
// and server agree on which starter sits in which position.
const FORMATIONS = {
  '4-3-3': ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'],
  '4-4-2': ['GK', 'RB', 'CB', 'CB', 'LB', 'RM', 'CM', 'CM', 'LM', 'ST', 'ST'],
  '4-2-3-1': ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CDM', 'CAM', 'RW', 'ST', 'LW'],
  '3-5-2': ['GK', 'CB', 'CB', 'CB', 'RWB', 'CM', 'CDM', 'CM', 'LWB', 'ST', 'ST'],
  '4-1-4-1': ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'RM', 'CM', 'CM', 'LM', 'ST'],
};

const DEFAULT_FORMATION = '4-3-3';

// Position -> broad line, for chemistry checks.
const LINE = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
};

// Out-of-position OVR penalty for a converted card (CAM played at RB etc.):
// exact position 0 · same line 2 · adjacent line 6 · opposite line 10.
function posPenalty(playerPos, slotPos) {
  if (playerPos === slotPos) return 0;
  const a = LINE[playerPos] || 'MID';
  const b = LINE[slotPos] || 'MID';
  if (a === b) return 2;
  const adj =
    (a === 'DEF' && b === 'MID') ||
    (a === 'MID' && b === 'DEF') ||
    (a === 'MID' && b === 'ATT') ||
    (a === 'ATT' && b === 'MID');
  return adj ? 6 : 10;
}

module.exports = { FORMATIONS, DEFAULT_FORMATION, LINE, posPenalty };
