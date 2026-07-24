'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Player / team catalog.
//
// To keep the dataset compact and easy to extend, each player is authored as a
// short row [name, position, overall]. The six FIFA-style attributes
// (pace, shooting, passing, dribbling, defending, physical) are derived from
// the overall + a position archetype + a *stable* per-name jitter, so a given
// player always has the same stats across restarts without us hand-typing them.
// ---------------------------------------------------------------------------

// Stable string hash -> [0,1) generator (mulberry32 seeded by name).
function seededRand(str, salt) {
  let h = 1779033703 ^ (salt || 0);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let t = (h += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Attribute weights per position group. Higher weight => attribute sits above
// the player's overall; lower => below.
const ARCHETYPES = {
  GK: { pace: -18, shooting: -30, passing: -8, dribbling: -20, defending: 6, physical: 2 },
  CB: { pace: -6, shooting: -22, passing: -6, dribbling: -12, defending: 10, physical: 8 },
  LB: { pace: 8, shooting: -12, passing: 2, dribbling: 2, defending: 4, physical: -2 },
  RB: { pace: 8, shooting: -12, passing: 2, dribbling: 2, defending: 4, physical: -2 },
  LWB: { pace: 10, shooting: -10, passing: 3, dribbling: 4, defending: 1, physical: -2 },
  RWB: { pace: 10, shooting: -10, passing: 3, dribbling: 4, defending: 1, physical: -2 },
  CDM: { pace: -4, shooting: -10, passing: 6, dribbling: 0, defending: 9, physical: 8 },
  CM: { pace: 0, shooting: -2, passing: 9, dribbling: 6, defending: 2, physical: 3 },
  CAM: { pace: 3, shooting: 6, passing: 9, dribbling: 9, defending: -10, physical: -4 },
  LM: { pace: 9, shooting: 2, passing: 5, dribbling: 8, defending: -6, physical: -4 },
  RM: { pace: 9, shooting: 2, passing: 5, dribbling: 8, defending: -6, physical: -4 },
  LW: { pace: 11, shooting: 6, passing: 3, dribbling: 11, defending: -16, physical: -6 },
  RW: { pace: 11, shooting: 6, passing: 3, dribbling: 11, defending: -16, physical: -6 },
  CF: { pace: 6, shooting: 10, passing: 5, dribbling: 9, defending: -18, physical: 2 },
  ST: { pace: 8, shooting: 13, passing: -3, dribbling: 5, defending: -22, physical: 6 },
};

// Which broad line a position belongs to (used by the match engine).
const LINE = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  LW: 'ATT', RW: 'ATT', CF: 'ATT', ST: 'ATT',
};

const ATTRS = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical'];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function buildAttributes(name, pos, ovr) {
  const arch = ARCHETYPES[pos] || ARCHETYPES.CM;
  const out = {};
  ATTRS.forEach((attr, i) => {
    const jitter = Math.round(seededRand(name + pos, i + 1) * 8) - 4; // -4..+3
    out[attr] = clamp(Math.round(ovr + (arch[attr] || 0) + jitter), 24, 99);
  });
  return out;
}

