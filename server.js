// 員工打卡系統 — 後端 API（正式上線強化版）
// 零外部相依套件：資料庫用 Node 22 內建 node:sqlite，管理者驗證用 Node 內建 crypto，
// 只要有 Node.js 22+ 就能直接 `node server.js` 執行。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const db = require('./lib/db');
const auth = require('./lib/auth');
const sheetsApi = require('./lib/sheets');

const PUBLIC_DIR = path.join(__dirname, 'public');

const initialAdmin = auth.ensureInitialAdmin();
if (initialAdmin) {
    console.log('============================================================');
    console.log('已建立管理者帳號（首次啟動）：');
    console.log(`  帳號：${initialAdmin.username}`);
    console.log(`  密碼：${initialAdmin.password}`);
    console.log(`  （同時已寫入 data/INITIAL_ADMIN_PASSWORD.txt，登入後請立即改密碼並刪除該檔案）`);
    console.log('============================================================');
}

function distanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

function todayStr(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

// 班表時間換算：以公司所在時區（Asia/Taipei, UTC+8）的實際打卡時鐘為準，
// 每小時 11~40 分登錄為該小時的 30 分，41 分~下個整點 10 分登錄為下個整點。
function pad2(n) {
    return String(n).padStart(2, '0');
}

// 打卡時間顯示換算：資料庫內儲存的 timestamp 是 UTC ISO 字串，
// 匯出到 Google Sheet 給人看時，必須換算成公司所在時區（Asia/Taipei, UTC+8）
// 的實際時間，否則會與「班表時間」欄位相差 8 小時、造成混淆。
function formatTaipeiDateTime(isoTimestamp) {
    const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
    const d = new Date(isoTimestamp);
    const local = new Date(d.getTime() + TZ_OFFSET_MS);
    return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ${pad2(
          local.getUTCHours()
        )}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
}

function computeScheduleTime(isoTimestamp) {
    const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Taipei，固定 UTC+8，無日光節約
    const d = new Date(isoTimestamp);
    const local = new Date(d.getTime() + TZ_OFFSET_MS);
    const bucket = new Date(
          Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours(), 0, 0, 0)
        );
    const m = local.getUTCMinutes();
    if (m <= 10) {
          // 維持整點
    } else if (m <= 40) {
          bucket.setUTCMinutes(30);
    } else {
          bucket.setUTCMinutes(60); // 自動進位到下一個整點（含跨小時/跨日）
    }
    return `${bucket.getUTCFullYear()}-${pad2(bucket.getUTCMonth() + 1)}-${pad2(bucket.getUTCDate())} ${pad2(
          bucket.getUTCHours()
        )}:${pad2(bucket.getUTCMinutes())}`;
}

// 將前端「不含時區」的本地時間字串（<input type="datetime-local"> 格式：YYYY-MM-DDTHH:MM）
// 解析成公司時區（Asia/Taipei, UTC+8）對應的正確 UTC ISO 字串，供寫入 timestamp 欄位使用。
// 明確補上 +08:00 時區位移，確保無論伺服器所在時區為何，換算結果都正確
// （避免伺服器跑在 UTC 時，把本地時間誤判成 UTC 時間，導致差 8 小時）。
function taipeiLocalToISO(localStr) {
    return new Date(`${localStr}:00+08:00`).toISOString();
}

// 把 UTC ISO 時間字串換算成台北時間、格式化成 <input type="datetime-local"> 可用的值
// （YYYY-MM-DDTHH:MM），用於管理者編輯打卡記錄時，先把目前時間帶入輸入框。
function toDatetimeLocalValue(isoTimestamp) {
    return formatTaipeiDateTime(isoTimestamp).replace(' ', 'T').slice(0, 16);
}

function getAdminConfig() {
    const row = db.prepare('SELECT * FROM admin_config WHERE id = 1').get();
    return {
          geofence: { lat: row.lat, lng: row.lng, radiusKm: row.radius_km },
          allowedIPs: JSON.parse(row.allowed_ips),
    };
}

function verifyDevice(employeeNo, deviceId) {
    const emp = db.prepare('SELECT * FROM employees WHERE employee_no = ?').get(employeeNo);
    if (!emp) return { ok: false, error: '查無此員工編號，請先綁定裝置' };
    if (emp.device_id !== deviceId) {
          return { ok: false, error: '裝置未綁定或與登記裝置不符，請聯繫管理者' };
    }
    return { ok: true, emp };
}

