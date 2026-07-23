/** Dashboard JS — render functions. */
export const DASHBOARD_JS_RENDER = `
function rSel(){
  const el=document.getElementById('projects'),ps=allProjects(),c=cur(),cp=curProject();
  const head=renderProjectNavHeader();
  if(!ps.length){patch(el,head+'<div class="text-center text-txt-500 text-[12px] py-6">暂无项目</div>');return}
  let h='<nav class="text-[12px]" aria-label="项目">'+head+'<div class="space-y-4">';
  ps.forEach(function(p){h+=renderProjectSection(p,cp,c)});
  h+='</div></nav>';
  patch(el,h);
}

function renderProjectNavHeader(){return '<div class="flex items-center justify-between gap-2 mb-3"><div class="text-[11px] font-semibold text-txt-300">项目</div><button id="nav-toggle" type="button" aria-label="隐藏项目导航" aria-controls="projects" aria-expanded="true" class="min-h-11 min-w-11 text-[11px] text-txt-400 border border-base-800 rounded hover:text-txt-100 hover:border-base-700 transition-colors">隐藏</button></div>'}
function renderProjectSection(p,cp,c){const teams=p.teams||[];return '<section>'+renderProjectButton(p,cp)+'<div class="mt-2 ml-[7px] border-l border-base-800/80">'+[...teams].sort((a,b)=>b.timeUpdated-a.timeUpdated).map(t=>renderTeamLink(t,c)).join('')+'</div></section>'}
function renderProjectButton(p,cp){const teams=p.teams||[],active=teams.filter(t=>t.status==='active').length,sel=cp&&cp.id===p.id,pss=projectStatus(p);return '<button type="button" aria-current="'+(sel?'true':'false')+'" title="'+E(statusTitleProject(p))+'" class="project-link group w-full min-h-11 py-1 text-left text-txt-300 hover:text-txt-100 transition-colors" data-project="'+E(p.id)+'" onclick="selectProject(this.dataset.project)"><div class="flex items-start gap-2 min-w-0"><span class="w-[6px] h-[6px] rounded-full mt-1.5 '+pss.dot+(pss.label==='working'?' pulse':'')+' shrink-0"></span><span class="font-mono font-semibold break-words min-w-0">'+E(p.name||p.path||p.id)+'</span>'+chip(enumLabel(pss.label),pss.color)+'</div><div class="mt-1 ml-3 text-[11px] text-txt-400">'+active+' 个活跃团队</div></button>'}
function renderTeamLink(t,c){const ss=coarseTeamStatus(t),tsel=c&&c.id===t.id;return '<button type="button" title="'+E(statusTitleTeam(t))+'" class="team-link block w-full min-h-11 text-left border-l-2 border-transparent -ml-px py-2 pl-3 pr-2 text-[12px] text-txt-400 hover:text-txt-100 hover:bg-base-900/70 transition-colors" aria-current="'+(tsel?'true':'false')+'" data-team="'+E(t.id)+'" onclick="selectTeam(this.dataset.team)"><div class="flex items-start gap-2 min-w-0"><span class="w-[6px] h-[6px] rounded-full mt-1.5 '+ss.dot+(ss.label==='working'?' pulse':'')+' shrink-0"></span><span class="break-words min-w-0 font-mono">'+E(t.name)+'</span><span class="ml-auto text-[10px] text-txt-400">'+E(enumLabel(ss.label))+'</span></div></button>'}

function rHealth(t){
  const el=document.getElementById('hring'),text=document.getElementById('health-text'),h=deriveHealth(t);
  text.textContent=h.e?h.e+' 个错误':h.w?h.w+' 个工作中':'无运行风险';
  if(!h.total){el.style.background='conic-gradient(#2a3144 0deg,#2a3144 360deg)';return}
  const total=h.total,segs=[];let deg=0;
  if(h.w){const d=h.w/total*360;segs.push('#3b82f6 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.i){const d=h.i/total*360;segs.push('#5e6a82 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.e){const d=h.e/total*360;segs.push('#ef4444 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.d){const d=h.d/total*360;segs.push('#2a3144 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  el.style.background='conic-gradient('+segs.join(',')+')';
  el.style.mask='radial-gradient(circle at center,transparent 7px,black 8px)';
  el.style.webkitMask=el.style.mask;
}

function rClock(t){
  const el=document.getElementById('clk');
  const now=new Date();
  const hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0'),ss=String(now.getSeconds()).padStart(2,'0');
  const uptime=t?D(Date.now()-t.timeCreated):'';
  el.textContent=hh+':'+mm+':'+ss+(uptime?' \\u00B7 '+uptime:'');
}

function rSum(t){
  const el=document.getElementById('sum'),mm=t.members||[],tk=t.tasks||[],msgs=t.messages||[];
  const h=deriveHealth(t),tc=tk.filter(x=>x.status==='completed').length;
  patch(el,
    '<span class="w-[6px] h-[6px] rounded-full '+(t.status==='active'?'bg-emerald-500':'bg-txt-500')+'"></span>'+
    '<span class="font-mono font-semibold text-txt-200">'+E(t.name)+'</span>'+
    (h.e?chip(h.e+' 个错误','red'):'')+
    (tk.filter(x=>x.status==='blocked').length?chip(tk.filter(x=>x.status==='blocked').length+' 项等待依赖','muted'):'')+
    (h.w?chip(h.w+' 个工作中','blue'):'')+
    (h.i?chip(h.i+' 个空闲','muted'):'')+
    (h.d?chip(h.d+' 个已结束','muted'):'')+
    (mm.length?chip(mm.length+' 个智能体','gray'):'')+
    (tk.length?chip(tc+'/'+tk.length+' 项任务','green'):'')+
    (msgs.length?chip(msgs.length+' 条消息','muted'):'')
  );
}

function rAttention(t){
  const el=document.getElementById('attention'),a=deriveAttention(t),h=deriveHealth(t),tk=t.tasks||[];
  const tone=a.items.length?'border-amber-500/30 bg-amber-500/[0.05]':'border-emerald-500/20 bg-emerald-500/[0.035]';
  const lead=a.items.length?'需要关注':'未发现阻塞';
  const chips=[chip(h.w+' 个工作中','blue'),chip(a.running.length+' 项进行中','green'),chip(a.waiting.length+' 项等待依赖','muted'),chip(tk.filter(x=>x.status==='pending').length+' 项待处理','muted')];
  let html='<div class="rounded-lg border '+tone+' px-3 py-2 flex flex-col gap-2">';
  html+='<div class="flex flex-wrap items-center gap-x-4 gap-y-2"><div class="min-w-[160px]"><div class="text-[10px] uppercase tracking-[.16em] text-txt-500">团队关注事项</div><div class="text-[14px] font-semibold text-txt-100">'+lead+'</div></div>';
  html+='<div class="flex flex-wrap gap-1.5">'+chips.join('')+'</div></div>';
  if(a.items.length){html+='<div class="grid gap-1 md:grid-cols-2 xl:grid-cols-4">'+a.items.map(x=>'<button type="button" title="'+E(x.kind+' · '+x.label+' · '+x.detail)+'" class="min-h-11 w-full text-left rounded border border-base-700/60 px-2 py-1.5 text-[12px] text-txt-200 hover:bg-base-800/60 focus-visible:border-blue-400 attention-copy line-clamp-3" data-attention-type="'+E(x.target.type)+'" data-attention-id="'+E(x.target.id)+'">'+chip(E(x.kind),x.color)+' <span class="font-mono font-semibold">'+E(x.label)+'</span> <span class="text-txt-300">'+E(x.detail)+'</span></button>').join('')+'</div>'}
  else if(a.latest){html+='<div class="text-[12px] text-txt-400 truncate md:ml-auto">最新消息：<span class="text-txt-200">'+E(a.latest.fromName)+'</span> '+relT(a.latest.timeCreated)+'</div>'}
  html+='</div>';
  patch(el,html);
}

function rAgents(t){
  const el=document.getElementById('agents'),mm=t.members||[];
  if(!mm.length){patch(el,'<div class="col-span-full text-center py-12"><div class="text-txt-400 text-sm mb-1">暂无智能体</div><div class="text-txt-500 text-[11px]">使用 <code class="px-1 py-0.5 bg-base-900 rounded font-mono text-[10px]">team_spawn</code> 创建队友</div></div>');return}
  const n=Date.now(),msgs=t.messages||[],sorted=[...mm].sort((a,b)=>rankAgent(a,b,t)),focusedAgent=document.activeElement?.closest?.('[data-card]')?.dataset.card||null;
  selCard=findAgentIndex(sorted.map(m=>m.name),selectedAgent,selCard);
  if(selCard>=0)selectedAgent=sorted[selCard].name;
  const html=sorted.map((m,idx)=>{
    const s=si(m.status),task=activeTaskFor(m.name,t.tasks||[]),msg=lastMessageFor(m.name,msgs),waiting=waitingTaskFor(m.name,t.tasks||[]);
    const d=D(n-m.timeUpdated),mi=msg?relT(msg.timeCreated):'\\u2014';
    const tt=task?.content,tr=tt;
    const mp=msg?msg.content:'';
    const spark=deriveSparkline(m.name,msgs);
    const isSel=selectedAgent===m.name;
    return '<button type="button" tabindex="'+(isSel||selCard<0&&idx===0?'0':'-1')+'" class="text-left rounded-lg border '+s.c+' p-3 min-h-11 transition-all duration-300 cursor-pointer hover:border-base-600 focus-visible:border-blue-400'+(isSel?' card-sel':'')+'" data-card="'+E(m.name)+'" onclick="openDrawer(this.dataset.card,this)" onfocus="selCard='+idx+';selectedAgent=this.dataset.card">'+
      '<div class="flex items-center gap-2">'+
        '<span class="w-[8px] h-[8px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+' shrink-0"></span>'+
        '<span class="font-mono font-semibold text-[14px] break-words min-w-0">'+E(m.name)+'</span>'+
        '<span class="text-[10px] px-1.5 py-[1px] rounded '+s.t+' bg-base-800/80 shrink-0">'+s.l+'</span>'+
        spark+
        '<span class="max-w-[7rem] truncate text-[10px] text-txt-500 ml-auto shrink">'+E(m.agent)+'</span>'+
      '</div>'+
      (tr?'<div class="mt-2 text-[13px] text-txt-200 leading-snug break-words">'+(waiting?'<span class="text-txt-400">等待依赖：</span>':'当前任务：')+E(tr)+'</div>':'<div class="mt-2 text-[13px] text-txt-500 leading-snug">无进行中任务</div>')+
      (mp?'<div class="mt-1 text-[12px] text-txt-400 line-clamp-2 break-words">最新消息：'+E(mp)+'</div><div class="mt-1 text-[10px] text-txt-500">打开智能体详情查看完整消息</div>':'')+
      '<div class="mt-2 flex items-center gap-1.5 flex-wrap">'+
        chip('状态持续 '+d,'muted')+chip('消息 '+mi,'muted')+chip(E(enumLabel(m.executionStatus||m.status)),m.status==='busy'?'blue':m.status==='error'?'red':'muted')+
        (m.model?chip(E(m.model),'muted'):'')+
        (m.worktreeBranch?chip(E(m.worktreeBranch),'muted'):'')+
      '</div></button>';
  }).join('');
  patch(el,html);
  if(focusedAgent===selectedAgent&&!modalOpen())requestAnimationFrame(function(){document.querySelector('[data-card="'+CSS.escape(focusedAgent)+'"]')?.focus()});
}

function openDrawer(name,opener){
  var t=cur();if(!t)return;
  modalOpener=captureModalOpener(opener||document.activeElement);
  var m=(t.members||[]).find(x=>x.name===name);if(!m)return;
  var s=si(m.status),msgs=(t.messages||[]).filter(x=>x.fromName===name);
  var h='';
  // Header
  h+='<div class="flex items-center justify-between mb-4">';
  h+='<div class="flex min-w-0 items-center gap-2"><span class="w-[10px] h-[10px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+' shrink-0"></span><h2 id="drawer-title" class="runtime-text min-w-0 font-mono font-semibold text-[16px]">'+E(m.name)+'</h2><span class="text-[11px] px-2 py-[2px] rounded '+s.t+' bg-base-800/80 shrink-0">'+s.l+'</span></div>';
  h+='<button id="drawer-close" aria-label="关闭智能体详情" onclick="closeDrawer()" class="text-txt-400 hover:text-txt-100 transition-colors min-w-11 min-h-11 flex items-center justify-center"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
  h+='</div>';
  // Meta chips
  var meta=[];
  meta.push(chip(E(m.agent),'gray'));
  if(m.model)meta.push(chip(E(m.model),'gray'));
  meta.push(chip(E(enumLabel(m.executionStatus||m.status)),m.status==='busy'?'blue':m.status==='error'?'red':'muted'));
  if(m.planApproval&&m.planApproval!=='none')meta.push(chip(E(enumLabel(m.planApproval)),m.planApproval==='approved'?'green':m.planApproval==='rejected'?'red':'amber'));
  meta.push(chip('启动于 '+relT(m.timeCreated),'muted'));
  if(m.worktreeBranch)meta.push(chip(E(m.worktreeBranch),'muted'));
  h+='<div class="flex flex-wrap gap-1.5 mb-4 pb-4 border-b border-base-800/50">'+meta.join('')+'</div>';
  var waitingTask=waitingTaskFor(name,t.tasks||[]);
  if(waitingTask){h+='<div class="mb-4 rounded border border-base-700 bg-base-800/20 p-3"><div class="text-[10px] uppercase tracking-wider text-txt-400 mb-1">等待依赖</div><div class="task-copy text-[13px] text-txt-200">'+E(waitingTask.content)+'</div></div>'}
  // Prompt
  if(m.prompt){
    h+='<div class="mb-4"><div class="text-txt-400 text-[10px] uppercase tracking-wider mb-2">原始提示词</div>';
    h+='<div class="text-[13px] text-txt-200 md bg-base-800/20 rounded-lg p-3 border border-base-800/30">'+md(m.prompt)+'</div></div>';
  }
  // Chat log
  h+='<div class="text-txt-400 text-[10px] uppercase tracking-wider mb-3">对话</div>';
  if(!msgs.length){h+='<div class="text-txt-500 text-[12px]">暂无消息</div>'}
  else{
    // Get all messages involving this agent (sent or received)
    var allMsgs=(t.messages||[]).filter(function(x){return x.fromName===name||x.toName===name});
    allMsgs.sort(function(a,b){return a.timeCreated-b.timeCreated});
    allMsgs.forEach(function(am){
      var isAgent=am.fromName===name;
      var p=parseR(am.content);
      var deliv=am.delivered?(am.read?'\\u2713\\u2713':'\\u2713'):'';
      var align=isAgent?'mr-8':'ml-8';
      var bubbleBg=isAgent?'bg-blue-500/[0.07] border-blue-500/20':'bg-base-800/40 border-base-700/30';
      var sender=E(am.fromName);
      h+='<div class="mb-2 '+align+'">';
      h+='<div class="rounded-xl border '+bubbleBg+' p-3">';
      h+='<div class="flex items-center gap-2 mb-1.5">';
      h+='<span title="'+sender+'" class="min-w-0 max-w-full truncate text-[10px] font-medium '+(isAgent?'text-blue-400':'text-txt-300')+'">'+sender+'</span>';
      h+=chip(relT(am.timeCreated),'muted');
      if(am.toName)h+=chip('\\u2192 '+E(am.toName),'muted');
      if(deliv)h+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
      h+='</div>';
      if(p){
        h+='<div class="mb-1">'+chip(E(enumLabel(p.status)),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200 font-medium">'+E(p.summary)+'</span></div>';
        if(p.details)h+='<div class="text-[12px] text-txt-300 md mt-2">'+md(p.details)+'</div>';
      }else{
        h+='<div class="text-[12px] text-txt-300 md">'+md(am.content)+'</div>';
      }
      h+='</div></div>';
    });
  }
  // Activity timeline
  h+='<div class="mt-4 pt-4 border-t border-base-800/50">';
  h+='<div class="flex items-center justify-between mb-3">';
  h+='<span class="text-txt-400 text-[10px] uppercase tracking-wider">活动记录</span>';
  h+='<button type="button" id="verbose-toggle" onclick="toggleVerbose()" aria-pressed="'+(verbose?'true':'false')+'" class="min-h-11 px-2 text-[11px] '+(verbose?'text-blue-400 border-blue-500/40 bg-blue-500/10':'text-txt-400 hover:text-txt-100 border-base-800')+' rounded transition-colors">详细模式：'+(verbose?'开':'关')+'</button>';
  h+='</div>';
  h+='<div id="drawer-activity-list"><div class="text-txt-500 text-[12px]">正在加载活动记录...</div></div>';
  h+='</div>';
  var drawer=document.getElementById('drawer');
  drawer.innerHTML=h;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden','false');
  drawer.inert=false;
  setBackgroundInert(true);
  drawer.focus();
  document.getElementById('drawer-bg').classList.add('open');
  // Fetch activity for this agent's session
  drawerActivity=null;drawerSession=null;drawerActivityError=false;
  if(m.sessionId)fetchActivity(m.sessionId);
  else rDrawerActivityUpdate();
}

function rDrawerActivityUpdate(){
  var el=document.getElementById('drawer-activity-list');
  if(!el)return;
  if(drawerActivityError){
    el.innerHTML='<div class="text-red-400 text-[12px]">活动记录加载失败</div>';
    return;
  }
  if(!drawerActivity||!drawerActivity.length){
    el.innerHTML='<div class="text-txt-500 text-[12px]">暂无活动记录</div>';
    return;
  }
  var html=drawerActivity.map(function(a){
    var icon='\\u25CF',color='text-txt-500',label=a.type;
    if(a.type==='tool_call'){icon='\\u25B8';color='text-blue-400';label=a.tool||'tool'}
    if(a.type==='tool_result'){icon='\\u25B8';color=a.error?'text-red-400':'text-emerald-400';label=a.tool||'tool'}
    if(a.type==='shell_command'){icon='$';color='text-amber-400';label='shell'}
    if(a.type==='step'){icon='\\u2261';color='text-violet-400';label='步骤'}
    if(a.type==='reasoning'){icon='\\u2726';color='text-violet-400';label='推理过程'}
    if(a.type==='file'){icon='\\u25A3';color='text-cyan-400';label=a.filePath?a.filePath.split('/').pop():'文件'}
    if(a.type==='text'){icon='\\u00BB';color=a.role==='user'?'text-emerald-400':'text-blue-400';label=a.role==='user'?'提示词':'响应'}
    var ts=relT(a.timestamp);
    if(!verbose){
      return '<div class="flex items-center gap-2 py-1 border-b border-base-800/30">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-txt-400 truncate flex-1">'+E(label)+'</span>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</div>';
    }
    if(a.type==='reasoning'){
      return '<details open class="py-2 border-b border-base-800/30">'+
        '<summary class="flex items-center gap-2 cursor-pointer select-none hover:text-txt-100 transition-colors">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-violet-300 font-medium">推理过程</span>'+
        '<span class="text-[10px] text-txt-500 ml-auto shrink-0">'+ts+'</span>'+
        '</summary>'+
        '<div class="mt-1.5 ml-5 text-[11px] text-violet-200/60 bg-violet-950/20 rounded-md p-2 border border-violet-800/30 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">'+E(a.reasoning||'')+'</div>'+
        '</details>';
    }
    if(a.type==='file'){
      var fname=a.filePath?a.filePath.split('/').pop():'文件';
      var fcontent=a.fileDiff||a.fileContent||'';
      return '<details open class="py-2 border-b border-base-800/30">'+
        '<summary class="flex items-center gap-2 cursor-pointer select-none hover:text-txt-100 transition-colors">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-cyan-300 font-medium truncate flex-1">'+E(a.filePath||fname)+'</span>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</summary>'+
        (fcontent?'<div class="mt-1.5 ml-5 text-[11px] text-cyan-200/70 bg-cyan-950/20 rounded-md p-2 border border-cyan-800/30 overflow-x-auto whitespace-pre font-mono max-h-[300px] overflow-y-auto">'+E(fcontent)+'</div>':'')+
        '</details>';
    }
    if(a.type==='text'){
      return '<div class="py-2 border-b border-base-800/30">'+
        '<div class="flex items-start gap-2">'+
        '<span class="'+color+' text-[11px] mt-[1px] shrink-0 font-mono">'+icon+'</span>'+
        '<div class="flex-1 min-w-0">'+
        '<div class="text-[12px] '+(a.role==='user'?'text-emerald-300':'text-blue-300')+' font-medium">'+E(label)+'</div>'+
        '<div class="text-[11px] text-txt-300 mt-1 md">'+md(a.text||'')+'</div>'+
        '</div>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</div></div>';
    }
    var title=a.title||a.tool||a.command||label;
    var row='<div class="py-2 border-b border-base-800/30">';
    row+='<div class="flex items-start gap-2">';
    row+='<span class="'+color+' text-[11px] mt-[1px] shrink-0 font-mono">'+icon+'</span>';
    row+='<div class="flex-1 min-w-0">';
    row+='<div class="text-[12px] text-txt-200 font-medium">'+E(title)+'</div>';
    if(a.input){row+='<div class="text-[11px] text-txt-300 mt-1.5 bg-base-900/60 rounded-md p-2 border border-base-700/40 overflow-x-auto font-mono whitespace-pre max-h-[200px] overflow-y-auto">'+E(a.input)+'</div>'}
    if(a.output){row+='<div class="text-[11px] text-emerald-300/80 mt-1.5 bg-emerald-950/20 rounded-md p-2 border border-emerald-800/30 overflow-x-auto whitespace-pre max-h-[200px] overflow-y-auto">'+E(a.output)+'</div>'}
    if(a.error){row+='<div class="text-[11px] text-red-400 mt-1.5 bg-red-950/20 rounded-md p-2 border border-red-800/30 overflow-x-auto">'+E(a.error)+'</div>'}
    if(a.command){row+='<div class="text-[11px] text-amber-300 mt-1.5 bg-amber-950/20 rounded-md p-2 border border-amber-800/30 overflow-x-auto font-mono whitespace-pre">'+E(a.command)+'</div>'}
    if(a.exitCode!==undefined||a.cost||a.tokensIn||a.tokensOut){
      row+='<div class="flex flex-wrap gap-1.5 mt-1.5">';
      if(a.exitCode!==undefined){row+=chip('退出码：'+a.exitCode,'muted')}
      if(a.cost){row+=chip('$'+a.cost.toFixed(4),'gray')}
      if(a.tokensIn||a.tokensOut){row+=chip('输入 '+(a.tokensIn||0)+' / 输出 '+(a.tokensOut||0),'muted')}
      row+='</div>';
    }
    row+='</div>';
    row+='<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>';
    row+='</div></div>';
    return row;
  }).join('');
  el.innerHTML=html;
}

function closeDrawer(){
  var drawer=document.getElementById('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden','true');
  drawer.inert=true;
  if(!modalOpen())setBackgroundInert(false);
  document.getElementById('drawer-bg').classList.remove('open');
  restoreModalFocus();
}

function rTasks(t){
  const el=document.getElementById('tasks'),tk=t.tasks||[];
  if(!tk.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">暂无任务</div>');return}
  const c=tk.filter(x=>x.status==='completed').length,pct=Math.max(Math.round(c/tk.length*100),tk.length>0?2:0);
  const allDone=c===tk.length&&tk.length>0;
  const g={in_progress:[],pending:[],completed:[],blocked:[],cancelled:[]};for(const x of tk)(g[x.status]||(g[x.status]=[])).push(x);
  const ds=saveD(el);
  const taskMap={};tk.forEach(x=>{taskMap[x.id]=x});
  function grp(label,items,dc,defOpen){
    if(!items.length)return'';
    const rows=items.map(x=>{
      const ic=x.status==='completed'?'\\u2713':x.status==='in_progress'?'\\u25CF':'\\u25CB';
      const icl=x.status==='completed'?'text-emerald-500':x.status==='in_progress'?'text-blue-400':'text-txt-500';
      const p=PR[x.priority]||PR.low,cn=x.content;
      let dep='';
      const depIds=Array.isArray(x.dependsOn)?x.dependsOn:(x.dependsOn?[String(x.dependsOn)]:[]);
      if(depIds.length){const labels=depIds.map(id=>{const parent=taskMap[id];return parent?parent.content:id}).join(', ');dep='<div class="runtime-text text-[11px] text-txt-400 mt-0.5">依赖：'+E(labels)+'</div>'}
      return '<div tabindex="-1" data-task="'+E(x.id)+'" class="flex items-start gap-2 min-h-11 py-2 px-1 rounded hover:bg-base-800/40 transition-colors">'+
        '<span class="'+icl+' text-[11px] mt-[2px] shrink-0">'+ic+'</span>'+
        '<div class="flex-1 min-w-0"><div class="task-copy text-[13px] text-txt-200">'+E(cn)+'</div>'+
        '<div class="flex gap-2 mt-1 text-[10px]"><span class="rounded px-1.5 py-[0px] '+p+'">'+E(enumLabel(x.priority))+'</span>'+
        '<span title="'+(E(x.assignee)||'未分配')+'" class="min-w-0 max-w-full truncate text-txt-500">'+(E(x.assignee)||'未分配')+'</span></div>'+dep+'</div></div>';
    }).join('');
    return '<details '+(defOpen?'open':'')+'><summary class="flex items-center gap-2 min-h-11 text-[12px] text-txt-300 cursor-pointer py-2 hover:text-txt-100 transition-colors select-none">'+
      '<svg class="w-3 h-3 transition-transform [details[open]>summary>&]:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'+
      '<span class="w-[6px] h-[6px] rounded-full '+dc+'"></span>'+label+' <span class="text-txt-500">('+items.length+')</span></summary>'+
      '<div class="ml-5 mt-1">'+rows+'</div></details>';
  }
  el.innerHTML='<div class="flex items-center gap-3 mb-3">'+
    '<span class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider">任务</span>'+
    '<div class="flex-1 bg-base-800 rounded-full h-[5px]"><div class="'+(allDone?'shimmer':'bg-emerald-500')+' h-[5px] rounded-full transition-all duration-500" style="width:'+pct+'%"></div></div>'+
    '<span class="text-[11px] text-txt-400 font-mono">'+c+'/'+tk.length+'</span>'+
    (allDone?'<span class="text-emerald-400 text-[10px] font-medium">全部完成</span>':'')+
  '</div>'+
  grp('进行中',g.in_progress,'bg-blue-500',true)+grp('待处理',g.pending,'bg-txt-500',true)+grp('等待依赖',g.blocked||[],'bg-txt-500',true)+grp('已完成',g.completed,'bg-emerald-500',false);
  restD(el,ds);
}

function rActivity(t){
  const el=document.getElementById('activity'),msgs=t.messages||[];
  if(!msgs.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">等待智能体消息...</div>');return}
  const sp=saveSc(el);
  const newCount=msgs.length,hasNew=newCount>prevMC&&prevMC>0;
  let html='<div class="flex items-center gap-2 mb-3"><span class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider">活动动态</span>'+chip(msgs.length+' 条消息','muted')+'</div>';
  html+='<div class="max-h-[50vh] overflow-y-auto scroll space-y-2">';
  msgs.slice(0,30).forEach(function(m,mi){
    const isNew=hasNew&&mi<(newCount-prevMC);
    const isExp=expMsgs.has(m.id);
    const p=parseR(m.content);
    const deliv=m.delivered?(m.read?'\\u2713\\u2713':'\\u2713'):'';
    const isFromAgent=m.fromName!=='lead'&&m.fromName!=='system';
    const isPeer=isFromAgent&&m.toName&&m.toName!=='lead'&&m.toName!=='all';
    const align=isFromAgent?'mr-6':'ml-6';
    const bubbleBg=isPeer?'bg-violet-500/[0.06] border-violet-500/15':isFromAgent?'bg-blue-500/[0.06] border-blue-500/15':'bg-base-800/40 border-base-700/30';
    const initial=m.fromName.charAt(0).toUpperCase();
    const avatarColor=m.fromName==='system'?'bg-amber-500/20 text-amber-400':isPeer?'bg-violet-500/20 text-violet-400':isFromAgent?'bg-blue-500/20 text-blue-400':'bg-emerald-500/20 text-emerald-400';
    html+='<div class="'+align+(isNew?' hl':'')+' cursor-pointer" role="button" tabindex="0" aria-expanded="'+(isExp?'true':'false')+'" data-msg="'+E(m.id)+'" onclick="toggleMsg(this.dataset.msg)" onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();toggleMsg(this.dataset.msg)}">';
    html+='<div class="flex items-start gap-2">';
    html+='<span class="w-5 h-5 rounded-full '+avatarColor+' flex items-center justify-center text-[9px] font-semibold shrink-0 mt-0.5">'+E(initial)+'</span>';
    html+='<div class="flex-1 min-w-0 rounded-xl border '+bubbleBg+' px-3 py-2">';
    html+='<div class="flex items-center gap-1.5 mb-1">';
    html+='<span title="'+E(m.fromName)+'" class="min-w-0 max-w-[45%] truncate text-[11px] font-medium '+(isPeer?'text-violet-400':isFromAgent?'text-blue-400':'text-txt-300')+'">'+E(m.fromName)+'</span>';
    if(m.toName)html+=chip('\\u2192 '+E(m.toName),'muted');
    html+=chip(relT(m.timeCreated),'muted');
    if(deliv)html+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
    html+='</div>';
    if(p){
      html+='<div>'+chip(E(enumLabel(p.status)),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200">'+E(p.summary)+'</span></div>';
      if(isExp&&p.details)html+='<div class="mt-2 text-[12px] text-txt-300 md">'+md(p.details)+'</div>';
      if(!isExp&&p.details)html+='<div class="mt-1 text-[10px] text-txt-500">点击展开详情</div>';
    }else{
      if(isExp){html+='<div class="text-[12px] text-txt-300 md">'+md(m.content)+'</div>'}
      else{html+='<div class="text-[13px] text-txt-300 line-clamp-2 break-words">'+E(m.content)+'</div>'}
    }
    html+='</div></div></div>';
  });
  if(msgs.length>30)html+='<div class="text-center text-[10px] text-txt-500 py-2">另有 '+(msgs.length-30)+' 条较早消息</div>';
  html+='</div>';
  prevMC=newCount;
  el.innerHTML=html;
  restSc(el,sp);
}

function rTimeline(t){
  const el=document.getElementById('tl'),evs=deriveTimeline(t),focusedTimeline=document.activeElement?.closest?.('[data-timeline-id]')?.dataset.timelineId||null;
  if(!evs.length){el.classList.add('hidden');return}
  el.classList.remove('hidden');
  const html=evs.map(ev=>{
    const key=ev.key;
    return '<button type="button" class="timeline-event flex flex-col items-center justify-center mx-1 shrink-0 group" tabindex="0" data-timeline-id="'+E(key)+'" aria-pressed="'+(timelinePinned===key?'true':'false')+'" aria-label="'+E(ev.label)+'，'+relT(ev.t)+'" title="'+E(ev.label)+' \\u00B7 '+relT(ev.t)+'" onclick="toggleTimelineEvent(this)"><div class="w-[7px] h-[7px] rounded-full '+ev.c+' group-hover:scale-150 group-focus-visible:scale-150 group-aria-[pressed=true]:scale-150 transition-transform"></div><div class="text-[10px] text-txt-400 mt-0.5 hidden group-hover:block group-focus-visible:block group-aria-[pressed=true]:block whitespace-nowrap">'+E(ev.label)+'</div></button>';
  }).join('<div class="w-3 h-px bg-base-700 shrink-0 self-center"></div>');
  patch(el,'<span class="text-[9px] text-txt-500 uppercase tracking-wider mr-3 shrink-0">时间线</span>'+html);
  if(focusedTimeline)requestAnimationFrame(function(){document.querySelector('[data-timeline-id="'+CSS.escape(focusedTimeline)+'"]')?.focus()});
}
`;