// Real height(cm)/weight(kg) for every named real footballer authored in
// CLUB_ROSTERS + MARKET_POOL below (keyed by base name — enhanced/icon tier
// suffixes like " (Icon)"/" (Ultra)" are stripped before lookup, since an
// enhanced card is still the same real person). Covers the ~328 statically
// authored real players; dynamically-fetched club/national rosters (Saudi
// Pro League + the 24 curated nations, fetched live from Wikipedia) aren't
// individually catalogued here and keep the position-archetype estimate
// below instead — there's no practical way to hand-verify every player in
// those live-fetched squads.
const REAL_PHYSICAL = {
  // Man City
  'Gianluigi Donnarumma': [196, 90], 'Matheus Nunes': [183, 76], 'Ruben Dias': [187, 82],
  'Josko Gvardiol': [185, 80], 'Rayan Ait-Nouri': [179, 71], 'Rodri': [191, 82],
  'Tijjani Reijnders': [178, 73], 'Bernardo Silva': [173, 64], 'Phil Foden': [171, 70],
  'Erling Haaland': [195, 88], 'Jeremy Doku': [175, 74], 'Omar Marmoush': [182, 75],
  'Rayan Cherki': [175, 68], 'John Stones': [188, 70],
  // Real Madrid
  'Thibaut Courtois': [199, 96], 'Trent Alexander-Arnold': [175, 69], 'Antonio Rudiger': [190, 88],
  'Dean Huijsen': [195, 87], 'Alvaro Carreras': [182, 75], 'Aurelien Tchouameni': [188, 89],
  'Jude Bellingham': [186, 75], 'Federico Valverde': [182, 78], 'Rodrygo': [174, 64],
  'Kylian Mbappe': [178, 73], 'Vinicius Jr': [176, 73], 'Arda Guler': [173, 62],
  'Eduardo Camavinga': [182, 68], 'Endrick': [178, 73],
  // Bayern Munich
  'Manuel Neuer': [193, 92], 'Konrad Laimer': [178, 74], 'Dayot Upamecano': [186, 90],
  'Kim Min-jae': [190, 88], 'Alphonso Davies': [183, 74], 'Joshua Kimmich': [177, 73],
  'Aleksandar Pavlovic': [185, 75], 'Jamal Musiala': [183, 72], 'Michael Olise': [178, 73],
  'Harry Kane': [188, 89], 'Luis Diaz': [178, 65], 'Serge Gnabry': [176, 75],
  'Leon Goretzka': [189, 81], 'Jonathan Tah': [195, 96],
  // Paris SG
  'Lucas Chevalier': [190, 82], 'Achraf Hakimi': [181, 73], 'Marquinhos': [183, 75],
  'Willian Pacho': [186, 79], 'Nuno Mendes': [176, 70], 'Vitinha': [172, 64],
  'Joao Neves': [176, 65], 'Fabian Ruiz': [189, 78], 'Ousmane Dembele': [178, 67],
  'Goncalo Ramos': [186, 80], 'Khvicha Kvaratskhelia': [183, 70], 'Desire Doue': [180, 72],
  'Bradley Barcola': [181, 66], 'Lee Kang-in': [173, 65],
  // Liverpool
  'Alisson': [191, 91], 'Jeremie Frimpong': [171, 68], 'Virgil van Dijk': [195, 92],
  'Ibrahima Konate': [194, 87], 'Milos Kerkez': [180, 75], 'Ryan Gravenberch': [190, 79],
  'Alexis Mac Allister': [174, 70], 'Dominik Szoboszlai': [186, 79], 'Mohamed Salah': [175, 71],
  'Alexander Isak': [192, 79], 'Florian Wirtz': [176, 68], 'Cody Gakpo': [189, 79],
  'Hugo Ekitike': [189, 75], 'Curtis Jones': [185, 74],
  // Inter Miami
  'Oscar Ustari': [186, 82], 'Marcelo Weigandt': [178, 72], 'Tomas Aviles': [186, 79],
  'Maximiliano Falcon': [188, 82], 'Noah Allen': [178, 72], 'Rodrigo De Paul': [180, 72],
  'Telasco Segovia': [178, 70], 'Federico Redondo': [185, 77], 'Tadeo Allende': [174, 68],
  'Luis Suarez': [182, 86], 'Lionel Messi': [170, 72], 'Benjamin Cremaschi': [180, 73],
  'Yannick Bright': [183, 75], 'Ian Fray': [188, 80],
  // Arsenal
  'David Raya': [183, 78], 'Jurrien Timber': [178, 75], 'William Saliba': [192, 82],
  'Gabriel Magalhaes': [190, 87], 'Myles Lewis-Skelly': [176, 70], 'Martin Zubimendi': [182, 76],
  'Declan Rice': [185, 82], 'Martin Odegaard': [178, 68], 'Bukayo Saka': [178, 72],
  'Viktor Gyokeres': [191, 88], 'Gabriel Martinelli': [176, 68], 'Leandro Trossard': [172, 68],
  'Kai Havertz': [193, 82], 'Ben White': [179, 75],
  // Chelsea
  'Robert Sanchez': [197, 92], 'Reece James': [183, 82], 'Wesley Fofana': [186, 80],
  'Levi Colwill': [186, 78], 'Marc Cucurella': [172, 70], 'Moises Caicedo': [178, 77],
  'Enzo Fernandez': [178, 76], 'Cole Palmer': [189, 72], 'Pedro Neto': [172, 65],
  'Joao Pedro': [178, 73], 'Alejandro Garnacho': [180, 70], 'Estevao': [173, 64],
  'Malo Gusto': [180, 68], 'Trevoh Chalobah': [189, 80],
  // Man United
  'Senne Lammens': [197, 90], 'Amad Diallo': [173, 68], 'Matthijs de Ligt': [189, 89],
  'Leny Yoro': [192, 82], 'Luke Shaw': [185, 80], 'Casemiro': [185, 84],
  'Bruno Fernandes': [179, 69], 'Kobbie Mainoo': [187, 72], 'Bryan Mbeumo': [172, 68],
  'Benjamin Sesko': [195, 87], 'Matheus Cunha': [184, 80], 'Mason Mount': [180, 70],
  'Diogo Dalot': [183, 75], 'Ayden Heaven': [188, 78],
  // Barcelona
  'Joan Garcia': [190, 84], 'Jules Kounde': [180, 75], 'Pau Cubarsi': [181, 74],
  'Ronald Araujo': [188, 79], 'Alejandro Balde': [175, 70], 'Pedri': [174, 60],
  'Frenkie de Jong': [180, 74], 'Dani Olmo': [179, 65], 'Lamine Yamal': [180, 69],
  'Robert Lewandowski': [185, 81], 'Marcus Rashford': [180, 70], 'Gavi': [173, 64],
  'Ferran Torres': [184, 73], 'Raphinha': [176, 69],
  // Atletico Madrid
  'Jan Oblak': [188, 87], 'Nahuel Molina': [175, 70], 'Jose Gimenez': [184, 79],
  'Robin Le Normand': [186, 80], 'David Hancko': [186, 80], 'Pablo Barrios': [180, 68],
  'Conor Gallagher': [180, 72], 'Thiago Almada': [168, 65], 'Giuliano Simeone': [176, 70],
  'Julian Alvarez': [170, 71], 'Alexander Sorloth': [195, 90], 'Antoine Griezmann': [176, 73],
  'Koke': [176, 74], 'Marcos Llorente': [186, 78],
  // Inter Milan
  'Yann Sommer': [183, 80], 'Denzel Dumfries': [188, 80], 'Alessandro Bastoni': [190, 85],
  'Francesco Acerbi': [192, 84], 'Federico Dimarco': [175, 72], 'Hakan Calhanoglu': [178, 75],
  'Nicolo Barella': [172, 68], 'Henrikh Mkhitaryan': [177, 75], 'Luis Henrique': [172, 68],
  'Lautaro Martinez': [174, 72], 'Marcus Thuram': [192, 80], 'Davide Frattesi': [173, 68],
  'Pio Esposito': [195, 85], 'Carlos Augusto': [176, 74],
  // AC Milan
  'Mike Maignan': [191, 92], 'Alexis Saelemaekers': [178, 73], 'Fikayo Tomori': [186, 85],
  'Strahinja Pavlovic': [195, 88], 'Pervis Estupinan': [175, 73], 'Luka Modric': [172, 66],
  'Youssouf Fofana': [186, 80], 'Adrien Rabiot': [188, 74], 'Christian Pulisic': [174, 68],
  'Santiago Gimenez': [180, 75], 'Rafael Leao': [188, 81], 'Christopher Nkunku': [175, 71],
  'Ruben Loftus-Cheek': [190, 87], 'Koni De Winter': [193, 85],
  // Napoli
  'Alex Meret': [190, 82], 'Giovanni Di Lorenzo': [183, 80], 'Amir Rrahmani': [195, 89],
  'Alessandro Buongiorno': [187, 82], 'Mathias Olivera': [182, 78], 'Stanislav Lobotka': [172, 68],
  'Kevin De Bruyne': [181, 76], 'Scott McTominay': [193, 88], 'Matteo Politano': [171, 66],
  'Rasmus Hojlund': [191, 79], 'David Neres': [175, 68], 'Frank Anguissa': [190, 85],
  'Romelu Lukaku': [191, 94], 'Juan Jesus': [189, 84],
  // Al-Nassr
  'Bento': [189, 84], 'Sultan Al-Ghannam': [178, 74], 'Inigo Martinez': [181, 78],
  'Mohamed Simakan': [190, 82], 'Alex Telles': [172, 72], 'Marcelo Brozovic': [181, 78],
  'Abdullah Al-Khaibari': [175, 70], 'Joao Felix': [181, 70], 'Kingsley Coman': [178, 74],
  'Cristiano Ronaldo': [187, 85], 'Sadio Mane': [175, 69], 'Angelo Gabriel': [175, 68],
  'Ayman Yahya': [176, 70], 'Nawaf Aqidi': [188, 82],
  // Dortmund
  'Gregor Kobel': [194, 91], 'Yan Couto': [172, 66], 'Nico Schlotterbeck': [191, 88],
  'Waldemar Anton': [189, 82], 'Ramy Bensebaini': [189, 82], 'Marcel Sabitzer': [177, 74],
  'Pascal Gross': [183, 75], 'Julian Brandt': [184, 75], 'Karim Adeyemi': [180, 73],
  'Serhou Guirassy': [187, 82], 'Maximilian Beier': [183, 75], 'Felix Nmecha': [187, 78],
  'Julien Duranville': [178, 68], 'Emre Can': [186, 83],
  // LAFC
  'Hugo Lloris': [188, 84], 'Ryan Hollingshead': [183, 77], 'Aaron Long': [190, 84],
  'Eddie Segura': [183, 76], 'Marco Farfan': [173, 68], 'Timothy Tillman': [178, 72],
  'Mark Delgado': [173, 68], 'Eduard Atuesta': [174, 68], 'Denis Bouanga': [173, 65],
  'Nathan Ordaz': [178, 73], 'Son Heung-min': [183, 78], 'David Martinez': [172, 68],
  'Frankie Amaya': [173, 68], 'Javairo Dilrosun': [178, 72],
  // National-only (not already in a club roster above)
  'Theo Hernandez': [184, 81], 'Emiliano Martinez': [195, 88], 'Cristian Romero': [185, 84],
  'Nicolas Otamendi': [183, 81], 'Nicolas Tagliafico': [170, 65], 'Nico Paz': [180, 70],
  'Danilo': [179, 78], 'Wendell': [172, 68], 'Bruno Guimaraes': [182, 74], 'Lucas Paqueta': [180, 72],
  'Jordan Pickford': [185, 80], 'Marc Guehi': [187, 79], 'Adam Wharton': [180, 70],
  'Anthony Gordon': [178, 70], 'Ollie Watkins': [180, 76],
  'Diogo Costa': [186, 80], 'Joao Cancelo': [182, 75], 'Goncalo Inacio': [190, 82], 'Joao Palhinha': [190, 84],
  'Jo Hyeon-woo': [189, 84], 'Seol Young-woo': [174, 70], 'Kim Ju-sung': [187, 78],
  'Lee Myung-jae': [178, 72], 'Paik Seung-ho': [181, 74], 'Hwang In-beom': [180, 74],
  'Hwang Hee-chan': [177, 73], 'Oh Hyeon-gyu': [187, 80], 'Lee Jae-sung': [176, 70],
  'Cho Gue-sung': [188, 80], 'Bae Jun-ho': [178, 68],
  // MARKET_POOL — non-enhanced stars outside the preset teams
  'Nico Williams': [181, 71], 'Victor Osimhen': [185, 78], 'Neymar Jr': [175, 68],
  'Karim Benzema': [185, 81], 'Toni Kroos': [183, 76], 'N Golo Kante': [168, 70],
  'Sergio Ramos': [184, 82], 'Dusan Vlahovic': [190, 88], 'Federico Chiesa': [175, 70],
  'Jack Grealish': [180, 71], 'Darwin Nunez': [187, 80],
  // MARKET_POOL — enhanced-tier rows authored under a short/mononym name
  // (e.g. "Haaland (Ultra)") rather than the full name used above — same
  // real person, aliased here so the suffix-strip lookup still resolves.
  'Mbappe': [178, 73], 'Haaland': [195, 88], 'Messi': [170, 72], 'Vinicius': [176, 73],
  'Bellingham': [186, 75], 'Van Dijk': [195, 92], 'Neuer': [193, 92], 'Salah': [175, 71],
  'Kane': [188, 89],
  // MARKET_POOL — legends (enhanced/icon cards resolve to these via suffix-strip)
  'Ronaldo R9': [183, 80], 'Zidane': [185, 80], 'Maradona': [165, 73], 'Pele': [173, 74],
  'Ronaldinho': [181, 79], 'Andres Iniesta': [171, 68],
  'Xavi Hernandez': [170, 68], 'Andrea Pirlo': [177, 68], 'Paolo Maldini': [186, 84],
  'Franco Baresi': [176, 74], 'Franz Beckenbauer': [181, 75], 'Johan Cruyff': [178, 71],
  'Eusebio': [174, 71], 'Alfredo Di Stefano': [178, 70], 'Ferenc Puskas': [172, 73],
  'Garrincha': [169, 65], 'Zico': [172, 68], 'Romario': [169, 70], 'Cafu': [179, 76],
  'Roberto Carlos': [168, 68], 'Marcelo': [175, 71], 'Philipp Lahm': [170, 66],
  'Fabio Cannavaro': [176, 74], 'Rio Ferdinand': [189, 79], 'John Terry': [188, 90],
  'Vincent Kompany': [191, 90], 'Steven Gerrard': [183, 79], 'Frank Lampard': [184, 82],
  'Patrick Vieira': [192, 84], 'Michael Ballack': [189, 88], 'Xabi Alonso': [183, 82],
  'David Beckham': [183, 74], 'Thierry Henry': [188, 82], 'Didier Drogba': [189, 88],
  'Samuel Eto o': [180, 78], 'Wayne Rooney': [178, 84], 'Robin van Persie': [183, 74],
  'Ruud van Nistelrooy': [186, 82], 'Gabriel Batistuta': [189, 85], 'David Villa': [175, 69],
  'Alessandro Del Piero': [174, 70], 'Francesco Totti': [180, 77], 'Raul Gonzalez': [182, 73],
  'Kaka': [186, 82], 'Michael Owen': [173, 68], 'Gianluigi Buffon': [192, 92],
  'Iker Casillas': [185, 84], 'Peter Schmeichel': [191, 92], 'Oliver Kahn': [188, 90],
};

