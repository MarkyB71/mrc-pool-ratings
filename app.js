
/* ============================================================
   RATING ENGINE — pure functions. Ratings are never stored:
   they are rebuilt by replaying every match in date order, so
   editing/deleting a match or changing a rule stays consistent.
   ============================================================ */
const RULES = {
  start: 400, floor: 250,
  kFor(played){ return played <= 10 ? 40 : played <= 25 ? 25 : 15; },
  divisions: [
    {min:700, name:"Elite",        cls:"d-elite"},
    {min:600, name:"Premier",      cls:"d-premier"},
    {min:500, name:"Championship", cls:"d-champ"},
    {min:400, name:"Division One", cls:"d-one"},
    {min:-Infinity, name:"Development", cls:"d-dev"},
  ],
};
const divisionOf = r => RULES.divisions.find(d => r >= d.min);
const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));

function computeLadder(players, matches, settings){
  const mode = settings.kMode === "individual" ? "individual" : "shared";
  const P = new Map();
  for (const p of players){
    const r = Math.max(RULES.floor, Number.isFinite(+p.seedRating) && p.seedRating !== "" && p.seedRating != null ? +p.seedRating : RULES.start);
    P.set(p.id, {id:p.id, name:p.name, active:p.active !== false, seedRating:r, seedMatches:+p.seedMatches||0,
      rating:r, played:+p.seedMatches||0, ratedHere:0, wins:0, losses:0, peak:r, lastChange:null,
      streak:0, bestStreak:0, form:[], h2h:{}, history:[], series:[{i:0, r, date:null}]});
  }
  const ordered = matches.filter(m => P.has(m.winnerId) && P.has(m.loserId) && m.winnerId !== m.loserId)
    .slice().sort((a,b) => (a.date||"").localeCompare(b.date||"") || (a.createdAt||0) - (b.createdAt||0));
  const results = [];
  for (const m of ordered){
    const W = P.get(m.winnerId), L = P.get(m.loserId);
    const eW = expected(W.rating, L.rating);
    const kW = RULES.kFor(W.played), kL = RULES.kFor(L.played);
    let gain, loss;
    if (mode === "shared"){ const k = (kW + kL) / 2; gain = loss = Math.round(k * (1 - eW)); }
    else { gain = Math.round(kW * (1 - eW)); loss = Math.round(kL * (1 - eW)); }
    loss = Math.max(0, Math.min(loss, L.rating - RULES.floor));
    const res = {id:m.id, date:m.date, createdAt:m.createdAt, winnerId:W.id, loserId:L.id,
      wBefore:W.rating, lBefore:L.rating, eW, kW, kL, gain, loss, wAfter:W.rating + gain, lAfter:L.rating - loss};
    results.push(res);
    // winner
    W.rating += gain; W.played++; W.ratedHere++; W.wins++; W.lastChange = gain; W.peak = Math.max(W.peak, W.rating);
    W.streak = W.streak > 0 ? W.streak + 1 : 1; W.bestStreak = Math.max(W.bestStreak, W.streak);
    // loser
    L.rating -= loss; L.played++; L.ratedHere++; L.losses++; L.lastChange = -loss;
    L.streak = L.streak < 0 ? L.streak - 1 : -1;
    for (const [me, op, won, d] of [[W, L, true, gain], [L, W, false, -loss]]){
      const h = me.h2h[op.id] ||= {w:0, l:0, net:0};
      won ? h.w++ : h.l++; h.net += d;
      me.form.push(won ? "W" : "L");
      me.history.push(res);
      me.series.push({i:me.series.length, r:me.rating, date:m.date});
    }
  }
  const list = [...P.values()];
  for (const p of list){ p.winPct = p.ratedHere ? p.wins / p.ratedHere * 100 : null; p.division = divisionOf(p.rating); }
  return {players:P, list, results};
}

/* ============================================================
   DATA — db capability (shared, live). Falls back to an in-page
   example ladder when the store is empty or unavailable.
   ============================================================ */
const state = {db:null, canEdit:false, players:[], matches:[], settings:{kMode:"shared"}, loaded:{p:false,m:false},
  demo:false, ladder:null, tab:"table", divFilter:"All", playerId:null, h2h:[null,null], downloads:null, readOnly:false};

