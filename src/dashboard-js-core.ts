type DashboardConnectionMode = "loading" | "live" | "error" | "stale" | "recovered"

interface DashboardAttentionMember {
  name: string
  status: string
  executionStatus?: string
}

interface DashboardAttentionTask {
  id: string
  status: string
  assignee?: string | null
  content: string
}

interface DashboardAttentionSource {
  members?: DashboardAttentionMember[]
  tasks?: DashboardAttentionTask[]
}

interface DashboardAttentionItem {
  kind: string
  label: string
  detail: string
  color: string
  target: { type: "agent" | "task"; id: string }
}

/** Derive ordered, actionable dashboard attention items. */
export function deriveDashboardAttention(_source: DashboardAttentionSource): DashboardAttentionItem[] {
  const source = _source
  const members = source.members ?? []
  const tasks = source.tasks ?? []
  const items: DashboardAttentionItem[] = []

  members.filter(member => member.status === "error").forEach(member => {
    items.push({
      kind: "智能体错误",
      label: member.name,
      detail: member.executionStatus ?? member.status,
      color: "red",
      target: { type: "agent", id: member.name },
    })
  })
  tasks.filter(task => task.status === "blocked").forEach(task => {
    items.push({
      kind: "受阻任务",
      label: task.assignee ?? "未分配",
      detail: task.content,
      color: "amber",
      target: task.assignee
        ? { type: "agent", id: task.assignee }
        : { type: "task", id: task.id },
    })
  })
  members.filter(member => member.status === "shutdown_requested").forEach(member => {
    items.push({
      kind: "正在停止",
      label: member.name,
      detail: "已请求停止",
      color: "amber",
      target: { type: "agent", id: member.name },
    })
  })
  return items
}

/** Return the next index for roving agent-card focus. */
export function nextDashboardAgentIndex(_current: number, _count: number, _direction: -1 | 1): number {
  if (_count <= 0) return -1
  if (_current < 0) return _direction > 0 ? 0 : _count - 1
  return (_current + _direction + _count) % _count
}

/** Resolve a selected agent name against the current risk-sorted member list. */
export function findDashboardAgentIndex(names: string[], selectedName: string | null, fallback: number): number {
  const selectedIndex = selectedName ? names.indexOf(selectedName) : -1
  if (selectedIndex >= 0) return selectedIndex
  return fallback >= 0 && fallback < names.length ? fallback : -1
}

/** Decide whether a global dashboard shortcut should ignore its event target. */
export function shouldIgnoreDashboardShortcut(_tagName: string, _editable: boolean, _interactive: boolean): boolean {
  if (_editable || _interactive) return true
  return ["INPUT", "SELECT", "TEXTAREA"].includes(_tagName.toUpperCase())
}

/** Advance the dashboard connection state after a poll result. */
export function nextDashboardConnection(mode: DashboardConnectionMode, _result: "success" | "failure", _hasData: boolean): DashboardConnectionMode {
  if (_result === "failure") return _hasData ? "stale" : "error"
  if (mode === "stale" || mode === "error") return "recovered"
  if (mode === "recovered") return "live"
  return "live"
}

