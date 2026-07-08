// ============================================================================
// HIT BOARD — AUTONOMOUS SQUAD RUNNER  (runs on GitHub Actions cron, no human)
// Pipeline each run:
//   1. Pull today's slate: schedule, probables, posted lineups (MLB Stats API)
//   2. Build the board: point-in-time batter/pitcher profiles, Savant Statcast,
//      park factors, DraftKings prices via The Odds API
//   3. Scan the wire: Reddit + MLB/ESPN/RotoWire feeds + Bluesky for injury /
//      scratch / lineup news (keyword engine; optional Claude for comprehension)
//   4. Each bot files or REVISES its card — revisions allowed until that game's
//      first pitch, every change logged to the wire with a reason
//   5. Settle finished days from official stats
//   6. Merge + write the ledger to jsonbin (same bin the dashboard syncs)
// ============================================================================
import process from 'node:process';

const RUNNER_BUILD='2026-07-08.6';
const API='https://statsapi.mlb.com/api/v1';
const JB='https://api.jsonbin.io/v3/b';
const ENV=k=>process.env[k]||'';
const JSONBIN_KEY=ENV('JSONBIN_KEY'), JSONBIN_BIN=ENV('JSONBIN_BIN');
const ODDS_KEY=ENV('ODDS_API_KEY'), ANTHROPIC_KEY=ENV('ANTHROPIC_API_KEY');
if(!JSONBIN_KEY||!JSONBIN_BIN){ console.error('Missing JSONBIN_KEY / JSONBIN_BIN secrets'); process.exit(1); }

const PARK_FACTORS={COL:112,BOS:107,KC:104,ATH:104,CIN:103,ARI:102,WSH:102,MIN:101,PIT:101,LAA:101,TEX:100,ATL:100,PHI:100,DET:100,CWS:100,CHC:99,STL:99,MIL:99,HOU:99,LAD:99,MIA:99,TOR:99,CLE:98,BAL:98,TB:98,NYY:97,NYM:97,SF:97,SD:97,SEA:94};
const num=v=>{const n=parseFloat(v);return isNaN(n)?null:n;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const scale=(v,lo,hi)=>v==null?null:clamp((v-lo)/(hi-lo)*100,0,100);
const todayISO=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const daysAgo=(iso,n)=>{const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10);};
const ipF=ip=>{if(ip==null)return 0;const[w,f]=String(ip).split('.');return(+w||0)+(f==='1'?1/3:f==='2'?2/3:0);};
const normName=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g,'').replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim();
const lastName=s=>s.split(' ').slice(-1)[0];

async function J(url,opts,tries=3){
  for(let i=0;i<tries;i++){
    try{ const r=await fetch(url,opts); if(!r.ok) throw new Error('HTTP '+r.status); return await r.json(); }
    catch(e){ if(i===tries-1){ console.log('fetch fail',url.split('?')[0],e.message); return null; } await new Promise(r=>setTimeout(r,600*(i+1))); }
  }
}
async function T(url,opts){ try{ const r=await fetch(url,opts); return r.ok?await r.text():null; }catch(e){ return null; } }
async function pool(tasks,limit){ let i=0; const out=new Array(tasks.length);
  await Promise.all(Array.from({length:Math.min(limit,tasks.length)},async()=>{ while(i<tasks.length){const k=i++; out[k]=await tasks[k]();}})); return out; }

function parseCSV(text){ const rows=[];let row=[],cur='',q=false;
  for(const ch of text){ if(q){ if(ch==='"')q=false; else cur+=ch; } else if(ch==='"')q=true;
    else if(ch===','){row.push(cur);cur='';} else if(ch==='\n'){row.push(cur.replace(/\r$/,''));rows.push(row);row=[];cur='';} else cur+=ch; }
  if(cur||row.length){row.push(cur);rows.push(row);}
  const head=rows[0]||[]; return rows.slice(1).map(r=>Object.fromEntries(head.map((h,i)=>[h.trim(),r[i]])));
}