function verifyLocationOrNetwork(req, lat, lng, accuracy) {
    const { geofence, allowedIPs } = getAdminConfig();
    const clientIp = getClientIp(req);

  const suspicious =
        typeof accuracy === 'number' && (accuracy <= 0 || (accuracy === Math.floor(accuracy) && accuracy <= 1));

  if (Array.isArray(allowedIPs) && allowedIPs.includes(clientIp)) {
        return { ok: true, method: 'wifi_ip', detail: `來源 IP ${clientIp} 在允許名單內（視為公司 WiFi）`, suspicious };
  }

  if (typeof lat === 'number' && typeof lng === 'number') {
        const dist = distanceKm(lat, lng, geofence.lat, geofence.lng);
        if (dist <= geofence.radiusKm) {
                return {
                          ok: true,
                          method: 'gps',
                          detail: `距離指定地點 ${dist.toFixed(2)} 公里`,
                          distanceKm: dist,
                          suspicious,
                };
        }
        return {
                ok: false,
                error: `不在允許範圍內（距離 ${dist.toFixed(2)} 公里，允許 ${geofence.radiusKm} 公里），也未偵測到公司 WiFi`,
                distanceKm: dist,
        };
  }

  return { ok: false, error: '無法取得定位資訊，且未偵測到公司 WiFi，請開啟定位權限或連接公司網路' };
}

const PUNCH_TYPES = ['check-in', 'break-start', 'break-end', 'check-out'];
const PUNCH_LABEL = {
    'check-in': '上班打卡',
    'break-start': '休息開始',
    'break-end': '休息結束',
    'check-out': '下班打卡',
};

const STATUS_LABEL = {
    confirmed: '已確認',
    pending_approval: '待審核',
    rejected: '已拒絕',
};

const VERIFY_LABEL = {
    gps: 'GPS 定位',
    wifi_ip: '公司 WiFi',
    manual_request: '人工補登',
    admin_manual: '管理者補登',
};

const SHEET_EXPORT_HEADER = ['員工編號', '姓名', '打卡類型', '班表時間', '打卡時間', '狀態', '驗證方式', '驗證/備註', '匯出時間'];

// 匯出到 Google Sheet 時「不同員工以不同底色區分」使用的顏色。
// 依員工編號做簡單雜湊、固定對應到 8 種顏色其中一種（跟 public/admin.js 的
// employeeColorClass() 用同一套雜湊公式，色相也大致對應），只是這裡改用適合
// 白底試算表的淺色版本，背景淺色搭配試算表預設的黑字仍清楚易讀。
const EMP_COLOR_COUNT = 8;
const SHEET_EMP_COLORS = [
    { red: 0.8627, green: 0.9098, blue: 1.0 }, // 0 藍
    { red: 0.9529, green: 0.9020, blue: 0.7686 }, // 1 金
    { red: 0.8431, green: 0.9608, blue: 0.8824 }, // 2 綠
    { red: 0.9882, green: 0.9373, blue: 0.8078 }, // 3 琥珀
    { red: 0.9843, green: 0.8706, blue: 0.8588 }, // 4 紅
    { red: 0.9059, green: 0.8745, blue: 0.9882 }, // 5 紫
    { red: 0.8510, green: 0.9529, blue: 0.9882 }, // 6 青
    { red: 0.9882, green: 0.8745, blue: 0.9373 }, // 7 粉
];
function employeeColorIndex(employeeNo) {
    const str = String(employeeNo || '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
          hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash % EMP_COLOR_COUNT;
}
function sheetEmployeeColor(employeeNo) {
    return SHEET_EMP_COLORS[employeeColorIndex(employeeNo)];
}

// 薪資試算規則：以「班表時間」（已依 10/30/60 分規則捨入的整點/半點）為準計算工時，
// 當日工時超過 8 小時的部分，超過時數以 1.33 倍時薪計算。
const NORMAL_DAILY_HOURS = 8;
const OVERTIME_MULTIPLIER = 1.33;

// 將「YYYY-MM-DD HH:MM」格式的班表時間字串轉成可比較大小的 Date（僅用於同一天內的時數相減，
// 使用 UTC 建構避免受伺服器所在時區影響換算結果）。
function scheduleTimeToDate(scheduleTimeStr) {
    const [datePart, timePart] = scheduleTimeStr.split(' ');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm] = (timePart || '0:0').split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
}

