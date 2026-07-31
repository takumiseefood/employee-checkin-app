// Google Sheets API 用戶端 — 零外部相依套件版本。
// 用服務帳戶（Service Account）JSON 金鑰簽發 JWT，換取 OAuth2 access token，
// 再直接呼叫 Google Sheets API v4 的 REST 端點寫入資料。
// 需要的環境變數：
//   GOOGLE_SERVICE_ACCOUNT_JSON — 服務帳戶金鑰檔的完整 JSON 內容（字串）
//   GOOGLE_SHEET_ID             — 目標試算表 ID
//   GOOGLE_SHEET_TAB            — 目標分頁名稱（預設「打卡記錄」）
const crypto = require('crypto');
const https = require('https');

function base64url(input) {
    return Buffer.from(input)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
}

function httpsRequestJson(options, bodyString) {
    return new Promise((resolve, reject) => {
          const req = https.request(options, (res) => {
                  let data = '';
                  res.on('data', (chunk) => { data += chunk; });
                  res.on('end', () => {
                            let parsed;
                            try {
                                        parsed = data ? JSON.parse(data) : {};
                            } catch (e) {
                                        parsed = { raw: data };
                            }
                            if (res.statusCode >= 200 && res.statusCode < 300) {
                                        resolve(parsed);
                            } else {
                                        reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
                            }
                  });
          });
          req.on('error', reject);
          if (bodyString) req.write(bodyString);
          req.end();
    });
}

let cachedToken = null; // { accessToken, expiresAt }

function getServiceAccountCredentials() {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
          throw new Error('伺服器尚未設定 GOOGLE_SERVICE_ACCOUNT_JSON 環境變數');
    }
    let creds;
    try {
          creds = JSON.parse(raw);
    } catch (e) {
          throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 不是合法的 JSON');
    }
    if (!creds.client_email || !creds.private_key) {
          throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 缺少 client_email 或 private_key 欄位');
    }
    return creds;
}

async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expiresAt - 60 > now) {
          return cachedToken.accessToken;
    }
    const creds = getServiceAccountCredentials();
    const header = { alg: 'RS256', typ: 'JWT' };
    const claimSet = {
          iss: creds.client_email,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer
      .sign(creds.private_key)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const jwt = `${unsigned}.${signature}`;

    const bodyString = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
    }).toString();

    const result = await httpsRequestJson(
          {
                  hostname: 'oauth2.googleapis.com',
                  path: '/token',
                  method: 'POST',
                  headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Length': Buffer.byteLength(bodyString),
                  },
          },
          bodyString
        );

    if (!result.access_token) {
          throw new Error('無法取得 Google access token：' + JSON.stringify(result));
    }

    cachedToken = {
          accessToken: result.access_token,
          expiresAt: now + (result.expires_in || 3600),
    };
    return cachedToken.accessToken;
}

async function sheetsApiRequest(method, pathAndQuery, bodyObj) {
    const accessToken = await getAccessToken();
    const bodyString = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (bodyString) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(bodyString);
    }
    return httpsRequestJson(
          {
                  hostname: 'sheets.googleapis.com',
                  path: pathAndQuery,
                  method,
                  headers,
          },
          bodyString
        );
}

// 讀取指定範圍目前的值（例如檢查標題列是否已存在/正確）
async function getValues(spreadsheetId, range) {
    const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    return sheetsApiRequest('GET', path);
}

// 覆寫指定範圍的值（用於寫入/校正標題列）
async function updateValues(spreadsheetId, range, values) {
    const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return sheetsApiRequest('PUT', path, { values });
}

// 在既有資料表最後一列之後插入新資料列
async function appendRows(spreadsheetId, sheetName, rows) {
    if (!rows || rows.length === 0) return { updates: { updatedRows: 0 } };
    const range = `${sheetName}!A:Z`;
    const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
          range
        )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    return sheetsApiRequest('POST', path, { values: rows });
}

// 確保分頁的標題列存在且與預期一致，不一致就覆寫
async function ensureHeader(spreadsheetId, sheetName, header) {
    const range = `${sheetName}!A1:${String.fromCharCode(64 + header.length)}1`;
    let current;
    try {
          current = await getValues(spreadsheetId, range);
    } catch (e) {
          current = { values: [] };
    }
    const currentRow = (current.values && current.values[0]) || [];
    const matches =
          currentRow.length === header.length && header.every((h, i) => currentRow[i] === h);
    if (!matches) {
          await updateValues(spreadsheetId, range, [header]);
    }
}

// 清除指定範圍的內容（保留列結構，僅清空儲存格值，用於移除測試/垃圾資料列）
async function clearValues(spreadsheetId, range) {
    const path = `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
    return sheetsApiRequest('POST', path, {});
}

// 確保分頁至少有 minRows 列，不足就自動擴充格線（因為 values.update 不像 append 會自動擴充範圍，
// 若之後要用「整段覆寫＋依員工排序重排」的方式匯出，必須先確保格線夠大，避免超出範圍而寫入失敗）
async function ensureSheetRowCount(spreadsheetId, sheetName, minRows) {
    const meta = await sheetsApiRequest(
          'GET',
          `/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`
        );
    const sheet = (meta.sheets || []).find((s) => s.properties.title === sheetName);
    if (!sheet) return;
    const sheetId = sheet.properties.sheetId;
    const currentRows = (sheet.properties.gridProperties && sheet.properties.gridProperties.rowCount) || 0;
    if (currentRows >= minRows) return;
    await sheetsApiRequest('POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          requests: [
                {
                      updateSheetProperties: {
                            properties: { sheetId, gridProperties: { rowCount: minRows + 100 } },
                            fields: 'gridProperties.rowCount',
                      },
                },
          ],
    });
}

module.exports = {
    getAccessToken,
    getValues,
    updateValues,
    appendRows,
    ensureHeader,
    clearValues,
    ensureSheetRowCount,
};