// ---------- ledger I/O (jsonbin) ----------
async function loadLedger(){
  const d=await J(`${JB}/${JSONBIN_BIN}/latest`,{headers:{'X-Master-Key':JSONBIN_KEY}});
  const rec=d?.record||{}; const L={...rec, days:rec.days||{}, wire:rec.wire||[]};
  if(L.mutBinId){
    const m=await J(`${JB}/${L.mutBinId}/latest`,{headers:{'X-Master-Key':JSONBIN_KEY}});
    if(m?.record){ L.mut=m.record.mut||L.mut; L.mdays=m.record.mdays||L.mdays; }
    else { L._mutLoadFailed=true; console.log('WARNING: colony bin unreachable — freezing all mutant ops this run so the colony cannot be overwritten'); }
  }
  return L;
}
async function ensureMutBin(L){
  if(L.mutBinId) return;
  const r=await fetch(`${JB}`,{method:'POST',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY,'X-Bin-Private':'true','X-Bin-Name':'hit-board-mutants'},body:JSON.stringify({mut:L.mut||null,mdays:L.mdays||{}})});
  if(r.ok){ const d=await r.json(); L.mutBinId=d?.metadata?.id||null; console.log('created mutant bin:',L.mutBinId); }
  else console.log('mutant bin creation failed HTTP',r.status);
}
function foldOldDays(L){
  // roll settled days older than 7d into compact season aggregates, then prune detail
  L.agg=L.agg||{books:{},series:{},folded:{}};
  const cutoff=daysAgo(todayISO(),7), hardCut=daysAgo(todayISO(),25);
  const BOOK_IDS=['you','r5','mit','chalky','gapper','sal','parkey','fadey','streaks','grinder'];
  const flag={you:r=>r.picked,r5:r=>r.bot,mit:r=>r.mit};
  const oddsOf={you:r=>r.pickOdds??r.od,r5:r=>r.botOdds??r.od,mit:r=>r.mitOdds??r.od};
  Object.keys(L.days).sort().forEach(dt=>{
    if(dt>=cutoff||L.agg.folded[dt]) return;
    const rows=Object.values(L.days[dt].rows);
    if(rows.some(r=>r.res==null&&(r.picked||r.bot||r.mit||(r.bks&&Object.keys(r.bks).length)))) return; // not fully settled
    const dayU={};
    rows.forEach(r=>{
      BOOK_IDS.forEach(b=>{
        const has=flag[b]?flag[b](r):!!(r.bks&&r.bks[b]!==undefined);
        if(has&&(r.res==='win'||r.res==='loss')){
          const od=oddsOf[b]?oddsOf[b](r):r.bks[b]??r.od;
          const u=r.res==='win'?(od!=null?(od>0?od/100:100/-od):0.4):-1;
          const A=L.agg.books[b]=L.agg.books[b]||{w:0,l:0,u:0,ow:0,ol:0,ouU:0,dnp:0};
          if(r.res==='win')A.w++; else A.l++; A.u+=u; dayU[b]=(dayU[b]||0)+u;
        }
        if(has&&r.res==='dnp'){ const A=L.agg.books[b]=L.agg.books[b]||{w:0,l:0,u:0,ow:0,ol:0,ouU:0,dnp:0}; A.dnp++; }
      });
      if(r.ou) Object.entries(r.ou).forEach(([b,e])=>{
        if(e.res!=='win'&&e.res!=='loss') return;
        const A=L.agg.books[b]=L.agg.books[b]||{w:0,l:0,u:0,ow:0,ol:0,ouU:0,dnp:0};
        const u=e.res==='win'?(e.odds!=null?(e.odds>0?e.odds/100:100/-e.odds):0.4):-1;
        if(e.res==='win')A.ow++; else A.ol++; A.ouU+=u; dayU[b]=(dayU[b]||0)+u;
      });
    });
    Object.entries(dayU).forEach(([b,u])=>{ (L.agg.series[b]=L.agg.series[b]||[]).push({d:dt,u:Math.round(u*100)/100}); L.agg.series[b]=L.agg.series[b].slice(-120); });
    L.agg.folded[dt]=true;
  });
  Object.keys(L.days).filter(d=>d<hardCut&&L.agg.folded[d]).forEach(d=>delete L.days[d]);
}
function stripDay(rows){
  Object.keys(rows).forEach(id=>{ const r=rows[id];
    const kept=r.picked||r.bot||r.mit||(r.bks&&Object.keys(r.bks).length)||(r.ou&&Object.keys(r.ou).length);
    if(!kept) delete rows[id];
  });
}
function pruneLedger(L){
  // core diet: TODAY keeps the full board (live tracker / cards need it);
  // every past day keeps only rows somebody actually bet on
  const today=todayISO();
  Object.keys(L.days).forEach(d=>{ if(d<today) stripDay(L.days[d].rows); });
  if(L.mut) Object.values(L.mut.roster).forEach(m=>{ m.log=(m.log||[]).slice(-2); m.rec.hist=(m.rec.hist||[]).slice(-10); });
  if(L.mdays) Object.keys(L.mdays).sort().slice(0,-3).forEach(d=>delete L.mdays[d]);
  L.wire=(L.wire||[]).slice(-60);
}
function emergencyTrim(L){
  // harsher: strip today too, shrink odds cache and wire to essentials
  Object.keys(L.days).forEach(d=>stripDay(L.days[d].rows));
  if(L.oddsCache){ delete L.oddsCache.ou; delete L.oddsCache.events; }
  L.wire=(L.wire||[]).slice(-15);
  L.mdays={};
}
async function saveLedger(L){
  foldOldDays(L);
  pruneLedger(L);
  await ensureMutBin(L);
  // colony lives in its own bin — split before sizing
  const M={mut:L.mut||null, mdays:L.mdays||{}};
  const core={...L};
  if(L.mutBinId){ delete core.mut; delete core.mdays; }   // no bin yet? colony rides in the core rather than vanishing
  if(L.mutBinId && !L._mutLoadFailed){
    const mb=JSON.stringify(M);
    const rm=await fetch(`${JB}/${L.mutBinId}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body:mb});
    console.log('mutant bin:',(mb.length/1024).toFixed(0),'KB —',rm.ok?'saved OK':'SAVE FAILED HTTP '+rm.status);
  }
  return saveCore(core);
}
async function saveCore(L){
  L.wire=L.wire.slice(-100); L.lastRun=new Date().toISOString();
  let body=JSON.stringify(L);
  console.log('ledger blob:', (body.length/1024).toFixed(0),'KB');
  let r=await fetch(`${JB}/${JSONBIN_BIN}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body});
  if(r.ok){ console.log('ledger saved OK'); return; }
  console.log('CORE SAVE FAILED HTTP',r.status,'— emergency trim & retry');
  emergencyTrim(L); delete L.mut; delete L.mdays; body=JSON.stringify(L);
  console.log('trimmed blob:', (body.length/1024).toFixed(0),'KB');
  r=await fetch(`${JB}/${JSONBIN_BIN}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body});
  if(r.ok){ console.log('retry save OK'); return; }
  // final fallback: minimal core that at least preserves picks + the colony pointer
  const minimal={days:{}, wire:[], oddsCache:{date:L.oddsCache?.date, prices:L.oddsCache?.prices||{}}, mutBinId:L.mutBinId, lastRun:L.lastRun};
  const today=todayISO();
  Object.keys(L.days).forEach(d=>{ minimal.days[d]={rows:{}}; Object.entries(L.days[d].rows).forEach(([id,row])=>{ minimal.days[d].rows[id]=row; }); });
  Object.keys(minimal.days).forEach(d=>stripDay(minimal.days[d].rows));
  const mb=JSON.stringify(minimal);
  console.log('minimal core:',(mb.length/1024).toFixed(0),'KB');
  const r3=await fetch(`${JB}/${JSONBIN_BIN}`,{method:'PUT',headers:{'Content-Type':'application/json','X-Master-Key':JSONBIN_KEY},body:mb});
  console.log(r3.ok?'minimal core saved — colony pointer preserved':'ALL SAVES FAILING HTTP '+r3.status+' — paste this log to Claude');
}
function wire(L,who,text){ L.wire.push({t:Date.now(),who,text}); console.log(`[wire:${who}] ${text}`); }

// ---------- board build ----------
async function buildBoard(date, L){
  const season=date.slice(0,4);
  const [sched,teams]=await Promise.all([
    J(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups`),
    J(`${API}/teams?sportId=1&season=${season}`)]);
  const abbr={};(teams?.teams||[]).forEach(t=>abbr[t.id]=t.abbreviation||t.name);
  const games=sched?.dates?.[0]?.games||[];
  console.log('schedule:',games.length,'game(s) for',date, sched?'':'(schedule fetch FAILED)');
  if(!games.length) return null;
  const ctx={},lineupOrder={},firstPitch={};
  for(const g of games){
    const label=`${abbr[g.teams.away.team.id]} @ ${abbr[g.teams.home.team.id]}`;
    const park={name:g.venue?.name||'',pf:PARK_FACTORS[abbr[g.teams.home.team.id]]??100};
    for(const side of['home','away']){
      const t=g.teams[side].team.id, opp=g.teams[side==='home'?'away':'home'].probablePitcher||null;
      ctx[t]={opp,label,gamePk:g.gamePk,park}; firstPitch[t]=g.gameDate;
      (g.lineups?.[side+'Players']||[]).forEach((p,i)=>lineupOrder[p.id]=i+1);
    }
  }
  const teamsPlaying=new Set(Object.keys(ctx).map(Number));
  // bulk stats
  async function bulk(stat,extra){ const out=[];
    for(let off=0;off<3000;off+=1000){
      const d=await J(`${API}/stats?stats=${stat}&group=hitting&season=${season}&playerPool=ALL&limit=1000&offset=${off}${extra||''}`);
      const s=d?.stats?.[0]?.splits||[]; out.push(...s); if(s.length<1000)break;
    } return out; }
  const [seasonS,recentS]=await Promise.all([bulk('season',''),bulk('byDateRange',`&startDate=${daysAgo(date,21)}&endDate=${date}`)]);
  const rec={}; recentS.forEach(s=>{ if(s.player) rec[s.player.id]=s.stat; });
  let cand=seasonS.filter(s=>s.player&&s.team&&teamsPlaying.has(s.team.id)&&s.position?.abbreviation!=='P')
    .map(s=>{const r=rec[s.player.id]||{};return{id:s.player.id,name:s.player.fullName,teamId:s.team.id,team:abbr[s.team.id],
      seasonAvg:num(s.stat.avg),seasonPA:s.stat.plateAppearances||0,recAvg:num(r.avg),recPA:r.plateAppearances||0};})
    .filter(p=>p.recPA>=20&&p.seasonPA>=60);
  cand.forEach(p=>{p.prelim=(scale(p.recAvg,.18,.34)??40)*.6+(scale(p.seasonAvg,.18,.34)??40)*.4+(lineupOrder[p.id]?8:0);});
  cand.sort((a,b)=>b.prelim-a.prelim);
  // cold tier: weakest qualifying bats — Under candidates for the O/U engine
  const hot=cand.slice(0,90), inPool=new Set(hot.map(c=>c.id));
  const cold=cand.slice(-35).filter(c=>!inPool.has(c.id));
  cold.forEach(c=>c.coldTier=true);
  cand=[...hot,...cold];
  console.log('pool:',hot.length,'hitters +',cold.length,'cold-tier bats');
  // savant
  async function savant(type,sel){
    const t=await T(`https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=${type}&filter=&min=10&selections=${sel}&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`);
    const m={}; if(t&&!t.trim().startsWith('<')) parseCSV(t).forEach(r=>{const id=+r.player_id; if(id)m[id]=r;}); return m;
  }
  const [savP,savB]=await Promise.all([
    savant('pitcher','xba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,whiff_percent,k_percent,iz_contact_percent,linedrives_percent'),
    savant('batter','xba,k_percent,whiff_percent,hard_hit_percent,exit_velocity_avg,sweet_spot_percent')]);
  // hands
  const pids=[...new Map(Object.values(ctx).filter(c=>c.opp).map(c=>[c.opp.id,c.opp])).values()];
  const hands={};
  for(let i=0;i<cand.length+pids.length;i+=100){
    const ids=[...cand.map(c=>c.id),...pids.map(p=>p.id)].slice(i,i+100); if(!ids.length)break;
    const d=await J(`${API}/people?personIds=${ids.join(',')}`);
    (d?.people||[]).forEach(p=>hands[p.id]={bats:p.batSide?.code||'?',throws:p.pitchHand?.code||'?'});
  }
  // pitchers
  const pInfo={};
  await pool(pids.map(pr=>async()=>{
    const [gl,sp,se]=await Promise.all([
      J(`${API}/people/${pr.id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`),
      J(`${API}/people/${pr.id}/stats?stats=statSplits&group=pitching&sitCodes=vl,vr&season=${season}`),
      J(`${API}/people/${pr.id}/stats?stats=season&group=pitching&season=${season}`)]);
    const logs=(gl?.stats?.[0]?.splits||[]).slice(-5); let ip=0,h=0;
    logs.forEach(g=>{ip+=ipF(g.stat.inningsPitched);h+=g.stat.hits||0;});
    const o={id:pr.id,name:pr.fullName,hand:hands[pr.id]?.throws||'?',h9L5:ip>0?h/ip*9:null,ipL5:ip};
    (sp?.stats?.[0]?.splits||[]).forEach(x=>{if(x.split?.code==='vl')o.baaVsL=num(x.stat.avg);if(x.split?.code==='vr')o.baaVsR=num(x.stat.avg);});
    const ss=se?.stats?.[0]?.splits?.[0]?.stat; if(ss){o.baa=num(ss.avg);o.whip=num(ss.whip);}
    const sv=savP[pr.id]||{};
    Object.assign(o,{xba:num(sv.xba),kpct:num(sv.k_percent),whiff:num(sv.whiff_percent),hardhit:num(sv.hard_hit_percent),ld:num(sv.linedrives_percent),izcontact:num(sv.iz_contact_percent)});
    pInfo[pr.id]=o;
  }),5);
  // odds — FREE-TIER BUDGET MODE:
  //   · each game's props fetched at most twice (initial + one retry if empty)
  //   · only inside the 11:00–19:30 ET posting window
  //   · hard cap of 16 credits/day; prices cached in the ledger all day and
  //     shared with the dashboard, so nothing is ever fetched twice.
  const DAILY_BUDGET=34, WINDOW=[11,22.5];
  if(L.oddsCache?.date!==date) L.oddsCache={date, prices:{}, events:{}, spent:0};
  const OC=L.oddsCache;
  const odds=new Map(Object.entries(OC.prices));
  const etHour=(()=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false}).formatToParts(new Date());
    return +p.find(x=>x.type==='hour').value + (+p.find(x=>x.type==='minute').value)/60;})();
  if(ODDS_KEY && etHour>=WINDOW[0] && etHour<=WINDOW[1] && OC.spent<DAILY_BUDGET){
    const evs=await J(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${ODDS_KEY}`); // events list = 0 credits
    const todays=(evs||[]).filter(e=>new Date(e.commence_time).toLocaleDateString('en-CA',{timeZone:'America/New_York'})===date);
    for(const ev of todays){
      const st=OC.events[ev.id]||(OC.events[ev.id]={tries:0,priced:false,closed:false});
      if(new Date(ev.commence_time).getTime()<=Date.now()) continue; // game started, prices moot
      const minsToPitch=(new Date(ev.commence_time).getTime()-Date.now())/60000;
      const closingWindow = minsToPitch<=100;
      // closing pass: one refetch near first pitch — completes late-posting players (bench bats)
      // and captures true closing prices so backfilled units are accurate
      if(st.priced && !(closingWindow && !st.closed)) continue;
      if(!st.priced && st.tries>=2) continue;
      if(OC.spent>=DAILY_BUDGET) continue;
      if(closingWindow) st.closed=true;
      st.tries++; OC.spent++;
      const d=await J(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${ev.id}/odds?apiKey=${ODDS_KEY}&regions=us&bookmakers=draftkings&markets=batter_hits&oddsFormat=american`);
      const mk=d?.bookmakers?.[0]?.markets?.find(m=>m.key==='batter_hits');
      let n=0;
      (mk?.outcomes||[]).forEach(oc=>{ if(!oc.description) return;
        const k=normName(oc.description), line=oc.point??0.5, v=Math.round(oc.price);
        if(oc.name==='Over'&&line===0.5){ odds.set(k,v); OC.prices[k]=v; n++; }
        OC.ou=OC.ou||{}; const e=OC.ou[k]||(OC.ou[k]={line});
        if(e.line===line){ if(oc.name==='Over') e.over=v; else e.under=v; } });
      if(n>0) st.priced=true;
    }
    // backfill null odds throughout today's ledger from the freshest cache
    let bf=0;
    const d=L.days[date];
    if(d) Object.values(d.rows).forEach(r=>{
      const k=normName(r.n), v=OC.prices[k]!=null?+OC.prices[k]:null;
      if(v!=null){
        if(r.od==null){r.od=v;bf++;}
        if(r.picked&&r.pickOdds==null){r.pickOdds=v;bf++;}
        if(r.bot&&r.botOdds==null){r.botOdds=v;bf++;}
        if(r.mit&&r.mitOdds==null){r.mitOdds=v;bf++;}
        if(r.bks) Object.keys(r.bks).forEach(b=>{if(r.bks[b]==null){r.bks[b]=v;bf++;}});
      }
      const e=(OC.ou||{})[k];
      if(e&&r.ou) Object.values(r.ou).forEach(x=>{ if(x.odds==null&&x.line===e.line){x.odds=x.side==='O'?e.over:e.under; if(x.odds!=null)bf++;} });
    });
    if(bf) console.log('backfilled',bf,'missing price fields in today\'s ledger');
    console.log(`odds budget: ${OC.spent}/${DAILY_BUDGET} credits today · ${Object.values(OC.events).filter(e=>e.priced).length}/${todays.length} games priced`);
  } else if(ODDS_KEY){
    console.log(`odds: using cache (${odds.size} prices) — ${etHour<WINDOW[0]||etHour>WINDOW[1]?'outside posting window':'daily budget reached'}`);
  }
  console.log('DK prices:',odds.size);
  // per-candidate detail
  const rows=[];
  await pool(cand.map(c=>async()=>{
    const cx=ctx[c.teamId]; const opp=cx?.opp?pInfo[cx.opp.id]:null;
    const [gl,sp,bvp]=await Promise.all([
      J(`${API}/people/${c.id}/stats?stats=gameLog&group=hitting&season=${season}&gameType=R`),
      J(`${API}/people/${c.id}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}`),
      opp?J(`${API}/people/${c.id}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${opp.id}`):null]);
    const logs=(gl?.stats?.[0]?.splits||[]).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const l15=logs.slice(-15); let ab=0,h=0,hitG=0,gwab=0;
    l15.forEach(g=>{const a=g.stat.atBats||0,hh=g.stat.hits||0;ab+=a;h+=hh;if(a>0){gwab++;if(hh>0)hitG++;}});
    let streak=0; for(let i=logs.length-1;i>=0;i--){const a=logs[i].stat.atBats||0;if(!a)continue;if((logs[i].stat.hits||0)>0)streak++;else break;}
    const r={...c,bats:hands[c.id]?.bats||'?',opp,game:cx?.label,gamePk:cx?.gamePk,park:cx?.park,
      firstPitch:firstPitch[c.teamId], order:lineupOrder[c.id]||null, confirmed:!!lineupOrder[c.id],
      expAB:lineupOrder[c.id]?[4.4,4.3,4.2,4.1,4.0,3.8,3.6,3.4,3.3][lineupOrder[c.id]-1]:3.8,
      l15Avg:ab>0?h/ab:null,l15GwAB:gwab,l15HitG:hitG,streak,
      st:(m=>({xba:num(m.xba),k:num(m.k_percent),whiff:num(m.whiff_percent),hh:num(m.hard_hit_percent),ev:num(m.exit_velocity_avg),ss:num(m.sweet_spot_percent)}))(savB[c.id]||{}),
      bvpAB:0,bvpH:0,bvpPA:0,bvpAvg:null};
    (sp?.stats?.[0]?.splits||[]).forEach(x=>{if(x.split?.code==='vl')r.avgVsL=num(x.stat.avg);if(x.split?.code==='vr')r.avgVsR=num(x.stat.avg);});
    if(bvp) for(const st of bvp.stats||[]) for(const s2 of st.splits||[]) if(s2.stat?.atBats!=null){r.bvpAB=s2.stat.atBats;r.bvpH=s2.stat.hits||0;r.bvpPA=s2.stat.plateAppearances||r.bvpAB;r.bvpAvg=num(s2.stat.avg);}
    r.dkOdds=odds.get(normName(c.name))??null;
    const ouE=(L.oddsCache?.ou||{})[normName(c.name)];
    if(ouE&&ouE.over!=null&&ouE.under!=null){ r.ouLine=ouE.line; r.ouOver=ouE.over; r.ouUnder=ouE.under; }
    r.dkImplied=r.dkOdds==null?null:(r.dkOdds<0?-r.dkOdds/(-r.dkOdds+100)*100:100/(r.dkOdds+100)*100);
    rows.push(r);
  }),6);
  scoreAll(rows);
  return {rows, date};
}

