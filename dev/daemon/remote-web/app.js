const $=id=>document.getElementById(id);
const encoder=new TextEncoder();
const phases={clarifying:'목표 구체화',meeting:'회의 진행',executing:'계획에 따라 실행 중',review:'최종 보고 · 검수 대기',completed:'검수 완료',blocked:'문제 확인 필요',cancelled:'작업 취소'};
const statuses={starting:'출근 중',working:'작업 중',idle:'한가함',waiting_approval:'승인 대기',waiting_answer:'답변 대기',error:'오류',exited:'퇴근',suspended:'복구 대기'};
let db,info,identity,socket,retryTimer,connected=false,stopped=false,seq=0,selected='',memberId='',workflow=null;
let snapshot={departments:[],members:[],pending:[],tasks:[]},events=[],inboxVersion='',deptVersion='',renderTimer;
const requests=new Map();
const mutations=new Map();
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function clearWorkView(){snapshot={departments:[],members:[],pending:[],tasks:[]};events=[];workflow=null;selected='';memberId='';seq=0;inboxVersion='';deptVersion='';$('task-text').value='';$('device-details').textContent='';$('fingerprint').textContent='';render();$('workspace').hidden=true;$('device-panel').hidden=true;}
const b64=buffer=>btoa(String.fromCharCode(...new Uint8Array(buffer)));
const error=e=>{$('error').textContent=e?.message??String(e);};
const setConnection=text=>{$('connection').textContent=text;$('connection').className=connected?'online':'';};
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function button(text,action,cls){const el=node('button',text,cls);el.type='button';el.addEventListener('click',()=>void action().catch(error));return el;}
function paragraphs(parent,text){parent.append(node('div',String(text??''),'report-text'));}
function transaction(mode,action){return new Promise((resolve,reject)=>{const tx=db.transaction('identity',mode),store=tx.objectStore('identity');let result;const request=action(store);if(request)request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}
const get=key=>transaction('readonly',s=>s.get(key));
const put=(key,value)=>transaction('readwrite',s=>s.put(value,key));
const remove=key=>transaction('readwrite',s=>s.delete(key));
async function api(endpoint,body){const response=await fetch(endpoint,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error??'PC에 연결할 수 없습니다.');return result;}
async function proof(message,key=identity?.privateKey){if(!key)throw new Error('기기 키가 없습니다.');return b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(message)));}
async function flushRevocations(){const rows=await transaction('readonly',s=>s.getAll());for(const row of rows??[]){if(row.kind!=='revocation')continue;try{await api('/api/revoke',{deviceId:row.deviceId,signature:row.signature});await remove(row.storageKey);}catch{}}}
function consumePairCode(){const code=new URLSearchParams(location.hash.slice(1)).get('pair');if(code){$('pair-code').value=code;history.replaceState(null,'',location.pathname);}}

async function boot(){
 if(!window.isSecureContext || !crypto.subtle){$('pair-submit').disabled=true;error(new Error('기기 키를 만들려면 HTTPS 접속이 필요합니다. PC 로컬 테스트는 localhost 주소를 사용하세요.'));return;}
 db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pixel-office-device',1);r.onupgradeneeded=()=>r.result.createObjectStore('identity');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 consumePairCode();
 info=await api('/api/info');await flushRevocations();identity=await get(info.workstationId);
 $('pair-submit').disabled=!!identity;
 if(identity){$('device-name').value=identity.name;$('fingerprint').textContent=`기기 지문: ${identity.fingerprint}`;connect();}else setConnection('기기 등록 필요');
}

$('pair-form').addEventListener('submit',async event=>{
 event.preventDefault();$('error').textContent='';$('pair-submit').disabled=true;
 try{
  if(!info || !db)throw new Error('PC 연결 준비가 끝나지 않았습니다.');
  if(identity?.deviceId)throw new Error('이 기기는 이미 등록 요청했습니다. PC에서 승인하거나 이 기기의 연결을 해제하세요.');
  const name=$('device-name').value.trim(),code=$('pair-code').value.trim();
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const publicKey=b64(await crypto.subtle.exportKey('spki',keys.publicKey));
  const signature=await proof(`pixel-office pair v1\n${info.workstationId}\n${code}\n${name}`,keys.privateKey);
  const result=await api('/api/pair',{name,code,publicKey,signature});
  identity={workstationId:info.workstationId,name,privateKey:keys.privateKey,publicKey,deviceId:result.deviceId,fingerprint:result.fingerprint};
  await put(info.workstationId,identity);$('pair-code').value='';$('fingerprint').textContent=`기기 지문: ${identity.fingerprint}`;
  $('pair-message').textContent='등록 요청을 보냈습니다. 작업 PC에서 이름과 지문을 확인하고 승인해 주세요.';stopped=false;connect();
 }catch(e){error(e);}finally{$('pair-submit').disabled=!!identity;}
});

