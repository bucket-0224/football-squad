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

let AUTO_ID = 1;

function makePlayer(row, teamName, enhanced) {
  const [name, pos, ovr] = row;
  const attrs = buildAttributes(name, pos, ovr);
  return {
    id: 'p' + AUTO_ID++,
    name,
    pos,
    line: LINE[pos] || 'MID',
    ovr,
    enhanced: !!enhanced,
    team: teamName || null,
    attrs,
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
];

// ---------------------------------------------------------------------------
// Player images.
//
// Transparent headshots live in public/img/players/<slug>.png, downloaded by
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

const IMG_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'players');
const TEAM_IMG_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'teams');
const imgExists = new Map(); // slug -> bool, checked once per slug

function imageUrlFor(name) {
  const slug = imageSlug(name);
  if (!imgExists.has(slug)) {
    imgExists.set(slug, fs.existsSync(path.join(IMG_DIR, slug + '.png')));
  }
  return imgExists.get(slug) ? `/img/players/${slug}.png` : null;
}

function teamLogoFor(teamName) {
  if (!teamName) return null;
  const slug = imageSlug(teamName);
  const key = 'team:' + slug;
  if (!imgExists.has(key)) {
    imgExists.set(key, fs.existsSync(path.join(TEAM_IMG_DIR, slug + '.png')));
  }
  return imgExists.get(key) ? `/img/teams/${slug}.png` : null;
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
  rates: [1, 0.8, 0.6, 0.4, 0.25], // success chance of reaching level 1..5
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
    type: 'club',
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