function scoreAll(rows){
  rows.forEach(r=>{
    const o=r.opp||{};
    let form=null; if(r.l15GwAB>=5){const hr=r.l15HitG/r.l15GwAB;
      form=clamp(.5*(scale(r.l15Avg,.18,.34)??40)+.2*(scale(r.seasonAvg,.18,.34)??40)+30*hr+Math.min(r.streak*2,12)-6,0,100);}
    let bvp=null,conf=0; if(r.bvpAB>=4&&r.bvpAvg!=null){bvp=scale(r.bvpAvg,.15,.4);conf=clamp(r.bvpPA/18,0,1);}
    const parts=[]; const add=(v,w)=>{if(v!=null)parts.push([v,w]);};
    add(o.xba!=null?scale(o.xba,.21,.29):null,.22); add(o.kpct!=null?100-scale(o.kpct,14,30):null,.14);
    add(o.h9L5!=null&&o.ipL5>=8?scale(o.h9L5,6.5,12.5):null,.12); add(o.whiff!=null?100-scale(o.whiff,18,32):null,.10);
    add(o.hardhit!=null?scale(o.hardhit,30,48):null,.10); add(o.ld!=null?scale(o.ld,18,30):null,.07);
    add(o.baa!=null?scale(o.baa,.2,.31):null,.06);
    let pit=null; if(parts.length){const w=parts.reduce((s,p)=>s+p[1],0);pit=parts.reduce((s,p)=>s+p[0]*p[1],0)/w;}
    let plat=null; if(o.hand&&o.hand!=='?'){const bS=o.hand==='L'?r.avgVsL:r.avgVsR;
      const side=r.bats==='S'?(o.hand==='L'?'R':'L'):r.bats; const pB=side==='L'?o.baaVsL:side==='R'?o.baaVsR:null;
      const pp=[]; if(bS!=null)pp.push(scale(bS,.18,.34)); if(pB!=null)pp.push(scale(pB,.2,.32));
      if(pp.length)plat=pp.reduce((a,b)=>a+b,0)/pp.length;}
    const terms=[]; if(form!=null)terms.push([form,.35]); if(bvp!=null)terms.push([bvp,.25*conf]);
    if(pit!=null)terms.push([pit,.25]); if(plat!=null)terms.push([plat,.15]);
    const w=terms.reduce((s,t)=>s+t[1],0);
    let comp=w>0?terms.reduce((s,t)=>s+t[0]*t[1],0)/w:null;
    const pf=r.park?.pf??100; if(comp!=null)comp=clamp(comp+clamp((pf-100)*.35,-4,4),0,100);
    r.score=comp!=null?Math.round(comp*10)/10:null; r.fPit=pit;
    // est prob
    const avgs=[]; if(r.l15Avg!=null)avgs.push([r.l15Avg,3]); if(r.seasonAvg!=null)avgs.push([r.seasonAvg,2]);
    const bS2=o.hand==='L'?r.avgVsL:r.avgVsR; if(bS2!=null)avgs.push([bS2,1]); if(o.baa!=null)avgs.push([o.baa,1.5]);
    if(avgs.length){const ww=avgs.reduce((s,a)=>s+a[1],0);let adj=avgs.reduce((s,a)=>s+a[0]*a[1],0)/ww*(pf/100);
      r.estP=(1-Math.pow(1-clamp(adj,.15,.4),r.expAB||3.8))*100;}
    r.edge=(r.estP!=null&&r.dkImplied!=null)?r.estP-r.dkImplied:null;
  });
  rows.sort((a,b)=>(b.score??0)-(a.score??0));
}