// 依「員工編號」把打卡紀錄依時間排序後，用「配對上下班」的方式算出每一班的工時，
// 而不是單純用「班表時間的日期」分組——後者遇到跨午夜的班（例如晚上 10 點上班、
// 隔天凌晨 1 點下班）會把上班和下班拆到兩個不同日期的分組，導致兩邊都判定成
// 「當天缺打卡」而無法計算工時。改成配對後，一整班無論是否跨過午夜 12 點，
// 都會被視為同一班、正確算出工時，並歸屬到「上班」那一天。
// 休息開始/結束若落在該班的上下班之間，也會從工時中扣除；
// 該班總工時超過 8 小時的部分，以 1.33 倍計算。
function computeDailyPayroll(rows) {
    const byEmployee = new Map();
    for (const r of rows) {
          const scheduleTime = computeScheduleTime(r.timestamp);
          if (!byEmployee.has(r.employee_no)) {
                byEmployee.set(r.employee_no, { employeeNo: r.employee_no, name: r.name, punches: [] });
          }
          byEmployee.get(r.employee_no).punches.push({ type: r.type, scheduleTime, at: scheduleTimeToDate(scheduleTime) });
    }

    function finishShift(days, emp, shift, checkOut) {
          let workedMs = checkOut.at - shift.checkIn.at - shift.breakMs;
          if (workedMs < 0) workedMs = 0;
          const workedHours = workedMs / 3600000;
          const normalHours = Math.min(workedHours, NORMAL_DAILY_HOURS);
          const overtimeHours = Math.max(workedHours - NORMAL_DAILY_HOURS, 0);
          days.push({
                employeeNo: emp.employeeNo,
                name: emp.name,
                date: shift.checkIn.scheduleTime.slice(0, 10),
                checkIn: shift.checkIn.scheduleTime,
                checkOut: checkOut.scheduleTime,
                breakHours: Math.round((shift.breakMs / 3600000) * 100) / 100,
                workedHours: Math.round(workedHours * 100) / 100,
                normalHours: Math.round(normalHours * 100) / 100,
                overtimeHours: Math.round(overtimeHours * 100) / 100,
          });
    }

    const days = [];
    for (const emp of byEmployee.values()) {
          emp.punches.sort((a, b) => a.at - b.at);

          let openShift = null;
          for (const p of emp.punches) {
                if (p.type === 'check-in') {
                      if (openShift) {
                            // 上一班還沒打下班卡，又出現新的上班打卡：視為上一班缺下班打卡。
                            days.push({
                                  employeeNo: emp.employeeNo, name: emp.name,
                                  date: openShift.checkIn.scheduleTime.slice(0, 10), incomplete: true,
                                  note: '缺下班打卡，無法計入該日工時',
                            });
                      }
                      openShift = { checkIn: p, breakStartOpen: null, breakMs: 0 };
                } else if (p.type === 'break-start') {
                      if (openShift && !openShift.breakStartOpen) openShift.breakStartOpen = p;
                } else if (p.type === 'break-end') {
                      if (openShift && openShift.breakStartOpen) {
                            openShift.breakMs += p.at - openShift.breakStartOpen.at;
                            openShift.breakStartOpen = null;
                      }
                } else if (p.type === 'check-out') {
                      if (!openShift) {
                            days.push({
                                  employeeNo: emp.employeeNo, name: emp.name,
                                  date: p.scheduleTime.slice(0, 10), incomplete: true,
                                  note: '缺上班打卡，無法計入該日工時',
                            });
                            continue;
                      }
                      finishShift(days, emp, openShift, p);
                      openShift = null;
                }
          }
          if (openShift) {
                days.push({
                      employeeNo: emp.employeeNo, name: emp.name,
                      date: openShift.checkIn.scheduleTime.slice(0, 10), incomplete: true,
                      note: '缺下班打卡，無法計入該日工時',
                });
          }
    }

    days.sort((a, b) =>
          a.employeeNo === b.employeeNo
            ? a.date.localeCompare(b.date)
            : String(a.employeeNo).localeCompare(String(b.employeeNo), undefined, { numeric: true })
        );
    return days;
}

const routes = [];
function addRoute(method, routePath, handler) {
    const keys = [];
    const pattern = new RegExp(
          '^' +
            routePath
              .split('/')
              .map((seg) => {
                          if (seg.startsWith(':')) {
                                        keys.push(seg.slice(1));
                                        return '([^/]+)';
                          }
                          return seg;
              })
              .join('/') +
            '$'
        );
    routes.push({ method, pattern, keys, handler });
}

function sendJSON(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => (data += chunk));
          req.on('end', () => {
                  if (!data) return resolve({});
                  try {
                            resolve(JSON.parse(data));
                  } catch (e) {
                            reject(new Error('Invalid JSON body'));
                  }
          });
          req.on('error', reject);
    });
}

function requireAdmin(req, res) {
    const cookies = auth.parseCookies(req);
    const session = auth.getSession(cookies[auth.COOKIE_NAME]);
    if (!session) {
          sendJSON(res, 401, { error: '請先登入管理者後台' });
          return null;
    }
    return session;
}

addRoute('POST', '/api/bind', async (req, res) => {
    const { employeeNo, name, deviceId } = await readBody(req);
    if (!employeeNo || !name || !deviceId) {
          return sendJSON(res, 400, { error: '缺少員工編號、姓名或裝置識別碼' });
    }
    const emp = db.prepare('SELECT * FROM employees WHERE employee_no = ?').get(employeeNo);

           if (!emp) {
                 db.prepare('INSERT INTO employees (employee_no, name, device_id, bound_at) VALUES (?, ?, ?, ?)').run(
                         employeeNo, name, deviceId, new Date().toISOString()
                       );
                 return sendJSON(res, 200, { ok: true, employee: { employeeNo, name, deviceId }, message: '裝置綁定成功' });
           }

           if (emp.device_id && emp.device_id !== deviceId) {
                 return sendJSON(res, 409, { error: '此員工編號已綁定其他裝置，如需更換裝置請聯繫管理者重設綁定' });
           }

           db.prepare('UPDATE employees SET device_id = ?, name = ? WHERE employee_no = ?').run(deviceId, name, employeeNo);
    sendJSON(res, 200, { ok: true, employee: { employeeNo, name, deviceId }, message: '裝置已確認綁定' });
});

