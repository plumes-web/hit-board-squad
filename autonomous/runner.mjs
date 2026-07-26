/* ============================================================================
   HIT BOARD — AUTONOMOUS SQUAD RUNNER  (autonomous/runner.mjs)
   Runs on GitHub Actions every 30 min (see .github/workflows/squad.yml).

   Each run:
     1. Settles yesterday's (and missed) results from official stat lines
     2. Rebuilds/refreshes today's board (MLB StatsAPI + Savant + Odds API)
     3. Scans the wire (Reddit / news RSS / Bluesky) for scratches & IL moves
     4. Files every bot's hit card + O/U card server-side, revises pre-pitch
        — incl. the BETTER-PRICE RULE: any bot's 1+hit pick is upgraded to the
          hits O/U Over when that market pays better for the same outcome
     5. Runs the 100-mutant colony: daily picks, settlement, evolution
     6. Writes everything to jsonbin MERGE-SAFELY (never clobbers fields)

   Env (GitHub secrets): JSONBIN_KEY, JSONBIN_BIN, ODDS_API_KEY (optional but
   strongly recommended), ANTHROPIC_API_KEY (optional news-confirm pass).
   Node >= 20 (built-in fetch). Zero dependencies.
   ========================================================================== */

const JSONBIN_KEY = (process.env.JSONBIN_KEY || '').trim();
const JSONBIN_BIN = (process.env.JSONBIN_BIN || '').trim();
const ODDS_KEY    = (process.env.ODDS_API_KEY || '').trim();
const ANTH_KEY    = (process.env.ANTHROPIC_API_KEY || '').trim();

if (!JSONBIN_KEY || !JSONBIN_BIN) {
  console.error('FATAL: JSONBIN_KEY and JSONBIN_BIN secrets are required. ' +
    'Repo → Settings → Secrets and variables → Actions.');
  process.exit(1);
}

const API = 'https://statsapi.mlb.com/api/v1';
const JB  = 'https://api.jsonbin.io/v3/b';
/* Records are stored gzip-compressed inside a JSON wrapper {v:1, z:"<base64>"}.
   Ledger JSON is highly repetitive and compresses ~10:1, which keeps everything
   comfortably inside jsonbin's free-plan 100KB record cap. Plain (uncompressed)
   records are still read transparently for backward compatibility. */
import { gzipSync, gunzipSync } from 'node:zlib';
const packRec = rec => JSON.stringify({ v: 1, z: gzipSync(Buffer.from(JSON.stringify(rec))).toString('base64') });
const unpackRec = raw => (raw && typeof raw.z === 'string')
  ? JSON.parse(gunzipSync(Buffer.from(raw.z, 'base64')).toString('utf8'))
  : raw;
// jsonbin has two key types with different headers. Try the key as a Master Key
// first; if jsonbin rejects a write/read with 401/403, retry it as an Access Key.
const HDR_MASTER = { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY };
const HDR_ACCESS = { 'Content-Type': 'application/json', 'X-Access-Key': JSONBIN_KEY };
let HDR = HDR_MASTER;
const KEY_HELP = ' — the key can read this bin but not update it. This usually means the ' +
  'JSONBIN_KEY secret is an Access Key without Update permission, or a key from a ' +
  'different jsonbin account than the one that owns the bin. Fix: jsonbin.io → API Keys → ' +
  'copy the MASTER key (starts with $2a$/$2b$) into the JSONBIN_KEY repo secret, or edit ' +
  'the Access Key and enable Update on Bins.';
async function jbFetch(url, opts) {
  let r = await fetch(url, { ...opts, headers: { ...HDR, ...(opts.extra || {}) } });
  if ((r.status === 401 || r.status === 403)) {
    const alt = HDR === HDR_MASTER ? HDR_ACCESS : HDR_MASTER;
    const r2 = await fetch(url, { ...opts, headers: { ...alt, ...(opts.extra || {}) } });
    if (r2.ok) { HDR = alt; log('jsonbin: switched to', alt === HDR_ACCESS ? 'X-Access-Key' : 'X-Master-Key', 'auth'); return r2; }
  }
  return r;
}

/* ---------------- small utils (mirrors of the dashboard's helpers) -------- */
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const scale = (v, lo, hi) => v == null ? null : clamp((v - lo) / (hi - lo) * 100, 0, 100);
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const nowET = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const daysAgoISO = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const fmtOdds = a => a == null ? '—' : (a > 0 ? '+' + a : String(a));
const fmtAvg = a => (a == null || isNaN(a)) ? '—' : a.toFixed(3).replace(/^0/, '');
const impliedPct = a => (a == null || isNaN(a)) ? null : (a < 0 ? (-a) / (-a + 100) * 100 : 100 / (a + 100) * 100);
const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const unitsFor = (res, od) => {
  if (res == null || res === 'dnp') return 0;
  if (res === 'loss') return -1;
  if (od == null) return 0.4;
  return od > 0 ? od / 100 : 100 / (-od);
};

async function getJSON(url, tries = 3, headers = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'hit-board-runner/1.0', ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) { log('✗', url.split('?')[0], '—', e.message); return null; }
      await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
}
async function getText(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'hit-board-runner/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { if (i === tries - 1) return null; await new Promise(res => setTimeout(res, 500)); }
  }
}
async function pool(tasks, limit) {
  const q = [...tasks]; const workers = [];
  for (let i = 0; i < limit; i++) workers.push((async () => { while (q.length) { const t = q.shift(); try { await t(); } catch (e) { log('task err:', e.message); } } })());
  await Promise.all(workers);
}
function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => o[h.trim()] = r[i]); return o; });
}

/* ---------------- jsonbin: merge-safe read / write ------------------------ */
async function binRead(binId) {
  const r = await jbFetch(`${JB}/${binId}/latest`, {});
  if (!r.ok) throw new Error('jsonbin read ' + binId + ': HTTP ' + r.status + (r.status === 403 ? KEY_HELP : ''));
  return unpackRec((await r.json()).record);
}
async function binWrite(binId, record) {
  const r = await jbFetch(`${JB}/${binId}`, { method: 'PUT', body: packRec(record) });
  if (!r.ok) {
    let body = ''; try { body = (await r.text()).slice(0, 200); } catch {}
    throw new Error('jsonbin write ' + binId + ': HTTP ' + r.status + (body ? ' — ' + body : '') + (r.status === 403 ? KEY_HELP : ''));
  }
}
/* jsonbin free plan caps records at 100KB. With gzip we're normally far under it,
   but writeFit still measures the *packed* payload and shrinks if ever needed. */
const BIN_CAP = 95_000;
function roundDeep(o) {
  if (Array.isArray(o)) return o.map(roundDeep);
  if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = roundDeep(v); return r; }
  if (typeof o === 'number' && !Number.isInteger(o)) return Math.round(o * 1000) / 1000;
  return o;
}
async function writeFit(binId, record, label, steps) {
  record = roundDeep(record);
  let body = packRec(record);
  for (const [name, fn] of steps) {
    if (body.length <= BIN_CAP) break;
    fn(record);
    record = roundDeep(record);
    body = packRec(record);
    log('✂', label, 'over the free-plan record cap — applied:', name, '→', (body.length / 1024).toFixed(0) + 'KB packed');
  }
  if (body.length > BIN_CAP) log('⚠', label, 'still', (body.length / 1024).toFixed(0) + 'KB packed after trimming — jsonbin may reject it.');
  const r = await jbFetch(`${JB}/${binId}`, { method: 'PUT', body });
  if (!r.ok) {
    let msg = ''; try { msg = (await r.text()).slice(0, 200); } catch {}
    throw new Error('jsonbin write ' + binId + ' (' + label + ', ' + (body.length / 1024).toFixed(0) + 'KB packed): HTTP ' + r.status + (msg ? ' — ' + msg : ''));
  }
  log(label, 'saved (' + (body.length / 1024).toFixed(0) + 'KB packed)');
}
async function binCreate(name, record) {
  const r = await jbFetch(JB, { method: 'POST', extra: { 'X-Bin-Name': name, 'X-Bin-Private': 'true' }, body: packRec(record) });
  if (!r.ok) throw new Error('jsonbin create: HTTP ' + r.status + (r.status === 403 ? KEY_HELP : ''));
  return (await r.json()).metadata.id;
}
/* deep-merge one ledger row: dashboard edits and runner edits both survive */
function mergeRow(remote, local) {
  const out = { ...remote, ...local };
  out.bks = { ...(remote?.bks || {}), ...(local?.bks || {}) };
  out.ou  = { ...(remote?.ou  || {}), ...(local?.ou  || {}) };
  out.why = { ...(remote?.why || {}), ...(local?.why || {}) };
  if (!Object.keys(out.bks).length) delete out.bks;
  if (!Object.keys(out.ou).length)  delete out.ou;
  if (!Object.keys(out.why).length) delete out.why;
  // settled results are final — prefer whichever side has a terminal grade
  const term = v => v === 'win' || v === 'loss';
  // the user's checkbox lives on the dashboard; the runner never writes it,
  // so the remote (dashboard-synced) value always wins on the runner side
  out.picked = remote?.picked ?? local?.picked ?? false;
  out.pickOdds = remote?.pickOdds ?? local?.pickOdds ?? null;
  out.res = term(local?.res) ? local.res : term(remote?.res) ? remote.res : (local?.res ?? remote?.res ?? null);
  return out;
}
function mergeDays(remoteDays = {}, localDays = {}) {
  const out = {};
  const dates = new Set([...Object.keys(remoteDays), ...Object.keys(localDays)]);
  for (const dt of dates) {
    const rd = remoteDays[dt]?.rows || {}, ld = localDays[dt]?.rows || {};
    const rows = {};
    for (const id of new Set([...Object.keys(rd), ...Object.keys(ld)]))
      rows[id] = mergeRow(rd[id], ld[id]);
    out[dt] = { rows };
  }
  return out;
}

/* ---------------- park factors ------------------------------------------- */
const PARK_FACTORS = {
  COL: 112, BOS: 107, KC: 104, ATH: 104, CIN: 103, ARI: 102, WSH: 102,
  MIN: 101, PIT: 101, LAA: 101, TEX: 100, ATL: 100, PHI: 100, DET: 100, CWS: 100,
  CHC: 99, STL: 99, MIL: 99, HOU: 99, LAD: 99, MIA: 99, TOR: 99,
  CLE: 98, BAL: 98, TB: 98, NYY: 97, NYM: 97, SF: 97, SD: 97, SEA: 94
};
const WEIGHTS = { form: 0.35, bvp: 0.25, pitcher: 0.25, platoon: 0.15 };
const FORM_DAYS = 21, FORM_GAMES = 15, BVP_FULL_PA = 18, EXP_AB = 3.8, DEPTH = 110;

/* ============================================================================
   1. SETTLEMENT — identical grading semantics to the dashboard
   ========================================================================== */