// ---------- strategies (mirror the dashboard) ----------
function mittsEval(r){ const o=r.opp||{};
  if(r.seasonAvg==null||r.l15Avg==null)return{ok:false};
  const base=.5*r.seasonAvg+.3*r.l15Avg+.2*(r.recAvg??r.seasonAvg); let p=base;
  const bS=o.hand==='L'?r.avgVsL:r.avgVsR;
  const side=r.bats==='S'?(o.hand==='L'?'R':'L'):r.bats;
  const pB=side==='L'?o.baaVsL:side==='R'?o.baaVsR:null;
  if(bS!=null)p+=(bS-base)*.3; if(pB!=null)p+=(pB-.245)*.35;
  if(o.xba!=null)p+=(o.xba-.245)*.45; if(o.kpct!=null)p+=(.22-o.kpct/100)*.28; if(o.whiff!=null)p+=(.24-o.whiff/100)*.18;
  if(o.h9L5!=null&&o.ipL5>=8)p+=(o.h9L5-8.6)*.004;
  if(r.bvpAvg!=null&&r.bvpPA>=6){const w=r.bvpPA>=30?.14:r.bvpPA>=18?.10:r.bvpPA>=12?.06:.03;p+=(r.bvpAvg-base)*w;}
  p*=(r.park?.pf??100)/100; p=clamp(p,.15,.4);
  const prob=(1-Math.pow(1-p,r.expAB||3.8))*100;
  const edge=r.dkImplied!=null?prob-r.dkImplied:null;
  const hitRate=r.l15GwAB>0?r.l15HitG/r.l15GwAB:0;
  const ok=r.dkOdds!=null&&(!r.confirmedKnown||r.confirmed)&&!(r.order>=8&&(edge==null||edge<10))&&hitRate>=.5&&(r.recPA||0)>=30
    &&!(bS!=null&&bS<.215)&&prob>=63&&edge!=null&&edge>=7;
  return{ok,prob,edge};
}
const STRATS=[
 {id:'r5', pick:rows=>rows.filter(r=>r.score!=null).slice(0,3)},
 {id:'mit', pick:rows=>rows.map(r=>({r,m:mittsEval(r)})).filter(x=>x.m.ok).sort((a,b)=>b.m.edge-a.m.edge).slice(0,3).map(x=>x.r)},
 {id:'chalky', pick:rows=>top(rows,r=>{const st=r.st||{},o=r.opp||{};const hr=r.l15GwAB>0?r.l15HitG/r.l15GwAB:0;
   if((st.k??99)>23||hr<.55)return null;return(26-(st.k??24))*3+(26-(st.whiff??24))*2+hr*60+(o.whiff!=null?(24-o.whiff)*1.5:0)+(r.l15Avg??.25)*60;})},
 {id:'gapper', pick:rows=>top(rows,r=>{const st=r.st||{},o=r.opp||{};if((st.xba??0)<.255)return null;
   return(st.xba??.24)*400+(st.hh??35)+(st.ss??32)*.5+(o.xba!=null?(o.xba-.245)*300:0)+(o.hardhit??38)*.5+(o.ld??22);})},
 {id:'sal', pick:rows=>top(rows,r=>{const o=r.opp||{};if(!o.hand||o.hand==='?')return null;
   const bS=o.hand==='L'?r.avgVsL:r.avgVsR;const side=r.bats==='S'?(o.hand==='L'?'R':'L'):r.bats;
   const pB=side==='L'?o.baaVsL:side==='R'?o.baaVsR:null;
   if(bS==null||pB==null||bS<.27||pB<.255)return null;return(bS-.245)*600+(pB-.245)*600+(r.l15Avg??.25)*100;})},
 {id:'parkey', pick:rows=>top(rows,r=>{const o=r.opp||{},pf=r.park?.pf??100,st=r.st||{};if(pf<100)return null;
   return(pf-100)*7+(o.h9L5!=null?o.h9L5*4:30)+(24-(st.k??24))+(r.l15Avg??.25)*120;})},
 {id:'fadey', pick:rows=>top(rows,r=>{if(r.dkOdds==null||r.estP==null||r.dkImplied==null)return null;
   const e=r.estP-r.dkImplied;if(r.dkOdds<-160||e<4||r.estP<55)return null;return r.dkOdds+e*12;})},
 {id:'streaks', pick:rows=>top(rows,r=>{if((r.streak??0)<3)return null;const hr=r.l15GwAB>0?r.l15HitG/r.l15GwAB:0;
   const heat=(r.l15Avg!=null&&r.seasonAvg!=null)?Math.max(0,r.l15Avg-r.seasonAvg):0;return r.streak*9+hr*50+heat*250;})},
 {id:'grinder', pick:rows=>top(rows,r=>{if((r.bvpPA??0)<10||(r.bvpAvg??0)<.28)return null;
   return r.bvpAvg*200*Math.log(r.bvpPA)+(r.opp?.h9L5!=null?r.opp.h9L5*3:24);})},
];
const NAMES={r5:'Rusty',mit:'Mitts',chalky:'Chalky',gapper:'Gapper',sal:'Southpaw Sal',parkey:'Parkey',fadey:'Fadey',streaks:'Streaks',grinder:'The Grinder'};
function top(rows,fn){ return rows.map(r=>({r,sc:fn(r)})).filter(x=>x.sc!=null).sort((a,b)=>b.sc-a.sc).slice(0,3).map(x=>x.r); }

