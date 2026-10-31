import {SKILLS,knowledge,validatePlan} from './skill-knowledge.mjs';
import {SkillMemory} from './skill-memory.mjs';
import {SURVIVAL_ROUTE} from './goals.mjs';

export function survey(bot){
  const groups={};
  for(const pattern of [/_log$/,/_ore$/,/^stone$/,/^water$/,/^short_grass$/,/^(farmland|wheat)$/,/^crafting_table$/])
  for(const p of bot.findBlocks({matching:b=>pattern.test(b.name),maxDistance:32,count:24})){
    const b=bot.blockAt(p);if(!b)continue;const g=groups[b.name]||={count:0,nearest:100,visible:0};g.count++;g.nearest=Math.min(g.nearest,Math.round(p.distanceTo(bot.entity.position)));if(bot.canSeeBlock(b))g.visible++;
  }
  return groups;
}

// 任务完成/失败才重新规划；语音生成和播放不会控制行动的生死。
export class GamePlanner {
  constructor({think,execute,observe,bridges,memory=new SkillMemory(),now=Date.now}){
    Object.assign(this,{think,execute,observe,bridges,memory,now});this.states=new Map();this.queue=Promise.resolve();
  }
  snapshot(){return {memory:this.memory.snapshot(),actors:[...this.states].map(([who,s])=>({who,phase:s.phase,goal:s.plan?.goal||'',step:s.cursor||0,total:s.plan?.steps.length||0,last:s.last||'',lookup:s.lookup||''}))};}
  async request(context,signal){
    // 两人的规划请求串行，避免同时规划时彼此都看不到对方的职责；不阻塞正在执行的技能。
    const previous=this.queue;let release;this.queue=new Promise(r=>release=r);
    await previous;try{signal.throwIfAborted();return await this.think(context(),signal);}finally{release();}
  }
  tick(b,j,tasks){
    let s=this.states.get(b.who);
    if(!s||s.job!==j.id){s={job:j.id,plan:null,cursor:0,feedback:[],facts:[],phase:'准备规划',failures:0};this.states.set(b.who,s);}
    const controller=j.controller=new AbortController(),signal=controller.signal,session=b.session;
    const valid=()=>!signal.aborted&&tasks.jobs.get(j.who)===j&&b.session===session;
    const update=(text,status='执行中')=>{if(valid()){s.last=text;tasks.update(j,text,status);}};
    const run=async()=>{
      if(!s.plan&&['wood','mine'].includes(j.mode)){
        const resource=j.mode==='wood'?'logs':'cobblestone';
        s.plan={goal:j.mode==='wood'?'按指令连续收集原木':'按指令连续收集圆石',steps:[{skill:'collect',item:resource,count:j.quota}]};s.cursor=0;
        j.goal={title:s.plan.goal,id:'manual:'+j.id};
      }
      if(!s.plan){
        s.phase='思考下一步';j.stage='planning';update('正在根据背包、环境和上次结果规划下一步');
        const context=()=>({who:b.who,objective:j.objective||SURVIVAL_ROUTE,world:this.bridges.map(x=>this.observe(x)),
          team:tasks.snapshot(),plans:this.snapshot().actors,route:tasks.goalSnapshot(),skills:SKILLS,
          survey:b.bot.findBlocks?survey(b.bot):{},facts:s.facts.slice(-6),feedback:s.feedback.slice(-6),experience:this.memory.context()});
        for(let lookupCount=0;lookupCount<3;lookupCount++){
          const plan=validatePlan(await this.request(context,signal));if(!valid())return;
          if(plan.lookup){const fact=knowledge(b.bot,plan.lookup);s.lookup=plan.lookup.kind+'：'+plan.lookup.query;s.facts.push(fact);update('查阅'+(plan.lookup.kind==='recipe'?'当前版本合成表：':'技能用法：')+plan.lookup.query);continue;}
          const stateNow=this.observe(b),signature=JSON.stringify({steps:plan.steps,inventory:stateNow.inventory,position:stateNow.position});
          if(signature===s.failedSignature)throw Error('相同条件下该计划刚刚失败，必须先补前置或探索换位置，不能原样重试');
          s.signature=signature;s.plan=plan;s.cursor=0;s.before=stateNow.inventory;j.goal={id:'ai:'+j.id,title:plan.goal,objective:j.objective||SURVIVAL_ROUTE};break;
        }
        if(!s.plan)throw Error('连续查询资料后仍未形成可执行计划');
      }
      const step=s.plan.steps[s.cursor];s.phase='执行技能';j.stage=({collect:'mine',farm:'farm',craft:'craft',prepare_tools:'gear',explore:'explore'}[step.skill]||step.skill);
      if(step.skill==='collect'&&/log/.test(step.item))j.stage='wood';
      j.quota=step.count;j.count=0;
      update(s.plan.goal+'：'+step.skill+(step.item?' '+step.item:'')+'（第 '+(s.cursor+1)+'/'+s.plan.steps.length+' 步）');
      const result=await this.execute(b,step,signal,(note,count)=>{if(valid()){j.count=count??j.count;update(note);}});
      if(!valid())return;
      if(!result?.ok)throw Error(result?.text||'技能未通过结果检查');
      j.count=step.count;
      s.feedback.push({step,result:result.text,inventory:this.observe(b).inventory});s.feedback=s.feedback.slice(-6);s.cursor++;s.failures=0;
      update(result.text);j.nextAt=this.now()+300;
      if(s.cursor===s.plan.steps.length){
        this.memory.record(s.plan,true,result.text);s.plan=null;s.phase='已核实本轮结果';
        // 自主目标持续推进；显式耕作任务要求最后一步确实完成指定技能。
        if(['wood','mine'].includes(j.mode)||(j.mode==='plan'&&step.skill===j.requiredSkill)){tasks.update(j,result.text,'已完成');s.phase='已完成';}
      }
    };
    Promise.resolve().then(run).catch(error=>{
      if(!valid())return;
      const reason=String(error?.message||'规划或动作失败').slice(0,180);
      s.feedback.push({failed:s.plan?.steps[s.cursor]||'planning',reason,inventory:this.observe(b).inventory});
      s.feedback=s.feedback.slice(-6);
      if(s.plan){this.memory.record(s.plan,false,reason);const stateNow=this.observe(b);s.failedSignature=JSON.stringify({steps:s.plan.steps,inventory:stateNow.inventory,position:stateNow.position});}
      s.plan=null;s.phase='根据阻碍重新规划';s.failures++;
      j.nextAt=this.now()+(s.failures>=3?15000:2000);
      if(['wood','mine'].includes(j.mode)){update(reason+'；已保留实际获得物品，请换到可达资源旁重试','失败');s.phase='需要新的指令';}
      else update(reason+'；将根据真实缺口调整方案','等待条件');
    }).finally(()=>{if(j.controller===controller)j.controller=null;});
  }
}
