import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname, { index: false, setHeaders(res, filePath) { if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); } } }));
app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.type('html').sendFile(path.join(__dirname, 'index.html')); });

// Supabase is the shared source of truth when credentials are configured.
// The local JSON file remains a fallback and a one-time migration source.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '');
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '');
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:brass-plus@example.com');
const pushReady = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && hasSupabase);
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) { try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); } catch (e) { console.error('[BRASS+ push] VAPID設定エラー:', e.message); } }
let supabaseWarningLogged = false;
async function supabaseRequest(pathname, options = {}) {
  if (!hasSupabase) throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY in Render Environment.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}
async function sendGroupPush(code, event) {
  if (!pushReady) return;
  let rows;
  try { rows = await supabaseRequest(`brass_push_subscriptions?select=endpoint,subscription,client_id,sound_enabled,vibration_enabled&group_code=eq.${encodeURIComponent(normalizeCode(code))}`); }
  catch (e) { console.warn('[BRASS+ push] subscriptions read failed:', e.message); return; }
  let groupName = normalizeCode(code);
  try { const db = await readDB(); groupName = cleanText(db.groups[normalizeCode(code)]?.name || groupName, 80).replace(/グループ/g, '') || groupName; } catch {}
  const payload = JSON.stringify({ title: `【${groupName}】${event.type === 'item-deleted' ? '削除のお知らせ' : event.type === 'member-left' ? 'メンバーの退出' : event.type === 'member-renamed' ? 'メンバー情報の変更' : '新しいお知らせ'}`, body: `${event.actor ? event.actor + '：' : ''}${event.detail || 'グループに更新があります'}`.slice(0,180), url: './', tag: `brass-${normalizeCode(code)}-${event.id}`, soundEnabled: true, vibrationEnabled: true });
  await Promise.all((Array.isArray(rows) ? rows : []).filter(row => row.client_id !== event.clientId).map(async row => {
    try {
      const data = JSON.parse(payload); data.soundEnabled = row.sound_enabled !== false; data.vibrationEnabled = row.vibration_enabled !== false;
      await webpush.sendNotification(row.subscription, JSON.stringify(data), { TTL: 60 * 60 * 12 });
    } catch (e) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        try { await supabaseRequest(`brass_push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`, { method: 'DELETE' }); } catch {}
      } else console.warn('[BRASS+ push] one delivery failed:', e?.message || e);
    }
  }));
}