// ---------- news wire ----------
const RISK_WORDS=/(scratch|scratched|out of (the )?lineup|not in (the )?lineup|placed on (the )?(10|15|60)?-?\s?day il|to the il|injured list|day.to.day|left tonight|exit(ed|s)? (the )?game|benched|sitting|getting a day|precautionary|tightness|soreness|sore |strain|sprain|discomfort)/i;
async function scanNews(rows){
  const texts=[];
  const UA={headers:{'User-Agent':'Mozilla/5.0 (hitboard-runner)'}};
  const FEEDS=[
    'https://news.google.com/rss/search?q=MLB+(scratched+OR+%22out+of+the+lineup%22+OR+%22placed+on%22+OR+%22injured+list%22)+when:1d&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=MLB+lineup+today+when:1d&hl=en-US&gl=US&ceid=US:en',
    'https://www.mlbtraderumors.com/feed',
    'https://www.mlb.com/feeds/news/rss.xml',
    'https://www.espn.com/espn/rss/mlb/news',
    'https://www.rotowire.com/rss/news.php?sport=MLB',
    'https://www.cbssports.com/rss/headlines/mlb/'
  ];
  for(const feed of FEEDS){
    const t=await T(feed,UA);
    if(!t){ console.log('feed unavailable:',feed.split('/')[2]); continue; }
    [...t.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)].forEach(m=>texts.push(m[1]));
    [...t.matchAll(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/g)].slice(0,40).forEach(m=>texts.push(m[1].replace(/<[^>]+>/g,' ').slice(0,300)));
  }
  console.log('news items scanned:',texts.length,'from',FEEDS.length,'feeds');
  // keyword pass: STRICT full-name matching only (word-boundary), so
  // "Evan Phillips" can never flag "Derek Hill" via the 'hill' substring.
  const signals=new Map(); // playerId -> reason
  const nameRe=new Map();
  for(const r of rows){
    const first=normName(r.name.split(' ')[0]), lastN=normName(lastName(r.name));
    if(lastN.length<3) continue;
    // "mookie betts" OR "m. betts" / "m betts", as whole words
    nameRe.set(r.id, new RegExp(`\\b(?:${first}|${first[0]}\\.?)[ ]${lastN}\\b`));
  }
  for(const tx of texts){
    if(!RISK_WORDS.test(tx)) continue;
    const low=normName(tx);
    for(const r of rows){
      const re=nameRe.get(r.id);
      if(re && re.test(low) && !signals.has(r.id)) signals.set(r.id,tx.slice(0,140));
    }
  }
  // optional Claude comprehension layer: confirm/deny keyword hits
  if(ANTHROPIC_KEY && signals.size){
    const items=[...signals.entries()].map(([id,tx])=>({id,name:rows.find(r=>r.id===id)?.name,tx}));
    const resp=await J('https://api.anthropic.com/v1/messages',{method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:400,
        messages:[{role:'user',content:'For each item, does the text indicate this specific MLB player is OUT, scratched, injured, or not starting TODAY? Reply ONLY JSON array of {"id":number,"out":boolean}. Items: '+JSON.stringify(items)}]})});
    try{ const arr=JSON.parse((resp?.content?.[0]?.text||'[]').replace(/```json|```/g,''));
      arr.forEach(x=>{ if(!x.out) signals.delete(x.id); }); console.log('Claude filtered signals to',signals.size);
    }catch(e){ console.log('Claude parse skipped'); }
  }
  return signals;
}


// ---------- hits O/U engine (mirror of the dashboard) ----------
function impliedPct(a){ return a==null?null:(a<0?-a/(-a+100)*100:100/(a+100)*100); }
function ouContext(r){
  if(r.ouLine==null||r.ouOver==null||r.ouUnder==null||r.estP==null) return null;
  const n=r.expAB||3.8, p=1-Math.pow(1-r.estP/100,1/n);
  const p1=r.estP/100, p2=1-Math.pow(1-p,n)-n*p*Math.pow(1-p,n-1);
  const pOver=r.ouLine<1?p1:p2;
  return {pOver, eO:pOver*100-impliedPct(r.ouOver), eU:(1-pOver)*100-impliedPct(r.ouUnder),
          hitRate:r.l15GwAB>0?r.l15HitG/r.l15GwAB:0};
}
const OU_AFFINITY={
  r5:(r,c)=>r.score!=null&&r.score>=62?{side:'O',w:r.score+c.eO*2}:r.score!=null&&r.score<=35?{side:'U',w:(100-r.score)+c.eU*2}:null,
  mit:(r,c)=>{const e=Math.max(c.eO,c.eU); return e>=5?{side:c.eO>=c.eU?'O':'U',w:e*10}:null;},
  chalky:(r,c)=>{const k=r.st?.k; if(k==null)return null;
    if(k<=20&&c.hitRate>=.6)return{side:'O',w:(24-k)*4+c.eO*3};
    if(k>=26&&(r.fPit??50)<=45)return{side:'U',w:k*2.5+c.eU*3}; return null;},
  gapper:(r,c)=>{const x=r.st?.xba; if(x==null)return null;
    if(x>=.27)return{side:'O',w:x*300+c.eO*3};
    if(x<=.225&&(r.opp?.xba??.3)<=.235)return{side:'U',w:(240-x*1000)+c.eU*3}; return null;},
  sal:(r,c)=>{const o=r.opp||{}; if(!o.hand||o.hand==='?')return null;
    const bS=o.hand==='L'?r.avgVsL:r.avgVsR; if(bS==null)return null;
    if(bS>=.29)return{side:'O',w:bS*500+c.eO*2};
    if(bS<=.21)return{side:'U',w:(300-bS*1000)+c.eU*2}; return null;},
  parkey:(r,c)=>{const pf=r.park?.pf??100;
    if(pf>=104)return{side:'O',w:(pf-100)*8+c.eO*2};
    if(pf<=96)return{side:'U',w:(100-pf)*8+c.eU*2}; return null;},
  fadey:(r,c)=>{ if(r.ouOver>=100&&c.eO>=3)return{side:'O',w:r.ouOver+c.eO*10};
    if(r.ouUnder>=100&&c.eU>=3)return{side:'U',w:r.ouUnder+c.eU*10}; return null;},
  streaks:(r,c)=>{ if((r.streak??0)>=5)return{side:'O',w:r.streak*10+c.eO*2};
    if(c.hitRate<=.4&&(r.streak??0)===0)return{side:'U',w:(60-c.hitRate*100)+c.eU*2}; return null;},
  grinder:(r,c)=>{if((r.bvpPA??0)<12)return null;
    if(r.bvpAvg>=.33)return{side:'O',w:r.bvpAvg*300+c.eO*2};
    if(r.bvpAvg<=.18)return{side:'U',w:(120-r.bvpAvg*300)+c.eU*2}; return null;},
};
function holdsOUOver05(L,dt,bid,id){
  const e=L.days[dt]?.rows[id]?.ou?.[bid];
  return !!(e && e.side==='O' && e.line<1);
}
function hasOU(L,dt,bid){ const d=L.days[dt]; return !!d&&Object.values(d.rows).some(r=>r.ou&&r.ou[bid]); }
function fileOU(L,dt,rows,now,pitchTime){
  for(const [bid,aff] of Object.entries(OU_AFFINITY)){
    if(hasOU(L,dt,bid)) continue;
    const cands=[];
    for(const r of rows){
      if(pitchTime(r)<=now) continue;
      const c=ouContext(r); if(!c) continue;
      const a=aff(r,c); if(!a) continue;
      if(a.side==='O' && r.ouLine<1 && hasPick(L,dt,bid,r.id)) continue; // same bet as hit card
      cands.push({r,side:a.side,line:r.ouLine,odds:a.side==='O'?r.ouOver:r.ouUnder,w:a.w});
    }
    cands.sort((a,b)=>b.w-a.w);
    const picks=cands.slice(0,3);
    if(picks.length<3){ console.log(NAMES[bid]+' O/U: passes'); continue; }
    picks.forEach(p=>{ record(L,dt,p.r); const row=L.days[dt].rows[p.r.id];
      row.ou=row.ou||{}; row.ou[bid]={side:p.side,line:p.line,odds:p.odds,res:null}; });
    wire(L,bid,`${NAMES[bid]} O/U card: ${picks.map(p=>`${p.r.name} ${p.side}${p.line}`).join(', ')}`);
  }
}