function demoData(){
  const names = ["Cue Ball Carl","Side Pocket Sue","Break-Off Bev","Double Kiss Dev","Long Pot Lou","Safety Sam","Snooker Steph","Rack 'Em Ray","Chalky Chris","Bank Shot Bo"];
  const skill = [760,700,660,640,600,560,520,480,440,400];
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const players = names.map((n,i) => ({id:"demo"+i, name:n, active:true}));
  const matches = []; const day0 = Date.now() - 70*864e5;
  for (let i=0;i<90;i++){
    let a = Math.floor(rnd()*10), b = Math.floor(rnd()*10); if (a===b) b=(b+1)%10;
    const aw = rnd() < expected(skill[a], skill[b]);
    const d = new Date(day0 + Math.floor(i/1.3)*864e5).toISOString().slice(0,10);
    matches.push({id:"dm"+i, winnerId:"demo"+(aw?a:b), loserId:"demo"+(aw?b:a), date:d, createdAt:i});
  }
  return {players, matches};
}

function rebuild(){
  const empty = !state.players.length;
  state.demo = empty;
  const src = empty ? demoData() : {players:state.players, matches:state.matches};
  state.ladder = computeLadder(src.players, src.matches, state.settings);
  render();
}

/* Server store: api.php keeps one JSON file. Everyone reads; changes need the admin PIN. */
let PIN = null;
try { PIN = sessionStorage.getItem("mrc-pin"); } catch {}
state.hasPin = true; state.loaded = {p:false, m:false};

function applyData(d){
  state.players = d.players || []; state.matches = d.matches || [];
  state.settings = Object.assign({kMode:"shared"}, d.settings || {});
  state.hasPin = !!d.hasPin; state.rev = d.rev; state.loaded = {p:true, m:true};
  rebuild();
}
async function load(){
  try {
    const r = await fetch("api.php", {cache:"no-store"});
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    if (d.rev !== state.rev || d.hasPin !== state.hasPin) applyData(d);
  } catch(e){ if (!state.loaded.p) toast("Couldn't reach the server. Showing example data."); }
}
async function api(action, payload={}){
  const r = await fetch("api.php", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action, pin:PIN, ...payload})});
  let d = {}; try { d = await r.json(); } catch {}
  if (r.status === 401){ lock(); throw {message:"Your admin PIN was not accepted. Unlock again."}; }
  if (!r.ok) throw {message: d.error || ("Server error " + r.status)};
  if (d.data) applyData(d.data);
  return d;
}
function lock(){ PIN = null; try { sessionStorage.removeItem("mrc-pin"); } catch {} state.canEdit = false; applyRole(); }

async function boot(){
  rebuild();
  state.db = true;
  state.canEdit = !!PIN; applyRole();
  await load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
}

function applyRole(){
  document.querySelectorAll("[data-admin]").forEach(el => el.hidden = !state.canEdit);
  $("unlockBtn").textContent = state.canEdit ? "Lock admin" : "Admin login";
  if (!state.canEdit && (state.tab === "enter" || state.tab === "admin")) setTab("table");
  render();
}
function writeFailed(e){ toast("Couldn't save. " + (e?.message || "Try again.")); }

/* ============================================================
   RENDERING
   ============================================================ */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nameOf = id => state.ladder.players.get(id)?.name ?? "Unknown";
