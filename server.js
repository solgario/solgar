/* solgar — authoritative multiplayer server
 * Runs the entire simulation server-side; clients only send input.
 * Serves the static client AND the WebSocket on one port (Railway-friendly).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------------- config ----------------
const PORT        = process.env.PORT || 3000;
const WORLD       = 6400, START_MASS = 22;
const FOOD_COUNT  = 850, FOOD_MASS = 1.4, GOLD_CHANCE = 0.05, GOLD_MASS = 5;
const VIRUS_COUNT = 20, VIRUS_MASS = 132, VIRUS_SPLIT_AT = 200;
const MIN_POP     = 20;                 // arena always has at least this many (bots pad it out)
const MAX_PLAYERS = 80;                 // hard cap on real players
const MIN_SPLIT_MASS = 35, MIN_EJECT_MASS = 35, EJECT_MASS = 13, EJECT_COST = 18;
const MAX_CELLS   = 16, MERGE_COOLDOWN = 7, SPLIT_BURST = 760, EAT_RATIO = 1.18;
const mergeTime = m => MERGE_COOLDOWN + m*0.012;   // small splits re-merge fast, giant ones take longer
const ROUND_LENGTH = 600, SHIELD_TIME = 3, FOOD_CAP = FOOD_COUNT + 320;

// ---------------- token gate ----------------
// Leave SOLGAR_MINT empty until the token is minted; set it (env var or here) to ENFORCE the gate.
// While empty the gate is OFF and anyone can join (matches the pre-mint demo).
const SOLGAR_MINT    = process.env.SOLGAR_MINT || '';
const MIN_HOLD       = Number(process.env.MIN_HOLD || 250000);
const RPC_URL        = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const AUTH_WINDOW_MS = 15 * 60 * 1000;  // a signed wallet login is accepted for 15 minutes
const GATE_ON        = !!SOLGAR_MINT;
const ADMIN_KEY      = process.env.ADMIN_KEY || '';   // protects the private /payouts page
const TICK_HZ = 30, SEND_HZ = 20;
const SKINS = ['#14F195','#9945FF','#36e6ff','#ff5c7a','#ffd23f','#3ddc97','#ff5cc8','#5cc8ff','#ff7a45','#c77dff'];
const NAMES = ['wojak','gigachad','ngmi','pumpit','diamondhand','rugged','ser','fomo','hodler','degen','moonboi','jeet','frenzy','anon','wagmi','chad','paperhand','aped','sniper','exitliq','copium','based','sigma','liquid8r'];

// ---------------- helpers ----------------
const rand = (a,b)=>a+Math.random()*(b-a);
const radiusOf = m=>Math.sqrt(m)*4.0;
const speedOf  = m=>Math.max(34, 770*Math.pow(m,-0.31));
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const d2 = (ax,ay,bx,by)=>{const dx=ax-bx,dy=ay-by;return dx*dx+dy*dy;};
const now = ()=>Date.now();

// ---------------- state ----------------
let CID = 1, PID = 1;
const players = new Map();   // id -> player
const spectators = new Set();// ws of token-less viewers (no slot, no cells)
const payoutLog = [];        // recent rounds' winners + verified wallets, for manual payouts
let food = [], viruses = [];
let round = { number:1, endsAt: now()+ROUND_LENGTH*1000 };

// ---------------- factories ----------------
function makeFood(){
  const gold = Math.random() < GOLD_CHANCE;
  return { x:rand(20,WORLD-20), y:rand(20,WORLD-20), m:gold?GOLD_MASS:FOOD_MASS, gold, vx:0, vy:0 };
}
function makeVirus(x,y,m){ return { x:x??rand(150,WORLD-150), y:y??rand(150,WORLD-150), m:m??VIRUS_MASS, vx:0, vy:0 }; }
function newCell(x,y,m){ return { id:CID++, x, y, m, vx:0, vy:0, merge:0 }; }

function spawnCells(p,m){
  let x,y,ok,t=0;
  do{ x=rand(300,WORLD-300); y=rand(300,WORLD-300); ok=true;
    for(const v of viruses){ if(d2(x,y,v.x,v.y) < (radiusOf(v.m)+90)**2){ ok=false; break; } } t++;
  }while(!ok && t<30);
  p.cells = [ newCell(x,y,m) ];
  p.dead = false; p.shieldUntil = now()+SHIELD_TIME*1000; p.respawnAt = 0; p._final = false;
}

function createPlayer(isBot,name,color){
  const p = {
    id:PID++, name, color, isBot, cells:[], dead:false, respawnAt:0, shieldUntil:0, _final:false,
    target:{x:WORLD/2,y:WORLD/2}, input:{x:WORLD/2,y:WORLD/2}, queueSplit:false, queueEject:false,
    ai:{tx:WORLD/2,ty:WORLD/2,retarget:0,jitter:rand(0,6)}, ws:null, peak:START_MASS, joinedAt:now()
  };
  spawnCells(p,START_MASS);
  players.set(p.id,p);
  return p;
}
const botName = ()=> NAMES[Math.floor(rand(0,NAMES.length))] + (Math.random()<0.4?Math.floor(rand(1,99)):'');
function spawnBot(){ return createPlayer(true, botName(), SKINS[Math.floor(rand(0,SKINS.length))]); }

// ---------------- lobby fill ----------------
// Arena floor of MIN_POP via bots; real players replace bots one-for-one up to MIN_POP,
// then keep joining as pure additions up to MAX_PLAYERS.
function realCount(){ let n=0; for(const p of players.values()) if(!p.isBot) n++; return n; }
function botCount(){ let n=0; for(const p of players.values()) if(p.isBot) n++; return n; }
function removeOneBot(){ for(const [id,p] of players){ if(p.isBot){ players.delete(id); return true; } } return false; }
function balanceBots(){
  const need = Math.max(0, MIN_POP - realCount());   // how many bots we should have right now
  let have = botCount();
  while(have > need){ removeOneBot(); have--; }       // a real took a slot — drop a bot (its mass just vanishes)
  while(have < need){ spawnBot(); have++; }           // someone left — refill the floor
}
function spawnRealPlayer(ws,name,color){
  ws.spectator = false; spectators.delete(ws);
  const p = createPlayer(false, name, color);         // spawns FRESH at START_MASS
  p.ws = ws; ws.pid = p.id; p.wallet = ws.wallet || '';   // verified payout address, if a wallet was connected
  balanceBots();                                      // displaced bot's mass is discarded, not dropped
  send(ws,{t:'joined', id:p.id, world:WORLD});
}

// Verify the wallet signed our login challenge AND holds >= MIN_HOLD of the token (read-only, on-chain).
// Deps are lazy-required so the server still runs with the gate OFF even if they aren't installed.
// Lightweight ownership proof: did this wallet sign our login challenge? (no balance check)
function verifyOwnership(wallet, sigB64, ts){
  try{
    if(!wallet || !sigB64 || !ts) return false;
    if(Math.abs(Date.now()-Number(ts)) > AUTH_WINDOW_MS) return false;
    const nacl = require('tweetnacl'); const bs58 = require('bs58');
    const message = new TextEncoder().encode(`solgar:${wallet}:${ts}`);
    return nacl.sign.detached.verify(message, Buffer.from(sigB64,'base64'), bs58.decode(wallet));
  }catch(e){ return false; }
}

let _rpc = null;
async function verifyHolder(wallet, sigB64, ts){
  try{
    if(!wallet || !sigB64 || !ts) return { ok:false, reason:'connect your wallet first' };
    if(Math.abs(Date.now() - Number(ts)) > AUTH_WINDOW_MS) return { ok:false, reason:'wallet signature expired — reconnect wallet' };
    const nacl = require('tweetnacl');
    const bs58 = require('bs58');
    const { Connection, PublicKey } = require('@solana/web3.js');
    const message = new TextEncoder().encode(`solgar:${wallet}:${ts}`);
    const sigOk = nacl.sign.detached.verify(message, Buffer.from(sigB64, 'base64'), bs58.decode(wallet));
    if(!sigOk) return { ok:false, reason:'signature did not match wallet' };
    if(!_rpc) _rpc = new Connection(RPC_URL, 'confirmed');
    const res = await _rpc.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(SOLGAR_MINT) });
    let bal = 0; for(const a of res.value) bal += a.account.data.parsed.info.tokenAmount.uiAmount || 0;
    if(bal >= MIN_HOLD) return { ok:true, balance:bal };
    return { ok:false, reason:`need ${MIN_HOLD.toLocaleString()} $SOLGAR (wallet holds ${Math.floor(bal).toLocaleString()})`, balance:bal };
  }catch(e){ return { ok:false, reason:'could not verify balance — try again' }; }
}

async function tryJoin(ws, msg){
  const name  = ((''+(msg.name||'player')).trim().slice(0,14)) || 'player';
  const color = SKINS.includes(msg.color) ? msg.color : SKINS[0];
  if(realCount() >= MAX_PLAYERS){ send(ws,{t:'full'}); return; }
  if(GATE_ON){
    send(ws,{t:'checking'});                           // keeps the client from falling back while we hit the chain
    const v = await verifyHolder(msg.wallet, msg.sig, msg.ts);
    if(!v.ok){ send(ws,{t:'need_token', reason:v.reason, balance:v.balance||0}); return; }
    ws.wallet = msg.wallet;                             // verified holder / payout address
  } else if(msg.wallet && msg.sig && msg.ts){
    if(verifyOwnership(msg.wallet, msg.sig, msg.ts)) ws.wallet = msg.wallet;  // record payout address pre-gate too
  }
  spawnRealPlayer(ws,name,color);
}
function removePlayer(id){ if(players.delete(id)) balanceBots(); }

// ---------------- queries ----------------
const shielded = p=>now() < p.shieldUntil;
const totalMass = p=>{ let s=0; for(const c of p.cells) s+=c.m; return s; };
const biggest = p=>{ let b=null; for(const c of p.cells) if(!b||c.m>b.m) b=c; return b; };
const centroid = p=>{ let x=0,y=0,m=0; for(const c of p.cells){ x+=c.x*c.m; y+=c.y*c.m; m+=c.m; } return m?{x:x/m,y:y/m,m}:{x:WORLD/2,y:WORLD/2,m:0}; };

// ---------------- bot AI ----------------
function botThink(p,dt){
  const a=p.ai, head=biggest(p); if(!head) return;
  let danger=null,dd=Infinity,prey=null,pd=Infinity;
  for(const q of players.values()){ if(q===p||q.dead||shielded(q)) continue;
    for(const c of q.cells){ const d=d2(head.x,head.y,c.x,c.y);
      if(c.m>head.m*EAT_RATIO && d<360*360 && d<dd){danger=c;dd=d;}
      else if(head.m>c.m*EAT_RATIO && d<520*520 && d<pd){prey=c;pd=d;} } }
  let vt=null,vd=Infinity;
  if(head.m>VIRUS_MASS*EAT_RATIO) for(const v of viruses){ const d=d2(head.x,head.y,v.x,v.y); if(d<240*240&&d<vd){vt=v;vd=d;} }
  a.retarget-=dt;
  if(danger){ a.tx=head.x*2-danger.x; a.ty=head.y*2-danger.y; }
  else if(vt){ a.tx=head.x*2-vt.x; a.ty=head.y*2-vt.y; }
  else if(prey){ a.tx=prey.x; a.ty=prey.y; if(pd<130*130 && head.m>prey.m*2.2 && p.cells.length<4 && Math.random()<0.02) doSplit(p); }
  else if(a.retarget<=0){
    let best=null,bd=Infinity; const sx=head.x+Math.cos(a.jitter)*200, sy=head.y+Math.sin(a.jitter)*200;
    for(let i=0;i<food.length;i+=3){ const f=food[i]; const d=d2(sx,sy,f.x,f.y)*(f.gold?0.4:1); if(d<bd){bd=d;best=f;} }
    if(best){ a.tx=best.x; a.ty=best.y; } else { a.tx=rand(400,WORLD-400); a.ty=rand(400,WORLD-400); }
    a.retarget=rand(0.6,1.6); a.jitter+=rand(-1,1);
  }
  if(head.x<220)a.tx=Math.max(a.tx,500); if(head.x>WORLD-220)a.tx=Math.min(a.tx,WORLD-500);
  if(head.y<220)a.ty=Math.max(a.ty,500); if(head.y>WORLD-220)a.ty=Math.min(a.ty,WORLD-500);
  a.tx=clamp(a.tx,0,WORLD); a.ty=clamp(a.ty,0,WORLD);
}

// ---------------- abilities ----------------
function doSplit(p){
  if(shielded(p)) return;
  const t=p.target, cur=p.cells.slice();
  for(const c of cur){
    if(p.cells.length>=MAX_CELLS) break;
    if(c.m<MIN_SPLIT_MASS) continue;
    const half=c.m/2; c.m=half; c.merge=mergeTime(half);
    let dx=t.x-c.x,dy=t.y-c.y,d=Math.hypot(dx,dy)||1; dx/=d;dy/=d;
    const nc=newCell(c.x+dx*radiusOf(half), c.y+dy*radiusOf(half), half);
    nc.vx=dx*SPLIT_BURST; nc.vy=dy*SPLIT_BURST; nc.merge=mergeTime(half); p.cells.push(nc);
  }
}
function doEject(p){
  const t=p.target;
  for(const c of p.cells){
    if(c.m<MIN_EJECT_MASS) continue;
    c.m-=EJECT_COST;
    let dx=t.x-c.x,dy=t.y-c.y,d=Math.hypot(dx,dy)||1; dx/=d;dy/=d;
    const r=radiusOf(c.m), pe=makeFood();
    pe.gold=false; pe.m=EJECT_MASS; pe.x=c.x+dx*(r+4); pe.y=c.y+dy*(r+4); pe.vx=dx*820; pe.vy=dy*820;
    food.push(pe);
  }
}
function sepMerge(p){
  const cs=p.cells;
  for(let i=0;i<cs.length;i++) for(let j=i+1;j<cs.length;j++){
    const a=cs[i],b=cs[j],ra=radiusOf(a.m),rb=radiusOf(b.m);
    const dx=b.x-a.x,dy=b.y-a.y; let d=Math.hypot(dx,dy)||0.001;
    const ov=ra+rb-d; if(ov<=0) continue;
    if(a.merge<=0&&b.merge<=0){ const big=a.m>=b.m?a:b,sm=a.m>=b.m?b:a; big.m+=sm.m; cs.splice(cs.indexOf(sm),1); i=-1; break; }
    else{ const push=ov/2,nx=dx/d,ny=dy/d; a.x-=nx*push;a.y-=ny*push;b.x+=nx*push;b.y+=ny*push; }
  }
}

// ---------------- round ----------------
function endRound(){
  const alive = [...players.values()].filter(p=>!p.dead).sort((a,b)=>totalMass(b)-totalMass(a));
  const top5 = alive.slice(0,5).map(p=>[p.name, Math.floor(totalMass(p))]);
  const ending = round.number;
  const PCT = [35,25,15,10,5];
  const winners = alive.slice(0,5).map((p,i)=>({ rank:i+1, pct:PCT[i]||0, name:p.name, mass:Math.floor(totalMass(p)), wallet:p.isBot?'':(p.wallet||''), bot:!!p.isBot }));
  payoutLog.unshift({ round:ending, at:new Date().toISOString(), winners });
  if(payoutLog.length>50) payoutLog.length=50;
  console.log(`[round ${ending}] winners:`);
  for(const w of winners) console.log(`  #${w.rank} ${w.pct}%  ${w.name} (mass ${w.mass})  ${w.bot?'BOT — skip':(w.wallet||'no wallet connected')}`);
  for(const p of players.values()){ if(!p.isBot && p.ws && p.ws.readyState===1) send(p.ws,{t:'round', n:ending, top5}); }
  for(const sws of spectators){ if(sws.readyState===1) send(sws,{t:'round', n:ending, top5}); }
  round.number++; round.endsAt = now()+ROUND_LENGTH*1000; resetArena();
}
function resetArena(){
  food=[]; for(let i=0;i<FOOD_COUNT;i++) food.push(makeFood());
  viruses=[]; for(let i=0;i<VIRUS_COUNT;i++) viruses.push(makeVirus());
  for(const p of players.values()){
    if(!p.dead) spawnCells(p,START_MASS);
    else if(p.isBot){ p.color=SKINS[Math.floor(rand(0,SKINS.length))]; spawnCells(p,START_MASS); }
  }
}

// ---------------- main tick ----------------
function tick(){
  const dt = 1/TICK_HZ, t0 = now();
  if(t0 >= round.endsAt) endRound();

  // 1) targets
  for(const p of players.values()){ if(p.dead) continue;
    if(p.isBot){ botThink(p,dt); p.target.x=p.ai.tx; p.target.y=p.ai.ty; }
    else { p.target.x=p.input.x; p.target.y=p.input.y; } }

  // 2) queued actions
  for(const p of players.values()){ if(p.dead) continue;
    if(p.queueSplit){ doSplit(p); p.queueSplit=false; }
    if(p.queueEject){ doEject(p); p.queueEject=false; } }

  // 3) movement + edge + decay + merge (mark deaths, never mutate the players map here)
  for(const p of players.values()){ if(p.dead) continue;
    const sh=shielded(p);
    for(let i=p.cells.length-1;i>=0;i--){
      const c=p.cells[i], r=radiusOf(c.m);
      let dx=p.target.x-c.x, dy=p.target.y-c.y, d=Math.hypot(dx,dy), sp=speedOf(c.m);
      if(d>1e-4){ const sc=Math.min(1,d/(r+6)); c.x+=(dx/d)*sp*sc*dt; c.y+=(dy/d)*sp*sc*dt; }
      c.x+=c.vx*dt; c.y+=c.vy*dt; const dm=Math.min(1,7.5*dt); c.vx-=c.vx*dm; c.vy-=c.vy*dm;
      const hit=(c.x-r<=0)||(c.x+r>=WORLD)||(c.y-r<=0)||(c.y+r>=WORLD);
      if(hit){ if(sh){ c.x=clamp(c.x,r,WORLD-r); c.y=clamp(c.y,r,WORLD-r); } else { p.cells.splice(i,1); continue; } }
      if(c.merge>0) c.merge=Math.max(0,c.merge-dt);
      if(c.m>140) c.m-=c.m*0.00095*dt;
    }
    if(p.cells.length===0){ p.dead=true; continue; }
    sepMerge(p);
    const m=totalMass(p); if(m>p.peak) p.peak=m;
  }

  // 4) food eating + ejected mass feeding viruses
  const GS=280, grid=new Map();
  for(let i=0;i<food.length;i++){ const f=food[i];
    if(f.vx||f.vy){ f.x+=f.vx*dt; f.y+=f.vy*dt; const k=Math.min(1,3*dt); f.vx-=f.vx*k; f.vy-=f.vy*k;
      if(Math.abs(f.vx)<4&&Math.abs(f.vy)<4){f.vx=0;f.vy=0;} f.x=clamp(f.x,6,WORLD-6); f.y=clamp(f.y,6,WORLD-6); }
    const key=Math.floor(f.x/GS)+','+Math.floor(f.y/GS); let a=grid.get(key); if(!a){a=[];grid.set(key,a);} a.push(i);
  }
  const eaten=new Set();
  for(const p of players.values()){ if(p.dead) continue;
    for(const c of p.cells){ const r=radiusOf(c.m);
      const gx0=Math.floor((c.x-r)/GS),gx1=Math.floor((c.x+r)/GS),gy0=Math.floor((c.y-r)/GS),gy1=Math.floor((c.y+r)/GS);
      for(let gx=gx0;gx<=gx1;gx++)for(let gy=gy0;gy<=gy1;gy++){ const arr=grid.get(gx+','+gy); if(!arr) continue;
        for(const fi of arr){ if(eaten.has(fi)) continue; const f=food[fi]; if(d2(c.x,c.y,f.x,f.y)<r*r){ c.m+=f.m; eaten.add(fi); } } }
    }
  }
  for(let i=0;i<food.length;i++){ const f=food[i]; if(eaten.has(i)||(!f.vx&&!f.vy)) continue;
    for(const v of viruses){ if(d2(f.x,f.y,v.x,v.y)<radiusOf(v.m)**2){ v.m+=f.m; eaten.add(i);
      if(v.m>=VIRUS_SPLIT_AT){ let dx=f.vx,dy=f.vy,d=Math.hypot(dx,dy)||1; const b=makeVirus(v.x,v.y,VIRUS_MASS); b.vx=dx/d*880;b.vy=dy/d*880; viruses.push(b); v.m=VIRUS_MASS; } break; } }
  }
  for(const v of viruses){ if(v.vx||v.vy){ v.x+=v.vx*dt;v.y+=v.vy*dt; const k=Math.min(1,1.5*dt); v.vx-=v.vx*k;v.vy-=v.vy*k; const r=radiusOf(v.m); v.x=clamp(v.x,r,WORLD-r);v.y=clamp(v.y,r,WORLD-r); } }
  if(eaten.size){ const keep=[]; for(let i=0;i<food.length;i++) if(!eaten.has(i)) keep.push(food[i]); food=keep; }
  while(food.length<FOOD_COUNT) food.push(makeFood());
  while(viruses.length>VIRUS_COUNT+8) viruses.shift();
  while(viruses.length<VIRUS_COUNT) viruses.push(makeVirus());

  // 5) eat rival cells (+ loot scatter), mark deaths
  for(const p of players.values()){ if(p.dead) continue;
    for(const c of p.cells){ if(c.m<=0) continue; const r=radiusOf(c.m);
      for(const q of players.values()){ if(q===p||q.dead||shielded(q)||shielded(p)) continue;
        for(let k=0;k<q.cells.length;k++){ const o=q.cells[k];
          if(c.m>o.m*EAT_RATIO){ const ro=radiusOf(o.m);
            if(d2(c.x,c.y,o.x,o.y)<(r-ro*0.45)**2){
              c.m+=o.m*0.6;
              if(food.length<FOOD_CAP){ const n=clamp(Math.round(o.m/22),1,5), each=(o.m*0.4)/n;
                for(let s=0;s<n;s++){ const ang=rand(0,6.28),dr=rand(0,ro*0.8); const lf=makeFood();
                  lf.gold=true; lf.m=Math.max(2,each); lf.vx=0;lf.vy=0; lf.x=clamp(o.x+Math.cos(ang)*dr,6,WORLD-6); lf.y=clamp(o.y+Math.sin(ang)*dr,6,WORLD-6); food.push(lf); } }
              q.cells.splice(k,1); k--;
            }
          }
        }
        if(q.cells.length===0) q.dead=true;
      }
    }
  }

  // 6) virus pops big cells
  for(const p of players.values()){ if(p.dead||shielded(p)) continue; const add=[];
    for(let ci=0;ci<p.cells.length;ci++){ const c=p.cells[ci], r=radiusOf(c.m);
      for(let vi=0;vi<viruses.length;vi++){ const v=viruses[vi], rv=radiusOf(v.m);
        if(c.m>v.m*EAT_RATIO && d2(c.x,c.y,v.x,v.y)<(r-rv*0.5)**2){
          c.m+=v.m*0.5; viruses.splice(vi,1); viruses.push(makeVirus());
          const pieces=Math.min(MAX_CELLS-p.cells.length-add.length,7);
          if(pieces>0){ const each=c.m/(pieces+1); c.m=each; c.merge=mergeTime(each);
            for(let s=0;s<pieces;s++){ const ang=(s/pieces)*6.283+rand(-0.2,0.2); const nc=newCell(c.x,c.y,each); nc.vx=Math.cos(ang)*640;nc.vy=Math.sin(ang)*640;nc.merge=mergeTime(each); add.push(nc); } }
          break;
        }
      }
    }
    for(const nc of add) p.cells.push(nc);
  }

  // 7) finalize deaths + respawns (safe to mutate map now)
  const remove=[];
  for(const p of players.values()){
    if(!p.dead) continue;
    if(p.isBot){ if(!p.respawnAt) p.respawnAt = t0 + rand(1800,4200); }
    else if(!p._final){
      p._final = true;
      let rank=1; for(const q of players.values()) if(!q.dead && totalMass(q) > p.peak) rank++;
      if(p.ws) send(p.ws, { t:'dead', peak:Math.floor(p.peak), survived:Math.round((t0-p.joinedAt)/1000), rank });
      if(p.ws) p.ws.pid = null;
      remove.push(p.id);
    }
  }
  for(const id of remove) players.delete(id);
  for(const p of players.values()){ if(p.dead && p.isBot && t0>=p.respawnAt && p.respawnAt){ spawnCells(p,START_MASS); } }
  balanceBots();
}

// ---------------- broadcast (per-client culled snapshot) ----------------
function broadcast(){
  const t0 = now();
  const rsec = Math.max(0, Math.round((round.endsAt-t0)/1000));
  const alive = [...players.values()].filter(p=>!p.dead);
  alive.sort((a,b)=>totalMass(b)-totalMass(a));
  const leaderId = alive.length ? alive[0].id : 0;
  const humans = realCount(), pop = players.size;

  for(const p of players.values()){
    if(p.isBot || !p.ws || p.ws.readyState!==1 || p.dead) continue;
    const ctr = centroid(p), mass = totalMass(p);
    const viewR = 360 + 26*Math.sqrt(mass);
    const hw = viewR*2.2 + 340, hh = viewR*1.6 + 340;
    const L=ctr.x-hw, R=ctr.x+hw, T=ctr.y-hh, B=ctr.y+hh;

    const cells=[];
    for(const q of players.values()){ if(q.dead) continue;
      const qs = shielded(q)?1:0, k = q.id===leaderId?1:0;
      for(const c of q.cells){ if(c.x<L||c.x>R||c.y<T||c.y>B) continue;
        cells.push({ i:c.id, x:Math.round(c.x), y:Math.round(c.y), m:Math.round(c.m),
                     c:q.color, n:q.name, o:q.id===p.id?1:0, s:qs, k }); }
    }
    const fd=[]; for(const f of food){ if(f.x<L||f.x>R||f.y<T||f.y>B) continue; fd.push([Math.round(f.x),Math.round(f.y),Math.round(f.m*10)/10,f.gold?1:0]); }
    const vr=[]; for(const v of viruses){ if(v.x<L||v.x>R||v.y<T||v.y>B) continue; vr.push([Math.round(v.x),Math.round(v.y),Math.round(v.m)]); }
    let rank=1; for(const q of alive){ if(q===p) break; rank++; }
    const lb = alive.slice(0,10).map(q=>[q.name, Math.floor(totalMass(q)), q.id===p.id?1:0]);

    send(p.ws, { t:'state', me:{mass:Math.round(mass),rank,alive:true}, cells, food:fd, vir:vr, lb, rsec, rnum:round.number, world:WORLD, pop, humans });
  }

  // spectators all share one snapshot centered on the leader
  if(spectators.size){
    const lead = alive.length ? alive[0] : null;
    const lc = lead ? centroid(lead) : {x:WORLD/2,y:WORLD/2};
    const viewR = 360 + 26*Math.sqrt(lead ? totalMass(lead) : 400);
    const hw=viewR*2.2+340, hh=viewR*1.6+340, L=lc.x-hw, Rr=lc.x+hw, T=lc.y-hh, B=lc.y+hh;
    const cells=[];
    for(const q of players.values()){ if(q.dead) continue; const qs=shielded(q)?1:0, k=q.id===leaderId?1:0;
      for(const c of q.cells){ if(c.x<L||c.x>Rr||c.y<T||c.y>B) continue;
        cells.push({ i:c.id, x:Math.round(c.x), y:Math.round(c.y), m:Math.round(c.m), c:q.color, n:q.name, o:0, s:qs, k }); } }
    const fd=[]; for(const f of food){ if(f.x<L||f.x>Rr||f.y<T||f.y>B) continue; fd.push([Math.round(f.x),Math.round(f.y),Math.round(f.m*10)/10,f.gold?1:0]); }
    const vr=[]; for(const v of viruses){ if(v.x<L||v.x>Rr||v.y<T||v.y>B) continue; vr.push([Math.round(v.x),Math.round(v.y),Math.round(v.m)]); }
    const lb = alive.slice(0,10).map(q=>[q.name, Math.floor(totalMass(q)), 0]);
    const msg = JSON.stringify({ t:'state', me:{mass:0,rank:0,alive:false,spectator:true}, cells, food:fd, vir:vr, lb, rsec, rnum:round.number, world:WORLD, pop, humans, leadName: lead?lead.name:'' });
    for(const sws of spectators){ if(sws.readyState===1){ try{ sws.send(msg); }catch(e){} } }
  }
}

// ---------------- networking ----------------
function send(ws,obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){} }

function escapeHtml(s){ return (''+s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function payoutPage(pool){
  const body = payoutLog.map(r=>{
    const items = r.winners.map(w=>{
      const amt = (pool>0 && !w.bot && w.wallet) ? (pool*w.pct/100) : null;
      const addr = w.bot ? '<i>bot — no payout</i>' : (w.wallet ? `<code>${escapeHtml(w.wallet)}</code>` : '<i>no wallet connected</i>');
      const amtTxt = amt!=null ? ` &rarr; <b>${amt.toFixed(4)} SOL</b>` : '';
      return `<li>#${w.rank} &middot; ${w.pct}% &middot; ${escapeHtml(w.name)} (mass ${w.mass}) &mdash; ${addr}${amtTxt}</li>`;
    }).join('');
    return `<section><h3>Round ${r.round} <small>${escapeHtml(r.at)}</small></h3><ol>${items}</ol></section>`;
  }).join('') || '<p>No finished rounds yet — winners show up here after each round ends.</p>';
  const note = pool>0
    ? `<p>Amounts shown for a <b>${pool} SOL</b> pool. Change it with <code>&amp;pool=AMOUNT</code> in the URL.</p>`
    : `<p>Add <code>&amp;pool=2.5</code> to the URL to auto-split your SOL pool across the winners.</p>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>solgar payouts</title>
<style>body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0a0f1c;color:#e8f6ff;margin:0;padding:18px;}
h1{font-size:18px;color:#14F195;margin:0 0 8px;} h3{margin:16px 0 6px;font-size:14px;color:#9945FF;} small{color:#566a80;font-weight:400;font-size:11px;}
ol{margin:0;padding-left:20px;} li{padding:4px 0;font-size:13px;line-height:1.5;}
code{background:#111a2e;border:1px solid #1d2a44;border-radius:5px;padding:2px 6px;word-break:break-all;color:#36e6ff;}
b{color:#ffd23f;} i{color:#7d93ad;} p{color:#9fb4c9;font-size:12px;} section{border-bottom:1px solid #16223c;padding-bottom:8px;}</style>
<h1>&#9678; solgar &mdash; winners to pay</h1>${note}${body}`;
}

const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req,res)=>{
  const f = (req.url||'/').split('?')[0];
  if(f==='/stats'){ res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify({humans:realCount(), spectators:spectators.size, total:players.size})); return; }
  if(f==='/payouts'){
    let key='', pool=0; try{ const u=new URL(req.url,'http://x'); key=u.searchParams.get('key')||''; pool=parseFloat(u.searchParams.get('pool')||'0')||0; }catch(_){}
    if(!ADMIN_KEY){ res.writeHead(403,{'Content-Type':'text/plain'}); res.end('Set an ADMIN_KEY env var to enable the payout page.'); return; }
    if(key!==ADMIN_KEY){ res.writeHead(401,{'Content-Type':'text/plain'}); res.end('Unauthorized. Open /payouts?key=YOUR_ADMIN_KEY'); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(payoutPage(pool)); return;
  }
  if(f==='/'||f===''||f==='/index.html'){
    fs.readFile(INDEX,(err,data)=>{
      if(err){ res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws=>{
  ws.pid = null; ws.spectator = false;
  ws.on('message', data=>{
    let msg; try{ msg = JSON.parse(data); }catch(e){ return; }
    if(msg.t==='join'){
      tryJoin(ws, msg);
    } else if(msg.t==='spectate'){
      ws.pid = null; ws.spectator = true; spectators.add(ws); send(ws,{t:'spectating', world:WORLD});
    } else if(msg.t==='input'){
      const p = ws.pid && players.get(ws.pid);
      if(p && !p.isBot){ p.input.x = clamp(+msg.x||0,0,WORLD); p.input.y = clamp(+msg.y||0,0,WORLD); }
    } else if(msg.t==='split'){ const p = ws.pid && players.get(ws.pid); if(p) p.queueSplit = true; }
    else if(msg.t==='eject'){ const p = ws.pid && players.get(ws.pid); if(p) p.queueEject = true; }
  });
  ws.on('close', ()=>{ spectators.delete(ws); if(ws.pid){ removePlayer(ws.pid); ws.pid=null; } });
  ws.on('error', ()=>{});
});

// ---------------- boot ----------------
for(let i=0;i<VIRUS_COUNT;i++) viruses.push(makeVirus());
for(let i=0;i<FOOD_COUNT;i++) food.push(makeFood());
balanceBots();
setInterval(tick, 1000/TICK_HZ);
setInterval(broadcast, 1000/SEND_HZ);
server.listen(PORT, ()=>console.log(`solgar server listening on :${PORT} (floor ${MIN_POP} bots, cap ${MAX_PLAYERS} players, ${ROUND_LENGTH/60}m rounds, token-gate ${GATE_ON ? 'ON ('+SOLGAR_MINT.slice(0,4)+'…, hold '+MIN_HOLD+')' : 'OFF — set SOLGAR_MINT to enable'})`));