addRoute('POST', '/api/punch', async (req, res) => {
    const { employeeNo, deviceId, type, lat, lng, accuracy } = await readBody(req);
    if (!PUNCH_TYPES.includes(type)) return sendJSON(res, 400, { error: '不支援的打卡類型' });

           const dev = verifyDevice(employeeNo, deviceId);
    if (!dev.ok) return sendJSON(res, 403, { error: dev.error });

           const verify = verifyLocationOrNetwork(req, lat, lng, accuracy);
    if (!verify.ok) return sendJSON(res, 403, { error: verify.error });

           const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO punches
        (id, employee_no, name, type, label, timestamp, verified_by, verify_detail, distance_km, status, location_suspicious)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
                 ).run(id, employeeNo, dev.emp.name, type, PUNCH_LABEL[type], timestamp, verify.method, verify.detail, verify.distanceKm || null, verify.suspicious ? 1 : 0);

           sendJSON(res, 200, {
                 ok: true,
                 record: {
                         id, employeeNo, name: dev.emp.name, type, label: PUNCH_LABEL[type], timestamp,
                         verifiedBy: verify.method, verifyDetail: verify.detail, status: 'confirmed',
                 },
           });
});

addRoute('POST', '/api/forgot-punch', async (req, res) => {
    const { employeeNo, deviceId, type, time, reason } = await readBody(req);
    if (!PUNCH_TYPES.includes(type)) return sendJSON(res, 400, { error: '不支援的打卡類型' });
    if (!time || !reason) return sendJSON(res, 400, { error: '請填寫補登時間與原因' });

           const dev = verifyDevice(employeeNo, deviceId);
    if (!dev.ok) return sendJSON(res, 403, { error: dev.error });

           const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const timestamp = taipeiLocalToISO(time);
    const submittedAt = new Date().toISOString();
    db.prepare(`INSERT INTO punches
        (id, employee_no, name, type, label, timestamp, verified_by, reason, status, submitted_at, location_suspicious)
            VALUES (?, ?, ?, ?, ?, ?, 'manual_request', ?, 'pending_approval', ?, 0)`
                 ).run(id, employeeNo, dev.emp.name, type, PUNCH_LABEL[type], timestamp, reason, submittedAt);

           sendJSON(res, 200, {
                 ok: true,
                 record: { id, employeeNo, name: dev.emp.name, type, label: PUNCH_LABEL[type], timestamp, reason, status: 'pending_approval' },
                 message: '補登申請已送出，待管理者審核',
           });
});

function rowToRecord(r) {
    return {
          id: r.id, employeeNo: r.employee_no, name: r.name, type: r.type, label: r.label,
          timestamp: r.timestamp, localTime: toDatetimeLocalValue(r.timestamp),
          verifiedBy: r.verified_by, verifyDetail: r.verify_detail,
          distanceKm: r.distance_km, reason: r.reason, status: r.status,
          submittedAt: r.submitted_at, reviewedAt: r.reviewed_at,
          locationSuspicious: !!r.location_suspicious,
    };
}

addRoute('GET', '/api/history', async (req, res, params, query) => {
    const { employeeNo, from, to } = query;
    if (!employeeNo) return sendJSON(res, 400, { error: '缺少員工編號' });
    let sql = 'SELECT * FROM punches WHERE employee_no = ?';
    const args = [employeeNo];
    if (from) { sql += ' AND timestamp >= ?'; args.push(from); }
    if (to) { sql += ' AND timestamp <= ?'; args.push(to + 'T23:59:59'); }
    sql += ' ORDER BY timestamp DESC';
    const rows = db.prepare(sql).all(...args);
    sendJSON(res, 200, { ok: true, records: rows.map(rowToRecord) });
});

addRoute('GET', '/api/status', async (req, res, params, query) => {
    const { employeeNo } = query;
    const rows = db
      .prepare(
              "SELECT * FROM punches WHERE employee_no = ? AND status = 'confirmed' AND timestamp LIKE ? ORDER BY timestamp ASC"
            )
      .all(employeeNo, todayStr() + '%');
    const last = rows[rows.length - 1];
    sendJSON(res, 200, { ok: true, lastType: last ? last.type : null, lastAt: last ? last.timestamp : null });
});

addRoute('POST', '/api/admin/login', async (req, res) => {
    const ip = getClientIp(req);
    if (auth.isLockedOut(ip)) {
          return sendJSON(res, 429, { error: '登入失敗次數過多，請 1 分鐘後再試' });
    }
    const { username, password } = await readBody(req);
    if (!username || !password) return sendJSON(res, 400, { error: '請輸入帳號密碼' });

           const user = auth.verifyPassword(username, password);
    if (!user) {
          auth.recordFailedAttempt(ip);
          return sendJSON(res, 401, { error: '帳號或密碼錯誤' });
    }
    auth.clearFailedAttempts(ip);
    const { token, expiresAt } = auth.createSession(username);
    auth.setSessionCookie(res, token, expiresAt);
    sendJSON(res, 200, { ok: true, username, mustChangePassword: !!user.must_change_password });
});