// Average height (cm) per position group — keepers/centre-backs/strikers
// trend tallest, wide/attacking players trend shortest, roughly matching
// real-world positional height distributions.
const HEIGHT_BASE = {
  GK: 191, CB: 188, LB: 176, RB: 176, LWB: 177, RWB: 177,
  CDM: 182, CM: 180, CAM: 176, LM: 174, RM: 174,
  LW: 174, RW: 174, CF: 183, ST: 184,
};

// Deterministic height/weight/leadership, same stable-jitter approach as
// buildAttributes — salts 101/102/103 keep them independent of the six core
// attribute rolls (which use salts 1-6) and of each other. Real players
// (see REAL_PHYSICAL above) use their actual measurements instead of the
// archetype estimate — the estimate is a fallback for dynamically-fetched
// rosters that were never hand-verified.
function buildPhysical(name, pos) {
  const baseName = String(name).trim().replace(/\s*\([^)]*\)\s*$/, '');
  const real = REAL_PHYSICAL[baseName];
  const leadership = seededRand(name + pos, 103) < 0.12; // ~12% of players
  if (real) {
    return { height: real[0], weight: real[1], leadership };
  }
  const base = HEIGHT_BASE[pos] || HEIGHT_BASE.CM;
  const height = Math.round(base + (seededRand(name + pos, 101) * 14 - 7)); // ±7cm
  // athletic-build heuristic tied to height, not just a free-floating roll
  const weight = Math.round((height - 100) * 0.92 + (seededRand(name + pos, 102) * 10 - 4)); // -4..+6
  return { height, weight, leadership };
}

let AUTO_ID = 1;

function makePlayer(row, teamName, enhanced) {
  const [name, pos, ovr] = row;
  const attrs = buildAttributes(name, pos, ovr);
  const { height, weight, leadership } = buildPhysical(name, pos);
  return {
    id: 'p' + AUTO_ID++,
    name,
    pos,
    line: LINE[pos] || 'MID',
    ovr,
    enhanced: !!enhanced,
    team: teamName || null,
    attrs,
    height,
    weight,
    leadership,
  };
}

// ---------------------------------------------------------------------------
// Preset teams. Each roster is a starting XI followed by a few bench options.
// Values are approximate, tuned for balance rather than real-world accuracy.
// ---------------------------------------------------------------------------

// Rosters reflect the 2025/26 season window (transfers through Jan 2026):
// De Bruyne -> Napoli, Donnarumma -> Man City, Isak/Wirtz/Frimpong/Kerkez ->
// Liverpool, Alexander-Arnold/Huijsen -> Real, Olise/Luis Diaz/Tah -> Bayern,
// Kvaratskhelia/Joao Neves -> PSG, De Paul -> Miami, Son -> LAFC, and
// international retirements (Pepe, Di Maria, Griezmann, Modric/Kroos era).
//
// Each human exists ONCE in the catalog. Club rosters define players as
// [name, pos, ovr, nationCode]; national squads reference club players by
// name (string) or define nation-only players as [name, pos, ovr].
// Nation codes are ISO2 ('EN' = England, rendered as the England flag).

