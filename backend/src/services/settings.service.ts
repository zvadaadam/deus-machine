import { getDatabase } from '../lib/database';

export function getAllSettings(): Record<string, any> {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;

  const settings: Record<string, any> = {};
  rows.forEach(row => {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  });

  return settings;
}

export function saveSetting(key: string, value: any): void {
  const db = getDatabase();
  const serializedValue = JSON.stringify(value);

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, serializedValue);
}
