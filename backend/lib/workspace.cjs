/**
 * Workspace Utilities Module
 *
 * Provides utility functions for workspace operations:
 * - Generating unique workspace names (city names)
 * - Git diff statistics
 * - PR status checking via gh CLI
 *
 * @module workspace
 */

/**
 * List of city names for auto-generating workspace names
 * @type {string[]}
 */
const CITY_NAMES = [
  'tokyo', 'delhi', 'shanghai', 'sao-paulo', 'mexico-city', 'cairo', 'mumbai', 'beijing',
  'dhaka', 'osaka', 'new-york', 'karachi', 'buenos-aires', 'chongqing', 'istanbul',
  'kolkata', 'manila', 'lagos', 'rio-de-janeiro', 'tianjin', 'kinshasa', 'guangzhou',
  'los-angeles', 'moscow', 'shenzhen', 'lahore', 'bangalore', 'paris', 'bogota', 'jakarta',
  'chennai', 'lima', 'bangkok', 'seoul', 'nagoya', 'hyderabad', 'london', 'tehran',
  'chicago', 'chengdu', 'nanjing', 'wuhan', 'ho-chi-minh-city', 'luanda', 'ahmedabad',
  'kuala-lumpur', 'xian', 'hong-kong', 'dongguan', 'hangzhou', 'foshan', 'shenyang',
  'riyadh', 'baghdad', 'santiago', 'surat', 'madrid', 'suzhou', 'pune', 'harbin',
  'houston', 'dallas', 'toronto', 'dar-es-salaam', 'miami', 'belo-horizonte', 'singapore',
  'philadelphia', 'atlanta', 'fukuoka', 'khartoum', 'barcelona', 'johannesburg', 'qingdao',
  'dalian', 'washington', 'yangon', 'alexandria', 'jinan', 'guadalajara', 'amman', 'kabul',
  'hartford', 'richmond', 'worcester', 'mumbai', 'freetown', 'montevideo', 'pattaya'
];

/**
 * Generate a unique city name for a new workspace
 *
 * Tries to find an unused city name from the list. If all are taken,
 * adds a version suffix. Falls back to timestamp if needed.
 *
 * @param {Database.Database} db - The database instance
 * @returns {string} A unique workspace name
 */
function generateUniqueCityName(db) {
  // Get all existing workspace names
  const existingNames = db.prepare('SELECT directory_name FROM workspaces')
    .all()
    .map(w => w.directory_name);

  // Try random cities first (100 attempts)
  for (let i = 0; i < 100; i++) {
    const city = CITY_NAMES[Math.floor(Math.random() * CITY_NAMES.length)];
    if (!existingNames.includes(city)) {
      return city;
    }
  }

  // If all cities taken, add version suffix (100 attempts)
  for (let i = 0; i < 100; i++) {
    const city = CITY_NAMES[Math.floor(Math.random() * CITY_NAMES.length)];
    const versionedName = `${city}-v${Math.floor(Math.random() * 100)}`;
    if (!existingNames.includes(versionedName)) {
      return versionedName;
    }
  }

  // Fallback to timestamp
  return `workspace-${Date.now()}`;
}

module.exports = {
  generateUniqueCityName,
  CITY_NAMES
};
