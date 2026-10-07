import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'groups.json');
const MAX_BODY = process.env.BRASS_MAX_BODY || '15mb';

app.use(express.json({limit: MAX_BODY}));
app.use(express.urlencoded({extended:false, limit:'1mb'}));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname));

async function readDB(){
  try { return JSON.parse(await fs.readFile(DATA_FILE,'utf8')); }
  catch { return {groups:{}}; }
}
async function writeDB(db){
  await fs.mkdir(DATA_DIR,{recursive:true});
  const tmp=DATA_FILE+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(db,null,2),'utf8');
  await fs.rename(tmp,DATA_FILE);
}
function cleanText(v,max=200){return String(v??'').trim().slice(0,max)}
function code(){return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,6)}
function newGroup(name,owner){
  return {code:code(),name:cleanText(name,80)||'BRASS+グループ',createdAt:new Date().toISOString(),members:[{name:cleanText(owner,40)||'未設定',joinedAt:new Date().toISOString()}],data:{goals:[],practices:[],issues:[],mornings:{},songs:[],lessons:[],posts:[],recommendations:[],voices:[],mySlides:[],tags:[],scaleChecks:{}}};
}
function mergeArray(target,incoming){
  const map=new Map((Array.isArray(target)?target:[]).map(x=>[x?.id,x]));
  for(const x of (Array.isArray(incoming)?incoming:[])){
    if(!x?.id) continue;
    map.set(String(x.id),x);
  }
  return [...map.values()].slice(-1000);
}
function mergeData(group,incoming){
  const allowed=['goals','practices','issues','songs','lessons','posts','recommendations','voices','mySlides','tags'];
  for(const k of allowed) group.data[k]=mergeArray(group.data[k],incoming?.[k]);
  group.data.mornings={...(group.data.mornings||{}),...(incoming?.mornings||{})};
  group.data.scaleChecks={...(group.data.scaleChecks||{}),...(incoming?.scaleChecks||{})};
}

app.get('/api/health',async(req,res)=>res.json({ok:true,service:'BRASS+',version:'complete-1'}));
app.post('/api/groups',async(req,res)=>{
  const db=await readDB();
  let g;
  do {g=newGroup(req.body?.name,req.body?.owner)} while(db.groups[g.code]);
  db.groups[g.code]=g;
  await writeDB(db);
  res.json({ok:true,code:g.code,name:g.name});
});
app.get('/api/groups/:code',async(req,res)=>{
  const db=await readDB(); const g=db.groups[String(req.params.code).toUpperCase()];
  if(!g) return res.status(404).json({error:'グループが見つかりません'});
  res.json({ok:true,code:g.code,name:g.name,members:g.members,data:g.data});
});
app.post('/api/groups/:code/join',async(req,res)=>{
  const db=await readDB(); const g=db.groups[String(req.params.code).toUpperCase()];
  if(!g) return res.status(404).json({error:'グループが見つかりません'});
  const name=cleanText(req.body?.name,40)||'未設定';
  if(!g.members.some(m=>m.name===name)) g.members.push({name,joinedAt:new Date().toISOString()});
  g.members=g.members.slice(-100);
  await writeDB(db);
  res.json({ok:true,code:g.code,name:g.name,members:g.members,data:g.data});
});
app.post('/api/groups/:code/sync',async(req,res)=>{
  const db=await readDB(); const g=db.groups[String(req.params.code).toUpperCase()];
  if(!g) return res.status(404).json({error:'グループが見つかりません'});
  const name=cleanText(req.body?.member,40)||'未設定';
  if(!g.members.some(m=>m.name===name)) g.members.push({name,joinedAt:new Date().toISOString()});
  mergeData(g,req.body?.data||{});
  g.updatedAt=new Date().toISOString();
  await writeDB(db);
  res.json({ok:true,data:g.data,members:g.members});
});

app.use((req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`BRASS+ server running on http://localhost:${PORT}`));
