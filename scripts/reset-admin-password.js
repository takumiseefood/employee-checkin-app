#!/usr/bin/env node
// 管理者密碼救援工具（伺服器機器上，用命令列執行，用於忘記密碼或建立新管理者帳號）
// 用法：
//   node scripts/reset-admin-password.js <username> <new-password>
//   node scripts/reset-admin-password.js admin "MyN3wP@ssw0rd"
const path = require('path');
const auth = require(path.join(__dirname, '..', 'lib', 'auth'));

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.error('用法：node scripts/reset-admin-password.js <username> <new-password>');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('密碼長度至少需要 8 碼');
  process.exit(1);
}

auth.createUser(username, newPassword, { mustChangePassword: false });
console.log(`已設定帳號 "${username}" 的密碼。請立即登入並確認可正常使用。`);
