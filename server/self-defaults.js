/* 나챗방을 처음 열 때 깔아 두는 기본 도구 — 일정·할 일 둘만(2026-11-03 사용자 결정). 틸봇이 만드는 것과 같은 모양(render + keep, 조건 rule)이라
   사용자가 지우거나 "@일정 달력으로 바꿔줘" 처럼 고칠 수 있다. c.items 는 받아 적은 항목(새것이 앞).
   펼친 모습에서 직접 더하고(＋ → 나챗방에 던진 것과 같다) 고치고 지운다(줄을 누르면 그 자리에서) */
const css = `<style>.lx{display:flex;flex-direction:column;gap:6px;min-width:0}
.lx .row{display:flex;align-items:center;gap:8px;min-width:0}
.lx .big{font-size:22px;font-weight:800;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.lx .sub{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lx .none{font-size:14px;color:var(--ink-3)}
.kl{flex:1;display:flex;flex-direction:column;gap:2px;padding:2px 0;min-width:0}
.kl .top{display:flex;align-items:center;gap:8px;min-height:36px;margin-bottom:4px}
.kl .it{display:flex;align-items:center;gap:10px;min-height:44px;border-bottom:1px solid var(--line);min-width:0;cursor:pointer}
.kl .it:last-child{border-bottom:0}
.kl .it:active{background:var(--paper-2)}
.kl .tx{flex:1;min-width:0;font-size:15px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kl .tx.done{color:var(--ink-3);text-decoration:line-through}
.kl .mt{flex:none;font-size:12px;color:var(--ink-3)}
.kl .hd{font-size:12px;color:var(--ink-3);padding:10px 0 2px}
.kl .ck{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--line)}
.kl .ck.on{background:var(--ink);border-color:var(--ink)}
.kl .zero{flex:1;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--ink-3)}</style>`;
const helpers = `
function day(d){ var x=new Date(d+'T00:00:00'); return isNaN(x)?null:x }
function md(x){ return (x.getMonth()+1)+'/'+x.getDate()+' '+'일월화수목금토'.charAt(x.getDay()) }
function left(x){ var t=new Date(); t.setHours(0,0,0,0); var n=Math.round((x-t)/86400000); return n===0?'오늘':n===1?'내일':n>0?'D-'+n:'' }
/* 적는 것은 모두 앱의 적는 줄에서 한다 — 키패드가 올라오고 그 바로 위에 입력줄이 붙는다(대화방과 같은 자리).
   도구는 입력칸을 그리지 않는다. 그래서 "줄 안에 열렸는데 못 나오는" 자리가 아예 없다 */
// 펼친 모습 맨 위: ＋ 를 누르면 적는 줄. 적은 것은 나챗방에 던진 것과 같이 받아 적힌다
function adder(box,c){
  var top=box.querySelector('.top'); if(!top) return;
  top.querySelector('[data-a="add"]').onclick=async function(){
    var t=await c.ask('type',{ph:c.ui.ph||'',ok:'추가'});
    if(t===null) return;
    var s=String(t).trim(); if(!s) return;
    top.innerHTML='<span class="mt">받아 적는 중</span>';
    try{ await c.ask('throw',{text:s}) }catch(e){ c.toast(e.message); c.redraw() }
  };
}
// 줄 하나를 고치기·지우기. 비우고 확인하면 지운다
async function editRow(c,id,text){
  var t=await c.ask('type',{text:text,ph:c.ui.ph||'',ok:'저장'});
  if(t===null) return;
  var s=String(t).trim();
  try{
    if(!s) await c.ask('item.drop',{id:id});
    else if(s!==text) await c.ask('item.edit',{id:id,text:s});
  }catch(err){ c.toast(err.message) }
}`;

