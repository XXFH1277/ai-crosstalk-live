// 双人决策和两句预缓冲。动作在实际播放前复核执行，受击清空过时缓存。
import { GamePacing } from './pacing.mjs';
export class GameAI {
 constructor({bridges,observe,act,generate,voice,publish,tasks=null,leisure=null,audience=null,onSpeech=()=>{},now=Date.now}){
  Object.assign(this,{bridges,observe,act,generate,voice,publish,tasks,leisure,audience,onSpeech,now});
  this.enabled=false;this.busy=false;this.history=[];this.turn=0;this.epoch=0;this.sequence=0;
  this.pending=null;this.ready=[];this.nextAt=0;this.playAt=0;this.owner=null;this.leaseAt=0;
  this.controller=null;this.phase='已暂停';this.warming=true;this.warmAt=0;
  this.pacing=new GamePacing(now);this.focusEpoch=0;
 }
 snapshot(){return {enabled:this.enabled,phase:this.phase,history:this.history.slice(-12),pending:this.pending,buffered:this.ready.length,bufferTarget:2,owner:this.owner,textOnly:!!this.textOnly};}
 world(){const jobs=this.tasks?.snapshot()||[],goal=this.tasks?.goalSnapshot?.();return this.bridges.map(b=>{const w=this.observe(b),mission=jobs.find(j=>j.who===b.who);return this.tasks?{...w,mission:mission||null,goal,choices:w.choices.filter(c=>c.type==='wait')} : w;});}
 hear(player,text){this.invalidate();this.chat={player,text,until:this.now()+45000};this.history.push({who:player,text,status:'玩家消息'});if(text.includes('月月')&&!text.includes('深深'))this.turn=1;else this.turn=0;this.pacing.open('玩家主动说话，请先直接回应玩家，再由搭档简短接话',true);}
 stamps(){return this.bridges.map(b=>b.session+':'+b.rules.states.get(b.who)?.revision);}
 matches(stamps){return stamps.every((s,i)=>s===this.stamps()[i]);}
 heartbeat(client){if(client===this.owner)this.leaseAt=this.now();}
 start(client,{textOnly=false,player}={}){
  if(typeof client!=='string'||client.length<8||client.length>100)throw Error('播放页面标识无效');
  if(this.enabled&&client!==this.owner&&!this.textOnly)throw Error('另一页面正在播放，请先暂停');
  if(!this.bridges.every(b=>b.state.status==='已入服'))throw Error('请先让两人都进入世界');
  if(this.enabled)this.invalidate();
  this.owner=client;this.leaseAt=this.now();this.enabled=true;this.warming=true;this.warmAt=this.now();
  this.textOnly=textOnly;this.player=player||this.bridges[0].state.players?.find(p=>!this.bridges.some(b=>b.username===p));
  this.tasks?.startDefault(this.player);
  this.pacing.reset();this.history=[];this.focusEpoch++;this.phase='预缓冲 0/2 句';this.nextAt=0;this.playAt=0;
 }
 stop(){
  this.leisure?.cancel();
  this.enabled=false;++this.epoch;this.controller?.abort();this.pending=null;this.ready=[];this.phase='已暂停';
  this.tasks?.stop();for(const b of this.bridges)b.stop();this.publish({type:'cancel'});
 }
 invalidate(){
  this.leisure?.cancel();
  ++this.epoch;this.controller?.abort();this.ready=[];
  if(this.pending){this.publish({type:'cancel',id:this.pending.id});this.pending=null;}
  this.warming=false;
  if(this.enabled){this.phase='重新观察，旧缓存已清空';this.nextAt=this.now()+500;}
 }
 acknowledge(client,id,status){
  if(client!==this.owner||this.pending?.id!==id)return false;
  if(status==='played'){this.history.push({who:this.pending.who,text:this.pending.text,status:this.textOnly?'已发送到游戏':'已播放'});this.history=this.history.slice(-16);}
  this.pending=null;this.playAt=this.now()+400;this.phase='接话缓冲 '+this.ready.length+'/2 句';
  if(status==='error')this.stop();return true;
 }
 dispatch(){
  const line=this.ready.shift(),actor=this.bridges.find(b=>b.who===line.who);
  const choice=this.world().find(w=>w.who===actor.who).choices.find(c=>c.id===line.action);
  if(!choice||!this.matches(line.stamps)||this.now()-line.createdAt>45000||(line.expiresAt&&this.now()>=line.expiresAt)){this.invalidate();return;}
  try{this.act(actor,choice);}catch{this.invalidate();return;}
  this.publish({type:'decision',who:actor.who,text:choice.label});
  this.pending={type:'speech',id:++this.sequence,who:line.who,text:line.text,audio:line.audio,seconds:line.seconds,owner:this.owner,replyTo:line.replyTo,deadline:this.now()+line.seconds*1000+20000};
  this.warming=false;this.phase=line.who+'说话中';this.publish(this.pending);
  this.onSpeech(this.pending);if(this.textOnly)this.acknowledge(this.owner,this.pending.id,'played');
 }
 async tick(){
  if(!this.enabled)return;
  if(this.textOnly&&this.bridges.some(b=>b.state.players?.includes(this.player)))this.leaseAt=this.now();
  if(this.now()-this.leaseAt>15000){this.stop();this.phase='播放页面离线，已暂停';return;}
  if(!this.bridges.every(b=>b.state.status==='已入服')){this.stop();return;}
  if(this.pending&&this.now()>this.pending.deadline){this.stop();this.phase='播放未确认，已暂停';return;}
  this.tasks?.tick();
  const world=this.world();
  if(this.pacing.update(world)){
   this.leisure?.cancel();
   // 普通任务进度让待播计划失效，但不掐断已经说到一半的句子。
   ++this.focusEpoch;++this.epoch;this.controller?.abort();this.ready=[];this.warming=false;
   this.history=this.history.slice(-2);this.nextAt=this.now()+500;
  }
  if(this.ready.some(l=>!this.matches(l.stamps)||this.now()-l.createdAt>45000||(l.expiresAt&&this.now()>=l.expiresAt))){this.invalidate();return;}
  // 先取得唯一播放权；任务执行器仍照常运行。
  if(this.audience&&!this.audience.ready){if(this.pending||this.ready.length||this.controller)this.invalidate();this.phase=this.audience.status;return;}
  if(!this.pending&&this.ready.length&&this.now()>=this.playAt&&(!this.warming||this.ready.length>=2||this.now()-this.warmAt>=20000))this.dispatch();
  if(this.busy||this.ready.length>=2||this.now()<this.nextAt)return;
  this.busy=true;
  const epoch=this.epoch,started=this.now(),actor=this.bridges[this.turn%this.bridges.length],stamps=this.stamps();
  const valid=()=>this.enabled&&epoch===this.epoch&&this.now()-started<45000&&this.matches(stamps);
  const controller=this.controller=new AbortController();
  const pacing={...this.pacing.directive(),playerMessage:this.chat&&this.chat.until>this.now()?this.chat:null},focusEpoch=this.focusEpoch;
  const leisure=this.leisure?.choose(world,pacing,{player:!!pacing.playerMessage,occupied:!!this.ready.length});
  if(leisure)Object.assign(pacing,{allowSpeech:true,remaining:leisure.remaining,leisure,instruction:leisure.remaining===1?'最后一句落包袱并收尾，不追问、不延长。':'两人小段子，先铺一个具体矛盾，下一句由搭档收尾。'});
  const context=[...this.history,...(this.pending?[{who:this.pending.who,text:this.pending.text,status:'播放中'}]:[]),...this.ready.map(l=>({who:l.who,text:l.text,status:'待播放'}))];
  try{
   if(!pacing.allowSpeech&&(this.pending||this.ready.length))return;
   if(!pacing.allowSpeech&&this.tasks){this.phase='自主行动持续执行 · 等待下一轮接话';this.nextAt=this.now()+1000;return;}
   this.phase=this.pending?this.pending.who+'说话中 · '+actor.who+'准备下一句':pacing.allowSpeech?'准备接话 · '+actor.who+'想话中':'任务继续执行 · '+actor.who+'观察现场';
   const result=await this.generate(actor.who,world,context,controller.signal,pacing);
   if(!valid()||(leisure&&this.now()>=leisure.expiresAt))return;
   if(!this.observe(actor).choices.some(c=>c.id===result.action))throw Error('动作已失效');
   if(!pacing.allowSpeech||!result.text?.trim()){
    const choice=this.observe(actor).choices.find(c=>c.id===result.action);
    this.act(actor,choice);++this.turn;
    this.publish({type:'decision',who:actor.who,text:'安静行动：'+choice.label});
    if(!this.pending)this.phase='专心游戏，等新情况再接话';
    this.nextAt=this.now()+4000;return;
   }
   this.phase=this.pending?this.pending.who+'说话中 · '+actor.who+'配音中':'预缓冲 '+this.ready.length+'/2 · '+actor.who+'配音中';
   const audio=this.textOnly?{url:'',seconds:0}:await this.voice(actor.who,result.text);
   if(!valid()||(leisure&&this.now()>=leisure.expiresAt))return;
   if(focusEpoch!==this.focusEpoch)return;
   if(leisure)this.leisure.reserve();else this.pacing.reserve();
   if(pacing.playerMessage&&this.pacing.remaining<=0)this.chat=null;
   this.ready.push({who:actor.who,text:result.text,action:result.action,audio:audio.url,seconds:audio.seconds,stamps,replyTo:pacing.playerMessage?.player,createdAt:started,expiresAt:leisure?.expiresAt});++this.turn;
  }catch{
   if(epoch===this.epoch&&this.enabled){this.phase='生成或配音暂不可用，缓冲不足时等待';this.publish({type:'notice',text:this.phase});this.nextAt=this.now()+12000;}
  }finally{
   this.busy=false;if(this.controller===controller)this.controller=null;
   if(this.nextAt<this.now())this.nextAt=this.now()+100;
  }
 }
}