async function hitsForDate(dt) {
  const season = dt.slice(0, 4); const hitsById = {};
  for (let off = 0; off < 3000; off += 1000) {
    const d = await getJSON(`${API}/stats?stats=byDateRange&group=hitting&season=${season}&startDate=${dt}&endDate=${dt}&playerPool=ALL&limit=1000&offset=${off}`);
    const s = d?.stats?.[0]?.splits || [];
    s.forEach(sp => { if (sp.player && (sp.stat.plateAppearances || 0) > 0) hitsById[sp.player.id] = (hitsById[sp.player.id] || 0) + (sp.stat.hits || 0); });
    if (s.length < 1000) break;
  }
  if (Object.keys(hitsById).length < 20) {
    log('bulk stats thin for', dt, '— grading from box scores…');
    const sched = await getJSON(`${API}/schedule?sportId=1&date=${dt}`);
    const games = (sched?.dates?.[0]?.games || []).filter(g => g.status?.abstractGameState === 'Final');
    await pool(games.map(g => async () => {
      const box = await getJSON(`${API}/game/${g.gamePk}/boxscore`);
      ['home', 'away'].forEach(side => {
        Object.values(box?.teams?.[side]?.players || {}).forEach(p => {
          const b = p?.stats?.batting;
          if (b && (b.plateAppearances || 0) > 0)
            hitsById[p.person.id] = (hitsById[p.person.id] || 0) + (b.hits || 0);
        });
      });
    }), 5);
  }
  return hitsById;
}
function applyResults(day, hitsById) {
  let n = 0;
  Object.values(day.rows).forEach(r => {
    if (r.res === 'win' || r.res === 'loss') { /* final */ }
    else {
      const h = hitsById[r.id];
      if (h == null) { if (r.res == null) { r.res = 'dnp'; n++; } }
      else { const nr = h >= 1 ? 'win' : 'loss'; if (r.res !== nr) { r.res = nr; n++; } }
    }
    if (r.ou) {
      const h = hitsById[r.id];
      Object.values(r.ou).forEach(e => {
        if (e.res === 'win' || e.res === 'loss') return;
        if (h == null) { e.res = 'dnp'; return; }
        e.res = (e.side === 'O' ? h > e.line : h < e.line) ? 'win' : 'loss'; n++;
      });
    }
  });
  return n;
}
async function settle(core, hitsCache) {
  const today = todayISO(); const recheck = daysAgoISO(today, 10);
  const dates = Object.keys(core.days || {}).filter(dt =>
    dt < today && Object.values(core.days[dt].rows).some(r =>
      r.res == null || (r.res === 'dnp' && dt >= recheck) ||
      (r.ou && Object.values(r.ou).some(e => e.res == null)))).sort();
  for (const dt of dates) {
    const hitsById = hitsCache[dt] || (hitsCache[dt] = await hitsForDate(dt));
    if (Object.keys(hitsById).length < 20) { log('⚠ no results for', dt, '— left as-is'); continue; }
    const n = applyResults(core.days[dt], hitsById);
    if (n) log('settled', n, 'entries for', dt);
  }
}

/* ============================================================================
   2. BOARD BUILD — full port of loadSlate() (spin analysis skipped, per docs)
   ========================================================================== */
async function fetchSavant(core, date) {
  const season = date.slice(0, 4);
  if (core.statCache?.date === date && core.statCache.bat && core.statCache.pit) return core.statCache;
  const bat = {}, pit = {};
  const bUrl = `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=batter&filter=&min=10&selections=xba,k_percent,whiff_percent,hard_hit_percent,exit_velocity_avg,sweet_spot_percent&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`;
  const bt = await getText(bUrl);
  if (bt && !bt.trim().startsWith('<')) parseCSV(bt).forEach(r => {
    const id = parseInt(r.player_id, 10); if (!id) return;
    bat[id] = { xba: num(r.xba), k: num(r.k_percent), whiff: num(r.whiff_percent), hh: num(r.hard_hit_percent), ev: num(r.exit_velocity_avg), ss: num(r.sweet_spot_percent) };
  });
  for (const sel of ['xba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,whiff_percent,k_percent,iz_contact_percent,linedrives_percent',
                     'xba,exit_velocity_avg,barrel_batted_rate,hard_hit_percent,whiff_percent,k_percent']) {
    const t = await getText(`https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=pitcher&filter=&min=1&selections=${sel}&chart=false&x=xba&y=xba&r=no&chartType=beeswarm&csv=true`);
    if (!t || t.trim().startsWith('<')) continue;
    const parsed = parseCSV(t); if (!parsed.length || parsed[0].player_id === undefined) continue;
    parsed.forEach(r => {
      const id = parseInt(r.player_id, 10); if (!id) return;
      pit[id] = { xba: num(r.xba), ev: num(r.exit_velocity_avg), barrel: num(r.barrel_batted_rate), hardhit: num(r.hard_hit_percent), whiff: num(r.whiff_percent), kpct: num(r.k_percent), izcontact: num(r.iz_contact_percent), ld: num(r.linedrives_percent) };
    });
    break;
  }
  log('Savant:', Object.keys(bat).length, 'batters,', Object.keys(pit).length, 'pitchers (cached for the day)');
  core.statCache = { date, bat, pit };
  return core.statCache;
}

function scoreRow(c) {
  let form = null;
  if (c.l15GwAB >= 5) {
    const hitRate = c.l15HitG / c.l15GwAB;
    form = clamp(0.50 * (scale(c.l15Avg, .180, .340) ?? 40) + 0.20 * (scale(c.seasonAvg, .180, .340) ?? 40) + 30 * hitRate + Math.min(c.streak * 2, 12) - 6, 0, 100);
  }
  let bvp = null, bvpConf = 0;
  if (c.bvpAB >= 4 && c.bvpAvg != null) { bvp = scale(c.bvpAvg, .150, .400); bvpConf = clamp(c.bvpPA / BVP_FULL_PA, 0, 1); }
  let pit = null; const o = c.opp;
  if (o) {
    const parts = []; const add = (v, w) => { if (v != null) parts.push([v, w]); };
    add(scale(o.xba, .225, .295), .22);
    add(o.babip != null ? scale(o.babip, .250, .345) : null, .12);
    add(o.kpct != null ? 100 - scale(o.kpct, 14, 32) : null, .14);
    add(o.whiff != null ? 100 - scale(o.whiff, 18, 32) : null, .10);
    add(o.izcontact != null ? scale(o.izcontact, 78, 90) : null, .05);
    add(o.ld != null ? scale(o.ld, 18, 30) : null, .07);
    add(scale(o.hardhit, 30, 48), .10);
    add(scale(o.ev, 86.5, 91.5), .06);
    add(scale(o.barrel, 4, 12), .08);
    if (o.h9L5 != null && o.ipL5 >= 8) add(scale(o.h9L5, 6.5, 12.5), .12);
    add(scale(o.baa, .200, .310), .06);
    if (parts.length) { const w = parts.reduce((s, p) => s + p[1], 0); pit = parts.reduce((s, p) => s + p[0] * p[1], 0) / w; }
  }
  let plat = null;
  if (o && o.hand !== '?') {
    const bAvg = o.hand === 'L' ? c.avgVsL : c.avgVsR;
    const side = c.bats === 'S' ? (o.hand === 'L' ? 'R' : 'L') : c.bats;
    const pBaa = side === 'L' ? o.baaVsL : side === 'R' ? o.baaVsR : null;
    const parts = [];
    if (bAvg != null) parts.push(scale(bAvg, .180, .340));
    if (pBaa != null) parts.push(scale(pBaa, .200, .320));
    if (parts.length) plat = parts.reduce((a, b) => a + b, 0) / parts.length;
  }
  const terms = [];
  if (form != null) terms.push([form, WEIGHTS.form]);
  if (bvp != null) terms.push([bvp, WEIGHTS.bvp * bvpConf]);
  if (pit != null) terms.push([pit, WEIGHTS.pitcher]);
  if (plat != null) terms.push([plat, WEIGHTS.platoon]);
  const wsum = terms.reduce((s, t) => s + t[1], 0);
  c.fForm = form; c.fBvp = bvp; c.fPit = pit; c.fPlat = plat; c.bvpConf = bvpConf;
  let comp = wsum > 0 ? terms.reduce((s, t) => s + t[0] * t[1], 0) / wsum : null;
  const pf = c.park?.pf ?? 100;
  if (comp != null) comp = clamp(comp + clamp((pf - 100) * 0.35, -4, 4), 0, 100);
  c.score = comp != null ? Math.round(comp * 10) / 10 : null;
  const avgs = [];
  if (c.l15Avg != null) avgs.push([c.l15Avg, 3]);
  if (c.seasonAvg != null) avgs.push([c.seasonAvg, 2]);
  const bAvg2 = o && o.hand === 'L' ? c.avgVsL : c.avgVsR;
  if (bAvg2 != null) avgs.push([bAvg2, 1]);
  if (c.bvpAvg != null && c.bvpAB >= 8) avgs.push([c.bvpAvg, bvpConf]);
  if (o?.baa != null) avgs.push([o.baa, 1.5]);
  if (avgs.length) {
    const w = avgs.reduce((s, a) => s + a[1], 0);
    let adj = avgs.reduce((s, a) => s + a[0] * a[1], 0) / w;
    adj *= (pf / 100);
    c.estP = (1 - Math.pow(1 - clamp(adj, .15, .4), EXP_AB)) * 100;
  } else c.estP = null;
}