const CLUB_ROSTERS = {
  'Man City': {
    color: '#6cabdd', league: 'EPL',
    roster: [
      ['Gianluigi Donnarumma', 'GK', 89, 'IT'], ['Matheus Nunes', 'RB', 81, 'PT'], ['Ruben Dias', 'CB', 87, 'PT'],
      ['Josko Gvardiol', 'CB', 86, 'HR'], ['Rayan Ait-Nouri', 'LB', 84, 'DZ'], ['Rodri', 'CDM', 90, 'ES'],
      ['Tijjani Reijnders', 'CM', 86, 'NL'], ['Bernardo Silva', 'CM', 86, 'PT'], ['Phil Foden', 'RW', 87, 'EN'],
      ['Erling Haaland', 'ST', 92, 'NO'], ['Jeremy Doku', 'LW', 85, 'BE'],
      ['Omar Marmoush', 'ST', 85, 'EG'], ['Rayan Cherki', 'CAM', 84, 'FR'], ['John Stones', 'CB', 84, 'EN'],
    ],
  },
  'Real Madrid': {
    color: '#febe10', league: 'LaLiga',
    roster: [
      ['Thibaut Courtois', 'GK', 90, 'BE'], ['Trent Alexander-Arnold', 'RB', 86, 'EN'], ['Antonio Rudiger', 'CB', 85, 'DE'],
      ['Dean Huijsen', 'CB', 85, 'ES'], ['Alvaro Carreras', 'LB', 83, 'ES'], ['Aurelien Tchouameni', 'CDM', 86, 'FR'],
      ['Jude Bellingham', 'CM', 91, 'EN'], ['Federico Valverde', 'CM', 89, 'UY'], ['Rodrygo', 'RW', 86, 'BR'],
      ['Kylian Mbappe', 'ST', 92, 'FR'], ['Vinicius Jr', 'LW', 90, 'BR'],
      ['Arda Guler', 'CAM', 85, 'TR'], ['Eduardo Camavinga', 'CM', 85, 'FR'], ['Endrick', 'ST', 79, 'BR'],
    ],
  },
  'Bayern Munich': {
    color: '#dc052d', league: 'Bundesliga',
    roster: [
      ['Manuel Neuer', 'GK', 86, 'DE'], ['Konrad Laimer', 'RB', 82, 'AT'], ['Dayot Upamecano', 'CB', 86, 'FR'],
      ['Kim Min-jae', 'CB', 85, 'KR'], ['Alphonso Davies', 'LB', 85, 'CA'], ['Joshua Kimmich', 'CDM', 88, 'DE'],
      ['Aleksandar Pavlovic', 'CM', 84, 'DE'], ['Jamal Musiala', 'CAM', 89, 'DE'], ['Michael Olise', 'RW', 88, 'FR'],
      ['Harry Kane', 'ST', 91, 'EN'], ['Luis Diaz', 'LW', 86, 'CO'],
      ['Serge Gnabry', 'RW', 82, 'DE'], ['Leon Goretzka', 'CM', 82, 'DE'], ['Jonathan Tah', 'CB', 85, 'DE'],
    ],
  },
  'Paris SG': {
    color: '#004170', league: 'Ligue1',
    roster: [
      ['Lucas Chevalier', 'GK', 85, 'FR'], ['Achraf Hakimi', 'RB', 89, 'MA'], ['Marquinhos', 'CB', 86, 'BR'],
      ['Willian Pacho', 'CB', 86, 'EC'], ['Nuno Mendes', 'LB', 87, 'PT'], ['Vitinha', 'CM', 89, 'PT'],
      ['Joao Neves', 'CM', 87, 'PT'], ['Fabian Ruiz', 'CM', 85, 'ES'], ['Ousmane Dembele', 'RW', 90, 'FR'],
      ['Goncalo Ramos', 'ST', 83, 'PT'], ['Khvicha Kvaratskhelia', 'LW', 88, 'GE'],
      ['Desire Doue', 'RW', 87, 'FR'], ['Bradley Barcola', 'LW', 85, 'FR'], ['Lee Kang-in', 'CAM', 83, 'KR'],
    ],
  },
  'Liverpool': {
    color: '#c8102e', league: 'EPL',
    roster: [
      ['Alisson', 'GK', 89, 'BR'], ['Jeremie Frimpong', 'RB', 84, 'NL'], ['Virgil van Dijk', 'CB', 89, 'NL'],
      ['Ibrahima Konate', 'CB', 86, 'FR'], ['Milos Kerkez', 'LB', 84, 'HU'], ['Ryan Gravenberch', 'CDM', 87, 'NL'],
      ['Alexis Mac Allister', 'CM', 86, 'AR'], ['Dominik Szoboszlai', 'CM', 85, 'HU'], ['Mohamed Salah', 'RW', 90, 'EG'],
      ['Alexander Isak', 'ST', 89, 'SE'], ['Florian Wirtz', 'LW', 90, 'DE'],
      ['Cody Gakpo', 'LW', 85, 'NL'], ['Hugo Ekitike', 'ST', 85, 'FR'], ['Curtis Jones', 'CM', 82, 'EN'],
    ],
  },
  'Inter Miami': {
    color: '#f7b5cd', league: 'MLS',
    roster: [
      ['Oscar Ustari', 'GK', 76, 'AR'], ['Marcelo Weigandt', 'RB', 75, 'AR'], ['Tomas Aviles', 'CB', 76, 'AR'],
      ['Maximiliano Falcon', 'CB', 75, 'UY'], ['Noah Allen', 'LB', 73, 'US'], ['Rodrigo De Paul', 'CM', 84, 'AR'],
      ['Telasco Segovia', 'CM', 77, 'VE'], ['Federico Redondo', 'CDM', 76, 'AR'], ['Tadeo Allende', 'RW', 77, 'AR'],
      ['Luis Suarez', 'ST', 78, 'UY'], ['Lionel Messi', 'CAM', 89, 'AR'],
      ['Benjamin Cremaschi', 'CM', 76, 'US'], ['Yannick Bright', 'CDM', 74, 'US'], ['Ian Fray', 'CB', 73, 'JM'],
    ],
  },
  'Arsenal': {
    color: '#ef0107', league: 'EPL',
    roster: [
      ['David Raya', 'GK', 87, 'ES'], ['Jurrien Timber', 'RB', 84, 'NL'], ['William Saliba', 'CB', 87, 'FR'],
      ['Gabriel Magalhaes', 'CB', 86, 'BR'], ['Myles Lewis-Skelly', 'LB', 82, 'EN'], ['Martin Zubimendi', 'CDM', 86, 'ES'],
      ['Declan Rice', 'CDM', 89, 'EN'], ['Martin Odegaard', 'CAM', 87, 'NO'], ['Bukayo Saka', 'RW', 89, 'EN'],
      ['Viktor Gyokeres', 'ST', 87, 'SE'], ['Gabriel Martinelli', 'LW', 84, 'BR'],
      ['Leandro Trossard', 'LW', 83, 'BE'], ['Kai Havertz', 'ST', 82, 'DE'], ['Ben White', 'RB', 83, 'EN'],
    ],
  },
  'Chelsea': {
    color: '#034694', league: 'EPL',
    roster: [
      ['Robert Sanchez', 'GK', 84, 'ES'], ['Reece James', 'RB', 84, 'EN'], ['Wesley Fofana', 'CB', 83, 'FR'],
      ['Levi Colwill', 'CB', 84, 'EN'], ['Marc Cucurella', 'LB', 85, 'ES'], ['Moises Caicedo', 'CDM', 88, 'EC'],
      ['Enzo Fernandez', 'CM', 87, 'AR'], ['Cole Palmer', 'CAM', 88, 'EN'], ['Pedro Neto', 'RW', 83, 'PT'],
      ['Joao Pedro', 'ST', 84, 'BR'], ['Alejandro Garnacho', 'LW', 82, 'AR'],
      ['Estevao', 'RW', 84, 'BR'], ['Malo Gusto', 'RB', 82, 'FR'], ['Trevoh Chalobah', 'CB', 82, 'EN'],
    ],
  },
  'Man United': {
    color: '#da291c', league: 'EPL',
    roster: [
      ['Senne Lammens', 'GK', 80, 'BE'], ['Amad Diallo', 'RB', 83, 'CI'], ['Matthijs de Ligt', 'CB', 84, 'NL'],
      ['Leny Yoro', 'CB', 83, 'FR'], ['Luke Shaw', 'LB', 80, 'EN'], ['Casemiro', 'CDM', 84, 'BR'],
      ['Bruno Fernandes', 'CAM', 88, 'PT'], ['Kobbie Mainoo', 'CM', 82, 'EN'], ['Bryan Mbeumo', 'RW', 85, 'CM'],
      ['Benjamin Sesko', 'ST', 84, 'SI'], ['Matheus Cunha', 'CF', 84, 'BR'],
      ['Mason Mount', 'CAM', 79, 'EN'], ['Diogo Dalot', 'RB', 82, 'PT'], ['Ayden Heaven', 'CB', 78, 'EN'],
    ],
  },
  'Barcelona': {
    color: '#004d98', league: 'LaLiga',
    roster: [
      ['Joan Garcia', 'GK', 85, 'ES'], ['Jules Kounde', 'RB', 86, 'FR'], ['Pau Cubarsi', 'CB', 86, 'ES'],
      ['Ronald Araujo', 'CB', 84, 'UY'], ['Alejandro Balde', 'LB', 84, 'ES'], ['Pedri', 'CM', 90, 'ES'],
      ['Frenkie de Jong', 'CM', 86, 'NL'], ['Dani Olmo', 'CAM', 85, 'ES'], ['Lamine Yamal', 'RW', 93, 'ES'],
      ['Robert Lewandowski', 'ST', 87, 'PL'], ['Marcus Rashford', 'LW', 83, 'EN'],
      ['Gavi', 'CM', 84, 'ES'], ['Ferran Torres', 'ST', 82, 'ES'], ['Raphinha', 'RW', 89, 'BR'],
    ],
  },
  'Atletico Madrid': {
    color: '#cb3524', league: 'LaLiga',
    roster: [
      ['Jan Oblak', 'GK', 87, 'SI'], ['Nahuel Molina', 'RB', 80, 'AR'], ['Jose Gimenez', 'CB', 83, 'UY'],
      ['Robin Le Normand', 'CB', 83, 'ES'], ['David Hancko', 'LB', 82, 'SK'], ['Pablo Barrios', 'CDM', 85, 'ES'],
      ['Conor Gallagher', 'CM', 81, 'EN'], ['Thiago Almada', 'CAM', 83, 'AR'], ['Giuliano Simeone', 'RW', 82, 'AR'],
      ['Julian Alvarez', 'ST', 89, 'AR'], ['Alexander Sorloth', 'ST', 82, 'NO'],
      ['Antoine Griezmann', 'CAM', 84, 'FR'], ['Koke', 'CM', 80, 'ES'], ['Marcos Llorente', 'RB', 82, 'ES'],
    ],
  },
  'Inter Milan': {
    color: '#0068a8', league: 'SerieA',
    roster: [
      ['Yann Sommer', 'GK', 84, 'CH'], ['Denzel Dumfries', 'RB', 84, 'NL'], ['Alessandro Bastoni', 'CB', 87, 'IT'],
      ['Francesco Acerbi', 'CB', 80, 'IT'], ['Federico Dimarco', 'LB', 85, 'IT'], ['Hakan Calhanoglu', 'CDM', 86, 'TR'],
      ['Nicolo Barella', 'CM', 87, 'IT'], ['Henrikh Mkhitaryan', 'CM', 80, 'AM'], ['Luis Henrique', 'RW', 79, 'BR'],
      ['Lautaro Martinez', 'ST', 88, 'AR'], ['Marcus Thuram', 'ST', 86, 'FR'],
      ['Davide Frattesi', 'CM', 82, 'IT'], ['Pio Esposito', 'ST', 79, 'IT'], ['Carlos Augusto', 'LB', 81, 'BR'],
    ],
  },
  'AC Milan': {
    color: '#fb090b', league: 'SerieA',
    roster: [
      ['Mike Maignan', 'GK', 87, 'FR'], ['Alexis Saelemaekers', 'RB', 80, 'BE'], ['Fikayo Tomori', 'CB', 82, 'EN'],
      ['Strahinja Pavlovic', 'CB', 82, 'RS'], ['Pervis Estupinan', 'LB', 82, 'EC'], ['Luka Modric', 'CDM', 84, 'HR'],
      ['Youssouf Fofana', 'CM', 82, 'FR'], ['Adrien Rabiot', 'CM', 82, 'FR'], ['Christian Pulisic', 'RW', 85, 'US'],
      ['Santiago Gimenez', 'ST', 81, 'MX'], ['Rafael Leao', 'LW', 86, 'PT'],
      ['Christopher Nkunku', 'ST', 82, 'FR'], ['Ruben Loftus-Cheek', 'CM', 79, 'EN'], ['Koni De Winter', 'CB', 79, 'BE'],
    ],
  },
  'Napoli': {
    color: '#12a0d7', league: 'SerieA',
    roster: [
      ['Alex Meret', 'GK', 83, 'IT'], ['Giovanni Di Lorenzo', 'RB', 84, 'IT'], ['Amir Rrahmani', 'CB', 83, 'XK'],
      ['Alessandro Buongiorno', 'CB', 84, 'IT'], ['Mathias Olivera', 'LB', 81, 'UY'], ['Stanislav Lobotka', 'CDM', 86, 'SK'],
      ['Kevin De Bruyne', 'CM', 87, 'BE'], ['Scott McTominay', 'CM', 85, 'SCT'], ['Matteo Politano', 'RW', 82, 'IT'],
      ['Rasmus Hojlund', 'ST', 82, 'DK'], ['David Neres', 'LW', 83, 'BR'],
      ['Frank Anguissa', 'CM', 84, 'CM'], ['Romelu Lukaku', 'ST', 82, 'BE'], ['Juan Jesus', 'CB', 77, 'BR'],
    ],
  },
  'Al-Nassr': {
    color: '#fdb913', league: 'Saudi',
    roster: [
      ['Bento', 'GK', 81, 'BR'], ['Sultan Al-Ghannam', 'RB', 76, 'SA'], ['Inigo Martinez', 'CB', 83, 'ES'],
      ['Mohamed Simakan', 'CB', 81, 'FR'], ['Alex Telles', 'LB', 79, 'BR'], ['Marcelo Brozovic', 'CDM', 82, 'HR'],
      ['Abdullah Al-Khaibari', 'CM', 75, 'SA'], ['Joao Felix', 'CAM', 82, 'PT'], ['Kingsley Coman', 'RW', 84, 'FR'],
      ['Cristiano Ronaldo', 'ST', 85, 'PT'], ['Sadio Mane', 'LW', 80, 'SN'],
      ['Angelo Gabriel', 'RW', 78, 'BR'], ['Ayman Yahya', 'RB', 74, 'SA'], ['Nawaf Aqidi', 'GK', 74, 'SA'],
    ],
  },
  'Dortmund': {
    color: '#fde100', league: 'Bundesliga',
    roster: [
      ['Gregor Kobel', 'GK', 87, 'CH'], ['Yan Couto', 'RB', 80, 'BR'], ['Nico Schlotterbeck', 'CB', 85, 'DE'],
      ['Waldemar Anton', 'CB', 82, 'DE'], ['Ramy Bensebaini', 'LB', 80, 'DZ'], ['Marcel Sabitzer', 'CM', 81, 'AT'],
      ['Pascal Gross', 'CM', 81, 'DE'], ['Julian Brandt', 'CAM', 83, 'DE'], ['Karim Adeyemi', 'RW', 83, 'DE'],
      ['Serhou Guirassy', 'ST', 86, 'GN'], ['Maximilian Beier', 'LW', 80, 'DE'],
      ['Felix Nmecha', 'CM', 81, 'DE'], ['Julien Duranville', 'RW', 77, 'BE'], ['Emre Can', 'CDM', 79, 'DE'],
    ],
  },
  'LAFC': {
    color: '#c39e6d', league: 'MLS',
    roster: [
      ['Hugo Lloris', 'GK', 80, 'FR'], ['Ryan Hollingshead', 'RB', 74, 'US'], ['Aaron Long', 'CB', 74, 'US'],
      ['Eddie Segura', 'CB', 74, 'CO'], ['Marco Farfan', 'LB', 73, 'US'], ['Timothy Tillman', 'CM', 76, 'US'],
      ['Mark Delgado', 'CM', 75, 'US'], ['Eduard Atuesta', 'CM', 76, 'CO'], ['Denis Bouanga', 'RW', 84, 'GA'],
      ['Nathan Ordaz', 'ST', 74, 'US'], ['Son Heung-min', 'LW', 85, 'KR'],
      ['David Martinez', 'LW', 76, 'VE'], ['Frankie Amaya', 'CM', 75, 'US'], ['Javairo Dilrosun', 'LW', 75, 'NL'],
    ],
  },
};

