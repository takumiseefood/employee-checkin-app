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
};

const SHEET_EXPORT_HEADER = ['員工編號', '姓名', '打卡類型', '班表時間', '打卡時間', '狀態', '驗證方式', '驗證/備註', '匯出時間'];

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
                 return sendJSON(res, 409, { error: '此員工編號已碶帐其他裝置，如需更捛裝置請肯繫管理者重設綁定' });
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
    if (!time || !reason) return sendJSON(res, 400, { error: '請填寫補登時间與原因' });

           const dev = verifyDevice(employeeNo, deviceId);
    if (!dev.ok) return sendJSON(res, 403, { error: dev.error });

           const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const timestamp = new Date(time).toISOString();
    const submittedAt = new Date().toISOString();
    db.prepare(`INSERT INTO punches
        (id, employee_no, name, type, label, timestamp, verified_by, reason, status, submitted_at, location_suspicious)
            VALUES (?, ?, ?, ?, ?, ?, 'manual_request', ?, 'pending_approval', ?, 0)`
                 ).run(id, employeeNo, dev.emp.name, type, PUNCH_LABEL[type], timestamp, reason, submittedAt);

           sendJSON(res, 200, {
                 ok: true,
                 record: { id, employeeNo, name: dev.emp.name, type, label: PUNCH_LABEL[type], timestamp, reason, status: 'pending_approval' },
                 message: '補登石請已送出，待管理者審核',
           });
});

function rowToRecord(r) {
    return {
          id: r.id, employeeNo: r.employee_no, name: r.name, type: r.type, label: r.label,
          timestamp: r.timestamp, verifiedBy: r.verified_by, verifyDetail: r.verify_detail,
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
          return sendJSON(res, 429, { error: '登入失敗次數過多（請 1 分鐘後再試' });
    }
    const { username, password } = await readBody(req);
    if (!username || !password) return sendJSON(res, 400, { error: '請輸入帳�陟密碼' });

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
    const rows = db.prepare('SELECT employee_no, name, device_id, bound_at FROM employees').all();
    sendJSON(res, 200, {
          ok: true,
          employees: rows.map((e) => ({ employeeNo: e.employee_no, name: e.name, deviceId: e.device_id, boundAt: e.bound_at })),
    });
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
          return sendJSON(res, 200, { ok: true, exported: 0, message: '沖有符合篩選条件的打卡紀錄' });
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
                r.timestamp,
                STATUS_LABEL[r.status] || r.status,
                VERIFY_LABEL[r.verified_by] || r.verified_by || '',
                r.verify_detail || r.reason || '',
                exportedAt,
          ]);
          await sheetsApi.appendRows(spreadsheetId, sheetName, values);
          sendJSON(res, 200, { ok: true, exported: rows.length, message: `已匯出 ${rows.length} 筆打卡紀錄到 Google Sheet「${sheetName}」分頁` });
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
