// 微信小程序灵感库 · 自部署版后端（零外部依赖，Node 20+ 原生 http + node:sqlite）
// 启动：node server.js，端口环境变量 PORT（默认 3000），监听 0.0.0.0。
// 数据：DATABASE_PATH 环境变量，默认./data/app.db；库为空时自动导入
// data/ideas-seed.json（66 条）与 data/fetch-log-seed.json（2 批抓取记录）。
// 定时抓取：见 scripts/fetch.js 与 crons/auto-fetch.md。没有配模型 API 时，
// 抓取只记一条任务（保存完整提示词）并跳过，绝不编造灵感。
// 注意：本文件不含任何真实凭据；模型 API Key 只放.env（已 gitignore）或
// 页面设置里（只存库文件里，不进仓库），不要写进聊天记录或仓库。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath} from 'node:url';
import { spawn} from 'node:child_process';
import { DatabaseSync} from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.resolve(process.env.DATABASE_PATH || './data/app.db');
const SEED_PATH = path.resolve(process.env.SEED_PATH || './data/ideas-seed.json');
const FETCH_LOG_SEED_PATH = path.resolve(process.env.FETCH_LOG_SEED_PATH || './data/fetch-log-seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true});
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS ideas (
id INTEGER PRIMARY KEY,
title TEXT NOT NULL,
category TEXT NOT NULL DEFAULT 'youth',
pitch TEXT NOT NULL DEFAULT '',
how TEXT NOT NULL DEFAULT '',
why TEXT NOT NULL DEFAULT '',
monetization TEXT NOT NULL DEFAULT '',
subject TEXT NOT NULL DEFAULT 'personal',
subject_note TEXT NOT NULL DEFAULT '',
difficulty INTEGER NOT NULL DEFAULT 2,
risks TEXT NOT NULL DEFAULT '',
source TEXT NOT NULL DEFAULT 'curated',
created_at INTEGER NOT NULL,
featured INTEGER NOT NULL DEFAULT 0,
favorite INTEGER NOT NULL DEFAULT 0,
seen INTEGER NOT NULL DEFAULT 0,
status TEXT
);
CREATE TABLE IF NOT EXISTS fetch_log (
id INTEGER PRIMARY KEY,
fetched_at INTEGER NOT NULL,
added_count INTEGER NOT NULL DEFAULT 0,
idea_ids TEXT NOT NULL DEFAULT '[]',
titles TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS fetch_tasks (
id INTEGER PRIMARY KEY,
started_at INTEGER NOT NULL,
finished_at INTEGER,
status TEXT NOT NULL DEFAULT 'running',
added INTEGER NOT NULL DEFAULT 0,
skipped INTEGER NOT NULL DEFAULT 0,
note TEXT,
prompt TEXT
);
CREATE TABLE IF NOT EXISTS fetch_settings (
id INTEGER PRIMARY KEY CHECK (id = 1),
fetch_times_per_day INTEGER NOT NULL DEFAULT 4,
fetch_batch_size INTEGER NOT NULL DEFAULT 12,
model_api_base_url TEXT NOT NULL DEFAULT '',
model_api_key TEXT,
model_name TEXT NOT NULL DEFAULT ''
);
`);
const cols = db.prepare(`PRAGMA table_info(ideas)`).all().map((c) => c.name);
for (const [col, def] of [['risks', `TEXT NOT NULL DEFAULT ''`], ['featured', 'INTEGER NOT NULL DEFAULT 0']]) {
if (!cols.includes(col)) db.exec(`ALTER TABLE ideas ADD COLUMN ${col} ${def}`);
}
db.prepare(`INSERT OR IGNORE INTO fetch_settings (id) VALUES (1)`).run();

const now = () => Date.now();
function toMs(v) {
if (v == null || v === '') return now();
if (typeof v === 'number') return v;
const t = Date.parse(String(v));
return Number.isFinite(t)? t: now();
}
function toIso(ms) { try { return new Date(Number(ms)).toISOString();} catch { return '';}}
function safeJsonArray(v) {
if (Array.isArray(v)) return v;
if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p)? p: [];} catch { return [];}}
return [];
}
function normTitle(t) { return String(t || '').toLowerCase().replace(/[\s·・\-_/\\()（）《》"“”'']/g, '');}

function ideaOut(row) {
if (!row) return null;
return {
id: row.id, title: row.title, category: row.category, pitch: row.pitch,
how: row.how, why: row.why, monetization: row.monetization,
subject: row.subject, subjectNote: row.subject_note, difficulty: row.difficulty,
risks: row.risks || '', source: row.source, createdAt: toIso(row.created_at),
featured: row.featured? 1: 0, favorite: row.favorite? 1: 0,
seen: row.seen? 1: 0, status: row.status || null,
};
}
function getIdea(id) {
const row = db.prepare(`SELECT * FROM ideas WHERE id =?`).get(Number(id));
return row? ideaOut(row): null;
}
function insertIdea(p) {
const id = Number.isFinite(Number(p.id)) && Number(p.id) > 0? Number(p.id): null;
const r = db.prepare(`INSERT INTO ideas
(id, title, category, pitch, how, why, monetization, subject, subject_note,
difficulty, risks, source, created_at, featured, favorite, seen, status)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
.run(id, p.title, p.category || 'youth', p.pitch || '', p.how || '', p.why || '',
p.monetization || '', p.subject || 'personal', p.subjectNote || '',
Number(p.difficulty) || 2, p.risks || '', p.source || 'curated', toMs(p.createdAt),
p.featured? 1: 0, p.favorite? 1: 0, p.seen? 1: 0, p.status || null);
return getIdea(r.lastInsertRowid);
}

function seedFromFiles() {
const count = db.prepare(`SELECT COUNT(*) c FROM ideas`).get().c;
if (count > 0) return { seeded: 0, note: '库里已有数据，跳过导入'};
if (!fs.existsSync(SEED_PATH)) return { seeded: 0, note: `种子文件不存在：${SEED_PATH}`};
let list;
try { list = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));} catch (e) {
return { seeded: 0, note: `种子文件解析失败：${e.message}`};
}
if (!Array.isArray(list)) list = list.ideas || [];
let inserted = 0, skipped = 0;
const seenTitles = new Set();
for (const p of list) {
if (!p ||!p.title) { skipped++; continue;}
const n = normTitle(p.title);
if (seenTitles.has(n)) { skipped++; continue;}
seenTitles.add(n);
insertIdea(p);
inserted++;
}
let logSeeded = 0;
if (fs.existsSync(FETCH_LOG_SEED_PATH)) {
try {
const batches = JSON.parse(fs.readFileSync(FETCH_LOG_SEED_PATH, 'utf8'));
for (const b of batches) {
db.prepare(`INSERT OR IGNORE INTO fetch_log (id, fetched_at, added_count, idea_ids, titles)
VALUES (?,?,?,?,?)`).run(b.id, toMs(b.fetchedAt), b.addedCount,
JSON.stringify(b.ideaIds || []), JSON.stringify(b.titles || []));
logSeeded++;
}
} catch { /* 抓取记录种子失败不影响灵感入库 */}
}
return { seeded: inserted, skipped, logSeeded};
}
const seedResult = seedFromFiles();
if (seedResult.seeded > 0) console.log(`seeded ${seedResult.seeded} ideas from ${SEED_PATH}`);