// National squads (2026 World Cup era). Strings reference club players above;
// arrays define players whose clubs aren't in the game (nation = the squad's).
const NATIONAL_SQUADS = {
  'France': {
    color: '#0055a4', nation: 'FR',
    roster: [
      'Mike Maignan', 'Jules Kounde', 'William Saliba',
      'Ibrahima Konate', ['Theo Hernandez', 'LB', 84], 'Aurelien Tchouameni',
      'Eduardo Camavinga', 'Michael Olise', 'Ousmane Dembele',
      'Kylian Mbappe', 'Desire Doue',
      'Marcus Thuram', 'Bradley Barcola', 'Dayot Upamecano',
    ],
  },
  'Argentina': {
    color: '#75aadb', nation: 'AR',
    roster: [
      ['Emiliano Martinez', 'GK', 87], 'Nahuel Molina', ['Cristian Romero', 'CB', 87],
      ['Nicolas Otamendi', 'CB', 80], ['Nicolas Tagliafico', 'LB', 79], 'Rodrigo De Paul',
      'Enzo Fernandez', 'Alexis Mac Allister', 'Lionel Messi',
      'Julian Alvarez', 'Alejandro Garnacho',
      'Lautaro Martinez', ['Nico Paz', 'CAM', 85], 'Thiago Almada',
    ],
  },
  'Brazil': {
    color: '#ffdf00', nation: 'BR',
    roster: [
      'Alisson', ['Danilo', 'RB', 79], 'Marquinhos',
      'Gabriel Magalhaes', ['Wendell', 'LB', 77], ['Bruno Guimaraes', 'CDM', 87],
      'Casemiro', ['Lucas Paqueta', 'CM', 83], 'Raphinha',
      'Matheus Cunha', 'Vinicius Jr',
      'Estevao', 'Rodrygo', 'Endrick',
    ],
  },
  'England': {
    color: '#cf081f', nation: 'EN',
    roster: [
      ['Jordan Pickford', 'GK', 84], 'Trent Alexander-Arnold', 'John Stones',
      ['Marc Guehi', 'CB', 85], 'Myles Lewis-Skelly', 'Declan Rice',
      'Jude Bellingham', ['Adam Wharton', 'CM', 83], 'Bukayo Saka',
      'Harry Kane', 'Phil Foden',
      'Cole Palmer', ['Anthony Gordon', 'LW', 84], ['Ollie Watkins', 'ST', 83],
    ],
  },
  'Portugal': {
    color: '#006600', nation: 'PT',
    roster: [
      ['Diogo Costa', 'GK', 86], ['Joao Cancelo', 'RB', 83], 'Ruben Dias',
      ['Goncalo Inacio', 'CB', 84], 'Nuno Mendes', ['Joao Palhinha', 'CDM', 84],
      'Vitinha', 'Bruno Fernandes', 'Bernardo Silva',
      'Cristiano Ronaldo', 'Rafael Leao',
      'Joao Neves', 'Pedro Neto', 'Goncalo Ramos',
    ],
  },
  'Korea Republic': {
    color: '#c60c30', nation: 'KR',
    roster: [
      ['Jo Hyeon-woo', 'GK', 79], ['Seol Young-woo', 'RB', 77], 'Kim Min-jae',
      ['Kim Ju-sung', 'CB', 75], ['Lee Myung-jae', 'LB', 75], ['Paik Seung-ho', 'CDM', 77],
      ['Hwang In-beom', 'CM', 80], 'Lee Kang-in', ['Hwang Hee-chan', 'RW', 80],
      ['Oh Hyeon-gyu', 'ST', 77], 'Son Heung-min',
      ['Lee Jae-sung', 'CM', 78], ['Cho Gue-sung', 'ST', 77], ['Bae Jun-ho', 'RW', 78],
    ],
  },
};