function connect(){
 if(stopped || !identity)return;clearTimeout(retryTimer);if(socket && socket.readyState<2)socket.close();connected=false;setConnection('PC에 연결 중');
 const current=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/connect`);socket=current;
 current.onopen=()=>current.send(JSON.stringify({type:'auth.begin',deviceId:identity.deviceId}));
 current.onmessage=async event=>{
  if(socket!==current || stopped)return;
  try{
   const m=JSON.parse(event.data);
   if(m.type==='auth.challenge'){current.send(JSON.stringify({type:'auth.prove',signature:await proof(m.message)}));return;}
   if(m.type==='auth.pending'){setConnection('PC 승인 대기');$('pair-message').textContent=m.message;retryTimer=setTimeout(()=>{if(current.readyState===1)current.send(JSON.stringify({type:'auth.begin',deviceId:identity.deviceId}));},3000);return;}
   if(m.type==='auth.error'){
    setConnection(m.message);if(m.reason==='revoked'){stopped=true;connected=false;await remove(info.workstationId);identity=null;clearWorkView();$('pair-submit').disabled=false;$('pairing').hidden=false;$('pair-message').textContent='연결이 해제되었습니다. 다시 등록하려면 PC에서 새 연결 키를 받으세요.';}return;
   }
   if(m.type==='auth.ready'){
    if(m.workstationId!==info.workstationId || m.deviceId!==identity.deviceId)throw new Error('다른 PC의 인증 응답입니다.');
    clearTimeout(retryTimer);connected=true;setConnection('연결됨');snapshot=m.snapshot;seq=snapshot.seq??0;events=[];$('pairing').hidden=true;$('workspace').hidden=false;
    $('device-details').textContent=`${identity.name}\n지문: ${identity.fingerprint}`;$('disconnect-device').disabled=false;for(const el of $('device-panel').querySelectorAll('.revoke-confirm'))el.remove();
    if(!snapshot.departments.some(d=>d.id===selected))selected=snapshot.departments[0]?.id??'';
    render();await refresh();return;
   }
   if(m.id!==undefined){const r=requests.get(m.id);if(r){requests.delete(m.id);clearTimeout(r.timer);m.error?r.reject(Object.assign(new Error(m.error.message),{definitive:m.error.code!==-32009})):r.resolve(m.result);}return;}
   if(m.method==='snapshot'){snapshot=m.params;render();if(!snapshot.departments.some(d=>d.id===selected)){selected=snapshot.departments[0]?.id??'';void refresh().catch(error);}return;}
   if(m.method==='member.status'){
    if(m.params.member){const i=snapshot.members.findIndex(x=>x.id===m.params.member.id);if(i<0)snapshot.members.push(m.params.member);else snapshot.members[i]=m.params.member;}
    else {const member=snapshot.members.find(x=>x.id===m.params.memberId);if(member)member.status=m.params.status;}
    if(snapshot.pending.some(p=>p.memberId===m.params.memberId))void refreshSnapshot().catch(error);
    schedule();return;
   }
   if(m.method==='workflow.changed' && m.params.departmentId===selected){workflow=m.params;schedule();return;}
   if(m.method==='event'){
    const e=m.params;if(e.seq<=seq)return;seq=e.seq;events.push(e);events=events.slice(-300);
    if(e.kind==='waiting_approval' || e.kind==='asking' || e.kind==='idle'){void refreshSnapshot().catch(error);}
    schedule();return;
   }
   if(m.method==='daemon.notice' && m.params.level==='error')error(new Error(m.params.message));
  }catch(e){error(e);}
 };
 current.onerror=()=>setConnection('PC 연결 확인 중');
 current.onclose=()=>{
  if(socket!==current)return;connected=false;setConnection(stopped?'연결 해제됨':'연결 끊김 · 다시 연결 중');renderActions();
  for(const r of requests.values()){clearTimeout(r.timer);r.reject(new Error('연결이 끊겼습니다. 작업 상태를 확인한 뒤 다시 요청하세요.'));}requests.clear();
  if(!stopped && identity)retryTimer=setTimeout(connect,2000);
 };
}
function rpc(method,params={},requestId){
 if(!connected || socket?.readyState!==1)return Promise.reject(new Error('PC에 연결되어 있지 않습니다.'));
 const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(id);reject(new Error('PC 응답 시간이 지났습니다. 작업 상태를 확인하세요.'));},35000);requests.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params,...(requestId?{requestId}:{})}));});
}
async function mutate(method,params={}){
 const fingerprint=b64(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(canonical({method,params})))));
 const key=`retry:${info.workstationId}:${identity.deviceId}:${fingerprint}`;
 if(mutations.has(key))return mutations.get(key);
 const operation=(async()=>{
   let record=await get(key);if(record && (!record.createdAt || Date.now()-record.createdAt>7*86400000))throw new Error('오래된 미확정 요청입니다. 작업 화면에서 실행 결과를 먼저 확인하세요.');
   if(!record){record={kind:'retry',requestId:crypto.randomUUID(),createdAt:Date.now()};await put(key,record);}
   let result;
   try{result=await rpc(method,params,record.requestId);}catch(e){if(e.definitive)await remove(key);throw e;}
   await remove(key);$('error').textContent='';
   // The command succeeded even if refreshing the view fails.
   try{await refresh();}catch(e){error(new Error(`요청은 처리됐습니다. 상태 갱신 실패: ${e.message}`));}
   return result;
 })();mutations.set(key,operation);try{return await operation;}finally{mutations.delete(key);}
}
async function refreshSnapshot(){
 const result=await rpc('remote.snapshot');snapshot=result.snapshot;
 if(!snapshot.departments.some(d=>d.id===selected))selected=snapshot.departments[0]?.id??'';
 render();
}
async function refresh(){
 if(!connected)return;await refreshSnapshot();if(selected){workflow=(await rpc('workflow.get',{departmentId:selected})).workflow;const query=await rpc('events.query',{departmentId:selected,limit:100});const merged=new Map(events.map(e=>[e.seq,e]));for(const e of query.events??[])merged.set(e.seq,e);events=[...merged.values()].sort((a,b)=>a.seq-b.seq).slice(-300);}else workflow=null;
 render();
}
function schedule(){clearTimeout(renderTimer);renderTimer=setTimeout(render,120);}
function memberName(id){return snapshot.members.find(m=>m.id===id)?.name??workflow?.meeting?.participantNames?.[id]??id;}
function render(){
 const departments=snapshot.departments??[],version=JSON.stringify(departments.map(d=>[d.id,d.name]));
 if(version!==deptVersion){deptVersion=version;$('department').replaceChildren(...departments.map(d=>{const o=node('option',d.name);o.value=d.id;return o;}));}$('department').value=selected;
 $('empty').hidden=departments.length>0;const members=(snapshot.members??[]).filter(m=>m.departmentId===selected && !['exited'].includes(m.status));
 $('office-summary').textContent=`${members.length}명`;draw(members);
 $('members').replaceChildren(...members.map(m=>{const el=button(m.name,async()=>{memberId=m.id;renderLogs();},'');el.append(node('small',`${m.rank==='head'?'부장':m.rank==='lead'?'팀장':'팀원'} · ${statuses[m.status]??m.status}`));return el;}));
 const logOptions=snapshot.members.filter(m=>m.departmentId===selected);if(!logOptions.some(m=>m.id===memberId))memberId=logOptions.find(m=>m.rank==='head')?.id??logOptions[0]?.id??'';
 $('log-member').replaceChildren(...logOptions.map(m=>{const o=node('option',m.name);o.value=m.id;return o;}));$('log-member').value=memberId;
 renderInbox();renderWorkflow();renderActions();renderLogs();
}
function draw(members){
 const canvas=$('office-canvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,680,280);ctx.imageSmoothingEnabled=false;
 const live=members.slice(0,18);live.forEach((m,i)=>{
  const x=m.rank==='head'?300:30+((i-1+6)%6)*110,y=m.rank==='head'?28:140+Math.floor(Math.max(0,i-1)/6)*74;
  ctx.fillStyle='#343e58';ctx.fillRect(x,y,76,43);ctx.fillStyle='#111a28';ctx.fillRect(x+5,y+6,66,24);
  ctx.fillStyle=m.status==='waiting_approval'?'#ffc36e':m.status==='working'?'#a9a3f3':m.status==='error'?'#ff8f97':'#89d4ae';ctx.fillRect(x+13,y+12,48,3);
  ctx.fillStyle='#ffdab4';ctx.fillRect(x+31,y+43,16,13);ctx.fillStyle=m.rank==='head'?'#ffd16d':m.rank==='lead'?'#b4adff':'#85c4e8';ctx.fillRect(x+27,y+56,24,14);
  ctx.fillStyle='#ccd2df';ctx.font='12px system-ui';ctx.fillText(m.name.slice(0,8),x,y-5);
 });
}
function renderInbox(){
 const pending=(snapshot.pending??[]).filter(p=>p.status==='open' && snapshot.members.find(m=>m.id===p.memberId)?.departmentId===selected);
 // Reconstruct pending additions/removals from live events, then refresh through authoritative remote snapshot RPC below.
 const version=JSON.stringify(pending);if(version===inboxVersion)return;inboxVersion=version;$('pending-count').textContent=`${pending.length}건`;
 $('inbox').replaceChildren();if(!pending.length){$('inbox').append(node('p','승인·답변을 기다리는 요청이 없습니다.','muted'));return;}
 for(const p of pending){const item=node('div',undefined,'item');item.append(node('h3',memberName(p.memberId)));const payload=p.payload??{};
  if(p.type==='approval'){
   item.append(node('p',`${payload.tool_name??'작업'} · 승인 요청`));paragraphs(item,JSON.stringify(payload.tool_input??{},null,2));
   const controls=node('div',undefined,'actions');controls.append(button('허가',()=>mutate('approval.respond',{pendingId:p.id,behavior:'allow'}),'allow'),button('거부',()=>mutate('approval.respond',{pendingId:p.id,behavior:'deny'}),'deny'));item.append(controls);
  }else{
   const questions=payload.questions??[{question:payload.question??'답변을 입력하세요.',header:payload.question??'답변'}];const inputs=[];
   for(const q of questions){item.append(node('p',q.question));const input=node('input');input.placeholder='답변';input.setAttribute('aria-label',q.question);inputs.push({question:q.question,header:q.header,input});item.append(input);}
   item.append(button('답변 보내기',()=>mutate('question.respond',{pendingId:p.id,answers:Object.fromEntries(inputs.map(x=>[x.header??x.question,x.input.value]))}),'primary'));
  }$('inbox').append(item);
 }
}
function section(title,text){const box=node('div',undefined,'item');box.append(node('h3',title));paragraphs(box,text);return box;}
function renderWorkflow(){
 $('phase').textContent=phases[workflow?.phase]??'작업 구체화부터 시작';const body=$('workflow-body');body.replaceChildren();
 for(const task of snapshot.tasks??[]){
  if(!['failed','submitting'].includes(task.delivery) || snapshot.members.find(m=>m.id===task.toMember)?.departmentId!==selected)continue;
  const card=section(`작업 #${task.id} · ${task.delivery==='failed'?'제출 확인 필요':'CLI 제출 확인 중'}`,task.delivery==='failed'?'기존 입력에 Enter만 다시 보냅니다. 입력을 수정했다면 PC 터미널에서 확인하세요.':'CLI가 지시를 받았는지 확인하고 있습니다.');
  if(task.delivery==='failed')card.append(button('지시 재제출',()=>mutate('task.retrySubmit',{taskId:task.id}),'primary'));
  body.append(card);
 }
 if(!workflow){body.append(node('p','부장과 목표·완료 기준을 정리한 뒤 작업을 시작하세요.','muted'));return;}
 if(workflow.problem)body.append(section('확인할 문제',workflow.problem));
 const shared=node('details');shared.append(node('summary','공유 작업안'));paragraphs(shared,workflow.brief);body.append(shared);
 const chat=node('details');chat.open=workflow.phase==='clarifying';chat.append(node('summary',`부장과 대화 · ${workflow.messages?.length??0}건`));
 for(const message of workflow.messages??[])chat.append(section(message.role==='user'?'사용자':'부장',message.text));body.append(chat);
 if(workflow.meeting){const meeting=node('details');meeting.append(node('summary',`회의록 · ${workflow.meeting.contributions.length}개 의견`));meeting.append(node('p',`참석자: ${workflow.meeting.participants.map(memberName).join(', ')}`));for(const c of workflow.meeting.contributions)meeting.append(section(`${c.round}차 · ${memberName(c.memberId)}`,c.text));if(workflow.meeting.minutes)meeting.append(section('부장 결정',workflow.meeting.minutes));body.append(meeting);}
 for(const a of workflow.assignments??[]){const box=section(`${memberName(a.leadId)} · ${{queued:'선행 업무 대기',assigned:'배정됨',done:'완료',blocked:'문제 확인'}[a.status]??'대기'}`,a.task);box.append(node('p',`완료 기준: ${a.acceptance.join(' / ')}`));if(a.dependsOn?.length)box.append(node('p',`선행 담당: ${a.dependsOn.map(memberName).join(', ')}`));body.append(box);}
 if(workflow.result)body.append(section('최종 보고 · 검수',workflow.result));
}
function renderActions(){
 const phase=workflow?.phase,canDiscuss=!phase || ['clarifying','completed','cancelled'].includes(phase);
 $('discuss-form').hidden=!canDiscuss;$('discuss').disabled=!connected || !selected;$('task-text').disabled=!connected;
 const actions=$('workflow-actions');actions.replaceChildren();
 const add=(label,method,cls)=>{const el=button(label,()=>mutate(method,{departmentId:selected}),cls);el.disabled=!connected;actions.append(el);};
 if(phase==='clarifying')add('작업 시작 · 회의 소집','workflow.start','primary');
 if(['meeting','blocked'].includes(phase) && workflow.meeting && !workflow.assignments.length)add('회의 재개','workflow.resume');
 if(['executing','blocked'].includes(phase) && workflow.assignments.length)add('업무 배정 재시도','workflow.resume');
 if(phase==='review')add('검수 완료','workflow.complete','primary');
 if(phase && !['completed','cancelled'].includes(phase))add('작업 취소','workflow.cancel','danger');
}
function renderLogs(){const rows=events.filter(e=>e.memberId===memberId && ['text','reporting','error','waiting_approval','reading','editing','running'].includes(e.kind)).slice(-40).reverse();$('logs').replaceChildren(...rows.map(e=>section(`${memberName(e.memberId)} · ${e.kind==='reporting'?'보고':e.kind==='text'?'대화':e.kind} · ${new Date(e.ts).toLocaleTimeString()}`,e.detail?.text??e.detail?.summary??e.detail?.path??e.detail?.cmd??e.detail?.tool??'')));if(!rows.length)$('logs').append(node('p','아직 작업 로그가 없습니다.','muted'));}
$('department').onchange=()=>{selected=$('department').value;workflow=null;memberId='';$('task-text').value='';inboxVersion='';void refresh().catch(error);};
$('log-member').onchange=()=>{memberId=$('log-member').value;renderLogs();};
$('refresh').onclick=()=>void refresh().catch(error);
$('discuss-form').onsubmit=async event=>{event.preventDefault();const text=$('task-text').value.trim();if(!text)return;$('discuss').disabled=true;try{await mutate('workflow.discuss',{departmentId:selected,text});$('task-text').value='';}catch(e){error(e);}finally{renderActions();}};
$('device-menu').onclick=()=>{$('device-panel').hidden=false;$('device-panel').scrollIntoView({behavior:'smooth'});};
$('device-close').onclick=()=>{$('device-panel').hidden=true;};
$('disconnect-device').onclick=()=>{
 const confirm=button('확인 · 연결 해제',async()=>{
  if(!identity)return;const current=identity,signature=await proof(`pixel-office revoke v1\n${info.workstationId}\n${current.deviceId}`),storageKey=`revoke:${current.deviceId}`;
  // Atomically retain only the signed revocation and delete the private key, even while offline.
  await transaction('readwrite',store=>{store.put({kind:'revocation',storageKey,deviceId:current.deviceId,signature},storageKey);return store.delete(info.workstationId);});
  stopped=true;identity=null;clearTimeout(retryTimer);socket?.close();connected=false;clearWorkView();
  $('workspace').hidden=true;$('device-panel').hidden=true;$('pairing').hidden=false;$('pair-submit').disabled=false;$('fingerprint').textContent='';setConnection('연결 해제됨');
  $('pair-message').textContent='이 기기의 연결을 해제했습니다. PC에 연결할 수 없으면 다음 접속 때 해제 사실을 전달합니다.';await flushRevocations();
 },'danger revoke-confirm');$('device-panel').append(node('p','이 기기를 다시 사용하려면 PC에서 새로 등록해야 합니다.','revoke-confirm'),confirm);$('disconnect-device').disabled=true;
};
window.addEventListener('online',()=>{void flushRevocations().catch(error);if(identity && !connected)connect();});
window.addEventListener('hashchange',consumePairCode);
void boot().catch(error);
