import {gearReady} from './gear.mjs';
import {chooseActivity,explorationChoices,inActivityArea} from './autonomy.mjs';
// 有界任务独立于写词和配音运行。独立规划器负责自主任务，不能覆盖玩家指令。
export function parseTask(text, player) {
  const value=String(text||'').trim();
  if(!value||value.length>180||value.startsWith('/'))return null;
  const names=['深深','月月'].filter(n=>value.includes(n));
  const actors=names.length===1&&!/两人|你们|一起|都/.test(value)?names:['深深','月月'];
  const tail=value.replace(/^(?:深深|月月|两人|你们|大家)[，,：:\s]*/,'').replace(/[。！!]$/,'');
  if(/^(?:请)?(?:停止|停下|别动|取消|不要|别)(?:所有)?(?:任务|动作|挖矿|砍树|采木|打怪|跟随|走动)?$/.test(tail))return {mode:'stop',actors};
  if(/^(?:别|不要|不用)(?:再)?跟(?:着)?我(?:了)?[，,\s]*(?:自己玩|自由活动|各玩各的)?$/.test(tail))return {mode:'auto',actors,quota:4,player};
  if(/[?？]|吗|是不是|有没有|能不能|在干嘛|为什么|别|不要|停止|取消/.test(tail))return null;
  const imperative=tail.replace(/^(?:请|帮我|一起|都|先|去)\s*/,'');
  if(/^(自由玩|自己玩|自主玩|自由活动|自主活动|各自活动|各玩各的)$/.test(imperative))return {mode:'auto',actors,quota:4,player};
  if(/^(开始生存|继续生存计划|生存建家)$/.test(imperative))return {mode:'auto',actors,quota:4,player};
  if(/^(制作工具|准备工具)$/.test(imperative))return {mode:'gear',actors,quota:1,player};
  if(/^(学会种田|开田|种田|耕田|开垦农田|种小麦)$/.test(imperative))return {mode:'plan',actors,quota:4,player,objective:'准备所需材料和工具，在水边开田种植小麦',requiredSkill:'farm'};
  if(/^(收获小麦|收麦子)$/.test(imperative))return {mode:'plan',actors,quota:4,player,objective:'收获成熟小麦并补种',requiredSkill:'harvest'};
  if(/^(跟着我|跟我|过来|集合)$/.test(imperative))return {mode:'follow',actors,player};
  const follow=imperative.match(/^跟随\s*([A-Za-z0-9_]{1,16})$/);
  if(follow)return {mode:'follow',actors,player:follow[1]};
  const count=value.match(/\d+/),quota=count?Number(count[0]):4;
  if(/^(砍树|采木|挖木)(?:\s*\d+\s*(?:块|个|根)?)?$/.test(imperative))return {mode:'wood',actors,quota,player};
  if(/^(挖矿|挖石头|采煤)(?:\s*\d+\s*(?:块|个)?)?$/.test(imperative))return {mode:'mine',actors,quota,player};
  if(/^(打怪|打僵尸|打骷髅)$/.test(imperative))return {mode:'fight',actors,quota:1,player};
  return null;
}