// ---------------------------------------------------------------------------
// Transfer-market-only pool: free agents + special "enhanced" (강화) versions
// with boosted stats and a premium price. These do not belong to a team.
// ---------------------------------------------------------------------------

const MARKET_POOL = [
  // stars outside the preset teams + classics: [name, pos, ovr, enhanced, nation]
  ['Nico Williams', 'LW', 86, false, 'ES'],
  ['Victor Osimhen', 'ST', 88, false, 'NG'],
  ['Neymar Jr', 'LW', 83, false, 'BR'],
  ['Karim Benzema', 'ST', 84, false, 'FR'],
  ['Toni Kroos', 'CM', 86, false, 'DE'],
  ['N Golo Kante', 'CDM', 82, false, 'FR'],
  ['Sergio Ramos', 'CB', 78, false, 'ES'],
  ['Dusan Vlahovic', 'ST', 83, false, 'RS'],
  ['Federico Chiesa', 'RW', 79, false, 'IT'],
  ['Jack Grealish', 'LW', 82, false, 'EN'],
  ['Darwin Nunez', 'ST', 82, false, 'UY'],
  // enhanced / icon-tier
  ['Mbappe (Ultra)', 'ST', 95, true, 'FR'],
  ['Haaland (Ultra)', 'ST', 95, true, 'NO'],
  ['Messi (Icon)', 'CAM', 96, true, 'AR'],
  ['Ronaldo R9 (Icon)', 'ST', 95, true, 'BR'],
  ['Zidane (Icon)', 'CAM', 96, true, 'FR'],
  ['Maradona (Icon)', 'CAM', 96, true, 'AR'],
  ['Pele (Icon)', 'CF', 95, true, 'BR'],
  ['Vinicius (Ultra)', 'LW', 94, true, 'BR'],
  ['Bellingham (Ultra)', 'CM', 93, true, 'EN'],
  ['Van Dijk (Wall)', 'CB', 94, true, 'NL'],
  ['Rodri (Prime)', 'CDM', 94, true, 'ES'],
  ['Neuer (Titan)', 'GK', 94, true, 'DE'],
  ['Salah (Ultra)', 'RW', 93, true, 'EG'],
  ['Kane (Ultra)', 'ST', 93, true, 'EN'],
  // 레전드 아이콘 대량 추가 (아이콘 팩 전용) — 은퇴 선수 위주, 사진 없으면
  // 실루엣 플레이스홀더로 자동 대체된다 (Maradona/Pele/Zidane과 동일한 처리)
  ['Cristiano Ronaldo (Icon)', 'ST', 96, true, 'PT'],
  ['Ronaldinho (Icon)', 'CAM', 95, true, 'BR'],
  ['Andres Iniesta (Icon)', 'CAM', 93, true, 'ES'],
  ['Xavi Hernandez (Icon)', 'CM', 93, true, 'ES'],
  ['Andrea Pirlo (Icon)', 'CDM', 92, true, 'IT'],
  ['Paolo Maldini (Icon)', 'CB', 94, true, 'IT'],
  ['Franco Baresi (Icon)', 'CB', 92, true, 'IT'],
  ['Franz Beckenbauer (Icon)', 'CB', 95, true, 'DE'],
  ['Johan Cruyff (Icon)', 'CF', 96, true, 'NL'],
  ['Eusebio (Icon)', 'ST', 93, true, 'PT'],
  ['Alfredo Di Stefano (Icon)', 'ST', 95, true, 'AR'],
  ['Ferenc Puskas (Icon)', 'ST', 95, true, 'HU'],
  ['Garrincha (Icon)', 'RW', 93, true, 'BR'],
  ['Zico (Icon)', 'CAM', 92, true, 'BR'],
  ['Romario (Icon)', 'ST', 93, true, 'BR'],
  ['Cafu (Icon)', 'RB', 91, true, 'BR'],
  ['Roberto Carlos (Icon)', 'LB', 92, true, 'BR'],
  ['Marcelo (Icon)', 'LB', 89, true, 'BR'],
  ['Philipp Lahm (Icon)', 'RB', 91, true, 'DE'],
  ['Fabio Cannavaro (Icon)', 'CB', 91, true, 'IT'],
  ['Rio Ferdinand (Icon)', 'CB', 89, true, 'EN'],
  ['John Terry (Icon)', 'CB', 89, true, 'EN'],
  ['Vincent Kompany (Icon)', 'CB', 88, true, 'BE'],
  ['Steven Gerrard (Icon)', 'CM', 92, true, 'EN'],
  ['Frank Lampard (Icon)', 'CM', 91, true, 'EN'],
  ['Patrick Vieira (Icon)', 'CDM', 90, true, 'FR'],
  ['Michael Ballack (Icon)', 'CM', 90, true, 'DE'],
  ['Xabi Alonso (Icon)', 'CDM', 90, true, 'ES'],
  ['Luka Modric (Icon)', 'CM', 93, true, 'HR'],
  ['David Beckham (Icon)', 'RM', 90, true, 'EN'],
  ['Thierry Henry (Icon)', 'ST', 93, true, 'FR'],
  ['Didier Drogba (Icon)', 'ST', 91, true, 'CI'],
  ['Samuel Eto o (Icon)', 'ST', 91, true, 'CM'],
  ['Wayne Rooney (Icon)', 'ST', 90, true, 'EN'],
  ['Robin van Persie (Icon)', 'ST', 90, true, 'NL'],
  ['Ruud van Nistelrooy (Icon)', 'ST', 90, true, 'NL'],
  ['Gabriel Batistuta (Icon)', 'ST', 91, true, 'AR'],
  ['David Villa (Icon)', 'ST', 89, true, 'ES'],
  ['Alessandro Del Piero (Icon)', 'CF', 91, true, 'IT'],
  ['Francesco Totti (Icon)', 'CAM', 91, true, 'IT'],
  ['Raul Gonzalez (Icon)', 'ST', 91, true, 'ES'],
  ['Kaka (Icon)', 'CAM', 92, true, 'BR'],
  ['Michael Owen (Icon)', 'ST', 88, true, 'EN'],
  ['Gianluigi Buffon (Icon)', 'GK', 93, true, 'IT'],
  ['Iker Casillas (Icon)', 'GK', 91, true, 'ES'],
  ['Peter Schmeichel (Icon)', 'GK', 91, true, 'DK'],
  ['Oliver Kahn (Icon)', 'GK', 92, true, 'DE'],
];

