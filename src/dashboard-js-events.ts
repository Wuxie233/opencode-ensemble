/** Dashboard JS — interaction handlers, keyboard, polling. */
export const DASHBOARD_JS_EVENTS = `
function toggleMsg(id){if(expMsgs.has(id))expMsgs.delete(id);else expMsgs.add(id);render()}

function toggleVerbose(){
  verbose=!verbose;
  try{localStorage.setItem('ensemble-verbose',verbose?'1':'0')}catch(e){}
  var btn=document.getElementById('verbose-toggle');
  if(btn){
    btn.textContent='详细模式：'+(verbose?'开':'关');
    btn.setAttribute('aria-pressed',verbose?'true':'false');
    btn.className='min-h-11 px-2 text-[11px] '+(verbose?'text-blue-400 border-blue-500/40 bg-blue-500/10':'text-txt-400 hover:text-txt-100 border-base-800')+' rounded transition-colors';
  }
  rDrawerActivityUpdate();
}

var fetchActivityGen=0;
async function fetchActivity(sessionId){
  var gen=++fetchActivityGen;
  try{
    var res=await fetch('api/session/'+encodeURIComponent(sessionId)+'/activity');
    var data=await res.json();
    if(gen!==fetchActivityGen)return;
    if(!res.ok)throw new Error(data.error||String(res.status));
    drawerActivity=data.activity||[];
    drawerSession=data.session||null;
    drawerActivityError=false;
    rDrawerActivityUpdate();
  }catch{if(gen!==fetchActivityGen)return;drawerActivity=[];drawerSession=null;drawerActivityError=true;rDrawerActivityUpdate()}
}

function applyNavCollapse(){
  const content=document.getElementById('content'),projects=document.getElementById('projects'),rail=document.getElementById('project-rail'),toggle=document.getElementById('nav-toggle'),expand=document.getElementById('nav-expand');
  content.classList.toggle('nav-collapsed',navCollapsed);
  projects.hidden=navCollapsed;
  projects.setAttribute('aria-hidden',String(navCollapsed));
  rail.hidden=!navCollapsed;
  if(toggle)toggle.setAttribute('aria-expanded',String(!navCollapsed));
  expand.setAttribute('aria-expanded',String(!navCollapsed));
  if(document.activeElement===toggle&&navCollapsed)expand.focus();
  if(document.activeElement===expand&&!navCollapsed&&toggle)toggle.focus();
}

function render(){
  rSel();const t=cur();
  const empty=document.getElementById('empty'),content=document.getElementById('content');
  if(!t){empty.classList.remove('hidden');empty.classList.add('flex');content.classList.add('hidden');document.getElementById('tl').classList.add('hidden');return}
  empty.classList.add('hidden');empty.classList.remove('flex');content.classList.remove('hidden');
  applyNavCollapse();
  const p=curProject();document.getElementById('crumb').textContent=p?' / '+projectLabel(p)+' / '+t.name:'';
  rHealth(t);rSum(t);rAttention(t);rAgents(t);rTasks(t);rActivity(t);rTimeline(t);
}

function selectProject(id){selProjectId=id;const p=S?.projects?.find(p=>p.id===id);const t=(p?.teams||[]).filter(t=>t.status==='active').sort((a,b)=>b.timeUpdated-a.timeUpdated)[0]||(p?.teams||[])[0];if(t)selId=t.id;selCard=-1;selectedAgent=null;render()}
function selectTeam(id){selId=id;selCard=-1;selectedAgent=null;render()}
function focusAgentCard(){requestAnimationFrame(function(){const cards=document.querySelectorAll('[data-card]');const card=cards[selCard];if(card)card.focus()})}
function activateAttention(type,id,opener){
  if(type==='agent'){const t=cur(),mm=[...(t?.members||[])].sort((a,b)=>rankAgent(a,b,t));selectedAgent=id;selCard=mm.findIndex(m=>m.name===id);render();requestAnimationFrame(function(){const card=document.querySelector('[data-card="'+CSS.escape(id)+'"]');if(card){card.scrollIntoView({block:'center',behavior:'smooth'});openDrawer(id,card)}});return}
  if(type==='task'){const row=document.querySelector('[data-task="'+CSS.escape(id)+'"]');if(row){const group=row.closest('details');if(group)group.open=true;row.scrollIntoView({block:'center',behavior:'smooth'});row.focus()}}
}
function toggleTimelineEvent(button){
  const id=button.dataset.timelineId;timelinePinned=timelinePinned===id?null:id;rTimeline(cur());
}

function captureModalOpener(element){
  if(!element)return null;
  const card=element.closest?.('[data-card]'),attention=element.closest?.('[data-attention-type]'),task=element.closest?.('[data-task]'),message=element.closest?.('[data-msg]');
  const selector=card?'[data-card="'+CSS.escape(card.dataset.card)+'"]':attention?'[data-attention-type="'+CSS.escape(attention.dataset.attentionType)+'"][data-attention-id="'+CSS.escape(attention.dataset.attentionId)+'"]':task?'[data-task="'+CSS.escape(task.dataset.task)+'"]':message?'[data-msg="'+CSS.escape(message.dataset.msg)+'"]':element.id?'#'+CSS.escape(element.id):null;
  return{element,selector};
}
function restoreModalFocus(){
  if(!modalOpener)return;
  const target=modalOpener.element?.isConnected?modalOpener.element:modalOpener.selector?document.querySelector(modalOpener.selector):null;
  modalOpener=null;
  if(target&&!target.inert)target.focus();
}

function conn(mode){
  const dot=document.getElementById('cd'),text=document.getElementById('ct'),live=document.getElementById('connection-state');
  const copy=mode==='loading'?'正在加载仪表盘':mode==='error'?'仪表盘加载失败，正在重试':mode==='stale'?'连接已中断，显示上次数据':mode==='recovered'?'连接已恢复，数据已更新':(Date.now()-pollT<10000?'刚刚更新':D(Date.now()-pollT)+'前更新');
  dot.className='w-[7px] h-[7px] rounded-full '+(mode==='live'||mode==='recovered'?'bg-emerald-500 pulse':mode==='loading'?'bg-amber-500 pulse':'bg-red-500');
  text.textContent=copy;
  if(copy!==lastConnectionAnnouncement){live.textContent=copy;lastConnectionAnnouncement=copy}
}

async function poll(){
  if(pollInFlight)return;
  pollInFlight=true;
  try{
    const res=await fetch('api/state');
    if(!res.ok)throw new Error('HTTP '+res.status);
    const data=await res.json(),was=connectionMode;
    S=data;fails=0;pollT=Date.now();connectionMode=nextConnection(was,'success',true);conn(connectionMode);render();
    if(connectionMode==='recovered')setTimeout(function(){if(connectionMode==='recovered'){connectionMode='live';conn(connectionMode)}},1500);
  }catch{
    fails++;connectionMode=nextConnection(connectionMode,'failure',!!S);conn(connectionMode);
  }finally{pollInFlight=false}
}

function setBackgroundInert(locked){
  document.querySelectorAll('header,main,#sum,#tl').forEach(function(el){
    el.inert=locked;
    if(locked)el.setAttribute('aria-hidden','true');
    else el.removeAttribute('aria-hidden');
  });
}

function modalOpen(){return document.getElementById('sco').classList.contains('show')||document.getElementById('drawer').classList.contains('open')}

function trapFocus(root,e){
  const nodes=[...root.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(function(el){return !el.disabled&&!el.inert&&el.offsetParent!==null});
  if(!nodes.length){e.preventDefault();root.focus();return}
  const first=nodes[0],last=nodes[nodes.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();return}
  if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();return}
}

function openShortcuts(){
  const el=document.getElementById('sco');
  modalOpener=captureModalOpener(document.activeElement);
  setBackgroundInert(true);
  el.classList.add('show');
  el.setAttribute('aria-hidden','false');
  document.getElementById('sco').focus();
}

function closeShortcuts(){
  const el=document.getElementById('sco');
  el.classList.remove('show');
  el.setAttribute('aria-hidden','true');
  if(!modalOpen())setBackgroundInert(false);
  restoreModalFocus();
}

// Clock update every second
setInterval(function(){var t=cur();if(t)rClock(t);if(connectionMode==='live')conn(connectionMode)},1000);

// Poll every 2.5s
setInterval(poll,2500);

document.addEventListener('click',function(e){
  const id=e.target&&e.target.id;
  if(id!=='nav-toggle'&&id!=='nav-expand')return;
  navCollapsed=id==='nav-toggle';
  applyNavCollapse();
});

document.addEventListener('click',function(e){
  const item=e.target&&e.target.closest?.('[data-attention-type]');
  if(item)activateAttention(item.dataset.attentionType,item.dataset.attentionId,item);
});

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  const shortcutsOpen=document.getElementById('sco').classList.contains('show');
  if(shortcutsOpen&&e.key==='Tab'){trapFocus(document.getElementById('sco'),e);return}
  if(shortcutsOpen&&e.key==='Escape'){e.preventDefault();closeShortcuts();return}
  const drawerOpen=document.getElementById('drawer').classList.contains('open');
  if(drawerOpen&&e.key==='Tab'){trapFocus(document.getElementById('drawer'),e);return}
  if(drawerOpen&&e.key==='Escape'){e.preventDefault();closeDrawer();return}
  if(drawerOpen&&e.key==='?'){e.preventDefault();return}
  const agentCard=e.target&&e.target.closest?.('[data-card]');
  if(agentCard&&(e.key==='j'||e.key==='ArrowRight'||e.key==='ArrowDown')){e.preventDefault();var nextTeam=cur(),nextMembers=[...(nextTeam?.members||[])].sort((a,b)=>rankAgent(a,b,nextTeam));selCard=nextAgentIndex(findAgentIndex(nextMembers.map(m=>m.name),selectedAgent,selCard),nextMembers.length,1);selectedAgent=nextMembers[selCard]?.name||null;render();focusAgentCard();return}
  if(agentCard&&(e.key==='k'||e.key==='ArrowLeft'||e.key==='ArrowUp')){e.preventDefault();var previousTeam=cur(),previousMembers=[...(previousTeam?.members||[])].sort((a,b)=>rankAgent(a,b,previousTeam));selCard=nextAgentIndex(findAgentIndex(previousMembers.map(m=>m.name),selectedAgent,selCard),previousMembers.length,-1);selectedAgent=previousMembers[selCard]?.name||null;render();focusAgentCard();return}
  if(shortcutTarget(e.target))return;
  var t=cur();if(!t)return;
  var mm=[...(t.members||[])].sort((a,b)=>rankAgent(a,b,t));
  if(e.key==='?'){e.preventDefault();shortcutsOpen?closeShortcuts():openShortcuts();return}
  if(e.key==='Escape'){closeDrawer();expMsgs.clear();selCard=-1;selectedAgent=null;closeShortcuts();render();return}
  if(e.key==='j'&&mm.length){e.preventDefault();selCard=nextAgentIndex(findAgentIndex(mm.map(m=>m.name),selectedAgent,selCard),mm.length,1);selectedAgent=mm[selCard]?.name||null;render();focusAgentCard();return}
  if(e.key==='k'&&mm.length){e.preventDefault();selCard=nextAgentIndex(findAgentIndex(mm.map(m=>m.name),selectedAgent,selCard),mm.length,-1);selectedAgent=mm[selCard]?.name||null;render();focusAgentCard();return}
  if(e.key==='v'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();toggleVerbose();return}
  if(e.key==='Enter'&&mm.length){const index=findAgentIndex(mm.map(m=>m.name),selectedAgent,selCard);if(index>=0){e.preventDefault();openDrawer(mm[index].name,document.activeElement)}return}
  if(e.key>='1'&&e.key<='9'){
    var teams=allTeams(),all=[...teams.active,...teams.archived];
    var idx=parseInt(e.key)-1;
    if(idx<all.length){selId=all[idx].id;render()}
  }
});

document.getElementById('tl').addEventListener('keydown',function(e){if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;e.preventDefault();this.scrollBy({left:e.key==='ArrowLeft'?-180:180,behavior:'smooth'})});

// Initial poll
conn('loading');
poll();

console.log('%c Ensemble Mission Control','font-size:14px;font-weight:bold;color:#22c55e');
`;
