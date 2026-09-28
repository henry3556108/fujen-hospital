// 由 src/data.js 產生 docs/ 下的 Markdown 文件：node gen-docs.js
const fs=require('fs'),vm=require('vm');
const ctx={};ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname+'/src/data.js','utf8'),ctx);
const {GROUPS,M,byId,LAYERS,SCEN}=ctx.window;
const ph=p=>p==='m1'?'M1 中期驗收（測試環境）':'M2 完成驗收（正式環境）';
let a='# 系統架構分層\n\n| 層 | 說明 | 模組 |\n|---|---|---|\n';
LAYERS.forEach(l=>a+=`| ${l.name} | ${l.note} | ${l.mods?l.mods.map(id=>`${id} ${byId[id].name}`).join('<br>'):l.plain} |\n`);
fs.writeFileSync(__dirname+'/docs/01-系統架構.md',a);
let b='# 16 個模組與子功能\n';
Object.keys(GROUPS).forEach(g=>{b+=`\n## ${GROUPS[g]}\n`;M.filter(m=>m.g===g).forEach(m=>{
 b+=`\n### ${m.id} ${m.name}\n\n- 階段：${ph(m.p)}\n- 甘特圖期間：${m.when}\n- 說明：${m.sum}\n\n| 子功能 | 內容 | 驗收指標 |\n|---|---|---|\n`;
 m.subs.forEach(s=>b+=`| ${s[0]} | ${s[1]} | ${s[2]} |\n`);});});
fs.writeFileSync(__dirname+'/docs/02-模組與子功能.md',b);
let c='# 需求與使用情境\n';
SCEN.forEach((s,i)=>{c+=`\n## 情境 ${i+1}：${s.t}\n\n**角色**：${s.who.join('、')}\n\n${s.story}\n\n**操作步驟**\n\n`;
 s.steps.forEach((x,j)=>c+=`${j+1}. ${x[0]}（${x[1]} ${byId[x[1]].name}）\n`);
 c+='\n**驗收時會實測**\n\n'+s.checks.map(x=>`- ${x}`).join('\n')+'\n';});
let t='\n## 模組 × 情境對照\n\n| 模組 | '+SCEN.map((s,i)=>`S${i+1}`).join(' | ')+' |\n|---|'+SCEN.map(()=>'---').join('|')+'|\n';
M.forEach(m=>t+=`| ${m.id} | `+SCEN.map(s=>s.steps.some(x=>x[1]===m.id)?'●':'').join(' | ')+' |\n');
fs.writeFileSync(__dirname+'/docs/03-使用情境.md',c+t);
console.log('docs 已產生');