async function buildBoard(core, date) {
  const season = date.slice(0, 4);
  const [sched, teamsResp] = await Promise.all([
    getJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups`),
    getJSON(`${API}/teams?sportId=1&season=${season}`)
  ]);
  const abbr = {}; (teamsResp?.teams || []).forEach(t => abbr[t.id] = t.abbreviation || t.teamName || t.name);
  const games = sched?.dates?.[0]?.games || [];
  if (!games.length) { log('no MLB games for', date); return null; }
  log(games.length, 'games on the slate');

  const teamCtx = {}, lineupIds = new Set(), lineupOrder = {}; let anyLineup = false;
  for (const g of games) {
    const home = g.teams.home, away = g.teams.away;
    const label = `${abbr[away.team.id] || away.team.name} @ ${abbr[home.team.id] || home.team.name}`;
    const park = { name: g.venue?.name || '', pf: PARK_FACTORS[abbr[home.team.id]] ?? 100 };
    teamCtx[home.team.id] = { opp: away.probablePitcher || null, label, gamePk: g.gamePk, park, firstPitch: g.gameDate };
    teamCtx[away.team.id] = { opp: home.probablePitcher || null, label, gamePk: g.gamePk, park, firstPitch: g.gameDate };
    const lu = g.lineups;
    if (lu) {
      (lu.homePlayers || []).forEach((p, i) => { lineupIds.add(p.id); lineupOrder[p.id] = i + 1; anyLineup = true; });
      (lu.awayPlayers || []).forEach((p, i) => { lineupIds.add(p.id); lineupOrder[p.id] = i + 1; anyLineup = true; });
    }
  }
  // fill missing probables from live feed
  const missing = games.filter(g => !g.teams.home.probablePitcher || !g.teams.away.probablePitcher);
  await pool(missing.map(g => async () => {
    const feed = await getJSON(`https://statsapi.mlb.com/api/v1.1/game/${g.gamePk}/feed/live`);
    const pp = feed?.gameData?.probablePitchers;
    if (pp?.away && !g.teams.away.probablePitcher) { g.teams.away.probablePitcher = pp.away; teamCtx[g.teams.home.team.id].opp = pp.away; }
    if (pp?.home && !g.teams.home.probablePitcher) { g.teams.home.probablePitcher = pp.home; teamCtx[g.teams.away.team.id].opp = pp.home; }
  }), 6);

  const probables = [...new Map(Object.values(teamCtx).filter(c => c.opp).map(c => [c.opp.id, c.opp])).values()];
  log(probables.length, 'probable pitchers');
  const playingTeams = new Set(Object.keys(teamCtx).map(Number));

  // bulk hitting: season + recent window
  async function bulk(statType, extra) {
    const splits = [];
    for (let off = 0; off < 3000; off += 1000) {
      const d = await getJSON(`${API}/stats?stats=${statType}&group=hitting&season=${season}&playerPool=ALL&limit=1000&offset=${off}${extra || ''}`);
      const s = d?.stats?.[0]?.splits || []; splits.push(...s);
      if (s.length < 1000) break;
    }
    return splits;
  }
  const startD = daysAgoISO(date, FORM_DAYS);
  const [seasonSplits, recentSplits] = await Promise.all([bulk('season', ''), bulk('byDateRange', `&startDate=${startD}&endDate=${date}`)]);
  const recentById = {}; recentSplits.forEach(s => { if (s.player) recentById[s.player.id] = s.stat; });
  const candidates = seasonSplits
    .filter(s => s.player && s.team && playingTeams.has(s.team.id) && s.position?.abbreviation !== 'P')
    .map(s => {
      const r = recentById[s.player.id] || {};
      return { id: s.player.id, name: s.player.fullName, teamId: s.team.id, team: abbr[s.team.id] || s.team.name,
        seasonAvg: num(s.stat.avg), seasonPA: s.stat.plateAppearances || 0,
        recAvg: num(r.avg), recPA: r.plateAppearances || 0, recG: r.gamesPlayed || 0, recH: r.hits || 0 };
    })
    .sort((a, b) => (b.recPA - a.recPA) || (b.seasonPA - a.seasonPA))
    .slice(0, DEPTH);

  // pitcher profiles
  const savant = await fetchSavant(core, date);
  const pInfo = {};
  await pool(probables.map(pr => async () => {
    const info = pInfo[pr.id] = { id: pr.id, name: pr.fullName, hand: '?', spin: null };
    const [person, stats, splits, l5] = await Promise.all([
      getJSON(`${API}/people/${pr.id}`),
      getJSON(`${API}/people/${pr.id}/stats?stats=season&group=pitching&season=${season}`),
      getJSON(`${API}/people/${pr.id}/stats?stats=statSplits&group=pitching&sitCodes=vl,vr&season=${season}`),
      getJSON(`${API}/people/${pr.id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`)
    ]);
    info.hand = person?.people?.[0]?.pitchHand?.code || '?';
    const ss = stats?.stats?.[0]?.splits?.[0]?.stat;
    if (ss) {
      info.baa = num(ss.avg); info.whip = num(ss.whip);
      const H = ss.hits, HR = ss.homeRuns, AB = ss.atBats, SO = ss.strikeOuts, SF = ss.sacFlies || 0, BF = ss.battersFaced;
      const den = (AB ?? 0) - (SO ?? 0) - (HR ?? 0) + SF;
      if (H != null && den > 0) info.babip = (H - HR) / den;
      if (SO != null && BF > 0) info.kpct = SO / BF * 100;
    }
    (splits?.stats?.[0]?.splits || []).forEach(sp => {
      if (sp.split?.code === 'vl') info.baaVsL = num(sp.stat.avg);
      if (sp.split?.code === 'vr') info.baaVsR = num(sp.stat.avg);
    });
    const logs = (l5?.stats?.[0]?.splits || []).slice(-5);
    let ip = 0, h = 0;
    logs.forEach(g => { ip += num(g.stat.inningsPitched) || 0; h += g.stat.hits || 0; });
    if (ip > 0) { info.h9L5 = h / ip * 9; info.ipL5 = ip; }
    const sv = savant.pit[pr.id];
    if (sv) { Object.assign(info, sv); if (sv.kpct != null) info.kpct = sv.kpct; }
  }), 5);

  // team recent games + starters, for the last-10 strip context (light version)
  // bat sides
  for (let i = 0; i < candidates.length; i += 100) {
    const ids = candidates.slice(i, i + 100).map(c => c.id).join(',');
    const ppl = await getJSON(`${API}/people?personIds=${ids}`);
    const map = {}; (ppl?.people || []).forEach(p => map[p.id] = p.batSide?.code || '?');
    candidates.slice(i, i + 100).forEach(c => c.bats = map[c.id] || '?');
  }
  await pool(candidates.map(c => async () => {
    const ctx = teamCtx[c.teamId]; const opp = ctx?.opp ? pInfo[ctx.opp.id] : null;
    c.game = ctx?.label || ''; c.opp = opp || null; c.gamePk = ctx?.gamePk || null;
    c.firstPitch = ctx?.firstPitch || null;
    c.confirmed = lineupIds.has(c.id);
    c.st = savant.bat[c.id] || {};
    c.order = lineupOrder[c.id] || null;
    c.expAB = c.order ? [4.4, 4.3, 4.2, 4.1, 4.0, 3.8, 3.6, 3.4, 3.3][c.order - 1] : 3.8;
    const calls = [
      getJSON(`${API}/people/${c.id}/stats?stats=gameLog&group=hitting&season=${season}&gameType=R`),
      getJSON(`${API}/people/${c.id}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}`)
    ];
    if (opp) calls.push(getJSON(`${API}/people/${c.id}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${opp.id}`));
    const [glog, splits, bvp] = await Promise.all(calls);
    const logs = (glog?.stats?.[0]?.splits || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const last15 = logs.slice(-FORM_GAMES);
    let ab = 0, h = 0, hitG = 0, gwab = 0;
    last15.forEach(g => { const gab = g.stat.atBats || 0, gh = g.stat.hits || 0; ab += gab; h += gh; if (gab > 0) { gwab++; if (gh > 0) hitG++; } });
    c.l15Avg = ab > 0 ? h / ab : null; c.l15G = last15.length; c.l15GwAB = gwab; c.l15HitG = hitG;
    let streak = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
      const gab = logs[i].stat.atBats || 0, gh = logs[i].stat.hits || 0;
      if (gab === 0) continue;
      if (gh > 0) streak++; else break;
    }
    c.streak = streak;
    (splits?.stats?.[0]?.splits || []).forEach(sp => {
      if (sp.split?.code === 'vl') c.avgVsL = num(sp.stat.avg);
      if (sp.split?.code === 'vr') c.avgVsR = num(sp.stat.avg);
    });
    c.bvpAB = 0; c.bvpH = 0; c.bvpPA = 0; c.bvpAvg = null;
    if (bvp) for (const st of (bvp.stats || [])) for (const sp of (st.splits || []))
      if (sp.stat && sp.stat.atBats != null) { c.bvpAB = sp.stat.atBats; c.bvpH = sp.stat.hits || 0; c.bvpPA = sp.stat.plateAppearances || sp.stat.atBats; c.bvpAvg = num(sp.stat.avg); }
  }), 8);

  candidates.forEach(c => { c.park = teamCtx[c.teamId]?.park || { name: '', pf: 100 }; });
  candidates.forEach(scoreRow);
  const rows = candidates.filter(c => c.score != null).sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => r.rank = i + 1);
  log('board built:', rows.length, 'hitters ranked · lineups:', anyLineup ? 'posted' : 'not yet');
  return { rows, hasLineups: anyLineup, gamesByPk: Object.fromEntries(games.map(g => [g.gamePk, g])) };
}

/* lineup/odds refresh applied to a cached board (cheap path between rebuilds) */
async function refreshBoardLive(board, date) {
  const sched = await getJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=lineups`);
  const games = sched?.dates?.[0]?.games || [];
  const lineupIds = new Set(), lineupOrder = {}; let anyLineup = false;
  const startByPk = {};
  for (const g of games) {
    startByPk[g.gamePk] = { firstPitch: g.gameDate, state: g.status?.abstractGameState };
    const lu = g.lineups; if (!lu) continue;
    (lu.homePlayers || []).forEach((p, i) => { lineupIds.add(p.id); lineupOrder[p.id] = i + 1; anyLineup = true; });
    (lu.awayPlayers || []).forEach((p, i) => { lineupIds.add(p.id); lineupOrder[p.id] = i + 1; anyLineup = true; });
  }
  board.rows.forEach(r => {
    r.confirmed = lineupIds.has(r.id);
    r.order = lineupOrder[r.id] || r.order || null;
    r.expAB = r.order ? [4.4, 4.3, 4.2, 4.1, 4.0, 3.8, 3.6, 3.4, 3.3][r.order - 1] : 3.8;
    const gi = startByPk[r.gamePk];
    if (gi) { r.firstPitch = gi.firstPitch; r.gameState = gi.state; }
  });
  board.hasLineups = anyLineup;
  return board;
}

/* ---------------- Odds API: DK 1+hit prices + hits O/U -------------------- */
async function fetchOdds(core, date) {
  const oc = core.oddsCache;
  const ageMin = oc?.fetchedAt ? (Date.now() - oc.fetchedAt) / 60000 : Infinity;
  const hourET = nowET().getHours();
  const meaningful = hourET >= 12;             // don't burn credits before noon ET
  if (oc?.date === date && (ageMin < 150 || !ODDS_KEY)) return oc;
  if (!ODDS_KEY || !meaningful) return oc?.date === date ? oc : null;
  const base = 'https://api.the-odds-api.com/v4/sports/baseball_mlb';
  const evs = await getJSON(`${base}/events?apiKey=${ODDS_KEY}`);
  if (!evs) return oc?.date === date ? oc : null;
  const todays = evs.filter(e => new Date(e.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === date);
  const prices = {}, ou = {};
  await pool(todays.map(ev => async () => {
    const d = await getJSON(`${base}/events/${ev.id}/odds?apiKey=${ODDS_KEY}&regions=us&bookmakers=draftkings&markets=batter_hits&oddsFormat=american`);
    const mk = d?.bookmakers?.[0]?.markets?.find(m => m.key === 'batter_hits');
    (mk?.outcomes || []).forEach(oc2 => {
      if (!oc2.description) return;
      const k = normName(oc2.description), line = oc2.point ?? 0.5, v = Math.round(oc2.price);
      if (oc2.name === 'Over' && line === 0.5) prices[k] = v;
      const e = ou[k] || (ou[k] = { line });
      if (e.line === line) { if (oc2.name === 'Over') e.over = v; else e.under = v; }
    });
  }), 4);
  core.oddsCache = { date, prices, ou, fetchedAt: Date.now() };
  log('odds fetched:', Object.keys(prices).length, 'hitters priced across', todays.length, 'games');
  return core.oddsCache;
}
function applyOddsToBoard(board, oddsCache) {
  if (!oddsCache) return 0;
  let n = 0;
  board.rows.forEach(r => {
    const k = normName(r.name);
    const p = oddsCache.prices?.[k];
    if (p != null) { r.dkOdds = p; r.dkImplied = impliedPct(p); if (r.estP != null) r.edge = r.estP - r.dkImplied; n++; }
    const e = oddsCache.ou?.[k];
    if (e && e.over != null && e.under != null) { r.ouLine = e.line; r.ouOver = e.over; r.ouUnder = e.under; }
  });
  return n;
}

/* ============================================================================
   3. NEWS WIRE — Reddit + RSS + Bluesky keyword engine (+ optional Claude)
   ========================================================================== */
const NEWS_KEYWORDS = /\b(scratch(ed)?|not in (the )?lineup|out of (the )?lineup|out of tonight|placed on|10-day il|15-day il|injured list|day.?to.?day|left the game|exit(ed|s)? (the )?game|paternity|bereavement|optioned|designated for assignment|dfa'?d|benched|sitting|getting a day)\b/i;
async function scanNews(rows) {
  const headlines = [];
  // Reddit
  for (const sub of ['fantasybaseball', 'baseball']) {
    const d = await getJSON(`https://www.reddit.com/r/${sub}/new.json?limit=40`, 2);
    (d?.data?.children || []).forEach(c => { const t = c.data?.title; if (t) headlines.push({ src: 'r/' + sub, text: t, at: (c.data.created_utc || 0) * 1000 }); });
  }
  // RSS feeds
  for (const feed of ['https://www.espn.com/espn/rss/mlb/news', 'https://www.mlb.com/feeds/news/rss.xml', 'https://www.rotowire.com/rss/news.php?sport=MLB']) {
    const t = await getText(feed);
    if (!t) continue;
    const src = feed.split('/')[2];
    for (const m of t.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{10,200})(?:\]\]>)?<\/title>/g))
      headlines.push({ src, text: m[1], at: Date.now() });
  }
  // Bluesky public search
  const bs = await getJSON('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=' + encodeURIComponent('mlb scratched lineup') + '&limit=25', 1);
  (bs?.posts || []).forEach(p => { const t = p.record?.text; if (t) headlines.push({ src: 'bsky', text: t.slice(0, 220), at: Date.parse(p.indexedAt) || Date.now() }); });

  const cutoff = Date.now() - 20 * 3600 * 1000;
  const recent = headlines.filter(h => !h.at || h.at > cutoff);
  const flags = new Map(); // id -> {reason, src}
  for (const r of rows) {
    const nn = normName(r.name);
    const last = nn.split(' ').slice(-1)[0];
    for (const h of recent) {
      const ht = normName(h.text);
      if (!NEWS_KEYWORDS.test(h.text)) continue;
      if (ht.includes(nn) || (last.length > 4 && ht.includes(last) && ht.includes(nn.split(' ')[0]))) {
        flags.set(r.id, { reason: h.text.slice(0, 140), src: h.src });
        break;
      }
    }
  }
  // optional Claude comprehension pass to cut false positives
  if (ANTH_KEY && flags.size) {
    for (const [id, f] of [...flags]) {
      const r = rows.find(x => x.id === id);
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 5,
            messages: [{ role: 'user', content: `Headline: "${f.reason}"\nDoes this headline say that MLB player ${r.name} is OUT of today's lineup, scratched, injured, or otherwise unavailable to bat today? Answer only YES or NO.` }]
          })
        });
        if (resp.ok) {
          const j = await resp.json();
          const ans = (j.content?.[0]?.text || '').trim().toUpperCase();
          if (ans.startsWith('NO')) { flags.delete(id); log('Claude cleared false flag:', r.name); }
        }
      } catch (e) { /* keyword verdict stands */ }
    }
  }
  if (flags.size) log('news flags:', [...flags.keys()].map(id => rows.find(r => r.id === id)?.name).join(', '));
  return flags;
}

