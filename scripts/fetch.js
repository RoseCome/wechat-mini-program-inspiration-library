// 定时 / 手动抓取新灵感（零外部依赖，Node 20+）
// 用法：
// node scripts/fetch.js # 跑一轮抓取（定时任务直接调它）
// node scripts/fetch.js --dry-run # 只检查配置，不调模型、不入库
// node scripts/fetch.js --check-due # 按 FETCH_TIMES_PER_DAY 判断本轮是否到时间，
// # 到时间返回 0，未到返回 2（供 cron / 青龙先判断）
// FETCH_TIMES_PER_DAY=4 node scripts/fetch.js # 一天 4 次，间隔约 6 小时
//
// 来源说明（重要）：灵感不是从某个网站抄来的，也不是爬虫抓的。它是模型根据
// 已知真实海外产品（如 Gartic Phone / BeReal / Yuka / Splitwise 等）生成的
// 中文点子，每条都要点名海外原型、写清为什么推荐、并附风险。生成前会先读
// 库里已有的全部标题做去重，生成后按标题归一化再去重一次。
//
// 没有配模型 API 时：本脚本只在 fetch_tasks 表里记一条 status='skipped_no_api'
// 的任务（连同完整提示词一起保存，方便以后配好 API 再跑），不入库、不编造
// 任何灵感，退出码为 0。
//
// 配置（环境变量优先于库里的设置；.env 文件会被自动读取）：
// MODEL_API_BASE_URL 模型接口地址，如 https://api.openai.com/v1（OpenAI 兼容）
// MODEL_API_KEY 模型 API Key（只放.env / 环境变量，不要进仓库）
// MODEL_NAME 模型名，如 gpt-4o-mini / deepseek-chat / qwen-plus
// FETCH_BATCH_SIZE 每批抓几个，默认 12（1–20）
// FETCH_TIMES_PER_DAY 一天抓几次，默认 4（配合 --check-due 用）
// DATABASE_PATH 默认./data/app.db
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath} from 'node:url';
import { DatabaseSync} from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// --- 读.env（简单解析，不依赖任何包；已在环境变量里的优先） ---
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
if (m &&!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
}