module.exports = [
  {
    name: "일정",
    // 일정은 기간(시작~끝)·누구의 일정인지·장소가 있을 수 있다. 끝나는 날까지는 "지금 진행 중"으로 남는다
    rule: { on: true, kinds: ["text"], ai: true, ask: "날짜나 요일·시각이 정해진 약속·예약·일정·여행·기간. 막연한 '나중에'·지난 일 이야기는 넣지 않는다", fields: ["date"] },
    code: helpers + `
var CSS=${JSON.stringify(css)};
function list(c){
  return c.items.map(function(it){ var d=it.data, x=day(d.date); if(!x) return null; var y=day(d.end); if(!y||y<x) y=x;
      return {id:it.id,text:it.text,x:x,y:y,t:d.time||'',w:d.what||it.text,who:d.who||'',p:d.place||''} })
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
  c.ui.ph='토요일 3시 치과';
  var t=new Date(); t.setHours(0,0,0,0);
  var all=list(c), up=all.filter(function(e){ return e.y>=t }), past=all.filter(function(e){ return e.y<t }).reverse().slice(0,10);
  var top='<div class="top"><span class="hd" style="flex:1;padding:0">다가오는 일정</span><button class="rt-btn ghost" data-a="add">＋</button></div>';
  if(!all.length){ box.innerHTML=CSS+'<div class="kl">'+top+'<div class="zero">일정 없음</div></div>'; adder(box,c); return }
  var row=function(e){ return '<div class="it" data-id="'+e.id+'"><span class="mt" style="width:96px">'+esc(when(e))+'</span><span class="tx">'+esc(what(e)+(e.p?' · '+e.p:''))+'</span><span class="mt">'+esc(state(e))+'</span></div>' };
  box.innerHTML=CSS+'<div class="kl">'+top+(up.length?up.map(row).join(''):'<div class="mt" style="padding:8px 0">없음</div>')+(past.length?'<div class="hd">지난 일정</div>'+past.map(row).join(''):'')+'</div>';
  adder(box,c);
  box.querySelectorAll('.it').forEach(function(el){ el.onclick=function(){ var e=all.find(function(x){ return String(x.id)===el.getAttribute('data-id') }); if(e) editRow(c,e.id,e.text) } });
}`,
  },
  {
    name: "할 일",
    rule: { on: true, kinds: ["text"], ai: true, ask: "해야 할 일·사야 할 것·잊지 말아야 할 것", fields: ["what"] },
    code: helpers + `
var CSS=${JSON.stringify(css)};
function items(c){ var d=c.data.done||{}; return c.items.map(function(it){ return {id:it.id,text:it.text,w:it.data.what||it.text,done:!!d[it.id]} }) }
function render(box,c){
  var all=items(c), open=all.filter(function(e){ return !e.done });
  if(!open.length){ box.innerHTML=CSS+'<div class="lx"><div class="none">'+(all.length?'다 했어요':'할 일 없음')+'</div></div>'; return }
  box.innerHTML=CSS+'<div class="lx"><div class="row"><span class="big">'+esc(open[0].w)+'</span><button class="rt-btn" data-k="ok">완료</button></div><div class="sub">남은 할 일 '+open.length+'개</div></div>';
  box.querySelector('[data-k="ok"]').onclick=function(){ c.data.done=c.data.done||{}; c.data.done[open[0].id]=true; c.save() };
}
function keep(box,c){
  c.ui.ph='우유 사기';
  var all=items(c);
  // 체크한 줄은 그 자리에 남는다. 들어올 때 한 번 "안 한 것 먼저"로 줄 세우고 그 순서를 화면에 있는 동안 지킨다 —
  // 누른 줄이 아래 구역으로 날아가 화면이 밀리는 일이 없게. 정리는 다시 들어왔을 때(c.ui 는 나가면 비워진다)
  if(!c.ui.ord) c.ui.ord=all.filter(function(e){ return !e.done }).concat(all.filter(function(e){ return e.done })).map(function(e){ return String(e.id) });
  var ord=c.ui.ord;
  var add=[]; all.forEach(function(e){ if(ord.indexOf(String(e.id))<0) add.push(String(e.id)) });
  if(add.length) c.ui.ord=ord=add.concat(ord);   // 새로 받아 적힌 것은 받아 적힌 순서대로 맨 위에
  all.sort(function(a,b){ return ord.indexOf(String(a.id))-ord.indexOf(String(b.id)) });
  var open=all.filter(function(e){ return !e.done }), dn=0;
  all=all.filter(function(e){ return !e.done||++dn<=10 });   // 한 것은 최근 10개까지만 보인다
  var top='<div class="top"><span class="hd" style="flex:1;padding:0">남은 할 일 '+open.length+'</span><button class="rt-btn ghost" data-a="add">＋</button></div>';
  if(!all.length){ box.innerHTML=CSS+'<div class="kl">'+top+'<div class="zero">할 일 없음</div></div>'; adder(box,c); return }
  // 동그라미를 누르면 했음/안 했음(그 자리에서 동그라미가 차고 글에 줄이 긋힌다. 다시 누르면 풀린다), 글을 누르면 그 자리에서 고치기·지우기
  var row=function(e){ return '<div class="it" data-id="'+e.id+'"><span class="ck'+(e.done?' on':'')+'"></span><span class="tx'+(e.done?' done':'')+'">'+esc(e.w)+'</span></div>' };
  box.innerHTML=CSS+'<div class="kl">'+top+all.map(row).join('')+'</div>';
  adder(box,c);
  box.querySelectorAll('.it').forEach(function(el){
    var id=el.getAttribute('data-id'), e=all.find(function(x){ return String(x.id)===id });
    el.querySelector('.ck').onclick=function(ev){ ev.stopPropagation(); c.data.done=c.data.done||{};
      if(c.data.done[id]) delete c.data.done[id]; else c.data.done[id]=true; c.save() };
    el.onclick=function(){ if(e) editRow(c,e.id,e.text) };
  });
}`,
  },
];