addRoute('POST', '/api/admin/logout', async (req, res) => {
    const cookies = auth.parseCookies(req);
    if (cookies[auth.COOKIE_NAME]) auth.destroySession(cookies[auth.COOKIE_NAME]);
    auth.clearSessionCookie(res);
    sendJSON(res, 200, { ok: true });
});

addRoute('GET', '/api/admin/me', async (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return;
    sendJSON(res, 200, { ok: true, username: session.username });
});

addRoute('POST', '/api/admin/change-password', async (req, res) => {
    const session = requireAdmin(req, res);
    if (!session) return;
    const { currentPassword, newPassword } = await readBody(req);
    if (!newPassword || newPassword.length < 8) {
          return sendJSON(res, 400, { error: '新密碼至少需要 8 碼' });
    }
    const ok = auth.verifyPassword(session.username, currentPassword || '');
    if (!ok) return sendJSON(res, 401, { error: '目前密碼不正確' });
    auth.changePassword(session.username, newPassword);
    sendJSON(res, 200, { ok: true, message: '密碼已更新' });
});

addRoute('GET', '/api/admin/config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    sendJSON(res, 200, { ok: true, config: getAdminConfig() });
});

addRoute('POST', '/api/admin/config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { lat, lng, radiusKm, allowedIPs } = await readBody(req);
    const current = db.prepare('SELECT * FROM admin_config WHERE id = 1').get();
    db.prepare('UPDATE admin_config SET lat=?, lng=?, radius_km=?, allowed_ips=? WHERE id=1').run(
          typeof lat === 'number' ? lat : current.lat,
          typeof lng === 'number' ? lng : current.lng,
          typeof radiusKm === 'number' ? radiusKm : current.radius_km,
          Array.isArray(allowedIPs) ? JSON.stringify(allowedIPs) : current.allowed_ips
        );
    sendJSON(res, 200, { ok: true, config: getAdminConfig() });
});

addRoute('GET', '/api/admin/employees', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare('SELECT employee_no, name, device_id, bound_at, hourly_wage FROM employees').all();
    sendJSON(res, 200, {
          ok: true,
          employees: rows.map((e) => ({
                employeeNo: e.employee_no,
                name: e.name,
                deviceId: e.device_id,
                boundAt: e.bound_at,
                hourlyWage: e.hourly_wage || 0,
          })),
    });
});

addRoute('POST', '/api/admin/employees/:employeeNo/wage', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const { hourlyWage } = await readBody(req);
    if (typeof hourlyWage !== 'number' || !isFinite(hourlyWage) || hourlyWage < 0) {
          return sendJSON(res, 400, { error: '時薪必須是大於等於 0 的數字' });
    }
    const emp = db.prepare('SELECT * FROM employees WHERE employee_no = ?').get(params.employeeNo);
    if (!emp) return sendJSON(res, 404, { error: '查無此員工' });
    db.prepare('UPDATE employees SET hourly_wage = ? WHERE employee_no = ?').run(hourlyWage, params.employeeNo);
    sendJSON(res, 200, { ok: true, message: `${emp.name}（${emp.employee_no}）時薪已更新為 ${hourlyWage}` });
});

addRoute('GET', '/api/admin/payroll', async (req, res, params, query) => {
    if (!requireAdmin(req, res)) return;
    const { employeeNo, from, to } = query;

    let sql = "SELECT * FROM punches WHERE status = 'confirmed'";
    const args = [];
    if (employeeNo) { sql += ' AND employee_no = ?'; args.push(employeeNo); }
    if (from) { sql += ' AND timestamp >= ?'; args.push(from); }
    if (to) { sql += ' AND timestamp <= ?'; args.push(to + 'T23:59:59'); }
    sql += ' ORDER BY timestamp ASC';
    const rows = db.prepare(sql).all(...args);

    const days = computeDailyPayroll(rows);

    const wageRows = db.prepare('SELECT employee_no, hourly_wage FROM employees').all();
    const wageMap = {};
    wageRows.forEach((w) => { wageMap[w.employee_no] = w.hourly_wage || 0; });

    const summaryMap = new Map();
    for (const d of days) {
          if (!summaryMap.has(d.employeeNo)) {
                summaryMap.set(d.employeeNo, {
                      employeeNo: d.employeeNo,
                      name: d.name,
                      hourlyWage: wageMap[d.employeeNo] || 0,
                      normalHours: 0,
                      overtimeHours: 0,
                      incompleteDays: 0,
                });
          }
          const s = summaryMap.get(d.employeeNo);
          if (d.incomplete) {
                s.incompleteDays += 1;
                continue;
          }
          s.normalHours += d.normalHours;
          s.overtimeHours += d.overtimeHours;
    }

    const summary = Array.from(summaryMap.values()).map((s) => {
          const normalHours = Math.round(s.normalHours * 100) / 100;
          const overtimeHours = Math.round(s.overtimeHours * 100) / 100;
          const pay = Math.round(normalHours * s.hourlyWage + overtimeHours * s.hourlyWage * OVERTIME_MULTIPLIER);
          return {
                employeeNo: s.employeeNo,
                name: s.name,
                hourlyWage: s.hourlyWage,
                normalHours,
                overtimeHours,
                totalHours: Math.round((normalHours + overtimeHours) * 100) / 100,
                incompleteDays: s.incompleteDays,
                pay,
          };
    });

    sendJSON(res, 200, { ok: true, days, summary });
});