/** Dashboard JS — utilities, data helpers, and state management. */
export const DASHBOARD_JS_CORE = `
let S=null,selId=null,selProjectId=null,fails=0,pollT=Date.now(),prevMC=0,selCard=-1,selectedAgent=null,navCollapsed=false,connectionMode='loading',lastConnectionAnnouncement='',modalOpener=null,timelinePinned=null,pollInFlight=false,verbose=(function(){try{return localStorage.getItem('ensemble-verbose')==='1'}catch(e){return false}})(),drawerActivity=null,drawerSession=null,drawerActivityError=false;
const expCards=new Set(),expMsgs=new Set();
const E=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';
const D=ms=>{const s=Math.floor(Math.abs(ms)/1000);return s<60?s+'秒':s<3600?Math.floor(s/60)+'分钟':s<86400?Math.floor(s/3600)+'小时':Math.floor(s/86400)+'天'};
function relT(ep){const ms=Math.max(0,Date.now()-ep);if(ms<10000)return'刚刚';if(ms<60000)return Math.floor(ms/1000)+'秒前';if(ms<3600000)return Math.floor(ms/60000)+'分钟前';if(ms<86400000)return Math.floor(ms/3600000)+'小时前';return Math.floor(ms/86400000)+'天前'}

const ENUM_LABELS={busy:'工作中',ready:'空闲',shutdown_requested:'正在停止',shutdown:'已结束',error:'错误',idle:'空闲',starting:'正在启动',running:'运行中',cancel_requested:'已请求取消',cancelling:'正在取消',cancelled:'已取消',completing:'即将完成',completed:'已完成',failed:'失败',timed_out:'已超时',active:'进行中',archived:'已归档',pending:'待处理',in_progress:'进行中',blocked:'受阻',working:'工作中',done:'已完成',empty:'暂无成员',high:'高',medium:'中',low:'低',approved:'已批准',rejected:'已拒绝',none:'无需审批'};
function enumLabel(value){return ENUM_LABELS[value]||value}
function nextAgentIndex(current,count,direction){if(count<=0)return-1;if(current<0)return direction>0?0:count-1;return(current+direction+count)%count}
function findAgentIndex(names,selectedName,fallback){const index=selectedName?names.indexOf(selectedName):-1;return index>=0?index:fallback>=0&&fallback<names.length?fallback:-1}
function nextConnection(mode,result,hasData){if(result==='failure')return hasData?'stale':'error';if(mode==='stale'||mode==='error')return'recovered';if(mode==='recovered')return'live';return'live'}
function shortcutTarget(target){if(!target)return false;const tag=target.tagName||'',editable=target.isContentEditable===true,interactive=!!target.closest?.('button,a,input,select,textarea,summary,[role="button"],[contenteditable="true"]');return editable||interactive||tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'}

// Chip: small readable badge with background tint
function chip(text,color){
  var colors={
    blue:'bg-blue-500/15 text-blue-400 border-blue-500/20',
    green:'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber:'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red:'bg-red-500/15 text-red-400 border-red-500/20',
    gray:'bg-base-700/40 text-txt-300 border-base-700/30',
    muted:'bg-base-800/60 text-txt-400 border-base-700/20',
  };
  var c=colors[color]||colors.muted;
  return '<span class="inline-flex max-w-full min-w-0 items-center break-all whitespace-normal px-1.5 py-[1px] rounded text-[10px] font-medium border '+c+'">'+text+'</span>';
}

function md(s){
  let h=E(s);
  h=h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,function(_,l,c){return '<pre><code>'+c.trim()+'</code></pre>'});
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h=h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h=h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  h=h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h=h.replace(/^- (.+)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>.*<\\/li>\\n?)+/g,'<ul>$&</ul>');
  h=h.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
  h=h.replace(/\\n\\n/g,'</p><p>');
  h=h.replace(/\\n/g,'<br>');
  return '<p>'+h+'</p>';
}

function saveD(el){const s={};el.querySelectorAll('details').forEach((d,i)=>{s[i]=d.open});return s}
function restD(el,s){if(!s)return;el.querySelectorAll('details').forEach((d,i)=>{if(i in s)d.open=s[i]})}
function saveSc(el){const s=el.querySelector('.scroll');return s?s.scrollTop:0}
function restSc(el,p){const s=el.querySelector('.scroll');if(s)s.scrollTop=p}
function patch(el,h){if(el.innerHTML!==h)el.innerHTML=h}

const ST={
  busy:{c:'border-blue-500 bg-blue-500/[0.04]',d:'bg-blue-500',t:'text-blue-400',l:'工作中',dim:false},
  ready:{c:'border-base-700 bg-base-950/50',d:'bg-txt-400',t:'text-txt-400',l:'空闲',dim:true},
  shutdown_requested:{c:'border-amber-500/50 bg-amber-500/[0.04]',d:'bg-amber-500',t:'text-amber-400',l:'正在停止',dim:false},
  shutdown:{c:'border-base-800 bg-base-950/30',d:'bg-base-700',t:'text-txt-500',l:'已结束',dim:true},
  error:{c:'border-red-500/50 bg-red-500/[0.04]',d:'bg-red-500',t:'text-red-400',l:'错误',dim:false},
};
const si=s=>ST[s]||ST.ready;
const PR={high:'text-red-400 bg-red-500/10 border border-red-500/20',medium:'text-amber-400 bg-amber-500/10 border border-amber-500/20',low:'text-txt-400 bg-base-800 border border-base-700'};

function parseR(c){const m=c.match(/<task-result>([\\s\\S]*?)<\\/task-result>/);if(!m)return null;const i=m[1],s=(i.match(/<status>([\\s\\S]*?)<\\/status>/)||[])[1]?.trim(),u=(i.match(/<summary>([\\s\\S]*?)<\\/summary>/)||[])[1]?.trim(),d=(i.match(/<details>([\\s\\S]*?)<\\/details>/)||[])[1]?.trim();return s&&u?{status:s,summary:u,details:d||''}:null}

function allTeams(){
  if(!S?.teams)return{active:[],archived:[]};
  const active=[...S.teams.filter(t=>t.status==='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  const archived=[...S.teams.filter(t=>t.status!=='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  return{active,archived};
}
function allProjects(){return S?.projects?[...S.projects].sort((a,b)=>b.timeUpdated-a.timeUpdated):[]}
function projectLabel(p){return p?(p.name||p.path||p.id):''}
function curProject(){const ps=allProjects();if(!ps.length)return null;if(selProjectId){const p=ps.find(p=>p.id===selProjectId);if(p)return p}var t=cur();return t?ps.find(p=>p.id===t.projectId)||ps[0]:ps[0]}
function cur(){const{active,archived}=allTeams(),all=[...active,...archived];if(!all.length)return null;if(selId){const t=all.find(t=>t.id===selId);if(t){selProjectId=t.projectId;return t}}const p=selProjectId&&S?.projects?.find(p=>p.id===selProjectId);const pt=p?[...(p.teams||[])].filter(t=>t.status==='active'):[ ];const t=pt.sort((a,b)=>b.timeUpdated-a.timeUpdated)[0]||active[0]||all[0];if(t){selId=t.id;selProjectId=t.projectId}return t}

function deriveHealth(t){
  const mm=t.members||[];if(!mm.length)return{w:0,i:0,e:0,d:0,total:0};
  return{w:mm.filter(m=>m.status==='busy').length,i:mm.filter(m=>m.status==='ready').length,e:mm.filter(m=>m.status==='error').length,d:mm.filter(m=>m.status==='shutdown'||m.status==='shutdown_requested').length,total:mm.length};
}

function coarseTeamStatus(t){const h=deriveHealth(t),blocked=(t.tasks||[]).filter(x=>x.status==='blocked').length;if(h.e)return{label:'error',color:'red',dot:'bg-red-500'};if(blocked)return{label:'blocked',color:'amber',dot:'bg-amber-500'};if(h.w)return{label:'working',color:'blue',dot:'bg-blue-500'};if(h.i)return{label:'idle',color:'muted',dot:'bg-txt-500'};return{label:t.status==='active'?'empty':t.status,color:'muted',dot:'bg-base-600'}}
function projectStatus(p){const teams=p.teams||[],counts={working:0,blocked:0,error:0,idle:0,done:0};teams.forEach(t=>{const s=coarseTeamStatus(t).label;if(s==='working')counts.working++;else if(s==='blocked')counts.blocked++;else if(s==='error')counts.error++;else if(s==='idle'||s==='empty')counts.idle++;else counts.done++});if(counts.error)return{label:'error',color:'red',dot:'bg-red-500',counts};if(counts.blocked)return{label:'blocked',color:'amber',dot:'bg-amber-500',counts};if(counts.working)return{label:'working',color:'blue',dot:'bg-blue-500',counts};return{label:'idle',color:'muted',dot:'bg-txt-500',counts}}
function statusTitleProject(p){const s=projectStatus(p),teams=p.teams||[];return projectLabel(p)+'\\n状态：'+enumLabel(s.label)+'\\n团队：'+teams.length+'\\n工作中：'+s.counts.working+' · 受阻：'+s.counts.blocked+' · 错误：'+s.counts.error+' · 空闲：'+s.counts.idle}
function statusTitleTeam(t){const h=deriveHealth(t),tasks=t.tasks||[],blocked=tasks.filter(x=>x.status==='blocked').length,active=tasks.filter(x=>x.status==='in_progress').length,pending=tasks.filter(x=>x.status==='pending').length,done=tasks.filter(x=>x.status==='completed').length;return t.name+'\\n状态：'+enumLabel(coarseTeamStatus(t).label)+'\\n智能体：共 '+h.total+' 个，工作中 '+h.w+'，空闲 '+h.i+'，错误 '+h.e+'\\n任务：进行中 '+active+'，受阻 '+blocked+'，待处理 '+pending+'，已完成 '+done}

function lastMessageFor(name,msgs){return msgs.filter(m=>m.fromName===name||m.toName===name).sort((a,b)=>b.timeCreated-a.timeCreated)[0]||null}
function activeTaskFor(name,tasks){return tasks.find(x=>x.assignee===name&&x.status==='in_progress')||tasks.find(x=>x.assignee===name&&x.status==='blocked')||null}
function blockedTaskFor(name,tasks){return tasks.find(x=>x.assignee===name&&x.status==='blocked')||null}

function rankAgent(a,b,t){
  const tasks=t?.tasks||[],msgs=t?.messages||[];
  const score=m=>{
    const lm=lastMessageFor(m.name,msgs),bt=blockedTaskFor(m.name,tasks);
    let s=0;
    if(m.status==='error')s-=1000;
    if(bt)s-=800;
    if(m.status==='shutdown_requested')s-=650;
    if(m.status==='busy')s-=500;
    if(m.status==='ready'&&activeTaskFor(m.name,tasks))s-=350;
    if(lm)s-=Math.max(0,200-Math.floor((Date.now()-lm.timeCreated)/60000));
    if(m.status==='shutdown')s+=700;
    return s;
  };
  const d=score(a)-score(b);return d||String(a.name).localeCompare(String(b.name));
}

function deriveAttention(t){
  const tasks=t.tasks||[],msgs=t.messages||[];
  const blocked=tasks.filter(x=>x.status==='blocked'),running=tasks.filter(x=>x.status==='in_progress');
  const errored=(t.members||[]).filter(m=>m.status==='error');
  const stopping=(t.members||[]).filter(m=>m.status==='shutdown_requested');
  const latest=msgs[0]||null;
  const items=[];
  errored.forEach(m=>items.push({kind:'智能体错误',label:m.name,detail:enumLabel(m.executionStatus||m.status),color:'red',target:{type:'agent',id:m.name}}));
  blocked.forEach(x=>items.push({kind:'受阻任务',label:x.assignee||'未分配',detail:x.content,color:'amber',target:x.assignee?{type:'agent',id:x.assignee}:{type:'task',id:x.id}}));
  stopping.forEach(m=>items.push({kind:'正在停止',label:m.name,detail:'已请求停止',color:'amber',target:{type:'agent',id:m.name}}));
  return{items,running,latest,blocked,errored};
}

function deriveSparkline(name,msgs){
  const mine=msgs.filter(m=>m.fromName===name).map(m=>m.timeCreated).sort();
  if(mine.length<2)return '';
  const min=mine[0],max=mine[mine.length-1],range=max-min||1;
  const buckets=new Array(12).fill(0);
  mine.forEach(t=>{const idx=Math.min(11,Math.floor((t-min)/range*12));buckets[idx]++});
  const mx=Math.max(...buckets)||1;
  const bars=buckets.map((v,i)=>{const h=Math.max(1,Math.round(v/mx*14));return '<rect x="'+(i*5)+'" y="'+(14-h)+'" width="3.5" height="'+h+'" rx="0.5" fill="currentColor" opacity="'+(0.3+v/mx*0.7)+'"/>'}).join('');
  return '<svg class="inline-block text-blue-500/60" width="60" height="14" viewBox="0 0 60 14">'+bars+'</svg>';
}

function deriveTimeline(t){
  const ev=[];
  (t.members||[]).forEach(m=>{ev.push({key:'member|'+m.name+'|spawn',t:m.timeCreated,type:'spawn',label:E(m.name)+' 已启动',c:'bg-blue-400'});if(m.status==='shutdown')ev.push({key:'member|'+m.name+'|off',t:m.timeUpdated,type:'off',label:E(m.name)+' 已停止',c:'bg-txt-500'});if(m.status==='error')ev.push({key:'member|'+m.name+'|error',t:m.timeUpdated,type:'err',label:E(m.name)+' 出错',c:'bg-red-500'})});
  (t.messages||[]).forEach(m=>{const p=parseR(m.content);ev.push({key:'message|'+m.id,t:m.timeCreated,type:'msg',label:E(m.fromName)+' \\u2192 '+(E(m.toName)||'全体'),c:p?'bg-emerald-500':'bg-blue-400'})});
  (t.tasks||[]).filter(x=>x.status==='completed').forEach(x=>{ev.push({key:'task|'+x.id+'|done',t:x.timeUpdated,type:'done',label:'任务已完成',c:'bg-emerald-500'})});
  return ev.sort((a,b)=>a.t-b.t).slice(-50);
}

function deriveThreads(msgs){
  const threads={};
  msgs.forEach(m=>{const k=m.fromName;if(!threads[k])threads[k]={from:m.fromName,msgs:[]};threads[k].msgs.push(m)});
  return Object.values(threads).sort((a,b)=>b.msgs[0].timeCreated-a.msgs[0].timeCreated);
}
`;