// ---------------------------------------------------------------------------
// Player images.
//
// Transparent headshots live in frontend/img/players/<slug>.png, downloaded by
// scripts/fetch-player-images.js. Enhanced/icon variants share the base
// player's image via IMG_ALIAS. Missing files render as a silhouette
// client-side.
// ---------------------------------------------------------------------------

const IMG_ALIAS = {
  'Mbappe (Ultra)': 'Kylian Mbappe',
  'Haaland (Ultra)': 'Erling Haaland',
  'Messi (Icon)': 'Lionel Messi',
  'Vinicius (Ultra)': 'Vinicius Jr',
  'Bellingham (Ultra)': 'Jude Bellingham',
  'Van Dijk (Wall)': 'Virgil van Dijk',
  'Rodri (Prime)': 'Rodri',
  'Neuer (Titan)': 'Manuel Neuer',
  'Salah (Ultra)': 'Mohamed Salah',
  'Kane (Ultra)': 'Harry Kane',
  // 현역 클럽 로스터에 이미 있는 선수는 그 사진을 그대로 재사용
  'Cristiano Ronaldo (Icon)': 'Cristiano Ronaldo',
  'Luka Modric (Icon)': 'Luka Modric',
};

function canonicalImageName(name) {
  return IMG_ALIAS[name] || name;
}

function imageSlug(name) {
  return canonicalImageName(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The React frontend serves its static image assets from public/, which
// Vite strips from the URL (public/img/x.png -> served at /img/x.png) but
// NOT from the filesystem path — the files on disk are still under
// frontend/public/img, one level deeper than the vanilla frontend's
// frontend/img.
const IMG_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'img', 'players');
const TEAM_IMG_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'img', 'teams');
const imgMeta = new Map(); // slug -> { exists, v } (v = mtime, checked once per slug per process)

// frontend/server.js caches .png responses for 30 days as immutable, so
// swapping a file in place (same filename) never reaches clients who already
// fetched the old bytes. Tagging the URL with the file's mtime makes a
// replaced image a new URL, forcing a real re-fetch — this is baked in once
// at catalog build time, so it refreshes naturally on every deploy restart.
function statImg(filePath) {
  try {
    return { exists: true, v: Math.round(fs.statSync(filePath).mtimeMs) };
  } catch {
    return { exists: false, v: 0 };
  }
}

function imageUrlFor(name) {
  const slug = imageSlug(name);
  if (!imgMeta.has(slug)) imgMeta.set(slug, statImg(path.join(IMG_DIR, slug + '.png')));
  const meta = imgMeta.get(slug);
  return meta.exists ? `/img/players/${slug}.png?v=${meta.v}` : null;
}

function teamLogoFor(teamName) {
  if (!teamName) return null;
  const slug = imageSlug(teamName);
  const key = 'team:' + slug;
  if (!imgMeta.has(key)) imgMeta.set(key, statImg(path.join(TEAM_IMG_DIR, slug + '.png')));
  const meta = imgMeta.get(key);
  return meta.exists ? `/img/teams/${slug}.png?v=${meta.v}` : null;
}

// ---------------------------------------------------------------------------
// Build catalog
// ---------------------------------------------------------------------------

const CATALOG = {};      // id -> player
const TEAMS = {};        // name -> { name, type, color, playerIds }
const MARKET = [];       // [{ ...player, price }]

function priceFor(player) {
  const o = player.ovr;
  // Exponential-ish curve so top/enhanced players cost a lot more.
  let base = Math.round(Math.pow(Math.max(0, o - 60), 2.35) * 0.9) + 40;
  if (player.enhanced) base = Math.round(base * 1.7);
  return base;
}