addRoute('POST', '/api/admin/employees/:employeeNo/reset-device', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const emp = db.prepare('SELECT * FROM employees WHERE employee_no = ?').get(params.employeeNo);
    if (!emp) return sendJSON(res, 404, { error: '查無此員工' });
    db.prepare('UPDATE employees SET device_id = NULL WHERE employee_no = ?').run(params.employeeNo);
    sendJSON(res, 200, { ok: true, message: `${emp.name}（${emp.employee_no}）的裝置綁定已重設` });
});

addRoute('GET', '/api/admin/forgot-requests', async (req, res, params, query) => {
    if (!requireAdmin(req, res)) return;
    const status = query.status || 'pending_approval';
    const rows = db
      .prepare("SELECT * FROM punches WHERE verified_by = 'manual_request' AND status = ?")
      .all(status);
    sendJSON(res, 200, { ok: true, records: rows.map(rowToRecord) });
});

addRoute('POST', '/api/admin/forgot-requests/:id/:action', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const { id, action } = params;
    if (!['approve', 'reject'].includes(action)) return sendJSON(res, 400, { error: '無效操作' });
    const record = db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
    if (!record) return sendJSON(res, 404, { error: '查無此申請' });
    const status = action === 'approve' ? 'confirmed' : 'rejected';
    db.prepare('UPDATE punches SET status = ?, reviewed_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    sendJSON(res, 200, { ok: true, record: rowToRecord({ ...record, status }) });
});

// 打卡記錄管理：讓管理者可直接新增、查詢、編輯（類型/時間/狀態）、刪除打卡記錄，
// 用於補登員工忘記或無法打卡的紀錄、修正重複打卡、打錯卡等情況，
// 避免匯出的資料與實際情況不符。
addRoute('POST', '/api/admin/punches', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { employeeNo, type, localTime, note } = await readBody(req);

    if (!employeeNo) return sendJSON(res, 400, { error: '請選擇員工' });
    if (!PUNCH_TYPES.includes(type)) return sendJSON(res, 400, { error: '不支援的打卡類型' });
    if (!localTime) return sendJSON(res, 400, { error: '請填寫打卡時間' });

    const emp = db.prepare('SELECT * FROM employees WHERE employee_no = ?').get(employeeNo);
    if (!emp) return sendJSON(res, 404, { error: '查無此員工' });

    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const timestamp = taipeiLocalToISO(localTime);
    const submittedAt = new Date().toISOString();
    db.prepare(`INSERT INTO punches
        (id, employee_no, name, type, label, timestamp, verified_by, verify_detail, status, submitted_at, reviewed_at, location_suspicious)
            VALUES (?, ?, ?, ?, ?, ?, 'admin_manual', ?, 'confirmed', ?, ?, 0)`
                 ).run(
          id, employeeNo, emp.name, type, PUNCH_LABEL[type], timestamp,
          note || '管理者補登', submittedAt, submittedAt
        );

    const record = db.prepare('SELECT * FROM punches WHERE id = ?').get(id);
    sendJSON(res, 200, {
          ok: true,
          record: rowToRecord(record),
          message: `已為 ${emp.name}（${employeeNo}）補登一筆${PUNCH_LABEL[type]}紀錄`,
    });
});

addRoute('GET', '/api/admin/punches', async (req, res, params, query) => {
    if (!requireAdmin(req, res)) return;
    const { employeeNo, from, to, status } = query;
    let sql = 'SELECT * FROM punches WHERE 1=1';
    const args = [];
    if (employeeNo) { sql += ' AND employee_no = ?'; args.push(employeeNo); }
    if (from) { sql += ' AND timestamp >= ?'; args.push(from); }
    if (to) { sql += ' AND timestamp <= ?'; args.push(to + 'T23:59:59'); }
    if (status) { sql += ' AND status = ?'; args.push(status); }
    sql += ' ORDER BY timestamp DESC LIMIT 300';
    const rows = db.prepare(sql).all(...args);
    sendJSON(res, 200, { ok: true, records: rows.map(rowToRecord) });
});