const fmtDate = d => d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", {day:"numeric", month:"short", year:"2-digit"}) : "—";
const signed = n => n == null ? "—" : (n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0");
const chg = n => `<span class="num ${n>0?"up":n<0?"down":"muted"}">${signed(n)}</span>`;
const divChip = d => `<span class="div ${d.cls}">${d.name}</span>`;
const pbtn = id => `<button class="pname" data-player="${esc(id)}">${esc(nameOf(id))}</button>`;
const today = () => new Date().toLocaleDateString("en-CA");
const ranked = () => state.ladder.list.filter(p => p.active).sort((a,b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
const alpha = () => state.ladder.list.slice().sort((a,b) => a.name.localeCompare(b.name));

function render(){
  if (!state.ladder) return;
  $("demoBanner").hidden = !state.demo || !state.loaded.p;
  const n = state.ladder.results.length, act = state.ladder.list.filter(p=>p.active).length;
  $("sub").textContent = `${act} player${act===1?"":"s"} · ${n} rated match${n===1?"":"es"}${state.demo?" · example data":""}`;
  renderTable(); renderEnter(); renderResults(); renderPlayer(); renderH2H(); renderStats(); renderAdmin();
}

function renderTable(){
  const segs = ["All", ...RULES.divisions.map(d=>d.name)];
  $("divFilter").innerHTML = segs.map(s => `<button data-div="${s}" aria-pressed="${s===state.divFilter}">${s==="Division One"?"Div One":s==="Championship"?"Champ":s}</button>`).join("");
  const rows = ranked();
  const shown = rows.filter(p => state.divFilter === "All" || p.division.name === state.divFilter);
  $("tableBody").innerHTML = shown.length ? shown.map(p => {
    const rank = rows.indexOf(p) + 1;
    return `<tr class="${rank===1?"top1":""}"><td class="rank">${rank}</td><td>${pbtn(p.id)}</td>
      <td class="r rating">${p.rating}</td><td class="r">${chg(p.lastChange)}</td>
      <td class="r num">${p.ratedHere}</td><td class="r num">${p.wins}</td><td class="r num">${p.losses}</td>
      <td class="r num">${p.winPct==null?"—":p.winPct.toFixed(0)+"%"}</td><td>${divChip(p.division)}</td>
      <td class="r">${p.form.slice(-5).map(f=>`<span class="result ${f==="W"?"w":"l"}">${f}</span>`).join(" ")||'<span class="muted small">—</span>'}</td></tr>`;
  }).join("") : `<tr><td colspan="10" class="empty">${rows.length ? "No players in this division." : "No players yet."}</td></tr>`;
  $("tableNote").textContent = "Last = rating change in the player's most recent match. Form = last five results, oldest first.";
}

function fillSelect(sel, list, value, blank){
  const opts = (blank ? `<option value="">${blank}</option>` : "") + list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.active?"":" (inactive)"}</option>`).join("");
  if (sel.dataset.sig !== opts){ sel.innerHTML = opts; sel.dataset.sig = opts; }
  sel.value = value ?? "";
}

function matchRow(r, opts={}){
  const del = opts.del && state.canEdit && !state.demo;
  const persp = opts.player;
  let left, who, right;
  if (persp){
    const won = r.winnerId === persp, op = won ? r.loserId : r.winnerId;
    const before = won ? r.wBefore : r.lBefore, after = won ? r.wAfter : r.lAfter;
    left = `<span class="date">${fmtDate(r.date)}</span>`;
    who = `<span class="result ${won?"w":"l"}">${won?"W":"L"}</span> vs ${pbtn(op)} <span class="small muted num">(${won?r.lBefore:r.wBefore})</span>`;
    right = `<span class="chg"><span class="num muted">${before}→${after}</span> ${chg(won?r.gain:-r.loss)}</span>`;
  } else {
    left = `<span class="date">${fmtDate(r.date)}</span>`;
    who = `<span>${pbtn(r.winnerId)} <span class="muted small">beat</span> ${pbtn(r.loserId)}</span>`;
    right = `<span class="chg">${chg(r.gain)} / ${chg(-r.loss)}${del?` <button class="btn link" data-del="${esc(r.id)}">Delete</button>`:""}</span>`;
  }
  return `<div class="mrow" data-row="${esc(r.id)}">${left}<span class="who">${who}</span>${right}</div>`;
}

function renderEnter(){
  const list = alpha().filter(p => p.active);
  const w = $("eWinner").value, l = $("eLoser").value;
  fillSelect($("eWinner"), list, list.some(p=>p.id===w)?w:"", "Choose winner…");
  fillSelect($("eLoser"), list, list.some(p=>p.id===l)?l:"", "Choose loser…");
  if (!$("eDate").value) $("eDate").value = today();
  updatePreview();
  const recent = state.ladder.results.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,8);
  $("eRecent").innerHTML = recent.length ? recent.map(r => matchRow(r,{del:true})).join("") : `<div class="empty">No results yet.</div>`;
}

function previewFor(wId, lId){
  const W = state.ladder.players.get(wId), L = state.ladder.players.get(lId);
  const eW = expected(W.rating, L.rating), kW = RULES.kFor(W.played), kL = RULES.kFor(L.played);
  let gain, loss;
  if (state.settings.kMode === "individual"){ gain = Math.round(kW*(1-eW)); loss = Math.round(kL*(1-eW)); }
  else { gain = loss = Math.round((kW+kL)/2*(1-eW)); }
  loss = Math.max(0, Math.min(loss, L.rating - RULES.floor));
  return {W, L, eW, kW, kL, gain, loss};
}

function updatePreview(){
  const w = $("eWinner").value, l = $("eLoser").value;
  const ok = w && l && w !== l && !state.demo;
  $("eSave").disabled = !ok;
  $("eErr").textContent = w && l && w === l ? "Winner and loser must be different players." : state.demo ? "Add real players in Admin before entering results." : "";
  if (!(w && l && w !== l)){ $("ePreview").innerHTML = `<div class="preview"><div class="side muted small" style="grid-column:1/-1">Choose both players to see the expected score and rating change before saving.</div></div>`; return; }
  const x = previewFor(w, l);
  $("ePreview").innerHTML = `<div class="preview">
    <div class="side"><span class="small muted">Winner · K ${x.kW}</span><b>${esc(x.W.name)}</b><span class="big num">${x.W.rating} → ${x.W.rating + x.gain}</span><span>${chg(x.gain)} · expected ${(x.eW*100).toFixed(0)}%</span></div>
    <div class="vs">VS</div>
    <div class="side right"><span class="small muted">Loser · K ${x.kL}</span><b>${esc(x.L.name)}</b><span class="big num">${x.L.rating} → ${x.L.rating - x.loss}</span><span>${chg(-x.loss)} · expected ${((1-x.eW)*100).toFixed(0)}%</span></div>
    <div class="bar" title="Expected score"><i style="width:${(x.eW*100).toFixed(1)}%"></i></div>
  </div>`;
}

function renderResults(){
  const v = $("rFilter").value;
  fillSelect($("rFilter"), alpha(), state.ladder.players.has(v)?v:"", "All players");
  const f = $("rFilter").value;
  const list = state.ladder.results.filter(r => !f || r.winnerId===f || r.loserId===f).reverse();
  $("rList").innerHTML = list.length ? list.map(r => matchRow(r,{del:true})).join("") : `<div class="empty">No results yet.</div>`;
}

function chartSVG(p){
  const pts = p.series; const W = 720, H = 260, padL = 44, padR = 96, padT = 12, padB = 26;
  const rs = pts.map(s=>s.r);
  let lo = Math.min(...rs), hi = Math.max(...rs);
  lo = Math.max(RULES.floor - 10, Math.floor((lo - 40)/50)*50); hi = Math.ceil((hi + 40)/50)*50;
  const x = i => padL + (pts.length<=1 ? 0 : i/(pts.length-1)) * (W-padL-padR);
  const y = r => padT + (1 - (r-lo)/(hi-lo)) * (H-padT-padB);
  let g = "";
  // division bands
  const bounds = [[700,Infinity,"d-elite","Elite"],[600,700,"d-premier","Premier"],[500,600,"d-champ","Championship"],[400,500,"d-one","Division One"],[250,400,"d-dev","Development"]];
  for (const [a,b,cls,name] of bounds){
    const top = Math.min(hi, b), bot = Math.max(lo, a); if (top <= bot) continue;
    g += `<rect style="fill:var(--c)" x="${padL}" y="${y(top)}" width="${W-padL-padR}" height="${y(bot)-y(top)}" opacity=".07" class="${cls}"/>`;
    g += `<text style="fill:var(--muted);font-family:var(--font-body)" x="${W-padR+8}" y="${(y(top)+y(bot))/2+4}" font-size="11">${name}</text>`;
  }
  for (let t = Math.ceil(lo/50)*50; t <= hi; t += 50){
    g += `<line style="stroke:var(--line)" x1="${padL}" x2="${W-padR}" y1="${y(t)}" y2="${y(t)}" stroke-width="1"/>`;
    g += `<text style="fill:var(--muted);font-family:var(--font-num)" x="${padL-8}" y="${y(t)+4}" font-size="11" text-anchor="end">${t}</text>`;
  }
  if (pts.length > 1){
    const d = pts.map((s,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(s.r).toFixed(1)}`).join("");
    g += `<path style="fill:var(--baize)" d="${d}L${x(pts.length-1)},${H-padB}L${x(0)},${H-padB}Z" opacity=".10"/>`;
    g += `<path style="stroke:var(--baize)" d="${d}" fill="none" stroke-width="2.25" stroke-linejoin="round"/>`;
    const peakI = rs.indexOf(Math.max(...rs));
    g += `<circle style="fill:var(--surface);stroke:var(--chalk)" cx="${x(peakI)}" cy="${y(rs[peakI])}" r="4" stroke-width="2"><title>Peak ${rs[peakI]}</title></circle>`;
  }
  const last = pts.length-1;
  g += `<circle style="fill:var(--baize)" cx="${x(last)}" cy="${y(rs[last])}" r="5"/>`;
  g += `<text style="fill:var(--muted);font-family:var(--font-body)" x="${padL}" y="${H-6}" font-size="11">Start</text>`;
  g += `<text style="fill:var(--muted);font-family:var(--font-body)" x="${W-padR}" y="${H-6}" font-size="11" text-anchor="end">Match ${last}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating of ${esc(p.name)} after each match">${g}</svg>`;
}

function renderPlayer(){
  const all = alpha(); if (!all.length) return;
  if (!state.ladder.players.has(state.playerId)) state.playerId = ranked()[0]?.id ?? all[0].id;
  fillSelect($("ppSelect"), all, state.playerId);
  const p = state.ladder.players.get(state.playerId);
  const rank = ranked().indexOf(p) + 1;
  $("ppName").textContent = p.name;
  const streak = p.streak > 0 ? `${p.streak} win${p.streak>1?"s":""}` : p.streak < 0 ? `${-p.streak} loss${p.streak<-1?"es":""}` : "—";
  $("ppTiles").innerHTML = [
    ["Rating", p.rating, rank ? `Rank ${rank} · ${divChip(p.division)}` : divChip(p.division)],
    ["Record", `${p.wins}–${p.losses}`, p.winPct==null ? "No matches yet" : `${p.winPct.toFixed(0)}% won · ${p.ratedHere} played`],
    ["Highest rating", p.peak, `Started at ${p.seedRating}`],
    ["Current streak", streak, `Best winning run: ${p.bestStreak}`],
    ["K-factor now", RULES.kFor(p.played), `${p.played} rated matches counted`],
  ].map(([k,v,s]) => `<div class="tile"><span class="k">${k}</span><span class="v num">${v}</span><span class="s">${s}</span></div>`).join("");
  $("ppChart").innerHTML = chartSVG(p);
  $("ppHistory").innerHTML = p.history.length ? p.history.slice().reverse().map(r => matchRow(r,{player:p.id})).join("") : `<div class="empty">No matches yet.</div>`;
  const h = Object.entries(p.h2h).sort((a,b)=> (b[1].w+b[1].l)-(a[1].w+a[1].l));
  $("ppH2H").innerHTML = h.length ? h.map(([id,v]) => `<tr><td>${pbtn(id)}</td><td class="r num">${v.w}</td><td class="r num">${v.l}</td><td class="r">${chg(v.net)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty">No opponents yet.</td></tr>`;
}

function renderH2H(){
  const all = alpha(); if (all.length < 2) { $("hOut").innerHTML = `<div class="card empty">Needs at least two players.</div>`; return; }
  let [a,b] = state.h2h;
  if (!state.ladder.players.has(a)) a = ranked()[0]?.id ?? all[0].id;
  if (!state.ladder.players.has(b) || b === a) b = (ranked()[1] ?? all.find(p=>p.id!==a)).id;
  state.h2h = [a,b];
  fillSelect($("hA"), all, a); fillSelect($("hB"), all, b);
  const A = state.ladder.players.get(a), B = state.ladder.players.get(b);
  if (a === b){ $("hOut").innerHTML = `<div class="card empty">Pick two different players.</div>`; return; }
  const rec = A.h2h[b] || {w:0,l:0,net:0};
  const games = state.ladder.results.filter(r => (r.winnerId===a&&r.loserId===b)||(r.winnerId===b&&r.loserId===a)).reverse();
  const eA = expected(A.rating, B.rating);
  $("hOut").innerHTML = `
    <div class="card"><div class="preview" style="background:none;padding:0">
      <div class="side"><b>${esc(A.name)}</b><span class="big num">${rec.w}</span><span class="small muted">wins · rating ${A.rating}</span></div>
      <div class="vs">VS</div>
      <div class="side right"><b>${esc(B.name)}</b><span class="big num">${rec.l}</span><span class="small muted">wins · rating ${B.rating}</span></div>
      <div class="bar"><i style="width:${(eA*100).toFixed(1)}%"></i></div>
      <div class="small muted" style="grid-column:1/-1">If they play today: ${esc(A.name)} expected ${(eA*100).toFixed(0)}%, ${esc(B.name)} ${((1-eA)*100).toFixed(0)}%. Net rating points swapped so far: ${esc(A.name)} ${signed(rec.net)}.</div>
    </div></div>
    <div class="card"><h3 style="margin-bottom:6px">Meetings</h3><div class="mlist">${games.length ? games.map(r=>matchRow(r)).join("") : `<div class="empty">These two haven't played a rated match yet.</div>`}</div></div>`;
}

function renderStats(){
  const L = state.ladder, act = L.list.filter(p=>p.active);
  const top = ranked()[0];
  const peak = L.list.reduce((m,p)=>!m||p.peak>m.peak?p:m, null);
  const bigGain = L.results.reduce((m,r)=>!m||r.gain>m.gain?r:m, null);
  const streak = L.list.reduce((m,p)=>!m||p.bestStreak>m.bestStreak?p:m, null);
  const most = L.list.reduce((m,p)=>!m||p.ratedHere>m.ratedHere?p:m, null);
  const improved = L.list.filter(p=>p.ratedHere).reduce((m,p)=>!m||(p.rating-p.seedRating)>(m.rating-m.seedRating)?p:m, null);
  const t = (k,v,s) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
  $("sTiles").innerHTML = [
    top ? t("Highest-rated player", esc(top.name), `<span class="num">${top.rating}</span> · ${divChip(top.division)}`) : "",
    peak ? t("Highest rating ever", `<span class="num">${peak.peak}</span>`, esc(peak.name)) : "",
    bigGain ? t("Biggest single gain", `<span class="num up">+${bigGain.gain}</span>`, `${esc(nameOf(bigGain.winnerId))} beat ${esc(nameOf(bigGain.loserId))}, ${fmtDate(bigGain.date)}`) : "",
    streak ? t("Longest winning streak", `<span class="num">${streak.bestStreak}</span>`, esc(streak.name)) : "",
    most ? t("Most matches played", `<span class="num">${most.ratedHere}</span>`, esc(most.name)) : "",
    improved ? t("Most improved", `<span class="num up">${signed(improved.rating-improved.seedRating)}</span>`, `${esc(improved.name)} since joining`) : "",
  ].join("") || `<div class="empty">Stats appear after the first result.</div>`;
  const maxN = Math.max(1, ...RULES.divisions.map(d => act.filter(p=>p.division.name===d.name).length));
  $("sDivs").innerHTML = RULES.divisions.map(d => {
    const n = act.filter(p=>p.division.name===d.name).length;
    const range = d.min === -Infinity ? "250–399" : d.min === 700 ? "700+" : `${d.min}–${d.min+99}`;
    return `<div style="display:grid;grid-template-columns:minmax(0,9.5em) 1fr 2.5em;gap:10px;align-items:center;padding:5px 0">
      <span>${divChip(d)}</span><span style="background:var(--sunken);border-radius:4px;height:14px;overflow:hidden" title="${range}"><i class="${d.cls}" style="display:block;height:100%;width:${n/maxN*100}%;background:var(--c);opacity:.75"></i></span><span class="num r" style="text-align:right">${n}</span></div>`;
  }).join("") + `<p class="small muted" style="margin:8px 0 0">Elite 700+ · Premier 600–699 · Championship 500–599 · Division One 400–499 · Development 250–399</p>`;
  const ups = L.results.filter(r=>r.eW<0.5).sort((a,b)=>a.eW-b.eW).slice(0,5);
  $("sUpsets").innerHTML = ups.length ? ups.map(r => `<div class="mrow"><span class="date">${fmtDate(r.date)}</span><span class="who">${pbtn(r.winnerId)} <span class="muted small">beat</span> ${pbtn(r.loserId)}</span><span class="chg small">${(r.eW*100).toFixed(0)}% chance · ${chg(r.gain)}</span></div>`).join("") : `<div class="empty">No upsets yet.</div>`;
}

function renderAdmin(){
  document.querySelectorAll("#kMode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.k === (state.settings.kMode||"shared"))));
  $("kModeNote").textContent = (state.settings.kMode === "individual")
    ? "Each player moves by their own K. A new player beating a veteran gains more than the veteran loses."
    : "Both players use the average of their two K values, so the winner gains exactly what the loser loses (unless the loser hits the 250 floor).";
  if (state.demo){ $("aPlayers").innerHTML = `<tr><td colspan="5" class="empty">No players yet. Add your first player above.</td></tr>`; return; }
  $("aPlayers").innerHTML = alpha().map(p => `<tr data-pid="${esc(p.id)}"><td>${pbtn(p.id)}</td><td class="r num">${p.seedRating}</td><td class="r num">${p.ratedHere}</td>
    <td>${p.active?'<span class="small up">Active</span>':'<span class="small muted">Inactive · hidden from table</span>'}</td>
    <td class="r"><button class="btn link" data-rename="${esc(p.id)}">Rename</button><button class="btn link" data-toggle="${esc(p.id)}">${p.active?"Make inactive":"Reactivate"}</button>${p.ratedHere?"":`<button class="btn link" data-remove="${esc(p.id)}" style="color:var(--loss)">Remove</button>`}</td></tr>`).join("");
}

/* ============================================================
   ACTIONS
   ============================================================ */
let toastT;
function toast(msg){ const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(()=>t.hidden=true, 4200); }

function setTab(tab){
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab===tab)));
  document.querySelectorAll("section.panel").forEach(s => s.hidden = s.id !== "p-"+tab);
  try { localStorage.setItem("mrc-tab", tab); } catch {}
  window.scrollTo({top:0});
}
$("tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
$("demoStart").addEventListener("click", () => { setTab("admin"); $("aName").focus(); });

document.addEventListener("click", async e => {
  const pb = e.target.closest("[data-player]");
  if (pb){ state.playerId = pb.dataset.player; setTab("player"); renderPlayer(); return; }
  const df = e.target.closest("[data-div]");
  if (df){ state.divFilter = df.dataset.div; renderTable(); return; }
  const del = e.target.closest("[data-del]");
  if (del){
    if (del.dataset.armed){ try { await api("deleteMatch", {id:del.dataset.del}); toast("Result deleted. Ratings recalculated."); } catch(err){ writeFailed(err); } return; }
    del.dataset.armed = "1"; del.textContent = "Confirm delete"; del.style.color = "var(--loss)";
    setTimeout(()=>{ if (del.isConnected){ delete del.dataset.armed; del.textContent = "Delete"; del.style.color = ""; } }, 4000); return;
  }
  const tg = e.target.closest("[data-toggle]");
  if (tg){ const p = state.players.find(x=>x.id===tg.dataset.toggle); try { await api("updatePlayer", {id:p.id, active: p.active===false}); } catch(err){ writeFailed(err); } return; }
  const rm = e.target.closest("[data-remove]");
  if (rm){
    if (rm.dataset.armed){ try { await api("removePlayer", {id:rm.dataset.remove}); toast("Player removed."); } catch(err){ writeFailed(err); } return; }
    rm.dataset.armed = "1"; rm.textContent = "Confirm remove"; setTimeout(()=>{ if (rm.isConnected){ delete rm.dataset.armed; rm.textContent = "Remove"; } }, 4000); return;
  }
  const rn = e.target.closest("[data-rename]");
  if (rn){
    const tr = rn.closest("tr"), p = state.players.find(x=>x.id===rn.dataset.rename);
    tr.cells[0].innerHTML = `<input type="text" id="rn-${esc(p.id)}" value="${esc(p.name)}" style="width:100%">`;
    rn.outerHTML = `<button class="btn link" data-rnsave="${esc(p.id)}">Save name</button>`;
    tr.querySelector("input").focus(); return;
  }
  const rs = e.target.closest("[data-rnsave]");
  if (rs){
    const v = $("rn-"+rs.dataset.rnsave).value.trim();
    if (!v) return toast("Name can't be empty.");
    if (state.players.some(p => p.id !== rs.dataset.rnsave && p.name.toLowerCase() === v.toLowerCase())) return toast("Another player already has that name.");
    try { await api("updatePlayer", {id:rs.dataset.rnsave, name:v}); toast("Renamed."); } catch(err){ writeFailed(err); }
  }
});

$("eWinner").addEventListener("change", updatePreview);
$("eLoser").addEventListener("change", updatePreview);
$("eSwap").addEventListener("click", () => { const w = $("eWinner").value; $("eWinner").value = $("eLoser").value; $("eLoser").value = w; updatePreview(); });
$("eSave").addEventListener("click", async () => {
  const w = $("eWinner").value, l = $("eLoser").value, d = $("eDate").value || today();
  if (!w || !l || w === l || !state.db) return;
  const x = previewFor(w, l);
  $("eSave").disabled = true;
  try {
    await api("addMatches", {matches:[{winnerId:w, loserId:l, date:d}]});
    toast(`Saved. ${x.W.name} ${signed(x.gain)} (${x.W.rating + x.gain}), ${x.L.name} ${signed(-x.loss)} (${x.L.rating - x.loss}).`);
    $("eWinner").value = ""; $("eLoser").value = ""; updatePreview();
  } catch(err){ writeFailed(err); $("eSave").disabled = false; }
});

$("rFilter").addEventListener("change", renderResults);
$("ppSelect").addEventListener("change", e => { state.playerId = e.target.value; renderPlayer(); });
$("hA").addEventListener("change", e => { state.h2h[0] = e.target.value; renderH2H(); });
$("hB").addEventListener("change", e => { state.h2h[1] = e.target.value; renderH2H(); });

async function addPlayer(name, seedRating, seedMatches){
  const d = await api("addPlayer", {name, seedRating, seedMatches});
  return d.id;
}
$("aAdd").addEventListener("click", async () => {
  const name = $("aName").value.trim().replace(/\s+/g," ");
  $("aErr").textContent = "";
  if (!name) return $("aErr").textContent = "Enter a name.";
  if (!state.db) return $("aErr").textContent = "Saving isn't available in this view.";
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return $("aErr").textContent = "That player is already on the list.";
  const sr = $("aSeedR").value === "" ? null : +$("aSeedR").value, sm = $("aSeedM").value === "" ? 0 : Math.max(0, Math.floor(+$("aSeedM").value));
  try { await addPlayer(name, sr, sm); $("aName").value = ""; $("aSeedR").value = ""; $("aSeedM").value = ""; toast(`${name} added at ${sr ?? RULES.start}.`); $("aName").focus(); }
  catch(err){ writeFailed(err); }
});
$("aName").addEventListener("keydown", e => { if (e.key === "Enter") $("aAdd").click(); });

$("kMode").addEventListener("click", async e => {
  const b = e.target.closest("button[data-k]"); if (!b || !state.db) return;
  try { await api("setSettings", {kMode:b.dataset.k}); toast("Rule changed. All ratings recalculated."); } catch(err){ writeFailed(err); }
});

$("bGo").addEventListener("click", async () => {
  const msg = $("bMsg"); msg.className = "small"; msg.textContent = "";
  if (!state.db) return msg.textContent = "Saving isn't available in this view.";
  const lines = $("bText").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (!lines.length) return msg.textContent = "Paste at least one line.";
  const byName = new Map(state.players.map(p => [p.name.toLowerCase(), p.id]));
  const parsed = [], bad = [], unknown = new Set();
  lines.forEach((ln,i) => {
    const parts = ln.split(/[,\t]/).map(s=>s.trim());
    const [w,l,d] = parts;
    if (!w || !l || w.toLowerCase() === l.toLowerCase()) return bad.push(i+1);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return bad.push(i+1);
    [w,l].forEach(n => { if (!byName.has(n.toLowerCase())) unknown.add(n); });
    parsed.push({w,l,d:d||today(),i});
  });
  if (bad.length){ msg.className = "err"; return msg.textContent = `Check line${bad.length>1?"s":""} ${bad.join(", ")}: needs Winner, Loser and an optional YYYY-MM-DD date.`; }
  if (unknown.size && !$("bCreate").checked){ msg.className = "err"; return msg.textContent = `Not on the player list: ${[...unknown].join(", ")}. Tick the box to add them.`; }
  $("bGo").disabled = true;
  try {
    for (const n of unknown){ msg.textContent = `Adding ${n}…`; byName.set(n.toLowerCase(), await addPlayer(n, null, 0)); }
    msg.textContent = `Saving ${parsed.length} results…`;
    await api("addMatches", {matches: parsed.map(r => ({winnerId:byName.get(r.w.toLowerCase()), loserId:byName.get(r.l.toLowerCase()), date:r.d}))});
    msg.className = "small up"; msg.textContent = `Imported ${parsed.length} result${parsed.length>1?"s":""}.`; $("bText").value = "";
  } catch(err){ writeFailed(err); msg.textContent = ""; }
  $("bGo").disabled = false;
});

const csvCell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
async function saveCSV(filename, rows){
  const msg = $("xMsg"); msg.className = "small";
  const data = rows.map(r => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + data], {type:"text/csv;charset=utf-8"}));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000); msg.textContent = `${filename} downloaded.`;
}
$("xTable").addEventListener("click", () => saveCSV(`mrc-league-table-${today()}.csv`, [
  ["Rank","Player","Rating","Last change","Played","Wins","Losses","Win %","Division","Highest rating","Best win streak"],
  ...ranked().map((p,i) => [i+1, p.name, p.rating, p.lastChange ?? "", p.ratedHere, p.wins, p.losses, p.winPct==null?"":p.winPct.toFixed(1), p.division.name, p.peak, p.bestStreak])]));
$("xMatches").addEventListener("click", () => saveCSV(`mrc-results-${today()}.csv`, [
  ["Date","Winner","Loser","Winner before","Loser before","Winner expected","Winner K","Loser K","Points won","Points lost","Winner after","Loser after"],
  ...state.ladder.results.map(r => [r.date, nameOf(r.winnerId), nameOf(r.loserId), r.wBefore, r.lBefore, r.eW.toFixed(3), r.kW, r.kL, r.gain, r.loss, r.wAfter, r.lAfter])]));

$("unlockBtn").addEventListener("click", () => {
  if (state.canEdit){ lock(); toast("Admin locked."); return; }
  const pnl = $("pinPanel"); pnl.hidden = !pnl.hidden;
  $("pinTitle").textContent = state.hasPin ? "Enter the admin PIN" : "Create an admin PIN (4–12 digits)";
  $("pinErr").textContent = ""; if (!pnl.hidden) $("pinInput").focus();
});
async function submitPin(){
  const v = $("pinInput").value.trim(); $("pinErr").textContent = "";
  if (!/^\d{4,12}$/.test(v)) { $("pinErr").textContent = "Use 4 to 12 digits."; return; }
  try {
    PIN = v;
    if (!state.hasPin){ await api("setPin"); state.hasPin = true; }
    await api("checkPin");
    try { sessionStorage.setItem("mrc-pin", v); } catch {}
    state.canEdit = true; $("pinPanel").hidden = true; $("pinInput").value = ""; applyRole(); toast("Admin unlocked.");
  } catch(e){ PIN = null; $("pinErr").textContent = e.message || "Couldn't unlock."; }
}
$("pinGo").addEventListener("click", submitPin);
$("pinInput").addEventListener("keydown", e => { if (e.key === "Enter") submitPin(); });

try { const t = localStorage.getItem("mrc-tab"); if (t && t !== "enter" && t !== "admin") state.tab = t; } catch {}
setTab(state.tab);
applyRole();
boot();
