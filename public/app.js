// 員工打卡系統原型 — 前端邏輯
const LS_DEVICE = 'checkin_deviceId';
const LS_EMPNO = 'checkin_employeeNo';
const LS_NAME = 'checkin_name';

let lastPunchType = null; // 由 /api/status 取得，決定按鈕可用狀態
let lastKnownPos = null;

function getOrCreateDeviceId() {
  let id = localStorage.getItem(LS_DEVICE);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now() + '-' + Math.random());
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
}

function isBound() {
  return !!(localStorage.getItem(LS_EMPNO) && localStorage.getItem(LS_NAME));
}

async function bindDevice() {
  const employeeNo = document.getElementById('bindNo').value.trim();
  const name = document.getElementById('bindName').value.trim();
  const msg = document.getElementById('bindMsg');
  if (!employeeNo || !name) {
    msg.textContent = '請填寫員工編號與姓名';
    msg.className = 'msg err';
    return;
  }
  const deviceId = getOrCreateDeviceId();
  try {
    const r = await fetch('/api/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, name, deviceId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '綁定失敗');
    localStorage.setItem(LS_EMPNO, employeeNo);
    localStorage.setItem(LS_NAME, name);
    msg.textContent = '';
    initMainView();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function initMainView() {
  hide('bindCard');
  show('mainCard');
  show('historyCard');
  document.getElementById('empNoDisplay').value = localStorage.getItem(LS_EMPNO);
  document.getElementById('empNameDisplay').value = localStorage.getItem(LS_NAME);
  startClock();
  startLocationWatch();
  refreshStatus();
  loadHistory();
  setInterval(refreshStatus, 15000);
  setInterval(loadHistory, 30000);
}

function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('zh-TW', { hour12: false });
    document.getElementById('dateLine').textContent = now.toLocaleDateString('zh-TW', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });
  }
  tick();
  setInterval(tick, 1000);
}

function startLocationWatch() {
  const line = document.getElementById('verifyLine');
  if (!navigator.geolocation) {
    line.textContent = '此裝置不支援定位，若在公司 WiFi 範圍內仍可打卡';
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      lastKnownPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      line.textContent = `已取得定位（精確度約 ${Math.round(pos.coords.accuracy)} 公尺），打卡時將由伺服器驗證是否在範圍內`;
    },
    (err) => {
      line.textContent = '無法取得定位（' + err.message + '），請確認%��開啟定位權限，或改連接公司 WiFi';
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
  );
}

function breakNextType() {
  return lastPunchType === 'break-start' ? 'break-end' : 'break-start';
}

async function refreshStatus() {
  const employeeNo = localStorage.getItem(LS_EMPNO);
  const r = await fetch(`/api/status?employeeNo=${encodeURIComponent(employeeNo)}`);
  const data = await r.json();
  lastPunchType = data.lastType;
  applyButtonState();
}

function applyButtonState() {
  const btnCheckin = document.getElementById('btnCheckin');
  const btnBreak = document.getElementById('btnBreak');
  const btnCheckout = document.getElementById('btnCheckout');

  const notStarted = lastPunchType === null || lastPunchType === 'check-out';
  const onShift = lastPunchType === 'check-in' || lastPunchType === 'break-end';
  const onBreak = lastPunchType === 'break-start';

  btnCheckin.disabled = !notStarted;
  btnCheckout.disabled = !onShift;
  btnBreak.disabled = notStarted;
  btnBreak.textContent = onBreak ? '休息結束' : '休息打卡';
}

async function doPunch(type) {
  const employeeNo = localStorage.getItem(LS_EMPNO);
  const deviceId = getOrCreateDeviceId();
  const msg = document.getElementById('punchMsg');
  msg.textContent = '處理中…';
  msg.className = 'msg';

  const body = { employeeNo, deviceId, type };
  if (lastKnownPos) {
    body.lat = lastKnownPos.lat;
    body.lng = lastKnownPos.lng;
    body.accuracy = lastKnownPos.accuracy;
  }
  try {
    const r = await fetch('/api/punch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '打卡失敗');
    msg.textContent = `${data.record.label} 成功（${data.record.verifyDetail || '已驗證'}）`;
    msg.className = 'msg ok';
    await refreshStatus();
    await loadHistory();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

function toggleForgot() {
  document.getElementById('forgotCard').classList.toggle('hidden');
  if (!document.getElementById('forgotCard').classList.contains('hidden')) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('forgotTime').value = now.toISOString().slice(0, 16);
  }
}

async function submitForgot() {
  const employeeNo = localStorage.getItem(LS_EMPNO);
  const deviceId = getOrCreateDeviceId();
  const type = document.getElementById('forgotType').value;
  const time = document.getElementById('forgotTime').value;
  const reason = document.getElementById('forgotReason').value.trim();
  const msg = document.getElementById('forgotMsg');
  if (!time || !reason) {
    msg.textContent = '請填寫時間與原因';
    msg.className = 'msg err';
    return;
  }
  try {
    const r = await fetch('/api/forgot-punch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeNo, deviceId, type, time, reason }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '送出失敗');
    msg.textContent = '已送出，待管理者審核';
    msg.className = 'msg ok';
    document.getElementById('forgotReason').value = '';
    await loadHistory();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'msg err';
  }
}

function statusBadge(rec) {
  if (rec.status === 'confirmed') return '<span class="badge badge-ok">已確認</span>';
  if (rec.status === 'pending_approval') return '<span class="badge badge-pending">待審核</span>';
  if (rec.status === 'rejected') return '<span class="badge badge-rejected">已拒絕</span>';
  return '';
}

async function loadHistory() {
  const employeeNo = localStorage.getItem(LS_EMPNO);
  if (!employeeNo) return;
  const r = await fetch(`/api/history?employeeNo=${encodeURIComponent(employeeNo)}`);
  const data = await r.json();
  const list = document.getElementById('historyList');
  if (!data.records.length) {
    list.innerHTML = '<p style="color:var(--text-faint);font-size:13px;">尚無打卡記錄</p>';
    return;
  }
  list.innerHTML = data.records
    .slice(0, 30)
    .map((rec) => {
      const t = new Date(rec.timestamp).toLocaleString('zh-TW', { hour12: false });
      return `<div class="record"><strong>${rec.label}</strong> ${statusBadge(rec)}<div class="t">${t}${rec.reason ? '　原因：' + rec.reason : ''}</div></div>`;
    })
    .join('');
}

// ---------- 初始化 ----------
(function init() {
  if (isBound()) {
    initMainView();
  } else {
    show('bindCard');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