async function readLocalDB() {
  try { return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); }
  catch { return { groups: {} }; }
}
async function writeLocalDB(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}
async function readDB() {
  if (!hasSupabase) return readLocalDB();
  const rows = await supabaseRequest('brass_groups?select=code,group_data');
  const groups = {};
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (row && row.code && row.group_data && typeof row.group_data === 'object') groups[normalizeCode(row.code)] = row.group_data;
  }
  // If the Supabase table is empty, migrate any groups that still exist in the old local file.
  if (!Object.keys(groups).length) {
    const local = await readLocalDB();
    for (const [code, group] of Object.entries(local.groups || {})) {
      if (group && typeof group === 'object') {
        groups[normalizeCode(code)] = group;
        await supabaseRequest('brass_groups?on_conflict=code', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ code: normalizeCode(code), group_data: group, updated_at: new Date().toISOString() })
        });
      }
    }
  }
  return { groups };
}
async function writeDB(db) {
  // Keep a local cache for diagnostics, but the Supabase table is authoritative.
  await writeLocalDB(db);
  if (!hasSupabase) return;
  for (const [rawCode, group] of Object.entries(db.groups || {})) {
    const code = normalizeCode(rawCode);
    await supabaseRequest('brass_groups?on_conflict=code', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ code, group_data: group, updated_at: new Date().toISOString() })
    });
  }
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
  const event = { id: group.nextEventId, type, actor: cleanText(actor, 40) || 'メンバー', detail: cleanText(detail, 100), clientId: cleanText(clientId, 100), at: new Date().toISOString() };
  group.events.push(event);
  group.events = group.events.slice(-150);
  // Push delivery is deliberately detached from group-data writes, so a push failure never blocks saving.
  if (group.code) setTimeout(() => sendGroupPush(group.code, event).catch(err => console.warn('[BRASS+ push] delivery failed:', err?.message || err)), 0);
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
app.get('/api/push/public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ ok: false, error: '通知サーバーのVAPID設定が未完了です。' });
  if (!hasSupabase) return res.status(503).json({ ok: false, error: '通知保存用のSupabase設定が必要です。' });
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});
app.post('/api/push/subscribe', async (req, res) => {
  if (!pushReady) return res.status(503).json({ ok: false, error: '通知サーバーの設定が未完了です。' });
  const code = normalizeCode(req.body?.groupCode), clientId = cleanText(req.body?.clientId, 100);
  const subscription = req.body?.subscription;
  const endpoint = cleanText(subscription?.endpoint, 2000);
  if (!/^[A-Z0-9]{1,32}$/.test(code) || !endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ ok: false, error: '通知登録情報が不正です。グループに参加してから再度お試しください。' });
  try {
    const db = await readDB(); if (!db.groups[code]) return res.status(404).json({ ok: false, error: '参加中のグループが見つかりません。' });
    const body = { endpoint, group_code: code, client_id: clientId, subscription, sound_enabled: req.body?.soundEnabled !== false, vibration_enabled: req.body?.vibrationEnabled !== false, updated_at: new Date().toISOString() };
    await supabaseRequest('brass_push_subscriptions?on_conflict=endpoint', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) });
    res.json({ ok: true });
  } catch (e) { console.error('[BRASS+ push] subscribe failed:', e.message); res.status(503).json({ ok: false, error: '通知登録に失敗しました。Supabaseの通知テーブル設定を確認してください。' }); }
});
app.post('/api/push/preferences', async (req, res) => {
  if (!pushReady) return res.status(503).json({ ok: false, error: '通知サーバーの設定が未完了です。' });
  const endpoint = cleanText(req.body?.endpoint, 2000);
  if (!endpoint) return res.status(400).json({ ok: false, error: '通知登録が見つかりません。通知を一度オンにしてください。' });
  try {
    await supabaseRequest(`brass_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sound_enabled: req.body?.soundEnabled !== false, vibration_enabled: req.body?.vibrationEnabled !== false, updated_at: new Date().toISOString() }) });
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ ok: false, error: '通知設定を保存できませんでした。' }); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
  const endpoint = cleanText(req.body?.endpoint, 2000);
  if (!endpoint || !hasSupabase) return res.json({ ok: true });
  try { await supabaseRequest(`brass_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' }); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false, error: '通知登録を解除できませんでした。' }); }
});

app.get('/api/health', async (req, res) => {
  const result = { ok: true, service: 'BRASS+', version: 'supabase-storage-v3-web-push', storage: hasSupabase ? 'supabase' : 'local', supabaseConfigured: hasSupabase, supabaseConnected: false, pushConfigured: pushReady };
  if (!hasSupabase) return res.status(503).json({ ...result, ok: false, error: 'Render環境変数 SUPABASE_URL / SUPABASE_SECRET_KEY が未設定です。' });
  try {
    // This is a real REST request, not merely an environment-variable check.
    await supabaseRequest('brass_groups?select=code&limit=1');
    result.supabaseConnected = true;
    return res.json(result);
  } catch (error) {
    console.error('[BRASS+ health] Supabase connection failed:', error?.message || error);
    return res.status(503).json({ ...result, ok: false, error: 'Supabaseに接続できません。テーブル名・列名・キー設定を確認してください。' });
  }
});

// Cross-browser BRASS+ accounts. Passwords are salted and hashed; the signing key stays on Render.
const ACCOUNT_SIGN_KEY = process.env.BRASS_ACCOUNT_SIGN_KEY || SUPABASE_KEY;
function accountToken(account) {
  const payload = Buffer.from(JSON.stringify({ id: account.id, exp: Date.now() + 1000*60*60*24*30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', ACCOUNT_SIGN_KEY || 'configure-a-long-random-secret-in-render').update(payload).digest('base64url');
  return payload + '.' + sig;
}
function accountFromRequest(req) {
  if (!ACCOUNT_SIGN_KEY) return null;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.'); if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', ACCOUNT_SIGN_KEY).update(payload).digest();
  let supplied; try { supplied = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.exp > Date.now() ? data.id : null; } catch { return null; }
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
async function accountRequest(pathname, options = {}) {
  return await supabaseRequest(pathname, options);
}
function emailTransport() {
  const host=process.env.SMTP_HOST, user=process.env.SMTP_USER, pass=process.env.SMTP_PASS;
  if(!host||!user||!pass) return null;
  return nodemailer.createTransport({host,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:{user,pass}});
}
async function sendResetEmail({to, subject, text}) {
  // Prefer Resend when configured. SMTP remains available as a fallback.
  const resendKey = process.env.RESEND_API_KEY || process.env.BRASS_RESEND_API_KEY;
  const from = resendKey ? (process.env.RESEND_FROM || 'BRASS+ <onboarding@resend.dev>') : (process.env.SMTP_FROM || process.env.SMTP_USER);
  if (resendKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Resend ${response.status}: ${result.message || result.name || 'email send failed'}`);
    return { provider: 'resend', id: result.id || null };
  }
  const mailer = emailTransport();
  if (!mailer) throw new Error('Email sender is not configured: set RESEND_API_KEY and RESEND_FROM, or SMTP settings.');
  const result = await mailer.sendMail({ from, to, subject, text });
  if (!result || !result.accepted || !result.accepted.length) throw new Error('SMTP did not accept recipient');
  return { provider: 'smtp', id: result.messageId || null };
}
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'')) && String(v).length<=254;
app.post('/api/account/register', async (req, res) => {
  try {
    if (!hasSupabase || !ACCOUNT_SIGN_KEY) return res.status(503).json({ error: 'アカウント機能にはSupabaseとRenderの設定が必要です。' });
    const email = cleanText(req.body?.email,254).toLowerCase();
    const username = email; // 内部互換用。画面ではユーザー名を使わずメールアドレスでログインする。
    const password = String(req.body?.password || '');
    if (!validEmail(email)) return res.status(400).json({error:'有効なメールアドレスを入力してください。'});
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'パスワードは8〜128文字にしてください。' });
    const existing = await accountRequest('brass_accounts?select=id&email=ilike.' + encodeURIComponent(email) + '&limit=1');
    if (existing?.length) return res.status(409).json({ error: 'このメールアドレスはすでに登録されています。ログインしてください。' });
    const pw = hashPassword(password);
    const rows = await accountRequest('brass_accounts', { method:'POST', headers:{ Prefer:'return=representation' }, body:JSON.stringify({ username, email, password_salt:pw.salt, password_hash:pw.hash, account_data:{} }) });
    const account = rows?.[0]; if (!account) throw new Error('account create failed');
    return res.json({ ok:true, token:accountToken(account), account:{id:account.id, username:account.username, email:account.email}, data:account.account_data || {} });
  } catch (e) { console.error('[BRASS+ account register]', e?.message || e); return res.status(503).json({ error: /duplicate key|unique/i.test(e?.message||'') ? 'そのアカウント名は使用されています。' : 'アカウントを作成できませんでした。Supabaseの設定とテーブルを確認してください。' }); }
});
app.post('/api/account/login', async (req, res) => {
  try {
    if (!hasSupabase || !ACCOUNT_SIGN_KEY) return res.status(503).json({ error: 'アカウント機能にはSupabaseとRenderの設定が必要です。' });
    const email = cleanText(req.body?.email,254).toLowerCase(), password = String(req.body?.password || '');
    if (!validEmail(email)) return res.status(400).json({error:'メールアドレスを入力してください。'});
    const rows = await accountRequest('brass_accounts?select=id,username,email,password_salt,password_hash,account_data&email=ilike.' + encodeURIComponent(email) + '&limit=1');
    const a = rows?.[0]; if (!a || !crypto.timingSafeEqual(Buffer.from(hashPassword(password,a.password_salt).hash,'hex'), Buffer.from(a.password_hash,'hex'))) return res.status(401).json({ error:'メールアドレスまたはパスワードが違います。' });
    return res.json({ ok:true, token:accountToken(a), account:{id:a.id, username:a.username, email:a.email}, data:a.account_data || {} });
  } catch (e) { console.error('[BRASS+ account login]', e?.message || e); return res.status(503).json({ error:'ログインできませんでした。通信とSupabaseの設定を確認してください。' }); }
});
app.post('/api/account/username', async (req,res) => {
  try {
    const id=accountFromRequest(req); if(!id)return res.status(401).json({error:'ログインし直してください。'});
    const username=cleanText(req.body?.username,32), password=String(req.body?.password||'');
    if(!/^[A-Za-z0-9ぁ-んァ-ヶ一-龠ー_-]{2,32}$/.test(username))return res.status(400).json({error:'ユーザー名は2〜32文字で入力してください。'});
    const rows=await accountRequest('brass_accounts?select=id,username,password_salt,password_hash&id=eq.'+encodeURIComponent(id)+'&limit=1'); const a=rows?.[0];
    if(!a||!crypto.timingSafeEqual(Buffer.from(hashPassword(password,a.password_salt).hash,'hex'),Buffer.from(a.password_hash,'hex')))return res.status(401).json({error:'現在のパスワードが違います。'});
    const existing=await accountRequest('brass_accounts?select=id&username=ilike.'+encodeURIComponent(username)+'&limit=1'); if(existing?.some(x=>x.id!==id))return res.status(409).json({error:'そのユーザー名は使用されています。'});
    await accountRequest('brass_accounts?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({username,updated_at:new Date().toISOString()})});
    res.json({ok:true,account:{id,username}});
  } catch(e){console.error('[account username]',e?.message||e);res.status(503).json({error:'ユーザー名を変更できませんでした。'});}
});
app.post('/api/account/password', async (req,res) => {
  try {
    const id=accountFromRequest(req); if(!id)return res.status(401).json({error:'ログインし直してください。'});
    const current=String(req.body?.currentPassword||''), next=String(req.body?.newPassword||'');
    if(next.length<8||next.length>128)return res.status(400).json({error:'新しいパスワードは8〜128文字にしてください。'});
    const rows=await accountRequest('brass_accounts?select=password_salt,password_hash&id=eq.'+encodeURIComponent(id)+'&limit=1');const a=rows?.[0];
    if(!a||!crypto.timingSafeEqual(Buffer.from(hashPassword(current,a.password_salt).hash,'hex'),Buffer.from(a.password_hash,'hex')))return res.status(401).json({error:'現在のパスワードが違います。'});
    const pw=hashPassword(next);await accountRequest('brass_accounts?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({password_salt:pw.salt,password_hash:pw.hash,updated_at:new Date().toISOString()})});
    res.json({ok:true});
  }catch(e){console.error('[account password]',e?.message||e);res.status(503).json({error:'パスワードを変更できませんでした。'});}
});
app.post('/api/account/delete', async (req, res) => {
  try {
    const id = accountFromRequest(req);
    if (!id) return res.status(401).json({ error: 'ログインし直してください。' });
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: '本人確認のため、現在のBRASS+専用パスワードを入力してください。' });
    const rows = await accountRequest('brass_accounts?select=id,password_salt,password_hash&id=eq.' + encodeURIComponent(id) + '&limit=1');
    const a = rows?.[0];
    if (!a) return res.status(404).json({ error: 'アカウントが見つかりません。' });
    const actual = Buffer.from(hashPassword(password, a.password_salt).hash, 'hex');
    const expected = Buffer.from(a.password_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'パスワードが違います。アカウントは削除されていません。' });
    await accountRequest('brass_accounts?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return res.json({ ok: true, message: 'アカウントを削除しました。' });
  } catch (e) {
    console.error('[BRASS+ account delete]', e?.message || e);
    return res.status(503).json({ error: 'アカウントを削除できませんでした。サーバー設定を確認してください。' });
  }
});

app.post('/api/account/forgot', async (req,res) => {
  try {
    const email=cleanText(req.body?.email,254).toLowerCase();
    if(!validEmail(email)) return res.status(400).json({error:'登録したメールアドレスを入力してください。'});
    const rows=await accountRequest('brass_accounts?select=id,username,email&email=ilike.'+encodeURIComponent(email)+'&limit=1');
    const a=rows?.[0];
    // Do not claim an email was sent unless the provider confirms acceptance.
    if (!a) return res.json({ok:true,sent:false,message:'申請を確認しました。登録したメールアドレスと一致するアカウントがある場合にメールが送信されます。届かない場合はアドレスを確認してください。'});
    const raw=crypto.randomBytes(32).toString('hex'), tokenHash=crypto.createHash('sha256').update(raw).digest('hex');
    await accountRequest('brass_accounts?id=eq.'+encodeURIComponent(a.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({reset_token_hash:tokenHash,reset_expires_at:new Date(Date.now()+30*60*1000).toISOString()})});
    const base=String(process.env.BRASS_PUBLIC_URL||'https://futaba2828.github.io/BRASS-plus/');
    const resetUrl=`${base}${base.includes('?')?'&':'?'}resetToken=${raw}`;
    const text=`BRASS+ アカウントのパスワード再設定

次のリンクから30分以内にパスワードを再設定してください。
${resetUrl}

心当たりがない場合は、このメールを無視してください。`;
    await sendResetEmail({to:a.email,subject:'BRASS+ パスワード再設定',text});
    console.log('[BRASS+ account forgot] reset email accepted by provider for account', a.id);
    return res.json({ok:true,sent:true,message:'再設定メールを送信しました。受信トレイと迷惑メールフォルダを確認してください。'});
  } catch(e) {
    console.error('[BRASS+ account forgot] email send failed:',e?.message||e);
    return res.status(503).json({error:'再設定メールを送信できませんでした。RenderのRESEND_API_KEY・RESEND_FROM（またはSMTP設定）と、送信元ドメインの認証状態を確認してください。'});
  }
});
app.post('/api/account/reset', async (req,res) => {
  try {
    const token=String(req.body?.token||''), password=String(req.body?.password||''); if(token.length<32)return res.status(400).json({error:'再設定リンクが正しくありません。'}); if(password.length<8||password.length>128)return res.status(400).json({error:'新しいパスワードは8〜128文字にしてください。'});
    const hash=crypto.createHash('sha256').update(token).digest('hex'); const rows=await accountRequest('brass_accounts?select=id&reset_token_hash=eq.'+encodeURIComponent(hash)+'&limit=1');const a=rows?.[0];
    if(!a)return res.status(400).json({error:'再設定リンクが無効か、すでに使用されています。'});
    const chk=await accountRequest('brass_accounts?select=reset_expires_at&id=eq.'+encodeURIComponent(a.id)+'&limit=1');if(!chk?.[0]?.reset_expires_at||new Date(chk[0].reset_expires_at).getTime()<Date.now())return res.status(400).json({error:'再設定リンクの有効期限が切れています。もう一度申請してください。'});
    const pw=hashPassword(password);await accountRequest('brass_accounts?id=eq.'+encodeURIComponent(a.id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({password_salt:pw.salt,password_hash:pw.hash,reset_token_hash:null,reset_expires_at:null,updated_at:new Date().toISOString()})});res.json({ok:true});
  }catch(e){console.error('[account reset]',e?.message||e);res.status(503).json({error:'パスワードを再設定できませんでした。'});}
});
app.get('/api/account/data', async (req,res) => {
  try { const id=accountFromRequest(req); if(!id)return res.status(401).json({error:'ログインし直してください。'}); const rows=await accountRequest('brass_accounts?select=username,email,account_data&id=eq.'+encodeURIComponent(id)+'&limit=1'); if(!rows?.[0])return res.status(404).json({error:'アカウントが見つかりません。'}); res.json({ok:true,account:{id,username:rows[0].username,email:rows[0].email},data:rows[0].account_data||{}}); }
  catch(e){console.error('[BRASS+ account data get]',e?.message||e);res.status(503).json({error:'アカウントデータを読み込めませんでした。'});}
});
app.put('/api/account/data', async (req,res) => {
  try { const id=accountFromRequest(req); if(!id)return res.status(401).json({error:'ログインし直してください。'}); const data=req.body?.data; if(!data || typeof data!=='object')return res.status(400).json({error:'保存データが不正です。'}); const safe={ profile:data.profile||{}, scaleChecks:data.scaleChecks||{}, mySlides:Array.isArray(data.mySlides)?data.mySlides:[], mornings:data.mornings||{}, sectionPrefs:data.sectionPrefs||{}, navOrder:Array.isArray(data.navOrder)?data.navOrder:[], groups:Array.isArray(data.groups)?data.groups.filter(x=>typeof x==='string').slice(0,100):[], privateData:data.privateData&&typeof data.privateData==='object'?data.privateData:{} }; await accountRequest('brass_accounts?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({account_data:safe,updated_at:new Date().toISOString()})}); res.json({ok:true}); }
  catch(e){console.error('[BRASS+ account data put]',e?.message||e);res.status(503).json({error:'アカウントデータを保存できませんでした。'});}
});

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
  try {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(400).json({ ok: false, error: 'グループコードが空です。' });
    const db = await readDB();
    const g = db.groups[code];
    if (!g) return res.json({ ok: true, left: false, missing: true, members: [] });
    if (!Array.isArray(g.members)) g.members = [];
    const name = cleanText(req.body?.name, 40) || 'メンバー';
    const clientId = cleanText(req.body?.clientId, 100);
    const before = g.members.length;
    // Prefer the exact device ID; use the name only for older clients without a matching ID.
    let matchIndex = clientId ? g.members.findIndex(m => m.clientId && m.clientId === clientId) : -1;
    if (matchIndex < 0) matchIndex = g.members.findIndex(m => m.name === name);
    if (matchIndex >= 0) g.members.splice(matchIndex, 1);
    const left = g.members.length < before;
    if (left) addEvent(g, 'member-left', name, `${name}さんが退会しました`, clientId);
    await writeDB(db);
    return res.json({ ok: true, left, members: g.members });
  } catch (error) {
    console.error('[BRASS+ leave] Failed:', error?.message || error);
    return res.status(503).json({ ok: false, error: '退会情報を共有データベースに保存できませんでした。Supabaseの接続・テーブル設定を確認してください。' });
  }
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
  const incomingMorningDates = Array.isArray(req.body?.morningDates) ? req.body.morningDates.filter(x => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(x))).slice(-5000) : null;
  if (incomingMorningDates) {
    member.morningDates = [...new Set(incomingMorningDates)].sort();
    member.morningTotalCount = member.morningDates.length;
    member.morningCount = Math.max(0, Math.floor(Number(req.body?.morningCount) || 0));
  } else {
    member.morningCount = Math.max(0, Math.floor(Number(req.body?.morningCount) || 0));
    member.morningTotalCount = Math.max(Number(member.morningTotalCount) || 0, member.morningCount);
  }
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
// Keep API failures as JSON so the client can show a useful message instead of HTML.
app.use((err, req, res, next) => {
  console.error('[BRASS+ request error]', req.method, req.originalUrl, err?.message || err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ ok: false, error: 'サーバーまたは共有データベースとの通信に失敗しました。時間をおいて再試行してください。' });
  }
  return res.status(500).send('サーバーエラーが発生しました。');
});
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'APIが見つかりません。Renderのデプロイ状態を確認してください。' });
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.listen(PORT, '0.0.0.0', () => { console.log(`BRASS+ server running on port ${PORT}`); console.log(`BRASS+ storage: ${hasSupabase ? 'Supabase configured' : 'LOCAL FILE (Supabase env missing)'}`); });
