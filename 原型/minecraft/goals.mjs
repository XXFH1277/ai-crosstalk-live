import {gearReady} from './gear.mjs';

// 路线长期保留；完成度始终重读背包，不把台词、旧存档或执行回执当成成果。
export const SURVIVAL_ROUTE = '先建立生存据点和稳定食物来源，再逐步探索';
export const WOOD_TARGET = 96; // 按木板等价量计算，原木可正常合成四块木板。
export const STONE_TARGET = 32; // 据点设备和工具维护的初始储备，不包含煤与原矿。
const sum=(items,test)=>(items||[]).filter(i=>test(i.name)).reduce((n,i)=>n+i.count,0);
export const woodUnits=items=>sum(items,n=>/_log$/.test(n))*4+sum(items,n=>/_planks$/.test(n));
export const stoneUnits=items=>sum(items,n=>n==='cobblestone');

export class SurvivalGoals {
  constructor({agent=false}={}){this.agent=agent;}
  assess(world){
    const online=world.filter(w=>w.status==='已入服');
    const tools=online.filter(w=>gearReady(w.inventory||[])).length;
    const wood=online.reduce((n,w)=>n+woodUnits(w.inventory),0),stone=online.reduce((n,w)=>n+stoneUnits(w.inventory),0);
    const ready=online.length===world.length&&world.length>0;
    const equipped=ready&&tools===world.length,stocked=equipped&&wood>=WOOD_TARGET&&stone>=STONE_TARGET;
    const unsafe=online.some(w=>w.danger||(Number.isFinite(w.food)&&w.food<6));
    return {ready,tools,total:world.length,wood,stone,equipped,stocked,unsafe};
  }
  snapshot(world,jobs=[]){
    const a=this.assess(world);
    const phase=a.unsafe?'safety':!a.equipped?'tools':!a.stocked?'supplies':'shelter';
    return {id:'survival-home',objective:SURVIVAL_ROUTE,phase,
      title:phase==='safety'?'优先解决危险与饥饿':phase==='tools'?'备齐两人的石镐和石剑':phase==='supplies'?'为据点和设备准备第一批材料':'搭建可避险的据点',
      status:!a.ready?'等待两人入服':a.unsafe?'需要安全恢复或食物':!jobs.some(j=>['auto','plan'].includes(j.mode)&&['执行中','等待条件'].includes(j.status))?'未自动推进（已暂停或手动任务优先）':this.agent?'游戏规划 AI 正在推进':a.stocked?'等待建造能力':'推进中',
      blocker:a.unsafe?(this.agent?'低血量暂停；有安全食物可进食。无食物或复杂避险仍可能需要玩家协助。':'危险角色暂停任务；完整避险和自动进食尚未接入，需要玩家协助。'):a.stocked?'材料达标不等于房子建成：选址、放置建筑和验收尚未接入，请先由玩家带领建家。':'',
      progress:{tools:{have:a.tools,need:a.total},wood:{have:a.wood,need:WOOD_TARGET,unit:'木板等价量'},stone:{have:a.stone,need:STONE_TARGET,unit:'圆石'}},
      milestones:[
        {id:'tools',title:'两人具备石镐和石剑',status:a.equipped?'已核实':'待准备'},
        {id:'supplies',title:'据点材料：96 木板等价量、32 圆石',status:a.stocked?'已核实':a.equipped?'进行中':'工具齐备后推进'},
        {id:'shelter',title:'选址、建造并检查可避险据点',status:'待接入建造与验收'},
        {id:'farm',title:'开田、播种、收获并储备食物',status:this.agent?'已有耕种、收获、合成与进食技能，按实际环境准备条件':'待接入耕种与补给'},
        {id:'explore',title:'装备升级后探索矿洞、地狱与末地',status:'后续路线，尚未开放'}
      ],
      assignments:jobs.map(j=>({who:j.who,mode:j.mode,goal:j.goal||null,status:j.status,note:j.note}))};
  }
  choose(view,world,jobs,job){
    const a=this.assess(world),base={objective:SURVIVAL_ROUTE};
    if(view.danger||(Number.isFinite(view.food)&&view.food<6))return {...base,stage:'blocked',id:'safety:'+view.who,title:'先恢复安全和补充食物',note:'危险或饥饿优先于材料收集；需要玩家协助恢复条件'};
    if(!a.ready)return {...base,stage:'blocked',id:'waiting-team',title:'等待同伴入服',note:'两人在线后重新核对共同缺口'};
    if(!gearReady(view.inventory||[]))return {...base,stage:'gear',quota:1,id:'tools:'+view.who,title:'先备齐自己的石镐和石剑',reason:'后续采石、据点建设和防身都依赖工具',note:'按缺失配方准备工具，材料不够先收集'};
    const deficits={wood:Math.max(0,WOOD_TARGET-a.wood),mine:Math.max(0,STONE_TARGET-a.stone)};
    const preferred=job.goal?.resourceStage||(view.who==='月月'?'mine':'wood');
    const order=[preferred,preferred==='wood'?'mine':'wood'];
    // 同伴已领取的份额也计入分工，避免最后几块资源被两人重复安排。
    const remaining=stage=>deficits[stage]-jobs.filter(j=>j.who!==view.who&&j.mode==='auto'&&j.status==='执行中'&&j.goal?.resourceStage===stage&&j.stage===stage).reduce((n,j)=>n+Math.max(0,j.quota-j.count)*(stage==='wood'?4:1),0);
    const stage=order.find(s=>remaining(s)>0);
    if(stage){
      const wood=stage==='wood',need=remaining(stage),quota=Math.min(4,Math.ceil(need/(wood?4:1)));
      return {...base,stage,quota,id:wood?'supplies:wood':'supplies:stone',resourceStage:stage,resource:wood?'logs':'cobblestone',
        title:wood?'补齐据点木料':'补齐设备与工具用圆石',reason:wood?'为建家准备木料，当前合计 '+a.wood+'/'+WOOD_TARGET+' 木板等价量':'为据点设备及工具维护储备圆石，当前合计 '+a.stone+'/'+STONE_TARGET,
        note:wood?'收集这批原木，完成后重新核对团队材料缺口':'只采本阶段需要的圆石，不用煤和原矿冒充建材'};
    }
    if(!a.equipped)return {...base,stage:'blocked',id:'waiting-tools',title:'自己的材料份额已够，等待同伴备齐工具',note:'保留共同建家目标，不追加无用途的采集'};
    if(!a.stocked)return {...base,stage:'blocked',id:'waiting-delivery',title:'剩余材料已由同伴负责',note:'等待实际入包再核对，不把同伴的计划算成库存'};
    return {...base,stage:'blocked',id:'shelter',title:'材料齐备，下一步选址建家',note:'建造与验收尚未接入，需要玩家带领；没有把材料齐备标记成房屋完成'};
  }
}