// ---------- picks, revisions, settlement ----------
function day(L,dt){ return L.days[dt]=L.days[dt]||{rows:{}}; }
function record(L,dt,r){ const d=day(L,dt); const prev=d.rows[r.id]||{};
  d.rows[r.id]={id:r.id,n:r.name,t:r.team,g:r.game,rk:r.rank??prev.rk,gp:r.gamePk??prev.gp??null,
    sc:r.score,ep:r.estP!=null?Math.round(r.estP*10)/10:null,od:r.dkOdds??prev.od??null,op:r.opp?.name||'',
    picked:prev.picked||false,pickOdds:prev.pickOdds??null,bot:prev.bot||false,botOdds:prev.botOdds??null,
    mit:prev.mit||false,mitOdds:prev.mitOdds??null,bks:prev.bks,ou:prev.ou,res:prev.res??null}; }
function setPick(L,dt,botId,r){ const d=day(L,dt); record(L,dt,r); const row=d.rows[r.id];
  if(botId==='r5'){row.bot=true;row.botOdds=r.dkOdds??row.od??null;}
  else if(botId==='mit'){row.mit=true;row.mitOdds=r.dkOdds??row.od??null;}
  else{row.bks=row.bks||{};row.bks[botId]=r.dkOdds??row.od??null;} }
function unpick(L,dt,botId,id){ const row=L.days[dt]?.rows[id]; if(!row)return;
  if(botId==='r5')row.bot=false; else if(botId==='mit')row.mit=false; else if(row.bks)delete row.bks[botId]; }
function hasPick(L,dt,botId,id){ const row=L.days[dt]?.rows[id]; if(!row)return false;
  return botId==='r5'?row.bot:botId==='mit'?row.mit:!!(row.bks&&row.bks[botId]!==undefined); }
function currentPicks(L,dt,botId){ const d=L.days[dt]; if(!d)return[];
  return Object.values(d.rows).filter(row=>hasPick(L,dt,botId,row.id)).map(r=>r.id); }

async function settle(L){
  const today=todayISO();
  const dates=Object.keys(L.days).filter(dt=>dt<today&&Object.values(L.days[dt].rows).some(r=>r.res==null||r.res==='dnp')).sort().slice(-10);
  for(const dt of dates){
    const hits={};
    for(let off=0;off<3000;off+=1000){
      const d=await J(`${API}/stats?stats=byDateRange&group=hitting&season=${dt.slice(0,4)}&startDate=${dt}&endDate=${dt}&playerPool=ALL&limit=1000&offset=${off}`);
      const sp=d?.stats?.[0]?.splits||[]; sp.forEach(x=>{if(x.player&&(x.stat.plateAppearances||0)>0)hits[x.player.id]=(hits[x.player.id]||0)+(x.stat.hits||0);});
      if(sp.length<1000)break;
    }
    if(Object.keys(hits).length<20){ console.log('skip settle',dt,'thin data'); continue; }
    let n=0;
    Object.values(L.days[dt].rows).forEach(r=>{
      if(r.res==='win'||r.res==='loss')return;
      const h=hits[r.id];
      if(h==null){ if(r.res==null){r.res='dnp';n++;} return; }
      const nr=h>=1?'win':'loss'; if(r.res!==nr){r.res=nr;n++;}
    });
    mutInit(L); mutantsSettle(L, dt, hits);
    Object.values(L.days[dt].rows).forEach(r=>{
      if(!r.ou) return; const h=hits[r.id];
      Object.values(r.ou).forEach(e=>{
        if(e.res==='win'||e.res==='loss') return;
        if(h==null){ e.res='dnp'; return; }
        e.res=(e.side==='O'?h>e.line:h<e.line)?'win':'loss'; n++;
      });
    });
    console.log('settled',n,'rows for',dt);
  }
}

// ================= THE MUTANTS — a 100-bot evolutionary colony =================
// Deterministic genetic strategy search over the same board data the squad uses.
// Each mutant = a genome: feature weights + filters + bet-type preferences.
// Daily lifecycle: pick → settle → evolve (learn from peers, merge, lock, unfuse).
// Everything is seeded & auditable; every change is logged with a rationale.
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function seedFrom(str){ let h=0; for(const c of str) h=Math.imul(31,h)+c.charCodeAt(0)|0; return h; }

const MUT_PRE=['Glitch','Vex','Nova','Krank','Byte','Fizz','Mook','Zap','Drift','Hex'];
const MUT_SUF=['tron','ide','us','by','mo','zilla','nik','form','ling','ex'];
function mutName(i){ return MUT_PRE[i%10]+MUT_SUF[Math.floor(i/10)%10]; }

const GENE_KEYS=['form','hr','stk','k','xba','hh','plat','bvp','park','h9','edge','prob'];
function randGenome(rng){
  const w={}; GENE_KEYS.forEach(k=>w[k]=Math.round(rng()*100)/100);
  return { w,
    f:{ minHR:.35+rng()*.25, maxK:20+rng()*12, minProb:52+rng()*12, conf:rng()<.5 },
    bt:{ hit:rng() },                       // probability mass on 1+hit vs O/U betting
    ouLo:25+rng()*15, ouHi:60+rng()*20,     // score thresholds for Under / Over
    n:2+Math.floor(rng()*2) };
}
function mutFeatures(r){
  const o=r.opp||{}, st=r.st||{};
  const bS=o.hand==='L'?r.avgVsL:r.avgVsR;
  return {
    form: scale(r.l15Avg,.18,.34)??50,
    hr:  (r.l15GwAB>0? r.l15HitG/r.l15GwAB*100 : 50),
    stk: Math.min((r.streak??0)*12,100),
    k:   st.k!=null? 100-scale(st.k,14,32) : 50,
    xba: st.xba!=null? scale(st.xba,.21,.30) : 50,
    hh:  st.hh!=null? scale(st.hh,28,50) : 50,
    plat:bS!=null? scale(bS,.18,.34) : 50,
    bvp: (r.bvpPA>=8&&r.bvpAvg!=null)? scale(r.bvpAvg,.15,.40) : 50,
    park:scale(r.park?.pf??100,92,112)??50,
    h9:  o.h9L5!=null? scale(o.h9L5,6.5,12.5) : 50,
    edge:r.edge!=null? clamp(50+r.edge*4,0,100) : 50,
    prob:r.estP!=null? scale(r.estP,45,80) : 50 };
}
function mutScore(g,r){
  const f=mutFeatures(r); let s=0,wsum=0;
  GENE_KEYS.forEach(k=>{ s+=f[k]*g.w[k]; wsum+=g.w[k]; });
  return wsum>0? s/wsum : 0;
}
function genomeSim(a,b){
  let dot=0,na=0,nb=0;
  GENE_KEYS.forEach(k=>{ dot+=a.w[k]*b.w[k]; na+=a.w[k]**2; nb+=b.w[k]**2; });
  return dot/Math.sqrt(na*nb||1);
}
function describeGenome(g){
  const top=[...GENE_KEYS].sort((x,y)=>g.w[y]-g.w[x]).slice(0,3);
  const L={form:'recent form',hr:'hit-game consistency',stk:'streak momentum',k:'contact (low-K)',xba:'batted-ball quality',hh:'hard contact',plat:'platoon edges',bvp:'BvP history',park:'park environment',h9:'leaky pitchers',edge:'market mispricing',prob:'raw hit probability'};
  const bt=g.bt.hit>=.66?'mostly 1+hit bets':g.bt.hit<=.33?'mostly O/U bets':'a mix of 1+hit and O/U';
  return `Hunts ${L[top[0]]}, ${L[top[1]]} and ${L[top[2]]}; plays ${bt}, ${g.n} picks; needs ${(g.f.minHR*100).toFixed(0)}%+ hit-rate, K% under ${g.f.maxK.toFixed(0)}${g.f.conf?', confirmed lineups only':''}.`;
}