/* ============================================================================
   4. THE NINE BOTS — exact ports of the dashboard strategies
   ========================================================================== */
const BOT_DEFS = [
  { id: 'chalky', name: 'Chalky', score(r) { const st = r.st || {}, o = r.opp || {};
      const hitRate = r.l15GwAB > 0 ? r.l15HitG / r.l15GwAB : 0;
      if ((st.k ?? 99) > 23 || hitRate < .55) return null;
      return (26 - (st.k ?? 24)) * 3 + (26 - (st.whiff ?? 24)) * 2 + hitRate * 60 + (o.whiff != null ? (24 - o.whiff) * 1.5 : 0) + (r.l15Avg ?? .25) * 60; } },
  { id: 'gapper', name: 'Gapper', score(r) { const st = r.st || {}, o = r.opp || {};
      if ((st.xba ?? 0) < .255) return null;
      return (st.xba ?? .24) * 400 + (st.hh ?? 35) + (st.ss ?? 32) * .5 + (o.xba != null ? (o.xba - .245) * 300 : 0) + (o.hardhit ?? 38) * .5 + (o.ld ?? 22); } },
  { id: 'sal', name: 'Southpaw Sal', score(r) { const o = r.opp || {}; if (!o.hand || o.hand === '?') return null;
      const bS = o.hand === 'L' ? r.avgVsL : r.avgVsR;
      const side = r.bats === 'S' ? (o.hand === 'L' ? 'R' : 'L') : r.bats;
      const pB = side === 'L' ? o.baaVsL : side === 'R' ? o.baaVsR : null;
      if (bS == null || pB == null || bS < .27 || pB < .255) return null;
      return (bS - .245) * 600 + (pB - .245) * 600 + (r.l15Avg ?? .25) * 100; } },
  { id: 'parkey', name: 'Parkey', score(r) { const o = r.opp || {}, pf = r.park?.pf ?? 100, st = r.st || {};
      if (pf < 100) return null;
      return (pf - 100) * 7 + (o.h9L5 != null ? o.h9L5 * 4 : 30) + (24 - (st.k ?? 24)) + (r.l15Avg ?? .25) * 120; } },
  { id: 'fadey', name: 'Fadey', score(r) { if (r.dkOdds == null || r.estP == null || r.dkImplied == null) return null;
      const edge = r.estP - r.dkImplied;
      if (r.dkOdds < -160 || edge < 4 || r.estP < 55) return null;
      return r.dkOdds + edge * 12; } },
  { id: 'streaks', name: 'Streaks', score(r) { if ((r.streak ?? 0) < 3) return null;
      const hitRate = r.l15GwAB > 0 ? r.l15HitG / r.l15GwAB : 0;
      const heat = (r.l15Avg != null && r.seasonAvg != null) ? Math.max(0, r.l15Avg - r.seasonAvg) : 0;
      return r.streak * 9 + hitRate * 50 + heat * 250; } },
  { id: 'grinder', name: 'The Grinder', score(r) { if ((r.bvpPA ?? 0) < 10 || (r.bvpAvg ?? 0) < .28) return null;
      return r.bvpAvg * 200 * Math.log(r.bvpPA) + (r.opp?.h9L5 != null ? r.opp.h9L5 * 3 : 24); } },
];
const PICK_WHY = {
  r5: r => 'composite ' + (r.score ?? '—') + ', #' + (r.rank ?? '?') + ' on the board',
  mit: r => { const m = mittsEval(r, true); return m.prob ? m.prob.toFixed(0) + '% model vs ' + (r.dkImplied?.toFixed(0) ?? '—') + '% price (' + (m.edge > 0 ? '+' : '') + (m.edge?.toFixed(1) ?? '—') + '%)' : 'value profile'; },
  chalky: r => 'K ' + (r.st?.k?.toFixed(1) ?? 'low') + '% · hit in ' + r.l15HitG + '/' + r.l15GwAB,
  gapper: r => 'xBA ' + fmtAvg(r.st?.xba) + ' · ' + (r.st?.hh?.toFixed(0) ?? '—') + '% hard-hit',
  sal: r => { const o = r.opp || {}; const bS = o.hand === 'L' ? r.avgVsL : r.avgVsR; return fmtAvg(bS) + ' vs ' + o.hand + 'HP'; },
  parkey: r => 'park ' + (r.park?.pf ?? 100) + ' · ' + (r.opp?.h9L5?.toFixed(1) ?? '—') + ' H/9',
  fadey: r => fmtOdds(r.dkOdds) + ' price, +' + ((r.edge ?? 0).toFixed(1)) + '% edge',
  streaks: r => (r.streak ?? 0) + '-game hit streak',
  grinder: r => 'BvP ' + r.bvpH + '-for-' + r.bvpAB + ' (' + r.bvpPA + ' PA)',
};
function mittsEval(r, quiet, hasLineups) {
  const o = r.opp || {}; const why = [];
  if (r.seasonAvg == null || r.l15Avg == null) return { ok: false, why: ['not enough batting data'] };
  const base = .5 * r.seasonAvg + .3 * r.l15Avg + .2 * (r.recAvg ?? r.seasonAvg);
  let p = base;
  const bSplit = o.hand === 'L' ? r.avgVsL : r.avgVsR;
  const side = r.bats === 'S' ? (o.hand === 'L' ? 'R' : 'L') : r.bats;
  const pBaa = side === 'L' ? o.baaVsL : side === 'R' ? o.baaVsR : null;
  if (bSplit != null) p += (bSplit - base) * 0.30;
  if (pBaa != null) p += (pBaa - .245) * 0.35;
  if (o.xba != null) p += (o.xba - .245) * 0.45;
  if (o.kpct != null) p += (.22 - o.kpct / 100) * 0.28;
  if (o.whiff != null) p += (.24 - o.whiff / 100) * 0.18;
  if (o.h9L5 != null && o.ipL5 >= 8) p += (o.h9L5 - 8.6) * 0.004;
  if (r.bvpAvg != null && r.bvpPA >= 6) {
    const w = r.bvpPA >= 30 ? .14 : r.bvpPA >= 18 ? .10 : r.bvpPA >= 12 ? .06 : .03;
    p += (r.bvpAvg - base) * w;
  }
  p *= (r.park?.pf ?? 100) / 100;
  p = clamp(p, .150, .400);
  const expAB = r.expAB || 3.8;
  const prob = (1 - Math.pow(1 - p, expAB)) * 100;
  const edge = r.dkImplied != null ? prob - r.dkImplied : null;
  let ok = true;
  const hitRate = r.l15GwAB > 0 ? r.l15HitG / r.l15GwAB : 0;
  if (r.dkOdds == null) { ok = false; why.push('no DK price posted'); }
  if (hasLineups && !r.confirmed) { ok = false; why.push('not confirmed in lineup'); }
  if (r.order && r.order >= 8 && (edge == null || edge < 10)) { ok = false; why.push('batting ' + r.order + 'th'); }
  if (hitRate < .50) { ok = false; why.push('hit-game rate too low'); }
  if ((r.recPA || 0) < 30) { ok = false; why.push('thin recent PA'); }
  if (bSplit != null && bSplit < .215) { ok = false; why.push('platoon disadvantage'); }
  if (r.fPit != null && r.fPit < 40) { ok = false; why.push('pitcher too tough'); }
  if (prob < 63) { ok = false; why.push('model prob < 63%'); }
  const tier = edge == null || edge < 4 ? null : edge < 7 ? 'lean' : edge < 11 ? 'playable' : 'strong';
  if (!tier) ok = false;
  return { ok, p, prob, edge, tier, expAB, why };
}
function ouContext(r) {
  if (r.ouLine == null || r.ouOver == null || r.ouUnder == null || r.estP == null) return null;
  const n = r.expAB || 3.8;
  const p = 1 - Math.pow(1 - r.estP / 100, 1 / n);
  const p1 = r.estP / 100;
  const p2 = 1 - Math.pow(1 - p, n) - n * p * Math.pow(1 - p, n - 1);
  const pOver = r.ouLine < 1 ? p1 : p2;
  const eO = pOver * 100 - impliedPct(r.ouOver);
  const eU = (1 - pOver) * 100 - impliedPct(r.ouUnder);
  const hitRate = r.l15GwAB > 0 ? r.l15HitG / r.l15GwAB : 0;
  return { pOver, eO, eU, hitRate };
}
const OU_AFFINITY = {
  r5: (r, c) => r.score != null && r.score >= 62 ? { side: 'O', w: r.score + c.eO * 2 } : r.score != null && r.score <= 35 ? { side: 'U', w: (100 - r.score) + c.eU * 2 } : null,
  mit: (r, c) => { const e = Math.max(c.eO, c.eU); return e >= 5 ? { side: c.eO >= c.eU ? 'O' : 'U', w: e * 10 } : null; },
  chalky: (r, c) => { const k = r.st?.k; if (k == null) return null;
    if (k <= 20 && c.hitRate >= .6) return { side: 'O', w: (24 - k) * 4 + c.eO * 3 };
    if (k >= 26 && (r.fPit ?? 50) <= 45) return { side: 'U', w: k * 2.5 + c.eU * 3 }; return null; },
  gapper: (r, c) => { const x = r.st?.xba; if (x == null) return null;
    if (x >= .27) return { side: 'O', w: x * 300 + c.eO * 3 };
    if (x <= .225 && (r.opp?.xba ?? .3) <= .235) return { side: 'U', w: (240 - x * 1000) + c.eU * 3 }; return null; },
  sal: (r, c) => { const o = r.opp || {}; if (!o.hand || o.hand === '?') return null;
    const bS = o.hand === 'L' ? r.avgVsL : r.avgVsR; if (bS == null) return null;
    if (bS >= .29) return { side: 'O', w: bS * 500 + c.eO * 2 };
    if (bS <= .21) return { side: 'U', w: (300 - bS * 1000) + c.eU * 2 }; return null; },
  parkey: (r, c) => { const pf = r.park?.pf ?? 100;
    if (pf >= 104) return { side: 'O', w: (pf - 100) * 8 + c.eO * 2 };
    if (pf <= 96) return { side: 'U', w: (100 - pf) * 8 + c.eU * 2 }; return null; },
  fadey: (r, c) => { const oO = r.ouOver, uO = r.ouUnder;
    if (oO >= 100 && c.eO >= 3) return { side: 'O', w: oO + c.eO * 10 };
    if (uO >= 100 && c.eU >= 3) return { side: 'U', w: uO + c.eU * 10 }; return null; },
  streaks: (r, c) => {
    if ((r.streak ?? 0) >= 5) return { side: 'O', w: r.streak * 10 + c.eO * 2 };
    if (c.hitRate <= .4 && (r.streak ?? 0) === 0) return { side: 'U', w: (60 - c.hitRate * 100) + c.eU * 2 }; return null; },
  grinder: (r, c) => { if ((r.bvpPA ?? 0) < 12) return null;
    if (r.bvpAvg >= .33) return { side: 'O', w: r.bvpAvg * 300 + c.eO * 2 };
    if (r.bvpAvg <= .18) return { side: 'U', w: (120 - r.bvpAvg * 300) + c.eU * 2 }; return null; },
};
function ouWhy(bid, r, side, c) {
  if (side === 'U') {
    const M = { chalky: () => 'fade: ' + (r.st?.k?.toFixed(1) ?? 'high') + '% K rate',
      gapper: () => 'fade: xBA ' + fmtAvg(r.st?.xba),
      sal: () => { const o = r.opp || {}; const bS = o.hand === 'L' ? r.avgVsL : r.avgVsR; return 'fade: ' + fmtAvg(bS) + ' vs ' + o.hand + 'HP'; },
      parkey: () => 'pitcher park (' + (r.park?.pf ?? 100) + ')',
      fadey: () => 'plus-money under, +' + c.eU.toFixed(1) + '%',
      streaks: () => 'cold: ' + ((c.hitRate * 100) | 0) + '% hit-game rate',
      grinder: () => 'BvP ' + r.bvpH + '-for-' + r.bvpAB,
      mit: () => 'under edge +' + c.eU.toFixed(1) + '%', r5: () => 'composite ' + (r.score ?? '—') + ' (bottom tier)' };
    return (M[bid] || M.mit)();
  }
  return (PICK_WHY[bid] || PICK_WHY.r5)(r);
}