const countItems=(view,mode,resource)=>(view.inventory||[]).filter(i=>mode==='wood'?/_log$/.test(i.name):resource==='cobblestone'?i.name==='cobblestone':/^(cobblestone|cobbled_deepslate|coal|raw_iron|raw_copper)$/.test(i.name)).reduce((n,i)=>n+i.count,0);
export function validateTask(command){
  if(!['auto','plan','wood','mine','fight','follow','gear'].includes(command.mode))throw Error('不支持的任务');
  if(command.mode!=='follow'&&(!Number.isInteger(command.quota)||command.quota<1||command.quota>16))throw Error('一次任务数量应为 1～16');
}
export class GameTasks {
  constructor({bridges,observe,options,execute,publish,goals=null,planner=null,now=Date.now}){Object.assign(this,{bridges,observe,options,execute,publish,goals,planner,now});this.jobs=new Map();this.serial=0;this.claims=new Map();}
  snapshot(){return [...this.jobs.values()].map(j=>({who:j.who,id:j.id,mode:j.mode,stage:j.stage,quota:j.quota,count:j.count,note:j.note,status:j.status,player:j.player,anchor:j.anchor,goal:j.goal||null}));}
  goalSnapshot(){return this.goals?.snapshot(this.bridges.map(b=>this.observe(b)),this.snapshot())||null;}
  stop(names=this.bridges.map(b=>b.who)){
    for(const who of names){const j=this.jobs.get(who);if(j){j.controller?.abort();if(j.claim&&this.claims.get(j.claim)===j.id)this.claims.delete(j.claim);this.jobs.delete(who);}this.planner?.states.delete(who);this.bridges.find(b=>b.who===who)?.stop();}
  }
  assign(command){
    const selected=this.bridges.filter(b=>command.actors.includes(b.who));
    if(!selected.length||!selected.every(b=>b.state.status==='已入服'))throw Error('选中的角色还未进入世界');
    validateTask(command);
    this.stop(selected.map(b=>b.who));
    selected.forEach((b,i)=>{
      const stage=command.mode==='auto'?'rest':command.mode;
      const quota=command.mode==='follow'?0:['fight','gear'].includes(command.mode)?1:Math.floor(command.quota/selected.length)+(i<command.quota%selected.length?1:0);
      const j={id:++this.serial,who:b.who,mode:command.mode,stage,quota,count:0,baseline:countItems(this.observe(b),stage),player:command.player,objective:command.objective,requiredSkill:command.requiredSkill,
        status:quota===0&&stage!=='follow'?'已完成':'执行中',note:stage==='follow'?'与玩家会合并持续跟随':'准备开始任务',nextAt:0,started:this.now(),failures:0,scans:0,controller:null,avoided:new Map(),
        anchor:this.observe(b).position?{...this.observe(b).position}:null,round:i,lastAuto:{},visited:[],restUntil:0,restCount:0};
      this.jobs.set(b.who,j);
    });
    this.publish({type:'mission',text:'已安排任务：'+selected.map(b=>b.who).join('、')+' '+({auto:'自主游玩',plan:command.objective,wood:'收集原木',mine:'采矿',fight:'协作打怪',follow:'跟随玩家',gear:'按生存配方制作工具'}[command.mode])});
  }
  startDefault(player){if(this.jobs.size===0)this.assign({mode:'auto',actors:this.bridges.map(b=>b.who),quota:4,player});}
  update(j,note,status='执行中'){if(j.note!==note||j.status!==status){j.note=note;j.status=status;this.publish({type:'mission',who:j.who,text:note,status,taskId:j.id});}}
  regroup(j,reason){
    this.bridges.find(b=>b.who===j.who)?.stop();
    j.stage='rest';j.quota=0;j.count=0;j.restCount++;
    const unsafe=/危险|饥饿|等待有效位置/.test(reason);
    j.forceExplore=!unsafe&&(this.goals?/缺少|超时|未成功|没有|不可达|阻断/.test(reason):!/自主巡视/.test(reason));
    j.restUntil=this.now()+(unsafe?5000:1500);j.nextAt=j.restUntil;j.failures=0;
    this.update(j,reason+(unsafe?'；暂时避险，稍后复查':'；正在选择下一处目标'));
  }
  tick(){
    for(const j of this.jobs.values()){
      const b=this.bridges.find(b=>b.who===j.who),view=this.observe(b);
      if(view.status!=='已入服'||view.danger){if(j.status!=='已停止'){j.controller?.abort();b.stop();this.update(j,view.danger?'血量危险，任务已停止，等待新的指令':'角色离线或死亡，任务已停止，重连后请重新下令','已停止');}continue;}
      if(['已停止','已完成','失败'].includes(j.status))continue;
      if(j.controller||this.now()<j.nextAt)continue;
      if(b.crafting)continue;
      if(this.planner&&['auto','plan','wood','mine'].includes(j.mode)){this.planner.tick(b,j,this);continue;}
      if(j.mode==='auto'&&['rest','blocked'].includes(j.stage)){
        if(this.now()<j.restUntil)continue;
        const plan=this.goals?.choose(view,this.bridges.map(b=>this.observe(b)),this.snapshot(),j);
        const next=chooseActivity(view,j,this.now(),plan);
        if(next.stage==='blocked'){b.stop();j.stage='blocked';j.quota=0;j.count=0;j.nextAt=this.now()+5000;j.forceExplore=false;this.update(j,next.note,'等待条件');continue;}
        if(next.stage==='rest'){this.regroup(j,next.note);continue;}
        b.stop();j.stage=next.stage;j.resource=next.resource;j.quota=next.quota??(next.stage==='explore'?1:2);j.count=0;j.baseline=countItems(view,j.stage,j.resource);j.started=this.now();j.failures=0;j.nextAt=0;j.exploreSteps=0;
        this.update(j,next.note);
      }
      if(j.stage==='gear'&&gearReady(view.inventory||[])){j.count=1;b.stop();if(j.mode==='auto')this.regroup(j,'石镐和石剑已在背包，继续核对下一阶段');else this.update(j,'石镐和石剑已在背包，准备完成','已完成');continue;}
      if(j.stage==='wood'||j.stage==='mine'){
        j.count=Math.max(0,countItems(view,j.stage,j.resource)-j.baseline);
        if(j.count>=j.quota){if(j.mode==='auto')this.regroup(j,'采集已进背包 '+j.count+'/'+j.quota);else{b.stop();this.update(j,'采集已进背包 '+j.count+'/'+j.quota,'已完成');}continue;}
      }
      if(j.stage==='follow'){
        if(!view.players?.includes(j.player)){b.stop();j.failures++;this.update(j,'看不到指定玩家，正在等待重新出现');j.nextAt=this.now()+2000;if(j.failures>=8)this.update(j,'指定玩家持续不可见，任务已停止','失败');continue;}
        j.failures=0;if(b.state.target!==j.player)b.follow(j.player);
        this.update(j,'跟随 '+j.player+'；玩家移动时继续前进');j.nextAt=this.now()+2000;
        continue;
      }
      const deadline=j.stage==='gear'?240000:90000;
      if(this.now()-j.started>deadline){if(j.mode==='auto')this.regroup(j,'采集超时，未凑齐目标');else this.update(j,'任务超过 '+deadline/1000+' 秒未完成，已停止','失败');b.stop();continue;}
      if(j.searchUntil<this.now())j.searchTargets=[];
      const result=j.stage==='explore'?{choices:explorationChoices(view,j),reason:'附近暂时没有新的安全落脚点'}:this.options(b,j);
      if(j.mode==='auto'&&result.searchTargets){j.searchTargets=result.searchTargets;j.searchUntil=this.now()+20000;}
      const choices=(result.choices||[]).filter(c=>!this.claims.has(c.key)&&(j.avoided.get(c.key)||0)<=this.now()&&(j.mode!=='auto'||j.stage==='explore'||inActivityArea(c,j,b)));
      let choice=choices[0];
      if(!choice){
        if(result.blocked){if(j.mode==='auto')this.regroup(j,result.blocked);else{this.update(j,result.blocked,'失败');b.stop();}continue;}
        if(!choice){j.failures++;j.nextAt=this.now()+4000;this.update(j,(result.reason||'附近没有可安全处理的目标')+'，正在重新观察');if(j.mode==='auto'){this.regroup(j,j.stage==='explore'?'附近没有可走的安全地面':'附近缺少可达资源');}else if(j.failures>=3)this.update(j,(result.reason||'附近没有可达目标')+'；请靠近目标后重新下令','失败');continue;}
      }
      j.claim=choice.key;this.claims.set(choice.key,j.id);const controller=j.controller=new AbortController();
      this.update(j,choice.label);const session=b.session;
      Promise.resolve().then(()=>{if(controller.signal.aborted||this.jobs.get(j.who)!==j)throw Error('任务已取消');return this.execute(b,choice,controller.signal);}).then(result=>{
        if(controller.signal.aborted||this.jobs.get(j.who)!==j||b.session!==session)return;
        j.failures=0;j.nextAt=this.now()+1000;
        if(result?.accessStep)j.accessSteps=(j.accessSteps||0)+1;
        if(j.mode==='auto'&&j.stage==='explore'){
          j.visited.push([Math.floor(choice.position.x),Math.floor(choice.position.y),Math.floor(choice.position.z)].join(','));j.visited=j.visited.slice(-12);
          if(++j.exploreSteps>=3){
            const position=this.observe(b).position;if(position)j.anchor={...position};
            this.regroup(j,'已到新的探索位置');j.forceExplore=false;
          }else this.update(j,'自主巡视中，继续看看附近另一处空地');return;
        }
        if(j.stage==='fight'&&result?.defeated){j.count++;this.update(j,'已观察到目标死亡','已完成');}
        else this.update(j,result?.text||'动作结束，重新核对实际进度');
      }).catch(error=>{
        if(controller.signal.aborted||this.jobs.get(j.who)!==j||b.session!==session)return;
        const message=String(error?.message||''),reason=/no path/i.test(message)?'寻路器找不到路':/方块已不可采集/.test(message)?'目标方块已变化或不在可挖范围':/工具不足/.test(message)?'工具不足':/超时|timeout/i.test(message)?'动作超时':/目标.*消失|掉落物已消失/.test(message)?'目标已消失':'当前动作被阻断';
        this.publish({type:'task-debug',who:j.who,taskId:j.id,kind:choice.kind,block:choice.block,position:choice.position,error:message.slice(0,180)});
        j.avoided.set(choice.key,this.now()+30000);j.failures++;j.nextAt=this.now()+1500;this.update(j,reason+'，暂时跳过此目标并选择另一处');
        if(j.failures>=6){if(j.mode==='auto')this.regroup(j,'连续尝试未成功');else this.update(j,'连续六次未成功，任务已停止','失败');}
      }).finally(()=>{if(this.claims.get(choice.key)===j.id)this.claims.delete(choice.key);if(j.controller===controller)j.controller=null;});
    }
  }
}