function getSettings() {
const row = db.prepare(`SELECT * FROM fetch_settings WHERE id = 1`).get();
const env = (k) => process.env[k] || '';
return {
fetch_times_per_day: row.fetch_times_per_day,
fetch_batch_size: row.fetch_batch_size,
model_api_base_url: env('MODEL_API_BASE_URL') || row.model_api_base_url || '',
model_name: env('MODEL_NAME') || row.model_name || '',
has_model_api_key:!!(env('MODEL_API_KEY') || row.model_api_key),
model_api_key_mask: (env('MODEL_API_KEY') || row.model_api_key || '').length > 4
? '••••' + (env('MODEL_API_KEY') || row.model_api_key).slice(-4): '',
};
}

const actions = {
listideas(b = {}) {
const where = [], params = [];
if (b.category) { where.push(`category =?`); params.push(b.category);}
if (b.subject) { where.push(`subject =?`); params.push(b.subject);}
if (b.favorites) { where.push(`favorite = 1`);}
if (b.unseen) { where.push(`seen = 0`);}
if (b.seen) { where.push(`seen = 1`);}
if (b.status) { where.push(`status =?`); params.push(b.status);}
if (b.batch) {
const log = db.prepare(`SELECT idea_ids FROM fetch_log WHERE id =?`).get(Number(b.batch));
const ids = log? safeJsonArray(log.idea_ids): [];
if (ids.length === 0) return { ideas: [], total: 0};
where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
}
if (b.search) {
where.push(`(title LIKE? OR pitch LIKE? OR why LIKE? OR how LIKE?)`);
const q = `%${b.search}%`; params.push(q, q, q, q);
}
const sql = `SELECT * FROM ideas ${where.length? 'WHERE ' + where.join(' AND '): ''} ORDER BY id DESC`;
const rows = db.prepare(sql).all(...params).map(ideaOut);
const categories = db.prepare(`SELECT category, COUNT(*) c FROM ideas GROUP BY category ORDER BY c DESC`)
.all().map((r) => ({ id: r.category, count: r.c}));
return { ideas: rows, total: rows.length, categories,
favoriteCount: db.prepare(`SELECT COUNT(*) c FROM ideas WHERE favorite = 1`).get().c,
unseenCount: db.prepare(`SELECT COUNT(*) c FROM ideas WHERE seen = 0`).get().c,
seenCount: db.prepare(`SELECT COUNT(*) c FROM ideas WHERE seen = 1`).get().c};
},

getstats() {
const total = db.prepare(`SELECT COUNT(*) c FROM ideas`).get().c;
const byCategory = {};
for (const r of db.prepare(`SELECT category, COUNT(*) c FROM ideas GROUP BY category`).all()) byCategory[r.category] = r.c;
const bySubject = {};
for (const r of db.prepare(`SELECT subject, COUNT(*) c FROM ideas GROUP BY subject`).all()) bySubject[r.subject] = r.c;
return { total, byCategory, bySubject,
favoriteCount: db.prepare(`SELECT COUNT(*) c FROM ideas WHERE favorite = 1`).get().c,
unseenCount: db.prepare(`SELECT COUNT(*) c FROM ideas WHERE seen = 0`).get().c,
fetchBatches: db.prepare(`SELECT COUNT(*) c FROM fetch_log`).get().c};
},

togglefavorite(b = {}) {
const cur = db.prepare(`SELECT * FROM ideas WHERE id =?`).get(Number(b.id));
if (!cur) throw Object.assign(new Error('灵感不存在'), { code: 404});
db.prepare(`UPDATE ideas SET favorite =? WHERE id =?`).run(cur.favorite? 0: 1, Number(b.id));
return { idea: getIdea(b.id)};
},

setstatus(b = {}) {
const cur = getIdea(b.id);
if (!cur) throw Object.assign(new Error('灵感不存在'), { code: 404});
const ok = [null, 'want', 'evaluating', 'started', 'dropped'].includes(b.status?? null);
if (!ok) throw Object.assign(new Error('非法状态'), { code: 400});
db.prepare(`UPDATE ideas SET status =? WHERE id =?`).run(b.status || null, Number(b.id));
return { idea: getIdea(b.id)};
},

markseen(b = {}) {
const cur = getIdea(b.id);
if (!cur) throw Object.assign(new Error('灵感不存在'), { code: 404});
db.prepare(`UPDATE ideas SET seen = 1 WHERE id =?`).run(Number(b.id));
return { idea: getIdea(b.id)};
},

nextidea(b = {}) {
const exclude = new Set(safeJsonArray(b.exclude).map(Number));
const rows = db.prepare(`SELECT * FROM ideas WHERE seen = 0 ORDER BY id`).all().map(ideaOut)
.filter((x) =>!exclude.has(x.id));
if (rows.length === 0) return { idea: null, unseenCount: 0};
return { idea: rows[Math.floor(Math.random() * rows.length)], unseenCount: rows.length};
},

addidea(b = {}) {
if (!b.title ||!String(b.title).trim()) throw Object.assign(new Error('title 必填'), { code: 400});
const idea = insertIdea({
title: String(b.title).trim(), category: b.category || 'youth', pitch: b.pitch || '',
how: b.how || '', why: b.why || '', monetization: b.monetization || '',
subject: b.subject || 'personal', subjectNote: b.subjectNote || '',
difficulty: b.difficulty?? 2, risks: b.risks || '', source: 'user',
createdAt: now(), featured: false, favorite: false, seen: false, status: null,
});
return { idea};
},

deleteidea(b = {}) {
const cur = db.prepare(`SELECT * FROM ideas WHERE id =?`).get(Number(b.id));
if (!cur) throw Object.assign(new Error('灵感不存在'), { code: 404});
if (cur.source!== 'user') throw Object.assign(new Error('只有自己加的灵感才能删'), { code: 403});
db.prepare(`DELETE FROM ideas WHERE id =?`).run(Number(b.id));
return { ok: true};
},

listfetchlog() {
const batches = db.prepare(`SELECT * FROM fetch_log ORDER BY id DESC`).all().map((r) => ({
id: r.id, fetchedAt: toIso(r.fetched_at), addedCount: r.added_count,
ideaIds: safeJsonArray(r.idea_ids), titles: safeJsonArray(r.titles),
}));
return { batches};
},

getfetchsettings() { return { settings: getSettings()};},

savefetchsettings(b = {}) {
const s = b.settings || b;
const times = [1, 2, 3, 4, 6, 8].includes(Number(s.fetch_times_per_day))? Number(s.fetch_times_per_day): 4;
const size = Math.min(20, Math.max(1, Number(s.fetch_batch_size) || 12));
const cur = db.prepare(`SELECT * FROM fetch_settings WHERE id = 1`).get();
const key = (s.model_api_key!== undefined && s.model_api_key!== '')? s.model_api_key: cur.model_api_key;
db.prepare(`UPDATE fetch_settings SET fetch_times_per_day =?, fetch_batch_size =?,
model_api_base_url =?, model_api_key =?, model_name =? WHERE id = 1`)
.run(times, size, s.model_api_base_url || '', key || null, s.model_name || '');
return { settings: getSettings()};
},

fetchnewideas() {
const r = db.prepare(`INSERT INTO fetch_tasks (started_at, status, added, skipped) VALUES (?, 'running', 0, 0)`).run(now());
const runId = r.lastInsertRowid;
const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'fetch.js')], {
detached: true, stdio: 'ignore',
env: {...process.env, DATABASE_PATH: DB_PATH, FETCH_TASK_ID: String(runId)},
});
child.unref();
return { started: true, run_id: runId};
},