/* -------- ledger helpers (server-side mirror of the dashboard's LEDGER) --- */
function day(core, date) { core.days = core.days || {}; if (!core.days[date]) core.days[date] = { rows: {} }; return core.days[date]; }
function recordBoard(core, date, rows) {
  const d = day(core, date);
  rows.forEach(r => {
    const prev = d.rows[r.id] || {};
    d.rows[r.id] = {
      id: r.id, n: r.name, t: r.team, g: r.game, rk: r.rank, gp: r.gamePk ?? prev.gp ?? null,
      sc: r.score, ep: r.estP != null ? Math.round(r.estP * 10) / 10 : null,
      od: r.dkOdds ?? prev.od ?? null,
      op: r.opp?.name || '',
      picked: prev.picked || false, pickOdds: prev.pickOdds ?? null,
      bot: prev.bot || false, botOdds: prev.botOdds ?? null,
      mit: prev.mit || false, mitOdds: prev.mitOdds ?? null,
      bks: prev.bks || undefined, ou: prev.ou || undefined, why: prev.why || undefined,
      res: prev.res ?? null
    };
  });
}
const hasBook = (core, date, bid) => {
  const d = core.days?.[date]; if (!d) return false;
  if (bid === 'r5') return Object.values(d.rows).some(r => r.bot);
  if (bid === 'mit') return Object.values(d.rows).some(r => r.mit);
  return Object.values(d.rows).some(r => r.bks && r.bks[bid] !== undefined);
};
const hasOU = (core, date, bid) => { const d = core.days?.[date]; return !!d && Object.values(d.rows).some(r => r.ou && r.ou[bid]); };
const holdsHitPick = (core, date, bid, id) => {
  const r = core.days?.[date]?.rows[id]; if (!r) return false;
  return bid === 'r5' ? !!r.bot : bid === 'mit' ? !!r.mit : !!(r.bks && r.bks[bid] !== undefined);
};
const holdsOUOver05 = (core, date, bid, id) => {
  const e = core.days?.[date]?.rows[id]?.ou?.[bid];
  return !!(e && e.side === 'O' && e.line < 1);
};
function setHitPick(core, date, bid, r, why) {
  const d = day(core, date);
  if (!d.rows[r.id]) recordBoard(core, date, [r]);
  const row = d.rows[r.id];
  if (bid === 'r5') { row.bot = true; row.botOdds = r.dkOdds ?? row.od ?? null; }
  else if (bid === 'mit') { row.mit = true; row.mitOdds = r.dkOdds ?? row.od ?? null; }
  else { row.bks = row.bks || {}; row.bks[bid] = r.dkOdds ?? row.od ?? null; }
  if (why) { row.why = row.why || {}; row.why[bid] = why; }
}
function clearHitPick(row, bid) {
  if (bid === 'r5') { row.bot = false; row.botOdds = null; }
  else if (bid === 'mit') { row.mit = false; row.mitOdds = null; }
  else if (row.bks) { delete row.bks[bid]; if (!Object.keys(row.bks).length) delete row.bks; }
  if (row.why) delete row.why[bid];
}
function setOUPick(core, date, bid, r, side, line, odds, why) {
  const d = day(core, date);
  if (!d.rows[r.id]) recordBoard(core, date, [r]);
  const row = d.rows[r.id];
  row.ou = row.ou || {};
  row.ou[bid] = { side, line, odds: odds ?? null, res: null, why: why || null };
}
const wire = (core, who, text) => {
  core.wire = core.wire || [];
  core.wire.push({ t: Date.now(), who, text });
  core.wire = core.wire.slice(-60);
};
const started = r => r.firstPitch && new Date(r.firstPitch).getTime() <= Date.now();

/* -------- card filing --------------------------------------------------- */
function fileCards(core, board, date, flags) {
  const rows = board.rows;
  const priced = rows.some(r => r.dkOdds != null);
  const eligible = r => !flags.has(r.id) && !started(r);

  // BETTER-PRICE RULE — one place, applied to every book after its card files:
  // if a pick's hits O/U Over (same 1+hit outcome, line 0.5) pays MORE than
  // the straight 1+hit market, take the O/U version instead.
  function upgradeToBetterMarket(bid) {
    const d = core.days[date]; if (!d) return;
    Object.values(d.rows).forEach(row => {
      if (!holdsHitPick(core, date, bid, row.id)) return;
      const r = rows.find(x => x.id === row.id); if (!r) return;
      const hitOdds = bid === 'r5' ? row.botOdds : bid === 'mit' ? row.mitOdds : row.bks?.[bid];
      if (r.ouLine != null && r.ouLine < 1 && r.ouOver != null && hitOdds != null && r.ouOver > hitOdds) {
        const oldWhy = row.why?.[bid];
        clearHitPick(row, bid);
        setOUPick(core, date, bid, r, 'O', r.ouLine, r.ouOver,
          'better price than 1+hit (' + fmtOdds(r.ouOver) + ' vs ' + fmtOdds(hitOdds) + ')' + (oldWhy ? ' · ' + oldWhy : ''));
        wire(core, bid, 'swapped ' + r.name + ' to O' + r.ouLine + ' — pays ' + fmtOdds(r.ouOver) + ' vs ' + fmtOdds(hitOdds) + ' on the hit market.');
      }
    });
  }

  // the 7 strategy bots
  for (const bot of BOT_DEFS) {
    if (hasBook(core, date, bot.id)) { upgradeToBetterMarket(bot.id); continue; }
    const scored = rows.filter(r => eligible(r) && !holdsOUOver05(core, date, bot.id, r.id))
      .map(r => ({ r, sc: bot.score(r) })).filter(x => x.sc != null)
      .sort((a, b) => b.sc - a.sc).slice(0, 3);
    if (!scored.length) continue;
    scored.forEach(x => setHitPick(core, date, bot.id, x.r, (PICK_WHY[bot.id] || (() => ''))(x.r)));
    wire(core, bot.id, 'card filed: ' + scored.map(x => x.r.name + ' (' + fmtOdds(x.r.dkOdds) + ')').join(', '));
    log('🤖', bot.name, 'locked:', scored.map(x => x.r.name).join(', '));
    upgradeToBetterMarket(bot.id);
  }
  // Rusty (r5): top 3 composite
  if (!hasBook(core, date, 'r5')) {
    const top = rows.filter(r => r.score != null && eligible(r) && !holdsOUOver05(core, date, 'r5', r.id))
      .sort((a, b) => (b.score - a.score) || ((b.dkOdds != null) - (a.dkOdds != null))).slice(0, 3);
    if (top.length) {
      top.forEach(r => setHitPick(core, date, 'r5', r, PICK_WHY.r5(r)));
      wire(core, 'r5', 'card filed: ' + top.map(r => r.name).join(', '));
      log('🤖 Rusty locked:', top.map(r => r.name).join(', '));
    }
  }
  upgradeToBetterMarket('r5');
  // Mitts: edge-based, only files when the market is priced
  if (!hasBook(core, date, 'mit') && priced) {
    const qual = rows.filter(r => eligible(r) && !holdsOUOver05(core, date, 'mit', r.id))
      .map(r => ({ r, m: mittsEval(r, true, board.hasLineups) }))
      .filter(x => x.m.ok && (x.m.tier === 'playable' || x.m.tier === 'strong'))
      .sort((a, b) => b.m.edge - a.m.edge).slice(0, 3);
    if (qual.length) {
      qual.forEach(x => setHitPick(core, date, 'mit', x.r, PICK_WHY.mit(x.r)));
      wire(core, 'mit', 'card filed: ' + qual.map(x => `${x.r.name} (+${x.m.edge.toFixed(1)}%)`).join(', '));
      log('🤖 Mitts locked:', qual.map(x => x.r.name).join(', '));
    }
  }
  upgradeToBetterMarket('mit');

  // O/U cards — affinity engine (only meaningful with full two-way prices)
  if (priced) {
    for (const [bid, aff] of Object.entries(OU_AFFINITY)) {
      if (hasOU(core, date, bid)) continue;
      const cands = [];
      for (const r of rows) {
        if (!eligible(r)) continue;
        const c = ouContext(r); if (!c) continue;
        const a = aff(r, c); if (!a) continue;
        if (a.side === 'O' && r.ouLine < 1 && holdsHitPick(core, date, bid, r.id)) continue;
        cands.push({ r, side: a.side, line: r.ouLine, odds: a.side === 'O' ? r.ouOver : r.ouUnder, w: a.w, why: ouWhy(bid, r, a.side, c) });
      }
      const overs = cands.filter(x => x.side === 'O').sort((a, b) => b.w - a.w);
      const unders = cands.filter(x => x.side === 'U').sort((a, b) => b.w - a.w);
      let picks = [...overs.slice(0, 2), ...unders.slice(0, 1)];
      if (picks.length < 3) picks = picks.concat((unders.length > 1 ? unders.slice(1) : overs.slice(2)).slice(0, 3 - picks.length));
      picks = picks.slice(0, 3);
      if (picks.length < 3) continue;
      picks.forEach(p => setOUPick(core, date, bid, p.r, p.side, p.line, p.odds, p.why));
      wire(core, bid, 'O/U card: ' + picks.map(p => `${p.r.name} ${p.side}${p.line} (${fmtOdds(p.odds)})`).join(', '));
    }
  }

  // Steam — child of Mitts & Fadey
  generateSteam(core, board, date);
}
function seasonStandingsLite(core) {
  const st = {};
  const bump = (id, kind, res, od) => {
    const o = st[id] || (st[id] = { w: 0, l: 0, ow: 0, ol: 0 });
    if (res === 'win') { kind === 'hit' ? o.w++ : o.ow++; }
    else if (res === 'loss') { kind === 'hit' ? o.l++ : o.ol++; }
  };
  Object.values(core.days || {}).forEach(d => Object.values(d.rows).forEach(r => {
    if (r.bot) bump('r5', 'hit', r.res);
    if (r.mit) bump('mit', 'hit', r.res);
    if (r.bks) Object.keys(r.bks).forEach(b => bump(b, 'hit', r.res));
    if (r.ou) Object.entries(r.ou).forEach(([b, e]) => bump(b, 'ou', e.res));
  }));
  return st;
}
function generateSteam(core, board, date) {
  const d = core.days?.[date]; if (!d) return;
  const ss = seasonStandingsLite(core);
  const pct = (id, kind) => { const o = ss[id]; if (!o) return null; const w = kind === 'hit' ? o.w : o.ow, l = kind === 'hit' ? o.l : o.ol; return (w + l) > 0 ? w / (w + l) : null; };
  const betterOdds = (a, b) => a == null ? b : b == null ? a : Math.max(a, b);
  const pitchOK = id => { const r = board.rows.find(x => x.id == id); return !r || !started(r); };
  if (!hasBook(core, date, 'steam')) {
    const mitP = Object.values(d.rows).filter(r => r.mit && pitchOK(r.id) && !holdsOUOver05(core, date, 'steam', r.id));
    const fadP = Object.values(d.rows).filter(r => r.bks && r.bks.fadey !== undefined && pitchOK(r.id) && !holdsOUOver05(core, date, 'steam', r.id));
    const fadIds = new Set(fadP.map(r => r.id));
    const inter = mitP.filter(r => fadIds.has(r.id));
    const mHot = (pct('mit', 'hit') ?? .5) >= (pct('fadey', 'hit') ?? .5);
    const primary = mHot ? mitP : fadP, hotName = mHot ? 'Mitts' : 'Fadey';
    const chosen = [...inter];
    for (const r of primary) { if (chosen.length >= 3) break; if (!chosen.some(x => x.id === r.id)) chosen.push(r); }
    if (chosen.length) {
      chosen.slice(0, 3).forEach(r => {
        r.bks = r.bks || {}; r.bks.steam = betterOdds(r.mitOdds, r.bks.fadey) ?? r.od ?? null;
        r.why = r.why || {};
        r.why.steam = inter.some(x => x.id === r.id) ? 'both parents converged — sharpest signal' : 'from ' + hotName + ' (better 1+hit win %)';
      });
      wire(core, 'steam', 'hit card: ' + chosen.slice(0, 3).map(r => r.n).join(', '));
    }
  }
  if (!hasOU(core, date, 'steam')) {
    const ent = [];
    Object.values(d.rows).forEach(r => {
      const m = r.ou?.mit, f = r.ou?.fadey;
      if (m && f && m.side === f.side && m.line === f.line) ent.push({ r, e: m, src: 'inter', odds: betterOdds(m.odds, f.odds) });
    });
    const oHot = (pct('mit', 'ou') ?? .5) >= (pct('fadey', 'ou') ?? .5);
    const hotId = oHot ? 'mit' : 'fadey', hotName = oHot ? 'Mitts' : 'Fadey';
    Object.values(d.rows).forEach(r => {
      const e = r.ou?.[hotId];
      if (e && !ent.some(x => x.r.id === r.id)) ent.push({ r, e, src: 'hot', odds: e.odds });
    });
    let placed = 0;
    for (const { r, e, src, odds } of ent) {
      if (placed >= 3) break;
      if (!pitchOK(r.id)) continue;
      if (e.side === 'O' && e.line < 1 && holdsHitPick(core, date, 'steam', r.id)) continue;
      r.ou = r.ou || {};
      r.ou.steam = { side: e.side, line: e.line, odds: odds ?? null, res: null,
        why: src === 'inter' ? 'both parents on the same side' : 'from ' + hotName + ' (better O/U win %)' };
      placed++;
    }
    if (placed) wire(core, 'steam', 'O/U card filed (' + placed + ' plays).');
  }
}

