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
      el.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">目前沒有待審核的補登申請</p>';
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
          <td>
            <input type="number" min="0" step="1" style="width:80px;" id="wage-${e.employeeNo}" value="${e.hourlyWage || 0}" />
            <button class="btn-secondary" onclick="saveWage('${e.employeeNo}')">儲存</button>
          </td>
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

    const payrollSelect = document.getElementById('payrollEmployee');
    const prevPayrollValue = payrollSelect.value;
    payrollSelect.innerHTML =
      '<option value="">全部員工</option>' +
      data.employees
        .map((e) => `<option value="${e.employeeNo}">${e.name}（${e.employeeNo}）</option>`)
        .join('');
    payrollSelect.value = prevPayrollValue;

    const punchSelect = document.getElementById('punchEmployee');
    const prevPunchValue = punchSelect.value;
    punchSelect.innerHTML =
      '<option value="">全部員工</option>' +
      data.employees
        .map((e) => `<option value="${e.employeeNo}">${e.name}（${e.employeeNo}）</option>`)
        .join('');
    punchSelect.value = prevPunchValue;

    const newPunchSelect = document.getElementById('newPunchEmployee');
    const prevNewPunchValue = newPunchSelect.value;
    newPunchSelect.innerHTML =
      '<option value="">請選擇員工</option>' +
      data.employees
        .map((e) => `<option value="${e.employeeNo}">${e.name}（${e.employeeNo}）</option>`)
        .join('');
    newPunchSelect.value = prevNewPunchValue;
  } catch (e) { /* 401 已導回登入頁 */ }
}