// ISO2 -> flag emoji ('EN'/'SCT' render the England/Scotland flag sequences).
function flagEmoji(code) {
  if (!code) return null;
  if (code === 'EN') {
    return '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  }
  if (code === 'SCT') {
    return '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  }
  return [...code]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join('');
}

const BY_NAME = {}; // non-enhanced players, one entry per human

function registerPlayer(name, pos, ovr, nation, teamName, enhanced) {
  if (!enhanced && BY_NAME[name]) {
    throw new Error(`duplicate player definition: ${name}`);
  }
  const p = makePlayer([name, pos, ovr], teamName, enhanced);
  p.nation = nation || null;
  p.flag = flagEmoji(nation);
  p.img = imageUrlFor(p.name);
  p.teamLogo = teamLogoFor(teamName);
  CATALOG[p.id] = p;
  MARKET.push({ id: p.id, price: priceFor(p) });
  if (!enhanced) BY_NAME[name] = p;
  return p;
}

const ORIGINAL_CLUB_IDS = {}; // curated rosters as shipped (pre live-refresh)

Object.entries(CLUB_ROSTERS).forEach(([teamName, def]) => {
  const ids = def.roster.map(
    ([name, pos, ovr, nat]) => registerPlayer(name, pos, ovr, nat, teamName, false).id
  );
  ORIGINAL_CLUB_IDS[teamName] = [...ids];
  TEAMS[teamName] = {
    name: teamName,
    type: 'club',
    league: def.league || null,
    color: def.color,
    logo: teamLogoFor(teamName),
    playerIds: ids,
  };
});

Object.entries(NATIONAL_SQUADS).forEach(([squadName, def]) => {
  const ids = def.roster.map((entry) => {
    if (typeof entry === 'string') {
      const p = BY_NAME[entry];
      if (!p) throw new Error(`${squadName} squad references unknown player: ${entry}`);
      return p.id;
    }
    const [name, pos, ovr] = entry;
    return registerPlayer(name, pos, ovr, def.nation, null, false).id;
  });
  TEAMS[squadName] = {
    name: squadName,
    type: 'national',
    color: def.color,
    logo: teamLogoFor(squadName),
    playerIds: ids,
  };
});

MARKET_POOL.forEach(([name, pos, ovr, enhanced, nat]) => {
  registerPlayer(name, pos, ovr, nat, null, enhanced);
});

const PRICE_BY_ID = {};
MARKET.forEach((m) => { PRICE_BY_ID[m.id] = m.price; });

function getPlayer(id) {
  return CATALOG[id] || null;
}

function getPrice(id) {
  return PRICE_BY_ID[id] || null;
}

function publicPlayer(id) {
  const p = CATALOG[id];
  if (!p) return null;
  return { ...p, price: PRICE_BY_ID[id] || null };
}

// ---------------------------------------------------------------------------
// 선수 강화 (enhancement). Upgrade levels are per-user (user.upgrades:
// id -> level); the catalog card never changes. Each level adds +1 OVR and
// +1 to every attribute. A failed attempt burns the coins but keeps the level.
// ---------------------------------------------------------------------------

const ENHANCE = {
  maxLevel: 5,
  rates: [0.75, 0.6, 0.45, 0.3, 0.15], // success chance of reaching level 1..5
  costRate: 0.15, // attempt cost ≈ price * costRate * target level
};

// Boosted view of a card at the given upgrade level (p unchanged when 0).
function upgraded(p, level) {
  const lvl = Math.max(0, Math.min(ENHANCE.maxLevel, level | 0));
  if (!p || !lvl) return p;
  const attrs = {};
  Object.keys(p.attrs || {}).forEach((k) => {
    attrs[k] = clamp(p.attrs[k] + lvl, 24, 99);
  });
  return { ...p, ovr: Math.min(99, p.ovr + lvl), attrs, up: lvl };
}

function enhanceCost(id, level) {
  const price = getPrice(id) || 200; // youth/dynamic fillers have no market price
  return Math.max(50, Math.round(price * ENHANCE.costRate * level));
}

function teamList() {
  return Object.values(TEAMS).map((t) => ({
    name: t.name,
    type: t.type,
    league: t.league || null,
    color: t.color,
    logo: t.logo,
    playerIds: t.playerIds,
    ovr: Math.round(
      t.playerIds.slice(0, 11).reduce((s, id) => s + CATALOG[id].ovr, 0) / 11
    ),
  }));
}

function marketList() {
  return MARKET.map((m) => publicPlayer(m.id)).sort((a, b) => b.ovr - a.ovr);
}

// Normalized name index so live rosters can reuse existing tuned players
// ("Heung-min Son" and "Son Heung-min" resolve to the same person).
let NAME_INDEX = null;
function nameKey(n) {
  return String(n || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}
function findByName(name) {
  if (!NAME_INDEX) {
    NAME_INDEX = {};
    Object.values(CATALOG).forEach((p) => {
      if (!p.enhanced && !p.youth && !NAME_INDEX[nameKey(p.name)]) NAME_INDEX[nameKey(p.name)] = p;
    });
  }
  return NAME_INDEX[nameKey(name)] || null;
}

// Register (or live-refresh) a club roster copied from the real player DB.
// Rows with refId reuse an existing catalog player; new players get stable
// name-based ids ('d<teamId>_<slug>') so refreshes never change identities.
// def.replace lets a curated club's roster be replaced with the live copy.
function registerDynamicTeam(def) {
  const existing = TEAMS[def.name];
  if (existing && !def.replace) return existing;
  const ids = [];
  const seen = new Set();
  def.players.forEach((row) => {
    let id;
    if (row.refId && CATALOG[row.refId]) {
      id = row.refId;
    } else {
      id = 'd' + def.teamId + '_' + nameKey(row.name).replace(/ /g, '-').slice(0, 28);
      if (!CATALOG[id]) {
        const p = makePlayer([row.name, row.pos, row.ovr], def.name, false);
        p.id = id;
        p.nation = row.nation || null;
        p.flag = flagEmoji(row.nation);
        p.img = row.img || null;
        p.teamLogo = def.logo || (existing && existing.logo) || null;
        p.youth = !!row.youth; // generated academy filler — club-only, not drawable
        CATALOG[id] = p;
        PRICE_BY_ID[id] = priceFor(p);
        MARKET.push({ id, price: PRICE_BY_ID[id] });
        NAME_INDEX = null;
      } else if (def.replace) {
        // roster refresh: freshen display fields (fixed names, cached images)
        // without touching identity or tuned numbers (ovr/attrs/price)
        const p = CATALOG[id];
        p.name = row.name;
        if (row.nation) {
          p.nation = row.nation;
          p.flag = flagEmoji(row.nation);
        }
        if (row.img) p.img = row.img;
        NAME_INDEX = null;
      }
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  TEAMS[def.name] = {
    name: def.name,
    type: def.type || (existing && existing.type) || 'club',
    league: def.league || (existing && existing.league) || null,
    color: def.color || (existing && existing.color) || '#3b82f6',
    logo: def.logo || (existing && existing.logo) || null,
    playerIds: ids,
    dynamic: true,
  };
  return TEAMS[def.name];
}

function originalRoster(teamName) {
  return ORIGINAL_CLUB_IDS[teamName] || null;
}

// Register a single player found in the external DB (market search fallback
// for players missing from the curated rosters, e.g. recent transfers).
// Stable id 's<tsdbId>' so purchases survive restarts.
function registerSoloPlayer(def) {
  const id = 's' + def.tsdbId;
  if (CATALOG[id]) return CATALOG[id];
  const p = makePlayer([def.name, def.pos, def.ovr], def.team || null, false);
  p.id = id;
  p.nation = def.nation || null;
  p.flag = flagEmoji(def.nation);
  p.img = def.img || null;
  p.teamLogo = null;
  CATALOG[id] = p;
  PRICE_BY_ID[id] = priceFor(p);
  MARKET.push({ id, price: PRICE_BY_ID[id] });
  return p;
}

module.exports = {
  CATALOG,
  TEAMS,
  LINE,
  getPlayer,
  getPrice,
  publicPlayer,
  ENHANCE,
  upgraded,
  enhanceCost,
  teamList,
  marketList,
  registerDynamicTeam,
  registerSoloPlayer,
  findByName,
  originalRoster,
  canonicalImageName,
  imageSlug,
};