/* -------- pre-pitch revisions -------------------------------------------- */
function reviseCards(core, board, date, flags) {
  const d = core.days?.[date]; if (!d) return;
  const rowsById = Object.fromEntries(board.rows.map(r => [r.id, r]));
  const allBooks = ['r5', 'mit', ...BOT_DEFS.map(b => b.id)];
  for (const bid of allBooks) {
    for (const row of Object.values(d.rows)) {
      if (!holdsHitPick(core, date, bid, row.id)) continue;
      if (row.res != null) continue;
      const r = rowsById[row.id];
      const flagged = flags.has(row.id);
      const scratched = board.hasLineups && r && !r.confirmed;
      if (!flagged && !scratched) continue;
      if (!r || started(r)) continue;                 // frozen after first pitch
      const reason = flagged ? ('news: ' + (flags.get(row.id)?.reason || 'flagged')) : 'missing from the posted lineup';
      clearHitPick(row, bid);
      // find replacement: next-best qualifier for this book
      let repl = null;
      const okRepl = x => !flags.has(x.id) && !started(x) && (!board.hasLineups || x.confirmed) &&
        !holdsHitPick(core, date, bid, x.id) && !holdsOUOver05(core, date, bid, x.id);
      if (bid === 'r5') repl = board.rows.filter(x => x.score != null && okRepl(x)).sort((a, b) => b.score - a.score)[0] || null;
      else if (bid === 'mit') {
        const q = board.rows.filter(okRepl).map(x => ({ x, m: mittsEval(x, true, board.hasLineups) }))
          .filter(y => y.m.ok && (y.m.tier === 'playable' || y.m.tier === 'strong')).sort((a, b) => b.m.edge - a.m.edge)[0];
        repl = q ? q.x : null;
      } else {
        const bot = BOT_DEFS.find(b => b.id === bid);
        const q = board.rows.filter(okRepl).map(x => ({ x, sc: bot.score(x) })).filter(y => y.sc != null).sort((a, b) => b.sc - a.sc)[0];
        repl = q ? q.x : null;
      }
      if (repl) {
        setHitPick(core, date, bid, repl, (PICK_WHY[bid] || (() => ''))(repl));
        wire(core, bid, 'REVISED: out ' + (row.n || row.id) + ' (' + reason + ') → in ' + repl.name + ' (' + fmtOdds(repl.dkOdds) + ').');
        log('revision:', bid, 'out', row.n, '→', repl.name);
      } else {
        wire(core, bid, 'REVISED: pulled ' + (row.n || row.id) + ' (' + reason + ') — no clean replacement, playing short.');
      }
    }
    // drop flagged O/U entries pre-pitch (no forced replacement)
    for (const row of Object.values(d.rows)) {
      const e = row.ou?.[bid]; if (!e || e.res != null) continue;
      const r = rowsById[row.id];
      const flagged = flags.has(row.id) || (board.hasLineups && r && !r.confirmed);
      if (flagged && r && !started(r)) {
        delete row.ou[bid];
        if (!Object.keys(row.ou).length) delete row.ou;
        wire(core, bid, 'REVISED: dropped ' + (row.n || row.id) + ' ' + e.side + e.line + ' — out of the lineup.');
      }
    }
  }
}

/* ============================================================================
   5. THE MUTANTS — 100-strong autonomous colony (spawn, pick, settle, evolve)
   Pick format (array — the dashboard viewer indexes into it):
     [0] 'H' for 1+hit, 'x' otherwise · [1] '' | 'O' | 'U' · [2] line
     [3] odds · [4] '' | 'w' | 'l' | 'p' · [5] why (string)
   ========================================================================== */
const MUT_ADJ = ['Feral', 'Glowing', 'Iron', 'Static', 'Neon', 'Rusted', 'Howling', 'Silent', 'Crimson', 'Vapor', 'Chrome', 'Jagged', 'Molten', 'Frost', 'Grim', 'Lucky', 'Twitchy', 'Patient', 'Greedy', 'Stoic'];
const MUT_NOUN = ['Mantis', 'Cortex', 'Slugger', 'Optic', 'Vulture', 'Prophet', 'Anvil', 'Cicada', 'Warden', 'Drifter', 'Oracle', 'Piston', 'Specter', 'Badger', 'Reactor', 'Nomad', 'Sentry', 'Magpie', 'Golem', 'Hornet'];
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function mkDNA(rand) {
  const w = { form: rand(), pit: rand(), plat: rand(), bvp: rand(), park: rand() * .6, streak: rand() * .6, xba: rand() * .8, kInv: rand() * .8, price: rand() * .5 };
  const s = Object.values(w).reduce((a, b) => a + b, 0);
  Object.keys(w).forEach(k => w[k] = Math.round(w[k] / s * 100) / 100);
  return { w, n: 2 + Math.floor(rand() * 3), ouBias: Math.round(rand() * 100) / 100, fade: rand() < .22, minScore: 40 + Math.floor(rand() * 20) };
}
function dnaDesc(dna) {
  const tops = Object.entries(dna.w).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + ' ' + v);
  return 'Hunts ' + (dna.fade ? 'weak profiles to fade Under' : 'live bats') + ' — ' + tops.join(' · ') + (dna.ouBias > .5 ? ' · leans hits O/U' : '') + '.';
}
function spawnColony() {
  const rand = rng(20260401);
  const roster = {};
  for (let i = 1; i <= 100; i++) {
    const id = 'm' + String(i).padStart(3, '0');
    const name = MUT_ADJ[Math.floor(rand() * MUT_ADJ.length)] + ' ' + MUT_NOUN[Math.floor(rand() * MUT_NOUN.length)] + ' ' + (100 + Math.floor(rand() * 900));
    const dna = mkDNA(rand);
    roster[id] = { id, name, dna, locked: false, mergedFrom: null, absorbed: false,
      rec: { w: 0, l: 0, ow: 0, ol: 0, u: 0, ouU: 0, hist: [] },
      log: [{ t: Date.now(), note: dnaDesc(dna) }] };
  }
  return { mut: { roster, alerts: [{ k: 'admin', t: Date.now(), msg: 'Colony spawned: 100 mutants online, DNA randomized. Evolution begins at first settlement.' }], series: [] }, mdays: {} };
}
/* Migrate a colony inherited from the old dashboard spawner (or any partial data)
   into the shape this runner needs. Records, names, locks and history are kept;
   only missing/incompatible DNA is re-sequenced (seeded from the mutant id so
   it stays stable across runs). */
