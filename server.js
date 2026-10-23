#!/usr/bin/env node
/**
 * 行程排期台账 · 协作服务器
 * ------------------------------------------------------------
 * 零依赖：只用 Node 内置模块（http / crypto / fs），不需要 npm install。
 * 数据：单文件 JSON（data/db.json），原子写入 + 每日自动备份。
 *
 * 启动：node server.js
 * 环境变量：
 *   PORT        监听端口（默认 3000）
 *   DATA_DIR    数据目录（默认 ./data）
 *   APP_SECRET  令牌签名密钥（不填会自动生成并写入 data/secret）
 *   MAX_DOC_MB  单份表大小上限（默认 4）
 *   ALLOW_REGISTER  是否开放注册（默认 1；设为 0 则只能由已有账号邀请加入）
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------- 配置
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BODY = Number(process.env.MAX_DOC_MB || 4) * 1024 * 1024;
const ALLOW_REGISTER = String(process.env.ALLOW_REGISTER ?? '1') !== '0';
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 密钥：环境变量优先，否则生成一次并持久化（重启后令牌仍有效）
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const SECRET = process.env.APP_SECRET || (() => {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
  catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
})();

// ---------------------------------------------------------------- 存储
const EMPTY = { users: [], docs: [], members: [], invites: [] };

function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const d = JSON.parse(raw);
    return { ...EMPTY, ...d };
  } catch (e) {
    if (e.code === 'ENOENT') return { ...EMPTY };
    console.error('[db] 读取失败，使用空库:', e.message);
    // 损坏时保留现场
    try { fs.renameSync(DB_FILE, DB_FILE + '.broken-' + Date.now()); } catch {}
    return { ...EMPTY };
  }
}

let db = readDB();
let writeTimer = null;
let writing = false;

function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 150);
}

function flush() {
  if (writing) { scheduleWrite(); return; }
  writing = true;
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] 写入失败:', e.message);
  } finally {
    writing = false;
  }
}

function save() { scheduleWrite(); }

// 每日备份（保留 14 份）
let lastBackupDay = '';
function backupDaily() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackupDay) return;
  lastBackupDay = day;
  try {
    const f = path.join(BACKUP_DIR, `db-${day}.json`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(db), 'utf8');
    const files = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('db-')).sort();
    files.slice(0, Math.max(0, files.length - 14)).forEach(n => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, n)); } catch {}
    });
  } catch (e) { console.error('[backup] 失败:', e.message); }
}

// ---------------------------------------------------------------- 工具
const uid = (p) => p + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
const fail = (res, code, error, message) => json(res, code, { error, message });

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}
function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
}

// 密码：scrypt（内置，无需依赖）
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(pwd, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    if (!salt || !h) return false;
    const calc = crypto.scryptSync(pwd, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(h, 'hex'));
  } catch { return false; }
}

// 令牌：uid.exp.sig（HMAC-SHA256，无依赖）
function signToken(uidv) {
  const payload = `${uidv}.${now() + TOKEN_TTL}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(t) {
  if (!t) return null;
  const parts = String(t).split('.');
  if (parts.length !== 3) return null;
  const [uidv, exp, sig] = parts;
  const payload = `${uidv}.${exp}`;
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  if (Number(exp) < now()) return null;
  return uidv;
}

function userFromReq(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const id = readToken(m[1]);
  if (!id) return null;
  return db.users.find(u => u.id === id) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { code: 'too_large' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('bad_json'), { code: 'bad_json' })); }
    });
    req.on('error', reject);
  });
}

// 简单登录限流：同 IP 10 分钟内最多 20 次失败
const attempts = new Map();
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (now() - rec.t > 10 * 60 * 1000) { attempts.delete(ip); return false; }
  return rec.n >= 20;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || { n: 0, t: now() };
  rec.n++; rec.t = now();
  attempts.set(ip, rec);
}
function clearFailures(ip) { attempts.delete(ip); }

// ---------------------------------------------------------------- 业务
function docRole(docId, userId) {
  const d = db.docs.find(x => x.id === docId && !x.deleted);
  if (!d) return null;
  if (d.owner_id === userId) return { doc: d, role: 'owner' };
  const m = db.members.find(x => x.doc_id === docId && x.user_id === userId);
  if (m) return { doc: d, role: m.role };
  return null;
}

function publicMeta(d) {
  const u = db.users.find(x => x.id === d.updated_by);
  return {
    id: d.id,
    title: d.title,
    version: d.version,
    updated_at: d.updated_at,
    updated_by: u ? u.email : '',
    owner_id: d.owner_id
  };
}

function handleApi(req, res, url) {
  const p = url.pathname;
  const ip = (req.socket.remoteAddress || '') + '|' + (req.headers['x-forwarded-for'] || '');

  // ---- health
  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      app: 'itinerary',
      api: 1,
      register: ALLOW_REGISTER,
      time: now()
    });
  }

  // ---- 注册
  if (p === '/api/register' && req.method === 'POST') {
    return readBody(req).then(b => {
      if (!ALLOW_REGISTER) return fail(res, 403, 'register_closed', '服务器未开放注册，请让同事邀请你加入');
      const email = normEmail(b.email);
      const pwd = String(b.password || '');
      if (!validEmail(email)) return fail(res, 400, 'bad_email', '邮箱格式不对');
      if (pwd.length < 8) return fail(res, 400, 'weak_password', '密码至少 8 位');
      if (db.users.some(u => u.email === email)) return fail(res, 409, 'email_taken', '该邮箱已注册，请直接登录');
      const u = { id: uid('u_'), email, pwd: hashPassword(pwd), created_at: now() };
      db.users.push(u); save();
      return json(res, 200, { token: signToken(u.id), user: { id: u.id, email: u.email } });
    }).catch(e => fail(res, e.code === 'too_large' ? 413 : 400, e.code || 'bad_request', '请求格式不对'));
  }

  // ---- 登录
  if (p === '/api/login' && req.method === 'POST') {
    if (tooManyAttempts(ip)) return fail(res, 429, 'too_many', '尝试次数过多，请 10 分钟后再试');
    return readBody(req).then(b => {
      const email = normEmail(b.email);
      const pwd = String(b.password || '');
      const u = db.users.find(x => x.email === email);
      if (!u || !verifyPassword(pwd, u.pwd)) { noteFailure(ip); return fail(res, 401, 'bad_credentials', '邮箱或密码不对'); }
      clearFailures(ip);
      return json(res, 200, { token: signToken(u.id), user: { id: u.id, email: u.email } });
    }).catch(e => fail(res, e.code === 'too_large' ? 413 : 400, e.code || 'bad_request', '请求格式不对'));
  }

  // ---- 以下都要登录
  const me = userFromReq(req);
  if (!me) return fail(res, 401, 'unauthorized', '请先登录');

  if (p === '/api/me' && req.method === 'GET') {
    return json(res, 200, { user: { id: me.id, email: me.email } });
  }

  // ---- 列表
  if (p === '/api/docs' && req.method === 'GET') {
    const mine = db.members.filter(m => m.user_id === me.id);
    const list = db.docs
      .filter(d => !d.deleted && (d.owner_id === me.id || mine.some(m => m.doc_id === d.id)))
      .map(d => {
        const role = d.owner_id === me.id ? 'owner' : (mine.find(m => m.doc_id === d.id) || {}).role || 'editor';
        return { ...publicMeta(d), role };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
    return json(res, 200, { docs: list });
  }

  // ---- 新建
  if (p === '/api/docs' && req.method === 'POST') {
    return readBody(req).then(b => {
      const d = {
        id: uid('doc_'),
        title: String(b.title || '未命名行程').slice(0, 120),
        data: b.data || {},
        version: 1,
        owner_id: me.id,
        updated_at: now(),
        updated_by: me.id,
        deleted: 0
      };
      db.docs.push(d); save();
      return json(res, 200, { id: d.id, version: d.version, updated_at: d.updated_at });
    }).catch(e => fail(res, e.code === 'too_large' ? 413 : 400, e.code || 'bad_request', '请求格式不对'));
  }

  // ---- 单份表：取 / 存 / 删
  const mDoc = p.match(/^\/api\/docs\/([\w-]+)$/);
  if (mDoc) {
    const id = mDoc[1];
    const got = docRole(id, me.id);
    if (!got) return fail(res, 404, 'not_found', '找不到这份表，或没有权限');

    if (req.method === 'GET') {
      return json(res, 200, { ...publicMeta(got.doc), data: got.doc.data, role: got.role });
    }

    if (req.method === 'PUT') {
      return readBody(req).then(b => {
        if (got.role !== 'owner' && got.role !== 'editor') return fail(res, 403, 'forbidden', '没有编辑权限');
        if (b.version !== got.doc.version) {
          const u = db.users.find(x => x.id === got.doc.updated_by);
          return json(res, 409, {
            error: 'version_conflict',
            message: '这份表已被' + (u ? u.email : '其他人') + '修改',
            current: { ...publicMeta(got.doc) }
          });
        }
        got.doc.title = String(b.title || got.doc.title).slice(0, 120);
        got.doc.data = b.data || got.doc.data;
        got.doc.version += 1;
        got.doc.updated_at = now();
        got.doc.updated_by = me.id;
        save();
        return json(res, 200, { version: got.doc.version, updated_at: got.doc.updated_at });
      }).catch(e => fail(res, e.code === 'too_large' ? 413 : 400, e.code || 'bad_request', '请求格式不对'));
    }

    if (req.method === 'DELETE') {
      if (got.role !== 'owner') return fail(res, 403, 'forbidden', '只有创建者能删除');
      got.doc.deleted = 1; got.doc.updated_at = now(); save();
      return json(res, 200, { ok: true });
    }
  }

  // ---- 邀请
  const mInvite = p.match(/^\/api\/docs\/([\w-]+)\/invite$/);
  if (mInvite && req.method === 'POST') {
    const got = docRole(mInvite[1], me.id);
    if (!got) return fail(res, 404, 'not_found', '找不到这份表');
    const code = crypto.randomBytes(5).toString('hex');
    db.invites = db.invites.filter(x => x.doc_id !== got.doc.id && x.expires_at > now());
    db.invites.push({ code, doc_id: got.doc.id, expires_at: now() + 7 * 24 * 3600 * 1000 });
    save();
    return json(res, 200, { code, expires_at: now() + 7 * 24 * 3600 * 1000 });
  }

  // ---- 接受邀请
  if (p === '/api/join' && req.method === 'POST') {
    return readBody(req).then(b => {
      const code = String(b.code || '').trim();
      const inv = db.invites.find(x => x.code === code);
      if (!inv || inv.expires_at < now()) return fail(res, 404, 'bad_code', '邀请码无效或已过期');
      const got = docRole(inv.doc_id, me.id);
      if (!got) {
        db.members.push({ doc_id: inv.doc_id, user_id: me.id, role: 'editor', joined_at: now() });
        save();
      }
      const d = db.docs.find(x => x.id === inv.doc_id);
      return json(res, 200, { docId: inv.doc_id, title: d ? d.title : '', role: got ? got.role : 'editor' });
    }).catch(e => fail(res, 400, e.code || 'bad_request', '请求格式不对'));
  }

  // ---- 成员
  const mMem = p.match(/^\/api\/docs\/([\w-]+)\/members$/);
  if (mMem && req.method === 'GET') {
    const got = docRole(mMem[1], me.id);
    if (!got) return fail(res, 404, 'not_found', '找不到这份表');
    const list = [{ email: (db.users.find(u => u.id === got.doc.owner_id) || {}).email, role: 'owner' }];
    db.members.filter(m => m.doc_id === got.doc.id).forEach(m => {
      const u = db.users.find(x => x.id === m.user_id);
      if (u) list.push({ email: u.email, role: m.role });
    });
    return json(res, 200, { members: list });
  }

  return fail(res, 404, 'not_found', '接口不存在');
}

// ---------------------------------------------------------------- 静态文件
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const file = path.join(__dirname, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(__dirname)) return fail(res, 403, 'forbidden', '禁止访问');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 单页应用兜底：未知路径回首页
      const idx = path.join(__dirname, 'index.html');
      return fs.readFile(idx, (e2, buf) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ETag: etag
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- 启动
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // 基础安全头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.startsWith('/api/')) {
    try {
      const r = handleApi(req, res, url);
      if (r && typeof r.catch === 'function') {
        r.catch(e => {
          console.error('[api] 未捕获:', e);
          if (!res.headersSent) fail(res, 500, 'server_error', '服务器出错了');
        });
      }
    } catch (e) {
      console.error('[api] 异常:', e);
      if (!res.headersSent) fail(res, 500, 'server_error', '服务器出错了');
    }
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  backupDaily();
  console.log(`行程排期台账已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据文件: ${DB_FILE}`);
  console.log(`注册: ${ALLOW_REGISTER ? '开放' : '关闭（仅邀请）'}`);
});

process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });
