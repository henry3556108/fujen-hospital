/* 頁面互動邏輯（分頁、架構圖、情境、模組清單、側邊詳細面板） */
/* ---- tabs ---- */
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.setAttribute("aria-selected",x===b));
  document.querySelectorAll(".panel").forEach(p=>p.hidden=p.id!=="p-"+b.dataset.tab);
});

/* ---- arch ---- */
const chip=id=>{const m=byId[id];return `<button class="chip ${m.p}" data-mod="${id}"><b>${id}</b>${m.name}</button>`};
document.getElementById("stack").innerHTML=LAYERS.map(l=>`<div class="layer"><div class="layer-name">${l.name}<small>${l.note}</small></div><div class="layer-body">${l.mods?l.mods.map(chip).join(""):`<span class="plain">${l.plain}</span>`}</div></div>`).join("");

const fb=document.getElementById("focusbar");
fb.insertAdjacentHTML("beforeend",`<button class="pill" aria-pressed="true" data-f="-1">全部</button>`+SCEN.map((s,i)=>`<button class="pill" aria-pressed="false" data-f="${i}">${s.t}</button>`).join(""));
fb.onclick=e=>{const b=e.target.closest(".pill");if(!b)return;
  fb.querySelectorAll(".pill").forEach(x=>x.setAttribute("aria-pressed",x===b));
  const i=+b.dataset.f;const set=i<0?null:new Set(SCEN[i].steps.map(s=>s[1]));
  document.querySelectorAll("#stack .chip").forEach(c=>{c.classList.toggle("dim",!!set&&!set.has(c.dataset.mod));c.classList.toggle("hl",!!set&&set.has(c.dataset.mod));});
};

/* ---- drawer ---- */
const drawer=document.getElementById("drawer"),scrim=document.getElementById("scrim");
function subHTML(m){return m.subs.map(s=>`<div class="subf"><b>${s[0]}</b><div>${s[1]}</div><div class="acc">驗收：${s[2]}</div></div>`).join("")}
function openMod(id){const m=byId[id];
  const used=SCEN.filter(s=>s.steps.some(x=>x[1]===id)).map(s=>s.t);
  drawer.innerHTML=`<button class="close" id="cls">關閉</button><div class="meta">${GROUPS[m.g]}</div><h2>${m.id} ${m.name}</h2>
  <p><span class="tag ${m.p}">${m.p==="m1"?"M1 中期驗收，測試環境":"M2 完成驗收，正式環境"}</span></p><p>${m.sum}</p>
  <p class="meta">甘特圖期間：${m.when}</p><h3 style="margin-top:14px">子功能</h3>${subHTML(m)}
  ${used.length?`<h3 style="margin-top:14px">出現在這些情境</h3><p>${used.join("、")}</p>`:""}`;
  drawer.classList.add("open");scrim.classList.add("open");drawer.setAttribute("aria-hidden","false");
  document.getElementById("cls").onclick=closeMod;document.getElementById("cls").focus();}
function closeMod(){drawer.classList.remove("open");scrim.classList.remove("open");drawer.setAttribute("aria-hidden","true")}
scrim.onclick=closeMod;document.addEventListener("keydown",e=>{if(e.key==="Escape")closeMod()});
document.addEventListener("click",e=>{const c=e.target.closest("[data-mod]");if(c)openMod(c.dataset.mod)});

/* ---- scenarios ---- */
const sl=document.getElementById("slist"),sd=document.getElementById("sdetail");
sl.innerHTML=SCEN.map((s,i)=>`<button class="sbtn" role="tab" aria-selected="${i===0}" data-s="${i}">${s.t}<small>${s.who.join("、")}</small></button>`).join("");
function showScen(i){const s=SCEN[i];
  const mods=[...new Set(s.steps.map(x=>x[1]))];
  sd.innerHTML=`<h2>${s.t}</h2>${s.who.map(w=>`<span class="actor">${w}</span>`).join("")}
  <p class="story">${s.story}</p><h3>操作步驟</h3>
  <ol class="steps">${s.steps.map(x=>`<li><span>${x[0]}</span><button class="tag ${byId[x[1]].p}" data-mod="${x[1]}">${x[1]} ${byId[x[1]].name}</button></li>`).join("")}</ol>
  <div class="checks"><h3>驗收時會實測</h3><ul>${s.checks.map(c=>`<li>${c}</li>`).join("")}</ul></div>
  <p class="meta" style="margin-top:12px">涉及模組：${mods.join("、")}</p>`;}
sl.onclick=e=>{const b=e.target.closest(".sbtn");if(!b)return;sl.querySelectorAll(".sbtn").forEach(x=>x.setAttribute("aria-selected",x===b));showScen(+b.dataset.s)};
showScen(0);

/* ---- modules ---- */
const F=[["all","全部 16 個"],["m1","M1 中期 7 個"],["m2","M2 完成 9 個"]];
const fl=document.getElementById("filters"),ml=document.getElementById("modlist");
fl.innerHTML=F.map((f,i)=>`<button class="pill" aria-pressed="${i===0}" data-p="${f[0]}">${f[1]}</button>`).join("");
function renderMods(p){ml.innerHTML=Object.keys(GROUPS).map(g=>{const list=M.filter(m=>m.g===g&&(p==="all"||m.p===p));if(!list.length)return"";
  return `<div class="mgroup"><h2>${GROUPS[g]}</h2>${list.map(m=>`<details class="mod"><summary><span class="mid">${m.id}</span><span class="mname">${m.name}<small>${m.sum}</small></span><span class="tag ${m.p}">${m.p==="m1"?"M1":"M2"}</span></summary><div class="mbody"><div class="meta">甘特圖期間：${m.when}</div>${subHTML(m)}</div></details>`).join("")}</div>`}).join("")}
fl.onclick=e=>{const b=e.target.closest(".pill");if(!b)return;fl.querySelectorAll(".pill").forEach(x=>x.setAttribute("aria-pressed",x===b));renderMods(b.dataset.p)};
renderMods("all");
