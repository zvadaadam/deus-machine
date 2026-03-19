import type Database from 'better-sqlite3';

// Planets, moons, stars, and nebulae — memorable codenames for workspaces
const CELESTIAL_NAMES = [
  // Planets
  'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto',
  // Moons
  'luna', 'europa', 'titan', 'ganymede', 'callisto', 'io', 'enceladus', 'triton',
  'charon', 'phobos', 'deimos', 'miranda', 'oberon', 'titania', 'ariel', 'rhea',
  'dione', 'tethys', 'hyperion', 'mimas', 'iapetus', 'proteus', 'nereid', 'amalthea',
  // Stars
  'sirius', 'vega', 'polaris', 'rigel', 'altair', 'deneb', 'arcturus', 'antares',
  'aldebaran', 'spica', 'capella', 'procyon', 'castor', 'pollux', 'regulus', 'achernar',
  'canopus', 'fomalhaut', 'bellatrix', 'mimosa', 'shaula', 'gacrux', 'alioth', 'alkaid',
  // Nebulae & galaxies
  'orion', 'andromeda', 'carina', 'helix', 'vela', 'lyra', 'cygnus', 'draco',
  'phoenix', 'centauri', 'aquila', 'serpens', 'hydra', 'corona', 'fornax', 'sculptor',
  // Notable celestial objects
  'kepler', 'hubble', 'cassini', 'voyager', 'horizon', 'pulsar', 'quasar', 'nova',
  'nebula', 'cosmos', 'eclipse', 'zenith', 'solstice', 'equinox', 'aurora', 'comet',
];

export function generateUniqueName(db: Database.Database): string {
  const existingNames = db.prepare('SELECT slug FROM workspaces')
    .all()
    .map((w: any) => w.slug);

  // Try random celestial names first (100 attempts)
  for (let i = 0; i < 100; i++) {
    const name = CELESTIAL_NAMES[Math.floor(Math.random() * CELESTIAL_NAMES.length)];
    if (!existingNames.includes(name)) {
      return name;
    }
  }

  // If all names taken, add version suffix (100 attempts)
  for (let i = 0; i < 100; i++) {
    const name = CELESTIAL_NAMES[Math.floor(Math.random() * CELESTIAL_NAMES.length)];
    const versionedName = `${name}-v${Math.floor(Math.random() * 100)}`;
    if (!existingNames.includes(versionedName)) {
      return versionedName;
    }
  }

  // Fallback to timestamp
  return `workspace-${Date.now()}`;
}

export { CELESTIAL_NAMES };