function mutInit(L){
  if(L._mutLoadFailed) return;
  if(L.mut && L.mut.roster) return;
  const rng=mulberry32(20260706);
  const roster={};
  for(let i=0;i<100;i++){
    const id='M'+String(i+1).padStart(3,'0');
    roster[id]={ id, name:mutName(i), g:randGenome(rng),
      rec:{w:0,l:0,u:0,ow:0,ol:0,ouU:0,cs:0,cl:0,hist:[]},
      locked:false, absorbed:null, mergedFrom:null, log:[{d:'genesis',note:'Spawned with a random genome. '+'Ready to evolve.'}] };
  }
  L.mut={roster, alerts:[], series:[], evoDone:{}};
  console.log('MUTANTS: colony of 100 spawned');
}
function mutAlert(L,k,msg){ L.mut.alerts.push({t:Date.now(),k,msg}); L.mut.alerts=L.mut.alerts.slice(-40); console.log('[mutant-alert:'+k+'] '+msg); }
function activeMutants(L){ return Object.values(L.mut.roster).filter(m=>!m.absorbed); }

function mutantsPick(L, date, rows, now, pitchTime){
  if(L._mutLoadFailed) return;
  mutInit(L);
  L.mdays=L.mdays||{};
  if(L.mdays[date] && L.mdays[date].filed) return;
  const avail=rows.filter(r=>pitchTime(r)>now);
  if(!avail.length) return;
  const priced=avail.filter(r=>r.dkOdds!=null);
  if(priced.length<20) { console.log('MUTANTS: waiting for a priced board'); return; }
  const md=L.mdays[date]=L.mdays[date]||{rows:{},filed:false};
  const rng=mulberry32(seedFrom(date)^99);
  let filed=0;
  for(const m of activeMutants(L)){
    const g=m.g;
    const pool=avail.filter(r=>{
      const hrOK=(r.l15GwAB>0? r.l15HitG/r.l15GwAB : 0)>=g.f.minHR;
      const kOK=(r.st?.k??24)<=g.f.maxK;
      const pOK=(r.estP??0)>=g.f.minProb;
      return hrOK&&kOK&&pOK&&(!g.f.conf||r.confirmed);
    });
    const scored=pool.map(r=>({r,sc:mutScore(g,r)})).sort((a,b)=>b.sc-a.sc);
    let placed=0;
    for(const {r,sc} of scored){
      if(placed>=Math.min(g.n,3)) break;
      const wantHit=rng()<g.bt.hit;
      const row=md.rows[r.id]=md.rows[r.id]||{n:r.name,t:r.team,op:r.opp?.name||'',od:r.dkOdds??null,ouL:r.ouLine??null,ouO:r.ouOver??null,ouU:r.ouUnder??null,res:null,mk:{}};
      if(wantHit && r.dkOdds!=null && !row.mk[m.id]){
        row.mk[m.id]=['H',null,r.dkOdds,null]; placed++;
      } else if(r.ouLine!=null && r.ouOver!=null && r.ouUnder!=null && !row.mk[m.id]){
        const side=sc>=g.ouHi?'O':sc<=g.ouLo?'U':null;
        if(side==='O'&&r.ouLine<1&&row.mk[m.id]) continue;
        if(side){ row.mk[m.id]=['OU',side,side==='O'?r.ouOver:r.ouUnder,r.ouLine]; placed++; }
      }
    }
    if(placed) filed++;
  }
  md.filed=true;
  console.log('MUTANTS:',filed,'of',activeMutants(L).length,'filed for',date);
  // trim old detail days to keep the bin small
  Object.keys(L.mdays).sort().slice(0,-7).forEach(d=>delete L.mdays[d]);
}

function mutantsSettle(L, dt, hits){
  if(L._mutLoadFailed) return;
  const md=L.mdays?.[dt]; if(!md||md.settled) return;
  const dayU={};
  Object.entries(md.rows).forEach(([pid,row])=>{
    const h=hits[pid];
    Object.entries(row.mk).forEach(([mid,pk])=>{
      if(pk[4]!=null) return; // already graded
      let res;
      if(h==null) res='p';
      else if(pk[0]==='H') res=h>=1?'w':'l';
      else res=((pk[1]==='O'? h>pk[3] : h<pk[3]))?'w':'l';
      pk[4]=res;
      const m=L.mut.roster[mid]; if(!m) return;
      const odds=pk[2];
      const u=res==='w'?(odds!=null?(odds>0?odds/100:100/-odds):0.4):res==='l'?-1:0;
      dayU[mid]=(dayU[mid]||0)+u;
      if(pk[0]==='H'){ if(res==='w')m.rec.w++; else if(res==='l')m.rec.l++; if(res!=='p')m.rec.u+=u; }
      else { if(res==='w')m.rec.ow++; else if(res==='l')m.rec.ol++; if(res!=='p')m.rec.ouU+=u; }
    });
  });
  Object.entries(dayU).forEach(([mid,u])=>{
    const m=L.mut.roster[mid]; if(!m) return;
    m.rec.hist.push({d:dt,u:Math.round(u*100)/100}); m.rec.hist=m.rec.hist.slice(-21);
    if(u>0){ m.rec.cs++; m.rec.cl=0; } else if(u<0){ m.rec.cl++; m.rec.cs=0; }
    // user rule: strategy change + 2 consecutive profitable days = front-page alert
    if(m.chgAt && m.rec.cs>=2){
      mutAlert(L,'hot',`🔥 ${m.name} retooled its strategy on ${m.chgAt} and just posted ${m.rec.cs} straight profitable days (+${m.rec.hist.slice(-m.rec.cs).reduce((s,x)=>s+x.u,0).toFixed(1)}u). The tweak is working.`);
      m.chgAt=null;
    }
  });
  const colonyU=Object.values(dayU).reduce((s,u)=>s+u,0);
  L.mut.series.push({d:dt,u:Math.round(colonyU*10)/10}); L.mut.series=L.mut.series.slice(-200);
  md.settled=true;
  console.log('MUTANTS: settled',dt,'colony day units',colonyU.toFixed(1));
}

