// 管理者後台邏輯（含登入驗證）

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    hide('adminContent');
    show('loginCard');
    throw new Error('請先登入');
  }
  return r;
}

async function login() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const msg = document.getElementById('loginMsg');
  if (!username || !password) {
    msg.textContent = '請輸入帳號密碼';
    msg.className = 'msg err';
    return;
  }
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'same-origin',
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '登入失敗');
    msg.textContent = '';
    await enterAdmin(data.username, data.mustChangePassword);
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function logout() {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  hide('adminContent');
  show('loginCard');
}

async function enterAdmin(username, mustChangePassword) {
  hide('loginCard');
  show('adminContent');
  document.getElementById('whoami').textContent = username;
  if (mustChangePassword) {
    const pwMsg = document.getElementById('pwMsg');
    pwMsg.textContent = '這是系統自動產生的初始密碼，請立即在上方設定新密碼';
    pwMsg.className = 'msg err';
  }
  loadConfig();
  loadForgotRequests();
  loadEmployees();
  loadSuspicious();
}

async function changePassword() {
  const currentPassword = document.getElementById('curPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const msg = document.getElementById('pwMsg');
  try {
    const r = await api('/api/admin/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '更新失敗');
    msg.textContent = '密碼已更新';
    msg.className = 'msg ok';
    document.getElementById('curPassword').value = '';
    document.getElementById('newPassword').value = '';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function loadConfig() {
  try {
    const r = await api('/api/admin/config');
    const data = await r.json();
    const c = data.config;
    document.getElementById('cfgLat').value = c.geofence.lat;
    document.getElementById('cfgLng').value = c.geofence.lng;
    document.getElementById('cfgRadius').value = c.geofence.radiusKm;
    document.getElementById('cfgIPs').value = (c.allowedIPs || []).join('\n');
  } catch (e) { /* 401 已導回登入頁 */ }
}

function useCurrentLocation() {
  if (!navigator.geolocation) return alert('此裝置不支援定位');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('cfgLat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('cfgLng').value = pos.coords.longitude.toFixed(6);
    },
    (err) => alert('取得定位失敗：' + err.message)
  );
}

async function saveConfig() {
  const lat = parseFloat(document.getElementById('cfgLat').value);
  const lng = parseFloat(document.getElementById('cfgLng').value);
  const radiusKm = parseFloat(document.getElementById('cfgRadius').value);
  const allowedIPs = document.getElementById('cfgIPs').value
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const msg = document.getElementById('cfgMsg');
  try {
    const r = await api('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, radiusKm, allowedIPs }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '儲存失敗');
    msg.textContent = '已儲存';
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function exportToSheet() {
  const employeeNo = document.getElementById('exportEmployee').value;
  const from = document.getElementById('exportFrom').value;
  const to = document.getElementById('exportTo').value;
  const status = document.getElementById('exportStatus').value;
  const msg = document.getElementById('exportMsg');
  msg.textContent = '匯出中…';
  msg.className = 'msg';
  try {
    const r = await api('/api/admin/export-to-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeNo: employeeNo || undefined,
        from: from || undefined,
        to: to || undefined,
        status: status || undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '匯出失敗');
    msg.textContent = data.message || `已匯出 ${data.exported} 筆`;
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function loadForgotRequests() {
  const el = document.getElementById('forgotList');
  try {
    const r = await api('/api/admin/forgot-requests?status=pending_approval');
    const data = await r.json();
    if (!data.records.length) {
      el.innerHTML = '<p style="color:#999;font-size:13px;">目前沒有待審核的補登申請</p>';
      return;
    }
    el.innerHTML = data.records
      .map((rec) => {
        const t = new Date(rec.timestamp).toLocaleString('zh-TW', { hour12: false });
        return `<div class="record">
          <strong>${rec.name}（${rec.employeeNo}）</strong> — ${rec.label}
          <div class="t">補登時間：${t}　原因：${rec.reason}</div>
          <div style="margin-top:6px;">
            <button class="btn-secondary" onclick="reviewForgot('${rec.id}','approve')">核准</button>
            <button class="btn-secondary" onclick="reviewForgot('${rec.id}','reject')">拒絕</button>
          </div>
        </div>`;
      })
      .join('');
  } catch (e) { /* 401 已導回登入頁 */ }
}

async function reviewForgot(id, action) {
  await api(`/api/admin/forgot-requests/${id}/${action}`, { method: 'POST' });
  loadForgotRequests();
}

async function loadEmployees() {
  try {
    const r = await api('/api/admin/employees');
    const data = await r.json();
    const tbody = document.querySelector('#empTable tbody');
    tbody.innerHTML = data.employees
      .map(
        (e) => `<tr>
          <td>${e.employeeNo}</td>
          <td>${e.name}</td>
          <td>${e.deviceId ? '已綁定' : '未綁定'}</td>
          <td>${e.deviceId ? `<button class="btn-secondary" onclick="resetDevice('${e.employeeNo}')">重設綁定</button>` : '-'}</td>
        </tr>`
      )
      .join('');

    const exportSelect = document.getElementById('exportEmployee');
    const prevValue = exportSelect.value;
    exportSelect.innerHTML =
      '<option value="">全部員工</option>' +
      data.employees
        .map((e) => `<option value="${e.employeeNo}">${e.name}（${e.employeeNo}）</option>`)
        .join('');
    exportSelect.value = prevValue;
  } catch (e) { /* 401 已導回登入頁 */ }
}

async function resetDevice(employeeNo) {
  if (!confirm(`確定要重設 ${employeeNo} 的裝置綁定嗎？重設後該員工下次打卡時可綁定新裝置。`)) return;
  await api(`/api/admin/employees/${employeeNo}/reset-device`, { method: 'POST' });
  loadEmployees();
}

async function loadSuspicious() {
  const el = document.getElementById('suspiciousList');
  try {
    const r = await api('/api/admin/suspicious-punches');
    const data = await r.json();
    if (!data.records.length) {
      el.innerHTML = '<p style="color:#999;font-size:13px;">目前沒有可疑定位記錄</p>';
      return;
    }
    el.innerHTML = data.records
      .map((rec) => {
        const t = new Date(rec.timestamp).toLocaleString('zh-TW', { hour12: false });
        return `<div class="record"><strong>${rec.name}（${rec.employeeNo}）</strong> — ${rec.label}<div class="t">${t}</div></div>`;
      })
      .join('');
  } catch (e) { /* 401 已導回登入頁 */ }
}

(async function init() {
  try {
    const r = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();
      await enterAdmin(data.username, false);
      return;
    }
  } catch (e) { /* ignore */ }
  show('loginCard');
})();

setInterval(() => {
  if (!document.getElementById('adminContent').classList.contains('hidden')) {
    loadForgotRequests();
    loadEmployees();
  }
}, 15000);