function normalizeColony(colony) {
  let fixed = 0;
  colony.mut = colony.mut || {};
  colony.mut.roster = colony.mut.roster || {};
  colony.mut.alerts = Array.isArray(colony.mut.alerts) ? colony.mut.alerts : [];
  colony.mut.series = Array.isArray(colony.mut.series) ? colony.mut.series : [];
  colony.mdays = colony.mdays || {};
  const NEED = ['form', 'pit', 'plat', 'bvp', 'park', 'streak', 'xba', 'kInv', 'price'];
  for (const [id, m] of Object.entries(colony.mut.roster)) {
    if (!m || typeof m !== 'object') { delete colony.mut.roster[id]; fixed++; continue; }
    m.id = m.id || id;
    const badDNA = !m.dna || typeof m.dna !== 'object' || !m.dna.w || typeof m.dna.w !== 'object' ||
      !NEED.some(k => typeof m.dna.w[k] === 'number');
    if (badDNA) {
      const seed = [...String(m.id)].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
      m.dna = mkDNA(rng(seed));
      m.log = Array.isArray(m.log) ? m.log : [];
      m.log.push({ t: Date.now(), note: 'DNA re-sequenced on migration. ' + dnaDesc(m.dna) });
      fixed++;
    } else {
      // fill any newly-added knobs with sane defaults
      if (typeof m.dna.n !== 'number') m.dna.n = 3;
      if (typeof m.dna.ouBias !== 'number') m.dna.ouBias = 0.3;
      if (typeof m.dna.fade !== 'boolean') m.dna.fade = false;
      if (typeof m.dna.minScore !== 'number') m.dna.minScore = 45;
    }
    const r0 = m.rec && typeof m.rec === 'object' ? m.rec : {};
    m.rec = { w: r0.w | 0, l: r0.l | 0, ow: r0.ow | 0, ol: r0.ol | 0,
      u: typeof r0.u === 'number' ? r0.u : 0, ouU: typeof r0.ouU === 'number' ? r0.ouU : 0,
      hist: Array.isArray(r0.hist) ? r0.hist : [] };
    m.locked = !!m.locked; m.absorbed = !!m.absorbed;
    if (!Array.isArray(m.log)) m.log = [{ t: Date.now(), note: dnaDesc(m.dna) }];
  }
  if (fixed) {
    colony.mut.alerts.push({ k: 'admin', t: Date.now(), msg: 'Migration: ' + fixed + ' mutant(s) re-sequenced to the new DNA format. Records preserved.' });
    log('colony migration: re-sequenced', fixed, 'legacy mutant(s)');
  }
  return colony;
}
function mutScore(m, r) {
  const w = m?.dna?.w;
  if (!w) return null; // legacy/malformed mutant — normalizeColony() should have fixed it, but never crash
  const feats = {
    form: r.fForm, pit: r.fPit, plat: r.fPlat, bvp: r.fBvp,
    park: scale(r.park?.pf, 94, 112),
    streak: scale(r.streak, 0, 10),
    xba: scale(r.st?.xba, .22, .30),
    kInv: r.st?.k != null ? 100 - scale(r.st.k, 12, 30) : null,
    price: r.dkOdds != null ? scale(r.dkOdds, -260, 140) : null
  };
  let s = 0, wsum = 0;
  for (const [k, v] of Object.entries(feats)) if (v != null && w[k]) { s += v * w[k]; wsum += w[k]; }
  return wsum > 0 ? s / wsum : null;
}
function mutantsFile(colony, core, board, date) {
  colony.mdays = colony.mdays || {};
  const md = colony.mdays[date] || (colony.mdays[date] = { rows: {} });
  if (Object.keys(md.rows).length) return 0; // already filed today
  const priced = board.rows.some(r => r.dkOdds != null);
  if (!priced && !board.hasLineups) return 0; // file once the day's board is priced/lined
  const rand = rng(parseInt(date.replace(/-/g, ''), 10));
  let filed = 0;
  const act = Object.values(colony.mut.roster).filter(m => !m.absorbed);
  for (const m of act) {
    const scored = board.rows.filter(r => !started(r)).map(r => ({ r, s: mutScore(m, r) })).filter(x => x.s != null);
    if (!scored.length) continue;
    scored.sort((a, b) => b.s - a.s);
    const picks = [];
    if (m.dna.fade) {
      // fade mutants take Unders on the weakest profiles with two-way prices
      const weak = scored.slice().reverse().filter(x => x.r.ouLine != null && x.r.ouUnder != null).slice(0, m.dna.n);
      weak.forEach(x => picks.push({ r: x.r, pk: ['x', 'U', x.r.ouLine, x.r.ouUnder, '', 'fade: profile score ' + x.s.toFixed(0)] }));
    } else {
      for (const x of scored) {
        if (picks.length >= m.dna.n) break;
        if (x.s < m.dna.minScore) break;
        const r = x.r;
        const takeOU = r.ouLine != null && r.ouOver != null &&
          (rand() < m.dna.ouBias || (r.ouLine < 1 && r.dkOdds != null && r.ouOver > r.dkOdds)); // better-price rule applies here too
        if (takeOU) picks.push({ r, pk: ['x', 'O', r.ouLine, r.ouOver, '', 'score ' + x.s.toFixed(0) + (r.dkOdds != null && r.ouOver > r.dkOdds ? ' · better O/U price' : '')] });
        else picks.push({ r, pk: ['H', '', 0.5, r.dkOdds ?? null, '', 'score ' + x.s.toFixed(0)] });
      }
    }
    for (const { r, pk } of picks) {
      const row = md.rows[r.id] || (md.rows[r.id] = { n: r.name, t: r.team, op: r.opp?.name || '', od: r.dkOdds ?? null, ouL: r.ouLine ?? null, mk: {} });
      row.mk[m.id] = pk;
      filed++;
    }
  }
  if (filed) {
    colony.mut.alerts.push({ k: 'admin', t: Date.now(), msg: date + ': colony filed — ' + filed + ' picks across ' + Object.keys(md.rows).length + ' hitters (' + act.length + ' mutants active).' });
    log('MUTANTS:', act.length, 'of 100 filed —', filed, 'picks on', Object.keys(md.rows).length, 'hitters');
  }
  return filed;
}
function mutantsSettle(colony, hitsCache) {
  const today = todayISO();
  const roster = colony.mut.roster;
  const dates = Object.keys(colony.mdays || {}).filter(dt => dt < today).sort();
  let settledDays = 0;
  return (async () => {
    for (const dt of dates) {
      const md = colony.mdays[dt];
      const open = Object.values(md.rows).some(row => Object.values(row.mk).some(pk => !pk[4]));
      if (!open) continue;
      const hitsById = hitsCache[dt] || (hitsCache[dt] = await hitsForDate(dt));
      if (Object.keys(hitsById).length < 20) { log('mutants: no results yet for', dt); continue; }
      const dayU = {}; // per-mutant units that day
      for (const [pid, row] of Object.entries(md.rows)) {
        const h = hitsById[pid];
        for (const [mid, pk] of Object.entries(row.mk)) {
          if (pk[4]) continue;
          const m = roster[mid]; if (!m) { pk[4] = 'p'; continue; }
          let res;
          if (h == null) res = 'p';                              // DNP = push
          else if (pk[0] === 'H') res = h >= 1 ? 'w' : 'l';
          else res = (pk[1] === 'O' ? h > pk[2] : h < pk[2]) ? 'w' : 'l';
          pk[4] = res;
          const u = res === 'p' ? 0 : unitsFor(res === 'w' ? 'win' : 'loss', pk[3]);
          if (pk[0] === 'H') { if (res === 'w') m.rec.w++; else if (res === 'l') m.rec.l++; m.rec.u = Math.round((m.rec.u + u) * 100) / 100; }
          else { if (res === 'w') m.rec.ow++; else if (res === 'l') m.rec.ol++; m.rec.ouU = Math.round((m.rec.ouU + u) * 100) / 100; }
          dayU[mid] = (dayU[mid] || 0) + u;
        }
      }
      let colonyDay = 0;
      Object.entries(dayU).forEach(([mid, u]) => {
        const m = roster[mid]; if (!m) return;
        m.rec.hist.push({ d: dt, u: Math.round(u * 100) / 100 });
        m.rec.hist = m.rec.hist.slice(-45);
        colonyDay += u;
      });
      colony.mut.series = colony.mut.series || [];
      if (!colony.mut.series.some(x => x.d === dt))
        colony.mut.series.push({ d: dt, u: Math.round(colonyDay * 100) / 100 });
      settledDays++;
      log('mutants settled', dt, '· colony', (colonyDay >= 0 ? '+' : '') + colonyDay.toFixed(1) + 'u');
      evolveColony(colony, dt);
    }
    // prune old mdays to keep the bin lean (standings live in rec/series):
    // last 7 days kept, and why-strings dropped from anything older than 2 days
    const keep = Object.keys(colony.mdays).sort().slice(-7);
    const pruned = {}; keep.forEach(dt => pruned[dt] = colony.mdays[dt]);
    colony.mdays = pruned;
    Object.keys(colony.mdays).sort().slice(0, -2).forEach(dt =>
      Object.values(colony.mdays[dt].rows || {}).forEach(row =>
        Object.values(row.mk || {}).forEach(pk => { if (pk?.length > 5) pk[5] = ''; })));
    colony.mut.alerts = (colony.mut.alerts || []).slice(-40);
    return settledDays;
  })();
}
function evolveColony(colony, dt) {
  const roster = colony.mut.roster;
  const act = Object.values(roster).filter(m => !m.absorbed);
  const units = m => (m.rec.u || 0) + (m.rec.ouU || 0);
  // hot-streak locks
  for (const m of act) {
    const l5 = m.rec.hist.slice(-5).reduce((s, x) => s + x.u, 0);
    if (!m.locked && m.rec.hist.length >= 5 && l5 >= 4) {
      m.locked = true;
      m.log.push({ t: Date.now(), note: 'LOCKED strategy after +' + l5.toFixed(1) + 'u over 5 settled days. ' + dnaDesc(m.dna) });
      colony.mut.alerts.push({ k: 'lock', t: Date.now(), msg: m.name + ' locked its strategy — +' + l5.toFixed(1) + 'u over the last 5 settled days.' });
    }
  }
  // daily hot alert
  const best = act.map(m => ({ m, u: m.rec.hist.find(h => h.d === dt)?.u ?? 0 })).sort((a, b) => b.u - a.u)[0];
  if (best && best.u >= 2.5)
    colony.mut.alerts.push({ k: 'hot', t: Date.now(), msg: best.m.name + ' ran hot on ' + dt + ': +' + best.u.toFixed(1) + 'u on the day.' });
  // merges: chronic losers get absorbed into fusions with a top performer
  const decided = m => m.rec.w + m.rec.l + m.rec.ow + m.rec.ol;
  const losers = act.filter(m => !m.locked && decided(m) >= 15 && units(m) <= -8).sort((a, b) => units(a) - units(b)).slice(0, 3);
  const tops = act.filter(m => units(m) > 0).sort((a, b) => units(b) - units(a));
  const rand = rng(parseInt(dt.replace(/-/g, ''), 10) ^ 0xBEEF);
  for (const loser of losers) {
    const top = tops[Math.floor(rand() * Math.min(5, tops.length))];
    if (!top) break;
    loser.absorbed = true;
    const nid = 'f' + String(Object.keys(roster).length + 1).padStart(3, '0');
    const w = {}; Object.keys(top.dna.w).forEach(k => w[k] = Math.round(((top.dna.w[k] * .7 + loser.dna.w[k] * .3)) * 100) / 100);
    const dna = { ...top.dna, w, n: Math.max(2, Math.round((top.dna.n + loser.dna.n) / 2)) };
    roster[nid] = { id: nid, name: top.name.split(' ')[0] + '-' + loser.name.split(' ')[1] + ' Fusion', dna,
      locked: false, mergedFrom: [top.id, loser.id], absorbed: false,
      rec: { w: 0, l: 0, ow: 0, ol: 0, u: 0, ouU: 0, hist: [] },
      log: [{ t: Date.now(), note: 'Fused from ' + top.name + ' × ' + loser.name + '. ' + dnaDesc(dna) }] };
    colony.mut.alerts.push({ k: 'merge', t: Date.now(), msg: loser.name + ' (' + units(loser).toFixed(1) + 'u) was absorbed — genome fused with ' + top.name + ' → ' + roster[nid].name + '.' });
    log('🧬 merge:', loser.name, '→', roster[nid].name);
  }
}