function fitness(m){ return m.rec.hist.slice(-7).reduce((s,x)=>s+x.u,0); }
function mutantsEvolve(L, dt){
  if(L._mutLoadFailed) return;
  if(L.mut.evoDone[dt]) return;
  const act=activeMutants(L).filter(m=>m.rec.hist.length>=2);
  if(act.length<10){ L.mut.evoDone[dt]=true; return; }
  const rng=mulberry32(seedFrom(dt)^7);
  const ranked=[...act].sort((a,b)=>fitness(b)-fitness(a));
  const top=ranked.slice(0,Math.max(5,Math.floor(ranked.length*.1)));
  // LOCK: 5 straight profitable days = strategy found, frozen forever
  for(const m of act){
    if(!m.locked && m.rec.cs>=5){
      m.locked=true;
      m.log.push({d:dt,note:'LOCKED IN. Five consecutive profitable days — this genome no longer changes. '+describeGenome(m.g)});
      mutAlert(L,'lock',`🔒 ${m.name} has locked its strategy after 5 straight green days (${uNum(fitness(m))} last 7). It will never change again.`);
    }
  }
  // LEARN: strugglers study a top performer and shift toward its genome
  const strugglers=ranked.slice(Math.floor(ranked.length*.6)).filter(m=>!m.locked);
  for(const m of strugglers){
    if(rng()>.3) continue;
    const mentor=top[Math.floor(rng()*top.length)];
    GENE_KEYS.forEach(k=>{ m.g.w[k]=Math.round((m.g.w[k]*.7+mentor.g.w[k]*.3+(rng()-.5)*.1)*100)/100; });
    if(rng()<.4) m.g.f.minHR=clamp(m.g.f.minHR+(rng()-.5)*.06,.3,.65);
    if(rng()<.4) m.g.f.minProb=clamp(m.g.f.minProb+(rng()-.5)*3,50,70);
    m.chgAt=dt; m.rec.cs=0;
    m.log.push({d:dt,note:`Studied ${mentor.name}'s approach (7-day ${uNum(fitness(mentor))}) and shifted 30% toward its weighting. New identity: ${describeGenome(m.g)}`});
    m.log=m.log.slice(-4);
  }
  // MERGE: two complementary top performers fuse (max 1 per day)
  const cands=ranked.slice(0,Math.floor(ranked.length*.3)).filter(m=>!m.locked&&!m.mergedFrom);
  outer:
  for(let i=0;i<cands.length&&rng()<.4;i++){
    for(let j=i+1;j<cands.length;j++){
      const a=cands[i],b=cands[j];
      if(genomeSim(a.g,b.g)<.55){
        GENE_KEYS.forEach(k=>a.g.w[k]=Math.round(((a.g.w[k]+b.g.w[k])/2)*100)/100);
        a.g.n=Math.min(5,Math.max(a.g.n,b.g.n));
        a.mergedFrom=[{id:a.id,name:a.name,g:JSON.parse(JSON.stringify(a.g))},{id:b.id,name:b.name,g:JSON.parse(JSON.stringify(b.g))}];
        const newName=a.name.slice(0,Math.ceil(a.name.length/2))+b.name.slice(Math.floor(b.name.length/2));
        a.log.push({d:dt,note:`FUSED with ${b.name} — our genomes disagreed enough to be complementary (similarity ${(genomeSim(a.g,b.g)*100).toFixed(0)}%). Now operating as ${newName}. ${describeGenome(a.g)}`});
        mutAlert(L,'merge',`🧬 ${a.name} + ${b.name} have merged into ${newName} — complementary strategies, both top-30% fitness. The colony is now ${activeMutants(L).length-1} strong.`);
        a.name=newName; a.chgAt=dt; a.rec.cs=0;
        b.absorbed=a.id;
        break outer;
      }
    }
  }
  // UNFUSE: a merged mutant on a 3-day slide petitions ADMIN, splits next day
  for(const m of act){
    if(m.mergedFrom && !m.unfusePending && m.rec.cl>=3){
      m.unfusePending=dt;
      mutAlert(L,'admin',`⚠️ ADMIN: ${m.name} (a fusion) has lost 3 straight days and requests to un-fuse back into ${m.mergedFrom[0].name} + ${m.mergedFrom[1].name}. Auto-approving on the next cycle unless the colony turns.`);
    } else if(m.mergedFrom && m.unfusePending && m.unfusePending!==dt){
      const [pa,pb]=m.mergedFrom;
      m.name=pa.name; m.g=pa.g; m.mergedFrom=null; m.unfusePending=null; m.chgAt=dt; m.rec.cs=0; m.rec.cl=0;
      m.log.push({d:dt,note:`Un-fused by ADMIN approval — reverted to ${pa.name}'s original genome.`});
      const b=L.mut.roster[pb.id];
      if(b){ b.absorbed=null; b.g=pb.g; b.rec.cs=0; b.rec.cl=0; b.log.push({d:dt,note:`Released from the ${pa.name} fusion — back to my own genome. ${describeGenome(b.g)}`}); }
      mutAlert(L,'admin',`✂️ Un-fuse executed: ${pa.name} and ${pb.name} are independent mutants again. Colony ${activeMutants(L).length}.`);
    }
  }
  L.mut.evoDone[dt]=true;
  const keep={}; Object.keys(L.mut.evoDone).sort().slice(-15).forEach(k=>keep[k]=true); L.mut.evoDone=keep;
}
function uNum(u){ return (u>=0?'+':'')+u.toFixed(1)+'u'; }

// ---------- main ----------
const __main=(async()=>{ if(process.env.MUT_TEST==='1') return;
  const date=todayISO();
  console.log('runner build',RUNNER_BUILD,'· ET date',date);
  const L=await loadLedger();
  console.log('ledger loaded:',Object.keys(L.days||{}).length,'day(s) · mutants in blob:',L.mut?Object.keys(L.mut.roster).length:0);
  mutInit(L);   // the colony exists from the very first run, games or not
  await settle(L);
  const board=await buildBoard(date, L);
  if(!board){
    console.log('EARLY EXIT: no completed schedule/games returned for',date,'— saving colony state and sleeping');
    wire(L,'sys','No MLB games found for '+date+' — colony state saved, back to sleep.');
    await saveLedger(L); return; }
  const {rows}=board; rows.forEach((r,i)=>r.rank=i+1);
  const now=Date.now();
  const pitchTime=r=>r.firstPitch?new Date(r.firstPitch).getTime():now+3e7;
  const signals=await scanNews(rows);
  signals.forEach((why,id)=>{ const r=rows.find(x=>x.id===id); if(r) wire(L,'wire',`⚠ ${r.name}: ${why}`); });

  for(const st of STRATS){
    const bot=NAMES[st.id];
    const wanted=st.pick(rows.filter(r=>!signals.has(r.id) && pitchTime(r)>now && !holdsOUOver05(L,date,st.id,r.id))); // never flagged/started/duplicate-of-O/U
    const have=currentPicks(L,date,st.id);
    if(have.length) console.log(bot+': holding '+have.length+' locked pick(s), checking for scratches…');
    if(!have.length){
      if(!wanted.length){ console.log(bot+': passes (nothing qualifies yet)'); continue; }
      wanted.forEach(r=>setPick(L,date,st.id,r));
      wire(L,st.id,`${bot} filed: ${wanted.map(r=>r.name).join(', ')}${wanted.some(r=>r.dkOdds==null)?' (some unpriced)':''}`);
      continue;
    }
    // REVISIONS — only while the pick's game hasn't started
    for(const id of have){
      const r=rows.find(x=>x.id===id);
      const started = r ? pitchTime(r)<=now : true;
      if(started) continue;
      const flagged=signals.has(id);
      const scratched = r && Object.values(rows.filter(x=>x.teamId===r.teamId&&x.confirmed)).length>0 && !r.confirmed;
      if(flagged||scratched){
        unpick(L,date,st.id,id);
        const pool_=st.pick(rows.filter(x=>!signals.has(x.id)&&pitchTime(x)>now&&!hasPick(L,date,st.id,x.id)&&!holdsOUOver05(L,date,st.id,x.id)));
        const sub=pool_.find(x=>x.id!==id);
        if(sub) setPick(L,date,st.id,sub);
        wire(L,st.id,`${bot} changed his mind: OUT ${r?.name||id} (${flagged?'news: '+signals.get(id).slice(0,90):'not in the posted lineup'})${sub?' → IN '+sub.name:''}`);
      }
    }
  }
  console.log('board:',rows.length,'hitters ·',rows.filter(r=>r.confirmed).length,'confirmed ·',rows.filter(r=>r.dkOdds!=null).length,'priced ·',signals.size,'news flags');
  fileOU(L, date, rows.filter(r=>!signals.has(r.id)), now, pitchTime);
  mutantsPick(L, date, rows.filter(r=>!signals.has(r.id)), now, pitchTime);
  mutantsEvolve(L, daysAgo(date,1));
  await saveLedger(L);
  console.log('run complete', new Date().toISOString());
})();
if(process.env.MUT_TEST!=='1') await __main;   // ensures the run completes before the process exits
export {mutInit,mutantsPick,mutantsSettle,mutantsEvolve,activeMutants,pruneLedger,emergencyTrim};