getfetchstatus() {
const last = db.prepare(`SELECT * FROM fetch_tasks ORDER BY id DESC LIMIT 1`).get();
const running =!!db.prepare(`SELECT 1 FROM fetch_tasks WHERE status = 'running' LIMIT 1`).get();
return { running, last_run: last? {
id: last.id, started_at: toIso(last.started_at), finished_at: last.finished_at? toIso(last.finished_at): null,
status: last.status, added: last.added, skipped: last.skipped, note: last.note || '',
}: null};
},

seedcatalog() { return seedFromFiles();},
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
'.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
'.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8'};

function sendJson(res, code, obj) {
res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8'});
res.end(JSON.stringify(obj));
}
function readBody(req) {
return new Promise((resolve, reject) => {
const chunks = []; let size = 0;
req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy();} chunks.push(c);});
req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
req.on('error', reject);
});
}

const server = http.createServer(async (req, res) => {
try {
const url = new URL(req.url, 'http://localhost');
const pathname = decodeURIComponent(url.pathname);
if (req.method === 'GET' && pathname === '/api/health') {
const ideas = db.prepare(`SELECT COUNT(*) c FROM ideas`).get().c;
return sendJson(res, 200, { ok: true, ideas});
}
if (req.method === 'POST' && pathname.startsWith('/api/')) {
const action = pathname.slice('/api/'.length).split('/')[0];
if (!actions[action]) return sendJson(res, 400, { ok: false, error: `未知动作：${action}`});
let body = {};
const raw = await readBody(req);
if (raw.trim()) { try { body = JSON.parse(raw);} catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败'});}}
const result = await actions[action](body && typeof body === 'object'? body: {});
return sendJson(res, 200, { ok: true,...result});
}
if (req.method === 'GET') {
const rel = pathname === '/'? 'index.html': pathname.replace(/^\/+/, '');
const file = path.normalize(path.join(PUBLIC_DIR, rel));
if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden'});
if (fs.existsSync(file) && fs.statSync(file).isFile()) {
res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'});
fs.createReadStream(file).pipe(res);
return;
}
return sendJson(res, 404, { ok: false, error: 'not found'});
}
return sendJson(res, 405, { ok: false, error: 'method not allowed'});
} catch (e) {
console.error(e);
return sendJson(res, e?.code || 500, { ok: false, error: String(e?.message || e)});
}
});

server.listen(PORT, '0.0.0.0', () => {
console.log(`wechat-mini-program-inspiration-library listening on 0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