/* ============================================================================
   MAIN
   ========================================================================== */
(async () => {
  const t0 = Date.now();
  const date = todayISO();
  log('=== HIT BOARD RUNNER ===', date);

  /* --- load core bin --- */
  let core = await binRead(JSONBIN_BIN);
  if (!core || typeof core !== 'object') core = {};
  core.version = core.version || 1;
  core.days = core.days || {};
  const remoteSnapshot = JSON.parse(JSON.stringify(core.days)); // for merge-safe write later

  /* --- write-permission probe: fail fast (before any real work) if the key can
         read but not update, instead of losing the whole run at the end --- */
  try { await binWrite(JSONBIN_BIN, core); }
  catch (e) { throw new Error('FATAL — jsonbin write test failed at startup. ' + e.message); }

  /* --- load / create colony bin --- */
  let colonyBinId = core.mutBinId || null;
  let colony = null;
  if (colonyBinId) {
    try { colony = await binRead(colonyBinId); } catch (e) { log('colony bin unreadable:', e.message); colony = null; }
  }
  if (!colony || !colony.mut || !colony.mut.roster || !Object.keys(colony.mut.roster).length) {
    log('spawning fresh 100-mutant colony…');
    colony = spawnColony();
    if (!colonyBinId) { colonyBinId = await binCreate('hit-board-colony', colony); core.mutBinId = colonyBinId; log('colony bin created:', colonyBinId); }
  }
  colony.mut.roster = colony.mut.roster || {};
  colony.mut.alerts = colony.mut.alerts || [];
  colony.mut.series = colony.mut.series || [];
  colony.mdays = colony.mdays || {};
  normalizeColony(colony); // migrate any legacy dashboard-format mutants safely

  /* --- 1. settle ledger + mutants (shared results cache) --- */
  const hitsCache = {};
  await settle(core, hitsCache);
  try { await mutantsSettle(colony, hitsCache); }
  catch (e) { log('⚠ mutant settlement failed (colony skipped this run):', e.message); }

  /* --- 2. today's board (full rebuild at most every 3h; cheap refresh otherwise) --- */
  let board = null;
  const meta = core.boardMeta || {};
  const needRebuild = meta.date !== date || !meta.builtAt || (Date.now() - meta.builtAt) > 3 * 3600 * 1000 || !core.boardCache?.rows?.length;
  if (needRebuild) {
    board = await buildBoard(core, date);
    if (board) {
      core.boardMeta = { date, builtAt: Date.now() };
      core.boardCache = { rows: board.rows, hasLineups: board.hasLineups };
    }
  } else {
    board = { rows: core.boardCache.rows, hasLineups: core.boardCache.hasLineups };
    board = await refreshBoardLive(board, date);
    core.boardCache = { rows: board.rows, hasLineups: board.hasLineups };
    log('board refreshed from cache (' + board.rows.length + ' hitters) — lineups:', board.hasLineups ? 'posted' : 'not yet');
  }

  if (board && board.rows.length) {
    /* --- 3. odds --- */
    const oc = await fetchOdds(core, date);
    const matched = applyOddsToBoard(board, oc);
    if (matched) log('odds on board:', matched, 'hitters priced');
    core.boardCache = { rows: board.rows, hasLineups: board.hasLineups };

    /* --- record board into ledger (preserves existing picks/results) --- */
    recordBoard(core, date, board.rows);
    // backfill missing pick odds now that prices exist
    if (oc?.prices) {
      const d = core.days[date];
      Object.values(d.rows).forEach(r => {
        const v = oc.prices[normName(r.n)];
        if (v != null) {
          if (r.od == null) r.od = v;
          if (r.picked && r.pickOdds == null) r.pickOdds = v;
          if (r.bot && r.botOdds == null) r.botOdds = v;
          if (r.mit && r.mitOdds == null) r.mitOdds = v;
          if (r.bks) Object.keys(r.bks).forEach(b => { if (r.bks[b] == null) r.bks[b] = v; });
        }
        const e = oc.ou?.[normName(r.n)];
        if (e && r.ou) Object.values(r.ou).forEach(x => { if (x.odds == null && x.line === e.line) x.odds = x.side === 'O' ? e.over : e.under; });
      });
    }

    /* --- 4. news scan → wire flags --- */
    const flags = await scanNews(board.rows);
    for (const [id, f] of flags) {
      const r = board.rows.find(x => x.id === id);
      const already = (core.wire || []).some(w => Date.now() - w.t < 12 * 3600 * 1000 && w.text.includes(r.name) && w.who === 'wire');
      if (!already) wire(core, 'wire', '⚠ ' + r.name + ' flagged — ' + f.reason + ' [' + f.src + ']');
    }

    /* --- 5. file cards (once prices/lineups exist), then revise --- */
    const filable = board.rows.some(r => r.dkOdds != null) || board.hasLineups;
    if (filable) fileCards(core, board, date, flags);
    else log('cards not filed yet — waiting for prices or posted lineups.');
    reviseCards(core, board, date, flags);

    /* --- 6. mutants file today (isolated — a colony error must never cost the ledger) --- */
    try { mutantsFile(colony, core, board, date); }
    catch (e) { log('⚠ mutant filing failed (colony skipped this run):', e.message); }
  }

  /* --- 7. write colony bin (size-aware — free plan caps bins at ~100KB) --- */
  try {
    // routine hygiene before measuring
    Object.values(colony.mut.roster).forEach(m => { if (m.log?.length > 6) m.log = m.log.slice(-6); });
    colony.mut.alerts = colony.mut.alerts.slice(-40);
    await writeFit(colonyBinId, colony, 'colony', [
      ['prune pick sheets to last 10 days', c => { const ks = Object.keys(c.mdays).sort().slice(0, -10); ks.forEach(k => delete c.mdays[k]); }],
      ['strip why-strings from older pick sheets', c => { const ks = Object.keys(c.mdays).sort().slice(0, -2); ks.forEach(k => Object.values(c.mdays[k].rows || {}).forEach(row => Object.values(row.mk || {}).forEach(pk => { if (pk?.length > 5) pk[5] = ''; }))); }],
      ['prune pick sheets to last 5 days', c => { const ks = Object.keys(c.mdays).sort().slice(0, -5); ks.forEach(k => delete c.mdays[k]); }],
      ['cap mutant logs to last 3 entries', c => Object.values(c.mut.roster).forEach(m => { if (m.log?.length > 3) m.log = m.log.slice(-3); })],
      ['cap alerts to last 20', c => { c.mut.alerts = c.mut.alerts.slice(-20); }],
      ['cap per-mutant history to last 30 days', c => Object.values(c.mut.roster).forEach(m => { if (m.rec?.hist?.length > 30) m.rec.hist = m.rec.hist.slice(-30); })],
      ['strip all remaining why-strings', c => Object.values(c.mdays).forEach(md => Object.values(md.rows || {}).forEach(row => Object.values(row.mk || {}).forEach(pk => { if (pk?.length > 5) pk[5] = ''; })))],
      ['prune pick sheets to last 2 days', c => { const ks = Object.keys(c.mdays).sort().slice(0, -2); ks.forEach(k => delete c.mdays[k]); }],
      ['cap per-mutant history to last 12 days', c => Object.values(c.mut.roster).forEach(m => { if (m.rec?.hist?.length > 12) m.rec.hist = m.rec.hist.slice(-12); })],
      ['cap mutant logs to last entry', c => Object.values(c.mut.roster).forEach(m => { if (m.log?.length > 1) m.log = m.log.slice(-1); })],
      ['keep only today\'s pick sheet', c => { const ks = Object.keys(c.mdays).sort().slice(0, -1); ks.forEach(k => delete c.mdays[k]); }]
    ]);
    // slim mirror on the core bin: enough for the dashboard to render the colony
    // panel instantly; the full colony lives in its own bin behind mutBinId
    core.mut = {
      roster: Object.fromEntries(Object.entries(colony.mut.roster).map(([id, m]) => [id, {
        id, name: m.name, dna: m.dna, locked: m.locked, absorbed: m.absorbed, mergedFrom: m.mergedFrom || null,
        rec: { ...m.rec, hist: (m.rec.hist || []).slice(-10) },
        log: (m.log || []).slice(-1)
      }])),
      alerts: colony.mut.alerts.slice(-15),
      series: colony.mut.series
    };
    core.mdays = (() => { const dts = Object.keys(colony.mdays).sort().slice(-2); const o = {}; dts.forEach(d => o[d] = colony.mdays[d]); return o; })();
  } catch (e) { log('⚠ colony write failed:', e.message); }

  /* --- 8. merge-safe core write: re-read, merge days, preserve everything --- */
  let latest = null;
  try { latest = await binRead(JSONBIN_BIN); } catch (e) { /* write ours */ }
  const localChangedDays = core.days;
  const finalRecord = { ...(latest || {}), ...core };
  finalRecord.days = mergeDays(latest?.days || remoteSnapshot, localChangedDays);
  // the Savant sheet (~1,300 players) is bigger than the whole free-plan bin cap;
  // it's cheap to refetch on each 3h rebuild, so it never gets persisted
  delete finalRecord.statCache;
  await writeFit(JSONBIN_BIN, finalRecord, 'core', [
    ['slim board cache to per-hitter essentials', rec => {
      if (!rec.boardCache?.rows) return;
      const KEEP = ['id', 'name', 'team', 'teamId', 'game', 'opp', 'gamePk', 'firstPitch', 'gameState', 'confirmed', 'order', 'expAB',
        'score', 'rank', 'estP', 'fForm', 'fPit', 'fPlat', 'fBvp', 'bvpConf', 'park', 'streak',
        'l15Avg', 'l15G', 'l15GwAB', 'l15HitG', 'avgVsL', 'avgVsR', 'bvpAB', 'bvpH', 'bvpPA', 'bvpAvg',
        'st', 'dkOdds', 'dkImplied', 'edge', 'ouLine', 'ouOver', 'ouUnder', 'mitEdge', 'mitTag', 'seasonAvg', 'bats', 'pitHand'];
      rec.boardCache.rows = rec.boardCache.rows.map(r => { const o = {}; KEEP.forEach(k => { if (r[k] !== undefined) o[k] = r[k]; }); return o; });
    }],
    ['trim wire to last 80 entries', rec => { if (Array.isArray(rec.wire)) rec.wire = rec.wire.slice(-80); }],
    ['drop colony mirror mdays to 1 day', rec => { const ks = Object.keys(rec.mdays || {}).sort().slice(0, -1); ks.forEach(k => delete rec.mdays[k]); }],
    ['slim colony mirror roster', rec => {
      if (!rec.mut?.roster) return;
      rec.mut.roster = Object.fromEntries(Object.entries(rec.mut.roster).map(([id, m]) => [id,
        { id, name: m.name, locked: m.locked, absorbed: m.absorbed, rec: { w: m.rec?.w | 0, l: m.rec?.l | 0, u: m.rec?.u || 0, ouU: m.rec?.ouU || 0 }, log: (m.log || []).slice(-1) }]));
    }],
    ['trim wire to last 40 entries', rec => { if (Array.isArray(rec.wire)) rec.wire = rec.wire.slice(-40); }],
    ['prune fully-settled ledger days older than 45 days', rec => {
      const cutoff = new Date(Date.now() - 45 * 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const [d, day] of Object.entries(rec.days || {})) {
        if (d >= cutoff) continue;
        const rows = Object.values(day.rows || {});
        if (rows.length && rows.every(r => r.res != null)) delete rec.days[d];
      }
    }]
  ]);

  log('=== done in', ((Date.now() - t0) / 1000).toFixed(0) + 's ===');
})().catch(e => { console.error('RUNNER FATAL:', e.stack || e.message || e); process.exit(1); });
