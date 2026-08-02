// 資料庫層 — 使用 Node.js 22 內建的 node:sqlite（DatabaseSync），不需安裝任何外部套件。
// 正式上線若需要多台伺服器共用資料、更高併發，可比照這裡的 SQL 改寫成 PostgreSQL / MySQL。
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, '..', 'data', 'checkin.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
try {
    db.exec('PRAGMA journal_mode = DELETE;');
} catch (e) {
    console.warn('設定 journal_mode 失敗，使用資料庫預設值：', e.message);
}
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  employee_no TEXT PRIMARY KEY,
    name TEXT NOT NULL,
      device_id TEXT,
        bound_at TEXT
        );

        CREATE TABLE IF NOT EXISTS punches (
          id TEXT PRIMARY KEY,
            employee_no TEXT NOT NULL,
              name TEXT,
                type TEXT NOT NULL,
                  label TEXT,
                    timestamp TEXT NOT NULL,
                      verified_by TEXT,
                        verify_detail TEXT,
                          distance_km REAL,
                            reason TEXT,
                              status TEXT NOT NULL,
                                submitted_at TEXT,
                                  reviewed_at TEXT,
                                    location_suspicious INTEGER NOT NULL DEFAULT 0
                                    );
                                    CREATE INDEX IF NOT EXISTS idx_punches_emp ON punches(employee_no);

                                    CREATE TABLE IF NOT EXISTS admin_config (
                                      id INTEGER PRIMARY KEY CHECK (id = 1),
                                        lat REAL NOT NULL,
                                          lng REAL NOT NULL,
                                            radius_km REAL NOT NULL,
                                              allowed_ips TEXT NOT NULL
                                              );

                                              CREATE TABLE IF NOT EXISTS admin_users (
                                                username TEXT PRIMARY KEY,
                                                  password_hash TEXT NOT NULL,
                                                    salt TEXT NOT NULL,
                                                      created_at TEXT NOT NULL,
                                                        must_change_password INTEGER NOT NULL DEFAULT 0
                                                        );

                                                        CREATE TABLE IF NOT EXISTS admin_sessions (
                                                          token TEXT PRIMARY KEY,
                                                            username TEXT NOT NULL,
                                                              created_at TEXT NOT NULL,
                                                                expires_at TEXT NOT NULL
                                                                );
                                                                `);

// 員工時薪欄位：用於「班表時數 × 時薪」自動試算薪資（超過 8 小時的部分以 1.33 倍計算）。
// 用 PRAGMA table_info 檢查欄位是否已存在，避免舊資料庫重複執行 ALTER TABLE 而出錯。
const empColumns = db.prepare('PRAGMA table_info(employees)').all();
if (!empColumns.some((c) => c.name === 'hourly_wage')) {
    db.exec('ALTER TABLE employees ADD COLUMN hourly_wage REAL NOT NULL DEFAULT 0');
}

const hasConfig = db.prepare('SELECT 1 FROM admin_config WHERE id = 1').get();
if (!hasConfig) {
    db.prepare(
          'INSERT INTO admin_config (id, lat, lng, radius_km, allowed_ips) VALUES (1, ?, ?, ?, ?)'
        ).run(25.033, 121.5654, 5, JSON.stringify(['127.0.0.1', '::1', '::ffff:127.0.0.1']));
}

const LEGACY_JSON = path.join(__dirname, '..', 'db.json');
const MIGRATED_MARK = path.join(__dirname, '..', 'data', '.migrated-from-json');
if (fs.existsSync(LEGACY_JSON) && !fs.existsSync(MIGRATED_MARK)) {
    try {
          const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf-8'));
          const insEmp = db.prepare(
                  'INSERT OR IGNORE INTO employees (employee_no, name, device_id, bound_at) VALUES (?, ?, ?, ?)'
                );
          for (const e of legacy.employees || []) {
                  insEmp.run(e.employeeNo, e.name, e.deviceId || null, e.boundAt || null);
          }
          const insPunch = db.prepare(`INSERT OR IGNORE INTO punches
                (id, employee_no, name, type, label, timestamp, verified_by, verify_detail, distance_km, reason, status, submitted_at, reviewed_at, location_suspicious)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
          for (const p of legacy.punches || []) {
                  insPunch.run(
                            p.id, p.employeeNo, p.name || null, p.type, p.label || null, p.timestamp,
                            p.verifiedBy || null, p.verifyDetail || null, p.distanceKm || null,
                            p.reason || null, p.status, p.submittedAt || null, p.reviewedAt || null
                          );
          }
          if (legacy.adminConfig) {
                  db.prepare('UPDATE admin_config SET lat=?, lng=?, radius_km=?, allowed_ips=? WHERE id=1').run(
                            legacy.adminConfig.geofence.lat,
                            legacy.adminConfig.geofence.lng,
                            legacy.adminConfig.geofence.radiusKm,
                            JSON.stringify(legacy.adminConfig.allowedIPs || [])
                          );
          }
          fs.writeFileSync(MIGRATED_MARK, new Date().toISOString());
          console.log('已將舊版 db.json 資料搬移至 SQLite（data/checkin.db）。');
    } catch (e) {
          console.warn('搬移舊版 db.json 資料時發生錯誤，已略過：', e.message);
    }
}

module.exports = db;