async function createPunch() {
  const employeeNo = document.getElementById('newPunchEmployee').value;
  const type = document.getElementById('newPunchType').value;
  const localTime = document.getElementById('newPunchTime').value;
  const note = document.getElementById('newPunchNote').value.trim();
  const msg = document.getElementById('newPunchMsg');

  if (!employeeNo) {
    msg.textContent = '請選擇員工';
    msg.className = 'msg err';
    return;
  }
  if (!localTime) {
    msg.textContent = '請填寫打卡時間';
    msg.className = 'msg err';
    return;
  }

  try {
    const r = await api('/api/admin/punches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, type, localTime, note: note || undefined }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '新增失敗');
    msg.textContent = data.message || '已新增打卡紀錄';
    msg.className = 'msg ok';
    document.getElementById('newPunchTime').value = '';
    document.getElementById('newPunchNote').value = '';
    loadPunches();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function saveWage(employeeNo) {
  const input = document.getElementById(`wage-${employeeNo}`);
  const hourlyWage = parseFloat(input.value);
  if (isNaN(hourlyWage) || hourlyWage < 0) {
    alert('請輸入大於等於 0 的時薪數字');
    return;
  }
  try {
    const r = await api(`/api/admin/employees/${employeeNo}/wage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hourlyWage }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '更新失敗');
  } catch (e) {
    alert(e.message);
  }
}

async function resetDevice(employeeNo) {
  if (!confirm(`確定要重設 ${employeeNo} 的裝置綁定嗎？重設後該員工下次打卡時可綁定新裝置。`)) return;
  await api(`/api/admin/employees/${employeeNo}/reset-device`, { method: 'POST' });
  loadEmployees();
}

const PUNCH_TYPE_OPTIONS = [
  { value: 'check-in', label: '上班打卡' },
  { value: 'break-start', label: '休息開始' },
  { value: 'break-end', label: '休息結束' },
  { value: 'check-out', label: '下班打卡' },
];
const PUNCH_STATUS_OPTIONS = [
  { value: 'confirmed', label: '已確認' },
  { value: 'pending_approval', label: '待審核' },
  { value: 'rejected', label: '已拒絕' },
];

async function loadPunches() {
  const employeeNo = document.getElementById('punchEmployee').value;
  const from = document.getElementById('punchFrom').value;
  const to = document.getElementById('punchTo').value;
  const status = document.getElementById('punchStatus').value;
  const msg = document.getElementById('punchMsg');
  const table = document.getElementById('punchTable');
  msg.textContent = '查詢中…';
  msg.className = 'msg';
  try {
    const params = new URLSearchParams();
    if (employeeNo) params.set('employeeNo', employeeNo);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (status) params.set('status', status);
    const r = await api(`/api/admin/punches?${params.toString()}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '查詢失敗');

    if (!data.records.length) {
      table.classList.add('hidden');
      msg.textContent = '沒有符合篩選條件的打卡紀錄';
      msg.className = 'msg';
      return;
    }

    const tbody = table.querySelector('tbody');
    tbody.innerHTML = data.records
      .map((rec) => {
        const typeOptions = PUNCH_TYPE_OPTIONS
          .map((o) => `<option value="${o.value}" ${o.value === rec.type ? 'selected' : ''}>${o.label}</option>`)
          .join('');
        const statusOptions = PUNCH_STATUS_OPTIONS
          .map((o) => `<option value="${o.value}" ${o.value === rec.status ? 'selected' : ''}>${o.label}</option>`)
          .join('');
        return `<tr>
          <td>${rec.name}（${rec.employeeNo}）</td>
          <td><select id="punch-type-${rec.id}">${typeOptions}</select></td>
          <td><input type="datetime-local" id="punch-time-${rec.id}" value="${rec.localTime}" style="width:170px;" /></td>
          <td><select id="punch-status-${rec.id}">${statusOptions}</select></td>
          <td style="max-width:160px;font-size:12px;color:var(--text-faint);">${rec.reason || rec.verifyDetail || ''}</td>
          <td>
            <button class="btn-secondary" onclick="savePunchEdit('${rec.id}')">儲存</button>
            <button class="btn-secondary" onclick="deletePunch('${rec.id}')">刪除</button>
          </td>
        </tr>`;
      })
      .join('');
    table.classList.remove('hidden');
    msg.textContent = `共 ${data.records.length} 筆`;
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function savePunchEdit(id) {
  const type = document.getElementById(`punch-type-${id}`).value;
  const localTime = document.getElementById(`punch-time-${id}`).value;
  const status = document.getElementById(`punch-status-${id}`).value;
  if (!localTime) {
    alert('請填寫有效的打卡時間');
    return;
  }
  try {
    const r = await api(`/api/admin/punches/${id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, localTime, status }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '更新失敗');
    loadPunches();
  } catch (e) {
    alert(e.message);
  }
}

async function deletePunch(id) {
  if (!confirm('確定要刪除這筆打卡紀錄嗎？此操作無法復原（例如用於移除重複打卡）。')) return;
  try {
    const r = await api(`/api/admin/punches/${id}/delete`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '刪除失敗');
    loadPunches();
  } catch (e) {
    alert(e.message);
  }
}

async function runPayroll() {
  const employeeNo = document.getElementById('payrollEmployee').value;
  const from = document.getElementById('payrollFrom').value;
  const to = document.getElementById('payrollTo').value;
  const msg = document.getElementById('payrollMsg');
  const table = document.getElementById('payrollTable');
  const warnings = document.getElementById('payrollWarnings');
  msg.textContent = '試算中…';
  msg.className = 'msg';
  warnings.innerHTML = '';
  try {
    const params = new URLSearchParams();
    if (employeeNo) params.set('employeeNo', employeeNo);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const r = await api(`/api/admin/payroll?${params.toString()}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '試算失敗');

    const tbody = table.querySelector('tbody');
    if (!data.summary.length) {
      tbody.innerHTML = '';
      table.classList.add('hidden');
      msg.textContent = '此篩選條件下沒有已確認的打卡紀錄';
      msg.className = 'msg';
      return;
    }

    tbody.innerHTML = data.summary
      .map(
        (s) => `<tr>
          <td>${s.employeeNo}</td>
          <td>${s.name}</td>
          <td>${s.hourlyWage}</td>
          <td>${s.normalHours}</td>
          <td>${s.overtimeHours}</td>
          <td>${s.totalHours}</td>
          <td>${s.pay}</td>
        </tr>`
      )
      .join('');
    table.classList.remove('hidden');
    msg.textContent = '試算完成';
    msg.className = 'msg ok';

    const incomplete = data.days.filter((d) => d.incomplete);
    if (incomplete.length) {
      warnings.innerHTML =
        '<p style="font-size:12px;color:var(--text-faint);margin-top:10px;">以下日期缺少完整的上下班打卡，未計入工時：</p>' +
        incomplete
          .map((d) => `<div class="record">${d.name}（${d.employeeNo}）— ${d.date}：${d.note}</div>`)
          .join('');
    }
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

async function loadSuspicious() {
  const el = document.getElementById('suspiciousList');
  try {
    const r = await api('/api/admin/suspicious-punches');
    const data = await r.json();
    if (!data.records.length) {
      el.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">目前沒有可疑定位記錄</p>';
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