const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(ROOT, 'data', 'app.db'));
const TASK_ID = process.env.FETCH_TASK_ID? Number(process.env.FETCH_TASK_ID): null;
const DRY_RUN = process.argv.includes('--dry-run');
const CHECK_DUE = process.argv.includes('--check-due');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true});
const db = new DatabaseSync(DB_PATH);
const now = () => Date.now();
const normTitle = (t) => String(t || '').toLowerCase().replace(/[\s·・\-_/\\()（）《》"“”'']/g, '');

const BANNED = ['二维码', '计算器', '倒数日', '图片压缩', '二维码生成', '生活计算器'];
const OVERSEAS_HINTS = ['Gartic', 'Wavelength', 'BeReal', 'Locket', 'NGL', 'Gas', 'Letterboxd', 'Depop', 'Finch', 'FutureMe', 'Yuka', 'Too Good To Go', 'Splitwise', 'PictureThis', 'NoWaste', 'Wise', 'Flighty', 'Headspace', 'Wordle', 'Heardle', 'Pinterest', 'Psych', 'Festify', 'Tribute', 'Taskmaster', 'Whering', 'Indyx', 'Photo Roulette', 'Most Likely'];

function getSettings() {
const row = db.prepare(`SELECT * FROM fetch_settings WHERE id = 1`).get() || {};
return {
timesPerDay: Number(process.env.FETCH_TIMES_PER_DAY || row.fetch_times_per_day || 4),
batchSize: Math.min(20, Math.max(1, Number(process.env.FETCH_BATCH_SIZE || row.fetch_batch_size || 12))),
baseUrl: (process.env.MODEL_API_BASE_URL || row.model_api_base_url || '').replace(/\/$/, ''),
apiKey: process.env.MODEL_API_KEY || row.model_api_key || '',
model: process.env.MODEL_NAME || row.model_name || '',
};
}

function buildPrompt(batchSize, existingTitles) {
return `你是一名熟悉中国微信小程序生态和海外 App/产品的选品顾问。请为一位做大码女装电商、正在做喝酒游戏小程序、同时有个人号和公司号的用户，生成 ${batchSize} 个「适合做成微信小程序」的灵感点子。

要求（必须全部满足，否则整批作废）：
1. 只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块。每个元素必须包含这些字段，全部用中文写：
title（标题）, category（只能是 party / youth / tool 三选一）, pitch（一句话卖点）, how（核心玩法/做法）, why（为什么推荐给这位用户，必须点名一个真实海外产品原型，如 Gartic Phone / BeReal / Yuka / Splitwise 等，并说清它在海外怎么火、搬到微信要改哪一刀）, monetization（怎么赚钱）, subject（只能是 personal / enterprise / license 三选一：personal=个人号可做，enterprise=需企业主体，license=需企业主体+资质）, subjectNote（主体与资质说明）, difficulty（1-3 的整数）, risks（风险与注意：这个点子本身的坑，审核、版权、隐私、成本、冷启动，至少一句话）。
2. 其中至少 5 个点子要在 why 里点名一个真实存在的海外产品原型。
3. 绝对不要这些基础货：二维码、计算器、倒数日、图片压缩，以及与下面已有标题重复或高度相似的点子。
4. 三类尽量均衡；点子要具体、有差异、有年轻人味，不要泛泛的「XX工具」「XX合集」。

已有标题（不要重复，标题归一化后去重）：${existingTitles.slice(0, 200).join(' | ') || '无'}`;
}

function finishTask(taskId, status, added, skipped, note) {
if (!taskId) return;
db.prepare(`UPDATE fetch_tasks SET finished_at =?, status =?, added =?, skipped =?, note =? WHERE id =?`)
.run(now(), status, added, skipped, String(note || '').slice(0, 1000), taskId);
}

async function main() {
const settings = getSettings();
const existing = db.prepare(`SELECT title FROM ideas`).all().map((r) => r.title);
const prompt = buildPrompt(settings.batchSize, existing);

if (CHECK_DUE) {
const last = db.prepare(`SELECT finished_at FROM fetch_tasks WHERE status IN ('ok','skipped_no_api') ORDER BY id DESC LIMIT 1`).get();
const intervalMs = (24 / Math.max(1, settings.timesPerDay)) * 3600 * 1000;
const lastAt = last?.finished_at || 0;
if (Date.now() - lastAt < intervalMs) {
console.log(`未到时间：上次抓取 ${lastAt? new Date(lastAt).toISOString(): '从未'}，间隔 ${(intervalMs / 3600000).toFixed(1)}h（一天 ${settings.timesPerDay} 次）`);
process.exit(2);
}
console.log('到时间了，可以抓取');
process.exit(0);
}

let taskId = TASK_ID;
if (!taskId &&!DRY_RUN) {
taskId = db.prepare(`INSERT INTO fetch_tasks (started_at, status, added, skipped, prompt) VALUES (?, 'running', 0, 0,?)`).run(now(), prompt).lastInsertRowid;
}

if (!settings.baseUrl ||!settings.apiKey ||!settings.model) {
const note = '未配置模型 API（MODEL_API_BASE_URL / MODEL_API_KEY / MODEL_NAME 缺一项或多项），已跳过，未编造任何灵感。配好.env 后再跑。';
console.log(note);
if (DRY_RUN) { console.log(JSON.stringify({ configured: false, batchSize: settings.batchSize, timesPerDay: settings.timesPerDay}, null, 2)); return;}
finishTask(taskId, 'skipped_no_api', 0, 0, note);
if (taskId) db.prepare(`UPDATE fetch_tasks SET prompt =? WHERE id =?`).run(prompt, taskId);
return;
}
if (DRY_RUN) { console.log(JSON.stringify({ configured: true, model: settings.model, baseUrl: settings.baseUrl, batchSize: settings.batchSize, timesPerDay: settings.timesPerDay}, null, 2)); return;}

// --- 调模型（OpenAI 兼容接口） ---
let ideas;
try {
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 120000);
const res = await fetch(`${settings.baseUrl}/chat/completions`, {
method: 'POST',
headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}`},
body: JSON.stringify({
model: settings.model,
messages: [{ role: 'user', content: prompt}],
temperature: 0.9,
}),
signal: ctrl.signal,
});
clearTimeout(timer);
if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
const data = await res.json();
let text = data?.choices?.[0]?.message?.content || '';
text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
ideas = JSON.parse(text);
if (!Array.isArray(ideas)) throw new Error('模型返回的不是 JSON 数组');
} catch (e) {
const note = `模型调用失败：${e.message}，未入库任何内容。`;
console.error(note);
finishTask(taskId, 'failed', 0, 0, note);
process.exitCode = 1;
return;
}

// --- 校验 + 去重（不满足直接整批/单条丢弃，绝不硬凑） ---
const existingNorm = new Set(existing.map(normTitle));
const seenBatch = new Set();
let added = 0, skipped = 0;
const valid = [];
for (const it of ideas) {
const bad =!it?.title ||!it?.pitch ||!it?.how ||!it?.why ||!it?.monetization
|| !['party', 'youth', 'tool'].includes(it.category)
|| !['personal', 'enterprise', 'license'].includes(it.subject)
||!it?.risks || BANNED.some((b) => String(it.title).includes(b));
if (bad) { skipped++; continue;}
const n = normTitle(it.title);
if (existingNorm.has(n) || seenBatch.has(n)) { skipped++; continue;}
seenBatch.add(n);
valid.push(it);
}
const overseasCount = valid.filter((it) => OVERSEAS_HINTS.some((h) => String(it.why || '').includes(h))).length;
if (valid.length < 6) {
const note = `本批通过校验的只有 ${valid.length} 条（要求至少 6 条），整批丢弃，未入库。`;
console.log(note);
finishTask(taskId, 'failed', 0, skipped, note);
return;
}
if (overseasCount < 5) {
const note = `本批点名海外原型的只有 ${overseasCount} 条（要求至少 5 条），整批丢弃，未入库。`;
console.log(note);
finishTask(taskId, 'failed', 0, skipped, note);
return;
}

const ids = [], titles = [];
for (const it of valid) {
const r = db.prepare(`INSERT INTO ideas
(title, category, pitch, how, why, monetization, subject, subject_note, difficulty, risks, source, created_at, featured, favorite, seen, status)
VALUES (?,?,?,?,?,?,?,?,?,?, 'fetched',?, 0, 0, 0, NULL)`)
.run(it.title, it.category, it.pitch, it.how, it.why, it.monetization,
it.subject, it.subjectNote || '', Number(it.difficulty) || 2, it.risks, now());
ids.push(r.lastInsertRowid); titles.push(it.title); added++;
}
const log = db.prepare(`INSERT INTO fetch_log (fetched_at, added_count, idea_ids, titles) VALUES (?,?,?,?)`)
.run(now(), added, JSON.stringify(ids), JSON.stringify(titles));
console.log(`抓取完成：新增 ${added} 条，跳过 ${skipped} 条，批次 #${log.lastInsertRowid}`);
finishTask(taskId, 'ok', added, skipped, `新增 ${added} 条，批次 #${log.lastInsertRowid}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1;});