addRoute('POST', '/api/admin/punches/:id/edit', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const record = db.prepare('SELECT * FROM punches WHERE id = ?').get(params.id);
    if (!record) return sendJSON(res, 404, { error: '查無此打卡紀錄' });

    const { type, localTime, status, note } = await readBody(req);
    const updates = {};

    if (type !== undefined) {
          if (!PUNCH_TYPES.includes(type)) return sendJSON(res, 400, { error: '不支援的打卡類型' });
          updates.type = type;
          updates.label = PUNCH_LABEL[type];
    }
    if (localTime !== undefined) {
          if (!localTime) return sendJSON(res, 400, { error: '請提供有效的打卡時間' });
          updates.timestamp = taipeiLocalToISO(localTime);
    }
    if (status !== undefined) {
          if (!['confirmed', 'pending_approval', 'rejected'].includes(status)) {
                return sendJSON(res, 400, { error: '無效的狀態' });
          }
          updates.status = status;
    }
    if (note !== undefined) {
          updates.verify_detail = note;
    }

    const fields = Object.keys(updates);
    if (!fields.length) return sendJSON(res, 400, { error: '沒有提供要更新的欄位' });

    updates.reviewed_at = new Date().toISOString();
    const updateFields = Object.keys(updates);
    const setClause = updateFields.map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE punches SET ${setClause} WHERE id = ?`).run(
          ...updateFields.map((f) => updates[f]),
          params.id
        );

    const updated = db.prepare('SELECT * FROM punches WHERE id = ?').get(params.id);
    sendJSON(res, 200, { ok: true, record: rowToRecord(updated), message: '打卡紀錄已更新' });
});

addRoute('POST', '/api/admin/punches/:id/delete', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    const record = db.prepare('SELECT * FROM punches WHERE id = ?').get(params.id);
    if (!record) return sendJSON(res, 404, { error: '查無此打卡紀錄' });
    db.prepare('DELETE FROM punches WHERE id = ?').run(params.id);
    sendJSON(res, 200, {
          ok: true,
          message: `已刪除 ${record.name}（${record.employee_no}）的一筆${PUNCH_LABEL[record.type] || record.type}紀錄`,
    });
});

addRoute('GET', '/api/admin/suspicious-punches', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare('SELECT * FROM punches WHERE location_suspicious = 1 ORDER BY timestamp DESC LIMIT 100').all();
    sendJSON(res, 200, { ok: true, records: rows.map(rowToRecord) });
});

addRoute('POST', '/api/admin/export-to-sheet', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { employeeNo, from, to, status } = await readBody(req);

    let sql = 'SELECT * FROM punches WHERE 1=1';
    const args = [];
    if (employeeNo) { sql += ' AND employee_no = ?'; args.push(employeeNo); }
    if (from) { sql += ' AND timestamp >= ?'; args.push(from); }
    if (to) { sql += ' AND timestamp <= ?'; args.push(to + 'T23:59:59'); }
    if (status) {
          sql += ' AND status = ?'; args.push(status);
    } else {
          sql += " AND status != 'rejected'";
    }
    sql += ' ORDER BY timestamp ASC';
    const rows = db.prepare(sql).all(...args);

    if (!rows.length) {
          return sendJSON(res, 200, { ok: true, exported: 0, message: '沒有符合篩選條件的打卡紀錄' });
    }

    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const sheetName = process.env.GOOGLE_SHEET_TAB || '打卡記錄';
    if (!spreadsheetId) {
          return sendJSON(res, 500, { error: '伺服器尚未設定 GOOGLE_SHEET_ID 環境變數' });
    }

    try {
          await sheetsApi.ensureHeader(spreadsheetId, sheetName, SHEET_EXPORT_HEADER);
          const exportedAt = new Date().toISOString();
          const values = rows.map((r) => [
                r.employee_no,
                r.name,
                PUNCH_LABEL[r.type] || r.type,
                computeScheduleTime(r.timestamp),
                formatTaipeiDateTime(r.timestamp),
                STATUS_LABEL[r.status] || r.status,
                VERIFY_LABEL[r.verified_by] || r.verified_by || '',
                r.verify_detail || r.reason || '',
                exportedAt,
                r.id,
          ]);

          // 依員工分區排序：讀出既有資料列，與本次新匯出的資料合併後，
          // 先依「員工編號」再依「打卡時間」排序，整段覆寫回試算表，
          // 讓同一人員的打卡記錄集中排列在連續的區塊，方便辨識。
          const existing = await sheetsApi.getValues(spreadsheetId, `${sheetName}!A2:J`);
          const padRow = (r) => {
                const row = (r || []).slice(0, 10);
                while (row.length < 10) row.push('');
                return row;
          };
          const existingRows = ((existing.values || [])).filter((r) => r && r[0]).map(padRow);

          // 去除重複：最後一欄（J）存放打卡紀錄在資料庫裡的內部 ID，僅供比對同一筆
          // 打卡使用，不在表格上特別標示欄名。用 ID 當識別鍵，即使該筆打卡的時間
          // 之後被管理者編輯過，重新匯出時仍能準確對應回同一列、直接覆蓋更新，
          // 而不是在下面多寫一列造成重複。舊版匯出（尚未有 ID 欄位）的既有列，
          // 因為沒有 ID 可比對，一律視為獨立資料保留，不會被誤判成重複而合併掉。
          const keyOf = (row, index) => (row[9] ? `id:${row[9]}` : `legacy:${index}`);
          const rowsByKey = new Map(existingRows.map((row, index) => [keyOf(row, index), row]));
          let newCount = 0;
          let updatedCount = 0;
          for (const row of values.map(padRow)) {
                const key = keyOf(row);
                if (rowsByKey.has(key)) {
                      updatedCount += 1;
                } else {
                      newCount += 1;
                }
                rowsByKey.set(key, row);
          }
          const merged = Array.from(rowsByKey.values());
          merged.sort((a, b) => {
                const empCompare = String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true });
                if (empCompare !== 0) return empCompare;
                return String(a[4]).localeCompare(String(b[4]));
          });

          await sheetsApi.ensureSheetRowCount(spreadsheetId, sheetName, merged.length + 1);
          const writeRange = `${sheetName}!A2:J${merged.length + 1}`;
          await sheetsApi.updateValues(spreadsheetId, writeRange, merged);

          // 若去重後的資料列比原本少（代表清掉了重複列），把底部多出來的舊列清空，
          // 避免整段覆寫後在表格尾端留下上一次匯出殘留的舊資料。
          const previousRowCount = (existing.values || []).length;
          if (merged.length < previousRowCount) {
                const clearRange = `${sheetName}!A${merged.length + 2}:J${previousRowCount + 1}`;
                await sheetsApi.clearValues(spreadsheetId, clearRange);
          }

          // 不同員工以不同底色區分：merged 已依「員工編號」排序，所以同一位員工
          // 的資料列必定連續，這裡找出每一段連續區塊，套用該員工對應的固定顏色。
          // 只上色到 I 欄（SHEET_EXPORT_HEADER 的範圍），J 欄是內部用的 ID、
          // 不特別標示欄名，保持不上色即可。
          try {
                const sheetId = await sheetsApi.getSheetIdByName(spreadsheetId, sheetName);
                if (sheetId !== null) {
                      const colorRanges = [];
                      let blockStart = 0;
                      for (let i = 1; i <= merged.length; i++) {
                            const sameAsPrev = i < merged.length && merged[i][0] === merged[blockStart][0];
                            if (!sameAsPrev) {
                                  colorRanges.push({
                                        startRowIndex: blockStart + 1,
                                        endRowIndex: i + 1,
                                        startColumnIndex: 0,
                                        endColumnIndex: SHEET_EXPORT_HEADER.length,
                                        color: sheetEmployeeColor(merged[blockStart][0]),
                                  });
                                  blockStart = i;
                            }
                      }
                      if (merged.length < previousRowCount) {
                            colorRanges.push({
                                  startRowIndex: merged.length + 1,
                                  endRowIndex: previousRowCount + 1,
                                  startColumnIndex: 0,
                                  endColumnIndex: SHEET_EXPORT_HEADER.length,
                                  color: { red: 1, green: 1, blue: 1 },
                            });
                      }
                      await sheetsApi.applyRowBackgroundColors(spreadsheetId, sheetId, colorRanges);
                }
          } catch (e) {
                console.warn('套用員工底色失敗（不影響資料匯出結果）：', e.message);
          }

          sendJSON(res, 200, {
                ok: true,
                exported: rows.length,
                message: `已處理 ${rows.length} 筆打卡紀錄（新增 ${newCount} 筆、更新既有 ${updatedCount} 筆重複紀錄）到 Google Sheet「${sheetName}」分頁，並依員工分區整理排序`,
          });
    } catch (e) {
          sendJSON(res, 500, { error: '匯出到 Google Sheet 失敗：' + e.message });
    }
});

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
          if (err) {
                  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                  return res.end('Not found');
          }
          const ext = path.extname(filePath);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(data);
    });
}

const server = http.createServer(async (req, res) => {
    try {
          const parsed = new URL(req.url, `http://${req.headers.host}`);
          const pathname = parsed.pathname;
          const query = Object.fromEntries(parsed.searchParams.entries());

      for (const r of routes) {
              if (r.method !== req.method) continue;
              const m = pathname.match(r.pattern);
              if (!m) continue;
              const params = {};
              r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
              return await r.handler(req, res, params, query);
      }

      if (pathname.startsWith('/api/')) {
              return sendJSON(res, 404, { error: 'API not found' });
      }
          serveStatic(req, res, pathname);
    } catch (e) {
          sendJSON(res, 500, { error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`員工打卡系統已啟動：http://localhost:${PORT}`);
    console.log(`管理者後台：http://localhost:${PORT}/admin.html`);
});
