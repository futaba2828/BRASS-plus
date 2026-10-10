import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.BRASS_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'groups.json');
app.use(express.json({ limit: process.env.BRASS_MAX_BODY || '15mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname, { index: false, setHeaders(res, filePath) { if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); } } }));
app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.type('html').sendFile(path.join(__dirname, 'index.html')); });

async function readDB() {
  try { return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); }
  catch { return { groups: {} }; }
}
async function writeDB(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}
const cleanText = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const normalizeCode = v => cleanText(v, 32).toUpperCase();
const randomCode = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
const emptyData = () => ({ goals: [], practices: [], issues: [], mornings: {}, songs: [], lessons: [], posts: [], recommendations: [], voices: [], tags: [] });
function newGroup(code, name, owner, clientId = '') {
  return { code, name: cleanText(name, 80) || 'BRASS+グループ', createdAt: new Date().toISOString(), members: [{ name: cleanText(owner, 40) || '未設定', clientId: cleanText(clientId, 100), joinedAt: new Date().toISOString(), profile: null }], data: emptyData() };
}
function addEvent(group, type, actor, detail, clientId = '') {
  group.events = Array.isArray(group.events) ? group.events : [];
  group.nextEventId = (Number(group.nextEventId) || 0) + 1;
  group.events.push({ id: group.nextEventId, type, actor: cleanText(actor, 40) || 'メンバー', detail: cleanText(detail, 100), clientId: cleanText(clientId, 100), at: new Date().toISOString() });
  group.events = group.events.slice(-150);
}
function mergeArray(target, incoming, deleted = []) {
  const blocked = new Set((Array.isArray(deleted) ? deleted : []).map(String));
  const map = new Map((Array.isArray(target) ? target : []).filter(x => x?.id && !blocked.has(String(x.id))).map(x => [String(x.id), x]));
  for (const x of (Array.isArray(incoming) ? incoming : [])) {
    if (!x?.id || x.share === 'private' || blocked.has(String(x.id))) continue;
    map.set(String(x.id), x);
  }
  return [...map.values()].slice(-1000);
}
function mergeData(group, incoming) {
  const allowed = ['goals', 'practices', 'issues', 'songs', 'lessons', 'posts', 'recommendations', 'voices'];
  group.deletedItems = group.deletedItems || {};
  for (const k of allowed) group.data[k] = mergeArray(group.data[k], incoming?.[k], group.deletedItems[k]);
  // Tags are strings, not objects with IDs. Treat the submitted list as the full group list so deletions sync too.
  if (Array.isArray(incoming?.tags)) group.data.tags = [...new Set(incoming.tags.map(x => cleanText(x, 40)).filter(Boolean))].slice(0, 200);
  else if (!Array.isArray(group.data.tags)) group.data.tags = [];
  // 朝練は各メンバーの端末内だけで管理し、グループ同期しない。
  // 音階チェックの達成記録は個人専用のため、サーバーに保存・同期しない。
  delete group.data.scaleChecks;
  // Myポジション表はサーバーへ保存しない（個人専用）
  delete group.data.mySlides;
}
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'BRASS+', version: 'complete-7-leave-missing-group-fix' }));
app.post('/api/groups', async (req, res) => {
  const db = await readDB();
  let requested = normalizeCode(req.body?.code);
  if (requested && !/^[A-Z0-9]{1,32}$/.test(requested)) return res.status(400).json({ error: 'グループコードは英大文字（A〜Z）と数字（0〜9）のみ、32文字以内で入力してください。' });
  if (requested && db.groups[requested]) return res.status(409).json({ error: 'すでに存在しています。同じコードは使えません。' });
  let code = requested;
  if (!code) { do { code = randomCode(); } while (db.groups[code]); }
  const g = newGroup(code, req.body?.name, req.body?.owner, req.body?.clientId || '');
  g.events = []; g.nextEventId = 0;
  addEvent(g, 'group-created', req.body?.owner, `「${g.name}」を作成しました`, req.body?.clientId || '');
  db.groups[code] = g;
  await writeDB(db);
  res.json({ ok: true, code: g.code, name: g.name, members: g.members, data: g.data, deletedItems: g.deletedItems || {} });
});
app.get('/api/groups/:code', async (req, res) => {
  const db = await readDB(); const g = db.groups[normalizeCode(req.params.code)];
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  res.json({ ok: true, code: g.code, name: g.name, members: g.members, data: g.data, deletedItems: g.deletedItems || {} });
});
app.post('/api/groups/:code/join', async (req, res) => {
  const db = await readDB(); const g = db.groups[normalizeCode(req.params.code)];
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  const name = cleanText(req.body?.name, 40) || '未設定';
  const clientId = cleanText(req.body?.clientId, 100);
  let member = clientId ? g.members.find(m => m.clientId === clientId) : null;
  if (!member) member = g.members.find(m => m.name === name);
  if (member) { const oldName = member.name; member.name = name; if (clientId) member.clientId = clientId; if (oldName !== name) addEvent(g, 'member-renamed', name, `${oldName}さんが${name}さんに名前を変更しました`, clientId); }
  else { g.members.push({ name, clientId, joinedAt: new Date().toISOString(), profile: null }); addEvent(g, 'member-joined', name, `${name}さんが参加しました`, clientId); }
  g.members = g.members.slice(-100); await writeDB(db);
  res.json({ ok: true, code: g.code, name: g.name, members: g.members, data: g.data, deletedItems: g.deletedItems || {} });
});
app.post('/api/groups/:code/leave', async (req, res) => {
  const db = await readDB(); const code = normalizeCode(req.params.code); const g = db.groups[code];
  if (!g) return res.json({ ok: true, left: false, missing: true, members: [] });
  const name = cleanText(req.body?.name, 40) || 'メンバー';
  const clientId = cleanText(req.body?.clientId, 100);
  const before = g.members.length;
  // First remove the exact device record. If the device ID changed (for example after
  // switching browser contexts), allow the matching name as a compatibility fallback.
  let matchIndex = clientId ? g.members.findIndex(m => m.clientId && m.clientId === clientId) : -1;
  if (matchIndex < 0) matchIndex = g.members.findIndex(m => m.name === name);
  if (matchIndex >= 0) g.members.splice(matchIndex, 1);
  const left = g.members.length < before;
  if (left) addEvent(g, 'member-left', name, `${name}さんが退会しました`, clientId);
  await writeDB(db);
  res.json({ ok: true, left, members: g.members });
});
app.get('/api/groups/:code/events', async (req, res) => {
  const db = await readDB(); const g = db.groups[normalizeCode(req.params.code)];
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  const after = Number(req.query.after) || 0; const clientId = cleanText(req.query.clientId, 100);
  res.json({ ok: true, events: (g.events || []).filter(e => e.id > after && e.clientId !== clientId), latestId: Number(g.nextEventId) || 0 });
});
app.get('/api/groups/:code/stream', async (req, res) => {
  const code = normalizeCode(req.params.code); const clientId = cleanText(req.query.clientId, 100);
  const initialDb = await readDB(); if (!initialDb.groups[code]) return res.status(404).end();
  res.status(200); res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  let after = Number(req.query.after) || 0; let closed = false; let busy = false;
  res.write('event: ready\ndata: {}\n\n');
  const timer = setInterval(async () => {
    if (closed || busy) return; busy = true;
    try {
      const db = await readDB(); const g = db.groups[code];
      if (!g) { res.write('event: group-missing\ndata: {}\n\n'); clearInterval(timer); res.end(); closed = true; return; }
      const events = (g.events || []).filter(e => e.id > after);
      for (const ev of events) { after = Math.max(after, Number(ev.id) || 0); if (ev.clientId !== clientId) res.write(`event: notification\ndata: ${JSON.stringify(ev)}\n\n`); }
      if (!events.length) res.write(': keepalive\n\n');
    } catch { /* transient read error; the stream retries on the next tick */ }
    finally { busy = false; }
  }, 1000);
  req.on('close', () => { closed = true; clearInterval(timer); });
});
app.post('/api/groups/:code/delete', async (req, res) => {
  const db = await readDB(); const g = db.groups[normalizeCode(req.params.code)];
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  const collection = cleanText(req.body?.collection, 30); const id = cleanText(req.body?.id, 200);
  if (!['goals', 'practices', 'issues', 'lessons', 'songs', 'posts', 'recommendations', 'voices'].includes(collection) || !id) return res.status(400).json({ error: '削除対象が不正です' });
  g.deletedItems = g.deletedItems || {}; g.deletedItems[collection] = Array.isArray(g.deletedItems[collection]) ? g.deletedItems[collection] : [];
  if (!g.deletedItems[collection].includes(id)) g.deletedItems[collection].push(id);
  g.deletedItems[collection] = g.deletedItems[collection].slice(-5000);
  g.data[collection] = (Array.isArray(g.data[collection]) ? g.data[collection] : []).filter(x => String(x?.id) !== id);
  addEvent(g, 'item-deleted', cleanText(req.body?.member, 40), `${({goals:'目標',practices:'練習',issues:'課題点',lessons:'レッスン',songs:'曲',posts:'投稿',recommendations:'おすすめ',voices:'音声'}[collection]||'項目')}を削除しました`, cleanText(req.body?.clientId, 100));
  await writeDB(db); res.json({ ok: true });
});
app.post('/api/groups/:code/sync', async (req, res) => {
  const db = await readDB(); const g = db.groups[normalizeCode(req.params.code)];
  if (!g) return res.status(404).json({ error: 'グループが見つかりません' });
  const name = cleanText(req.body?.member, 40) || '未設定';
  const clientId = cleanText(req.body?.clientId, 100);
  let member = clientId ? g.members.find(m => m.clientId === clientId) : null;
  if (!member) member = g.members.find(m => m.name === name);
  if (!member) { member = { name, clientId, joinedAt: new Date().toISOString(), profile: null }; g.members.push(member); }
  else { const oldName = member.name; member.name = name; if (clientId) member.clientId = clientId; if (oldName !== name) addEvent(g, 'member-renamed', name, `${oldName}さんが${name}さんに名前を変更しました`, clientId); }
  member.morningCount = Math.max(0, Math.floor(Number(req.body?.morningCount) || 0));
  if (req.body?.profile && typeof req.body.profile === 'object') member.profile = { instrument: cleanText(req.body.profile.instrument, 60), grade: cleanText(req.body.profile.grade, 30), intro: cleanText(req.body.profile.intro, 240), trombonist: cleanText(req.body.profile.trombonist, 100) };
  g.members = g.members.slice(-100);
  const incoming = req.body?.data || {};
  const labels = { goals: '目標', practices: '練習', issues: '課題点', songs: '曲', lessons: 'レッスン', posts: '一言投稿', recommendations: 'おすすめ', voices: '音声・記録', tags: 'タグ' };
  for (const key of Object.keys(labels)) {
    const oldList = Array.isArray(g.data?.[key]) ? g.data[key] : [];
    const newList = Array.isArray(incoming[key]) ? incoming[key] : [];
    const oldMap = new Map(oldList.filter(x => x?.id).map(x => [String(x.id), x]));
    for (const item of newList) {
      if (!item?.id || item.share === 'private') continue;
      const oldItem = oldMap.get(String(item.id));
      if (!oldItem) addEvent(g, 'item-added', name, `${labels[key]}「${cleanText(item.title || item.text || item.name || '項目', 50)}」を登録しました`, clientId);
      else if (JSON.stringify(oldItem) !== JSON.stringify(item)) addEvent(g, 'item-updated', name, `${labels[key]}「${cleanText(item.title || item.text || item.name || '項目', 50)}」を変更しました`, clientId);
    }
  }
  mergeData(g, incoming); g.updatedAt = new Date().toISOString();
  await writeDB(db); res.json({ ok: true, data: g.data, members: g.members });
});
app.post('/api/analyze', (req, res) => {
  const issues = Array.isArray(req.body?.issues) ? req.body.issues : [];
  const counts = {};
  for (const issue of issues) for (const tag of (Array.isArray(issue.tags) ? issue.tags : [])) counts[cleanText(tag, 40)] = (counts[cleanText(tag, 40)] || 0) + 1;
  const top = Object.entries(counts).filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const suggestions = {
    '音程': ['チューナーを使い、ロングトーンで音の中心を確認する。', '小さな音量でも音程が安定するか確認する。'],
    'リズム': ['難しい小節だけを取り出し、ゆっくりから練習する。', 'メトロノームに合わせて手拍子してから楽器で吹く。'],
    '息': ['息の流れを一定にして、無理のない音量でロングトーンを行う。'],
    '発音': ['息の流れを先に作り、ゆっくりしたテンポで音の立ち上がりを確認する。'],
    'タンギング': ['ゆっくりしたテンポで、音の長さと粒をそろえて練習する。']
  };
  const tips = top.map(([tag, count]) => ({ title: `${tag}（${count}件）`, text: (suggestions[tag] || ['課題を短い部分に分け、ゆっくり確認してから少しずつテンポを上げる。']).join(' '), url: 'https://www.yamaha.com/ja/musical_instrument_guide/trombone/' }));
  if (!tips.length && issues.length) tips.push({ title: '課題を整理する', text: '課題点にタグを付けると、傾向をより分かりやすく分析できます。まずは一度に一つの課題に絞って練習しましょう。', url: 'https://www.yamaha.com/ja/musical_instrument_guide/trombone/' });
  res.json({ ok: true, summary: issues.length ? `${issues.length}件の課題点をもとに、タグの多い順で練習のヒントをまとめました。これはルールベースの分析で、生成AIによる分析ではありません。` : '課題点がまだ登録されていません。課題点を登録してから、もう一度分析してください。', tips });
});
app.use((req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`BRASS+ server running on port ${PORT}`));
