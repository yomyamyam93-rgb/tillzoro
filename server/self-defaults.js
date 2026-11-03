/* 나챗방을 처음 열 때 깔아 두는 기본 도구 — 일정·할 일 둘만(2026-11-03 사용자 결정). 틸봇이 만드는 것과 같은 모양(render + keep, 조건 rule)이라
   사용자가 지우거나 "@일정 달력으로 바꿔줘" 처럼 고칠 수 있다. c.items 는 받아 적은 항목(새것이 앞) */
const css = `<style>.lx{display:flex;flex-direction:column;gap:6px;min-width:0}
.lx .row{display:flex;align-items:center;gap:8px;min-width:0}
.lx .big{font-size:22px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.lx .sub{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lx .none{font-size:14px;color:var(--ink-3)}
.kl{flex:1;display:flex;flex-direction:column;gap:2px;padding:2px 0;min-width:0}
.kl .it{display:flex;align-items:center;gap:10px;min-height:40px;border-bottom:1px solid var(--line);min-width:0}
.kl .it:last-child{border-bottom:0}
.kl .tx{flex:1;min-width:0;font-size:15px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kl .tx.done{color:var(--ink-3);text-decoration:line-through}
.kl .mt{flex:none;font-size:12px;color:var(--ink-3)}
.kl .hd{font-size:12px;color:var(--ink-3);padding:8px 0 2px}
.kl .ck{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--line)}
.kl .ck.on{background:var(--ink);border-color:var(--ink)}
.kl .zero{flex:1;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--ink-3)}</style>`;
const helpers = `
function day(d){ var x=new Date(d+'T00:00:00'); return isNaN(x)?null:x }
function md(x){ return (x.getMonth()+1)+'/'+x.getDate()+' '+'일월화수목금토'.charAt(x.getDay()) }
function left(x){ var t=new Date(); t.setHours(0,0,0,0); var n=Math.round((x-t)/86400000); return n===0?'오늘':n===1?'내일':n>0?'D-'+n:'' }`;

module.exports = [
  {
    name: "일정",
    // 일정은 기간(시작~끝)·누구의 일정인지·장소가 있을 수 있다. 끝나는 날까지는 "지금 진행 중"으로 남는다
    rule: { on: true, kinds: ["text"], ai: true, ask: "날짜나 요일·시각이 정해진 약속·예약·일정·여행·기간. 막연한 '나중에'·지난 일 이야기는 넣지 않는다", fields: ["date", "end", "time", "what", "who", "place"] },
    code: helpers + `
var CSS=${JSON.stringify(css)};
function list(c){
  return c.items.map(function(it){ var d=it.data, x=day(d.date); if(!x) return null; var y=day(d.end); if(!y||y<x) y=x;
      return {x:x,y:y,t:d.time||'',w:d.what||it.text,who:d.who||'',p:d.place||''} })
    .filter(Boolean).sort(function(a,b){ return a.x-b.x||String(a.t).localeCompare(String(b.t)) });
}
function when(e){ return md(e.x)+(e.y>e.x?' ~ '+md(e.y):'')+(e.t?' '+e.t:'') }
function what(e){ return (e.who?e.who+' · ':'')+e.w }
function state(e){ var t=new Date(); t.setHours(0,0,0,0); return e.x<=t&&e.y>=t&&e.y>e.x?'진행 중':left(e.x) }
function render(box,c){
  var t=new Date(); t.setHours(0,0,0,0);
  var up=list(c).filter(function(e){ return e.y>=t });
  if(!up.length){ box.innerHTML=CSS+'<div class="lx"><div class="none">다가오는 일정 없음</div></div>'; return }
  var e=up[0];
  box.innerHTML=CSS+'<div class="lx"><div class="row"><span class="big">'+esc(what(e))+'</span></div><div class="sub">'+esc(when(e)+' · '+state(e))+(up.length>1?' · 다가오는 일정 '+up.length+'개':'')+'</div></div>';
}
function keep(box,c){
  var t=new Date(); t.setHours(0,0,0,0);
  var all=list(c), up=all.filter(function(e){ return e.y>=t }), past=all.filter(function(e){ return e.y<t }).reverse().slice(0,10);
  if(!all.length){ box.innerHTML=CSS+'<div class="kl"><div class="zero">일정 없음</div></div>'; return }
  var row=function(e){ return '<div class="it"><span class="mt" style="width:96px">'+esc(when(e))+'</span><span class="tx">'+esc(what(e)+(e.p?' · '+e.p:''))+'</span><span class="mt">'+esc(state(e))+'</span></div>' };
  box.innerHTML=CSS+'<div class="kl">'+(up.length?up.map(row).join(''):'')+(past.length?'<div class="hd">지난 일정</div>'+past.map(row).join(''):'')+'</div>';
}`,
  },
  {
    name: "할 일",
    rule: { on: true, kinds: ["text"], ai: true, ask: "해야 할 일·사야 할 것·잊지 말아야 할 것", fields: ["what"] },
    code: `
var CSS=${JSON.stringify(css)};
function items(c){ var d=c.data.done||{}; return c.items.map(function(it){ return {id:it.id,w:it.data.what||it.text,done:!!d[it.id]} }) }
function render(box,c){
  var all=items(c), open=all.filter(function(e){ return !e.done });
  if(!open.length){ box.innerHTML=CSS+'<div class="lx"><div class="none">'+(all.length?'다 했어요':'할 일 없음')+'</div></div>'; return }
  box.innerHTML=CSS+'<div class="lx"><div class="row"><span class="big">'+esc(open[0].w)+'</span><button class="rt-btn" data-k="ok">완료</button></div><div class="sub">남은 할 일 '+open.length+'개</div></div>';
  box.querySelector('[data-k="ok"]').onclick=function(){ c.data.done=c.data.done||{}; c.data.done[open[0].id]=true; c.save() };
}
function keep(box,c){
  var all=items(c);
  if(!all.length){ box.innerHTML=CSS+'<div class="kl"><div class="zero">할 일 없음</div></div>'; return }
  var open=all.filter(function(e){ return !e.done }), done=all.filter(function(e){ return e.done }).slice(0,10);
  var row=function(e){ return '<div class="it" data-id="'+e.id+'"><span class="ck'+(e.done?' on':'')+'"></span><span class="tx'+(e.done?' done':'')+'">'+esc(e.w)+'</span></div>' };
  box.innerHTML=CSS+'<div class="kl">'+open.map(row).join('')+(done.length?'<div class="hd">한 것</div>'+done.map(row).join(''):'')+'</div>';
  box.querySelectorAll('.it').forEach(function(el){ el.onclick=function(){ var id=el.getAttribute('data-id'); c.data.done=c.data.done||{};
    if(c.data.done[id]) delete c.data.done[id]; else c.data.done[id]=true; c.save() } });
}`,
  },
];
