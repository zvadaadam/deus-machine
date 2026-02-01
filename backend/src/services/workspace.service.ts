import type Database from 'better-sqlite3';

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
  'hartford', 'richmond', 'worcester', 'brisbane', 'freetown', 'montevideo', 'pattaya',
];

export function generateUniqueCityName(db: Database.Database): string {
  const existingNames = db.prepare('SELECT directory_name FROM workspaces')
    .all()
    .map((w: any) => w.directory_name);

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

export { CITY_NAMES };
