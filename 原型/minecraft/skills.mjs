import navigation from 'mineflayer-pathfinder';
import {Vec3} from 'vec3';
import {COLLECT,itemCount,inventory,recipes} from './skill-knowledge.mjs';
import {gearReady} from './gear.mjs';
import {observe} from './play.mjs';
import {explorationChoices} from './autonomy.mjs';

// collect/craft/farm 的分步方式参考并适配 Mindcraft MIT 技能库，来源见 vendor/mindcraft/README.md。
// 不执行生成的 JavaScript，不开放作弊命令；所有成果重新读取游戏状态。
const {GoalLookAtBlock,GoalNear,GoalFollow}=navigation.goals;
const claims=new Map(),histories=new WeakMap();
const cropNames={wheat_seeds:'wheat',carrot:'carrots',potato:'potatoes'};
const edible=/^(bread|apple|baked_potato|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_rabbit|cooked_cod|cooked_salmon|carrot|melon_slice|sweet_berries)$/;
const label={collect:'连续采集',craft:'合成',farm:'耕地播种',harvest:'收获补种',explore:'寻找条件',eat:'补充食物',prepare_tools:'准备工具',wait:'短暂等待'};
export function hydrated(bot,pos){
  for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)for(const y of [0,1])if(bot.blockAt(pos.offset(x,y,z))?.name==='water')return true;
  return false;
}
export async function executeSkill(bridge,step,parentSignal,progress=()=>{},dependencies={}){
  const bot=bridge.bot,session=bridge.session,epoch=bridge.actionEpoch;
  if(!bot||bridge.state.status!=='已入服')throw Error('角色未入服');
  const controller=new AbortController(),signal=controller.signal;
  const active=()=>bridge.bot===bot&&bridge.session===session&&bridge.actionEpoch===epoch;
  const halt=()=>{if(active()){bot.pathfinder.setGoal(null);bot.stopDigging();bot.clearControlStates();bot.deactivateItem?.();}};
  const cancel=()=>{controller.abort();halt();};parentSignal.addEventListener('abort',cancel,{once:true});if(parentSignal.aborted)cancel();
  let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;cancel();},120000);
  const check=()=>{if(timedOut)throw Error('技能超过两分钟，保留已获得物品并重新规划');signal.throwIfAborted();if(!active())throw Error('行动已被停止或世界已切换');if(bridge.state.danger)throw Error('血量危险，停止技能');};
  const pause=ms=>new Promise((resolve,reject)=>{check();const abort=()=>{clearTimeout(t);reject(Error('已取消'));};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
  const run=async(fn,ms=15000)=>{
    check();let timer,onAbort;
    try{return await Promise.race([Promise.resolve().then(()=>{check();return fn();}),new Promise((_,reject)=>{
      timer=setTimeout(()=>{halt();reject(Error('动作超时'));},ms);onAbort=()=>reject(Error(timedOut?'技能超过两分钟':'已取消'));signal.addEventListener('abort',onAbort,{once:true});
    })]);}finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  };
  const travel=async(goal,ms=8000)=>{
    await run(()=>bot.pathfinder.goto(goal),ms);check();
    for(let i=0;i<20&&!goal.isEnd(bot.entity.position.floored());i++)await pause(50);
    // pathfinder 2.4.5 的 goto 在空路径事件时也会 resolve，不能把回调当作到达证明。
    if(!goal.isEnd(bot.entity.position.floored())){halt();throw Error('寻路结束但没有实际到达目标');}
  };
  const goBlock=async block=>{
    if(bot.canDigBlock(block)&&(block.boundingBox==='empty'||bot.canSeeBlock(block)))return;
    if(block.boundingBox==='empty')await travel(new GoalNear(block.position.x,block.position.y,block.position.z,2));
    else await travel(new GoalLookAtBlock(block.position,bot.world,{reach:4.2}));
    check();
  };
  const MovementClass=dependencies.Movements||navigation.Movements;
  const oldMovements=bot.pathfinder.movements,moves=new MovementClass(bot),digSafety=new MovementClass(bot);
  digSafety.canDig=true;
  Object.assign(moves,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,maxDropDown:1,scafoldingBlocks:[]});
  bot.pathfinder.setMovements(moves);
  const activity=bridge.state.activity={kind:step.skill,label:label[step.skill]};
  let h=histories.get(bot);if(!h){h={avoided:new Map(),visited:[],round:0};histories.set(bot,h);}
  for(const [key,until] of h.avoided)if(until<Date.now()||h.avoided.size>256)h.avoided.delete(key);
  const nearby=(matching,distance=32,count=96)=>bot.findBlocks({matching,maxDistance:distance,count}).map(p=>bot.blockAt(p)).filter(Boolean).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
  const equip=async item=>{if(!item)throw Error('背包缺少所需工具或物品');await run(()=>bot.equip(item,'hand'));};
  const tool=async block=>{
    const items=bot.inventory.items(),pick=items.filter(i=>/_pickaxe$/.test(i.name)).sort((a,b)=>['wooden','golden','stone','iron','diamond','netherite'].findIndex(n=>b.name.startsWith(n))-['wooden','golden','stone','iron','diamond','netherite'].findIndex(n=>a.name.startsWith(n)))[0];
    const needed=/stone|_ore$/.test(block.name),item=needed?pick:items.find(i=>/_axe$/.test(i.name));
    if(needed&&!pick)throw Error('缺少镐，先合成镐再采矿');
    if(item)await equip(item);
    if(!block.canHarvest(bot.heldItem?.type??null))throw Error('工具等级不足，先升级工具');
  };
  const pickup=async()=>{
    const items=Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.position?.distanceTo(bot.entity.position)<6).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
    for(const item of items.slice(0,4)){
      check();try{await travel(new GoalFollow(item,.7),7000);}catch(e){check();}
      await pause(300);
    }
  };
  try{
    check();
    if(step.skill==='collect'){
      if(!COLLECT[step.item]&&!bot.registry.blocksByName[step.item])throw Error('当前版本不存在这种原木');
      const pattern=COLLECT[step.item]||new RegExp('^'+step.item+'$'),base=itemCount(bot,step.item);let broken=0,misses=0,access=0,last='附近没有可采集资源';
      const openStair=async()=>{
        if(step.item!=='cobblestone'||access>=6||!bot.inventory.items().some(i=>/_pickaxe$/.test(i.name)))return false;
        const p=bot.entity.position.floored();
        const natural=/^(dirt|grass_block|stone|granite|diorite|andesite|deepslate)$/;
        const air=/^(air|cave_air|short_grass|snow)$/;
        for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const feet=p.offset(x,-1,z),ground=bot.blockAt(feet.offset(0,-1,0)),soil=bot.blockAt(feet),head=bot.blockAt(feet.offset(0,1,0)),above=bot.blockAt(feet.offset(0,2,0));
          if(!natural.test(ground?.name)||!natural.test(soil?.name)||!(natural.test(head?.name)||air.test(head?.name))||!air.test(above?.name))continue;
          const targets=[head,soil].filter(b=>!air.test(b.name));
          if(targets.some(b=>!bot.canDigBlock(b)||!digSafety.safeToBreak(b)))continue;
          const keys=targets.map(b=>b.position.toString());if(keys.some(k=>claims.has(k)))continue;
          keys.forEach(k=>claims.set(k,bridge.who));
          try{
            progress('沿当前采矿目标开浅阶梯，第 '+(access+1)+'/6 阶；保持收集 '+step.count+' 个圆石的目标');
            for(const target of targets){check();await tool(target);await run(()=>bot.dig(target),15000);await pause(200);}
            await travel(new GoalNear(feet.x+.5,feet.y,feet.z+.5,0));check();access++;return true;
          }finally{keys.forEach(k=>claims.delete(k));}
        }
        return false;
      };
      while(itemCount(bot,step.item)-base<step.count&&broken<Math.max(step.count*5,12)&&misses<8){
        check();const p=bot.entity.position;
        const blocks=nearby(b=>pattern.test(b.name)).filter(b=>!claims.has(b.position.toString())&&(h.avoided.get(b.position.toString())||0)<Date.now()&&!(b.position.x===Math.floor(p.x)&&b.position.z===Math.floor(p.z)&&b.position.y<p.y));
        blocks.sort((a,b)=>Number(bot.canSeeBlock(b))-Number(bot.canSeeBlock(a)));
        if((!blocks.length||!blocks.some(b=>bot.canSeeBlock(b)))&&await openStair())continue;
        if(!blocks.length)break;
        const block=blocks[0],key=block.position.toString();claims.set(key,bridge.who);
        try{
          await tool(block);await goBlock(block);check();
          const current=bot.blockAt(block.position);if(!current||!pattern.test(current.name))continue;
          const feet=bot.entity.position.floored();
          if(current.position.x===feet.x&&current.position.z===feet.z&&current.position.y<feet.y)throw Error('不能挖脚下支撑');
          if(!digSafety.safeToBreak(current)||!bot.canDigBlock(current)||(current.boundingBox!=='empty'&&!bot.canSeeBlock(current)))throw Error('目标当前不可安全挖掘');
          progress('连续收集 '+step.item+'：已入包 '+Math.max(0,itemCount(bot,step.item)-base)+'/'+step.count,Math.max(0,itemCount(bot,step.item)-base));
          await run(()=>bot.dig(current),20000);broken++;await pause(350);await pickup();
          const gained=Math.max(0,itemCount(bot,step.item)-base);progress('已实际收集 '+step.item+' '+gained+'/'+step.count,gained);
        }catch(e){check();last=/工具|缺少镐/.test(e.message)?e.message:/timeout|超时/i.test(e.message)?'接近资源超时':/path/i.test(e.message)?'寻路器找不到到达资源的路':'资源不可达或挖掘受阻';h.avoided.set(key,Date.now()+60000);misses++;if(/工具|缺少镐/.test(e.message))break;}
        finally{claims.delete(key);}
      }
      const gained=Math.max(0,itemCount(bot,step.item)-base);
      return {ok:gained>=step.count,text:gained>=step.count?'已核实新增入包 '+step.item+' '+gained+' 个':'已入包 '+gained+'/'+step.count+' 个 '+step.item+'；'+last+'，需换位置或补足条件'};
    }
    if(step.skill==='craft'){
      const id=bot.registry.itemsByName[step.item]?.id;if(!id)throw Error('当前版本没有该合成物品');
      let table=bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24});
      if(!bot.recipesFor(id,null,1,null).length&&!table&&itemCount(bot,'crafting_table')){
        const floor=nearby(b=>b.boundingBox==='block'&&!/chest|furnace|crafting|magma|cactus|farmland/.test(b.name),4,64).find(b=>b.position.y===Math.floor(bot.entity.position.y)-1&&b.position.distanceTo(bot.entity.position)>1.5&&bot.blockAt(b.position.offset(0,1,0))?.name==='air');
        if(floor){await goBlock(floor);await equip(bot.inventory.items().find(i=>i.name==='crafting_table'));await run(()=>bot.placeBlock(floor,new Vec3(0,1,0)));check();table=bot.blockAt(floor.position.offset(0,1,0));if(table?.name!=='crafting_table')table=null;}
      }
      if(table)await goBlock(table);
      const recipe=bot.recipesFor(id,null,1,table).find(r=>r.result?.id===id);
      if(!recipe){
        const info=recipes(bot,step.item),best=info.recipes?.[0];
        if(best?.table&&!table)throw Error('合成 '+step.item+' 缺少可达工作台；先用木板合成 crafting_table，随后会自动放置');
        throw Error('合成 '+step.item+' 材料不足：'+(best?.ingredients.filter(i=>i.have<i.count).map(i=>i.item+' 缺 '+(i.count-i.have)).join('、')||'没有可用配方'));
      }
      const count=Math.ceil(step.count/recipe.result.count),stock=inventory(bot);
      const missing=recipe.delta.filter(d=>d.count<0&&(stock[bot.registry.items[d.id]?.name]||0)<-d.count*count);
      if(missing.length)throw Error('材料不足：'+missing.map(d=>bot.registry.items[d.id]?.name+' 需要 '+(-d.count*count)).join('、'));
      const base=itemCount(bot,step.item);
      // 每次合成一份，等待产物入包后再操作下一份，避免窗口数据包滞后时连点漏产物。
      for(let batch=0;batch<count&&itemCount(bot,step.item)-base<step.count;batch++){
        check();const before=itemCount(bot,step.item),promise=bot.craft(recipe,1,table);bridge.crafting=promise;
        promise.finally(()=>{if(bridge.crafting===promise)bridge.crafting=null;}).catch(()=>{});
        await run(()=>promise,25000);check();
        for(let i=0;i<10&&itemCount(bot,step.item)<before+recipe.result.count;i++)await pause(200);
        if(itemCount(bot,step.item)<before+recipe.result.count)throw Error('合成回执后产物尚未到齐，停止连续操作；以当前背包重新计算缺口');
      }
      const gain=itemCount(bot,step.item)-base;
      return {ok:gain>=step.count,text:'合成后核实新增 '+step.item+' '+gain+' 个'};
    }
    if(step.skill==='farm'||step.skill==='harvest'){
      let done=0;
      const soil=step.skill==='farm'?nearby(b=>['dirt','grass_block','farmland'].includes(b.name),24,256):nearby(b=>b.name==='wheat'&&Number(b.getProperties().age)===7,24,128).map(b=>bot.blockAt(b.position.offset(0,-1,0)));
      for(const ground of soil){
        if(done>=step.count)break;check();const key=ground.position.toString();if(claims.has(key))continue;
        let above=bot.blockAt(ground.position.offset(0,1,0));if(!hydrated(bot,ground.position))continue;
        if(step.skill==='farm'&&!['air','short_grass','tall_grass'].includes(above?.name))continue;
        if(step.skill==='harvest'&&(above?.name!=='wheat'||Number(above.getProperties().age)!==7))continue;
        claims.set(key,bridge.who);
        try{
          await goBlock(above?.name==='wheat'?above:ground);check();
          if(above.name!=='air'){await run(()=>bot.dig(above));await pause(250);await pickup();}
          const seedName=step.skill==='harvest'?'wheat_seeds':step.item;
          const seed=bot.inventory.items().find(i=>i.name===seedName);if(!seed)throw Error('缺少种子：'+seedName);
          let current=bot.blockAt(ground.position);
          if(current.name!=='farmland'){
            await equip(bot.inventory.items().find(i=>/_hoe$/.test(i.name)));await run(()=>bot.activateBlock(current));await pause(300);check();current=bot.blockAt(ground.position);
            if(current.name!=='farmland')throw Error('锄地后未观察到耕地');
          }
          await equip(seed);await run(()=>bot.activateBlock(current));await pause(450);check();
          if(bot.blockAt(current.position.offset(0,1,0))?.name!==cropNames[seedName])throw Error('播种后未观察到作物');
          done++;progress('已核实'+(step.skill==='farm'?'新种植':'收获并补种')+' '+done+'/'+step.count+' 格',done);
        }finally{claims.delete(key);}
      }
      return {ok:done>=step.count,text:'已核实完成 '+done+'/'+step.count+' 格'+(step.skill==='farm'?'耕地播种':'成熟小麦收获并补种')+(done<step.count?'；需要水边可达空地、锄头和种子（收获需成熟小麦）':'')};
    }
    if(step.skill==='eat'){
      if(bot.food>=20)return {ok:true,text:'饥饿值已满，无需进食'};
      const food=bot.inventory.items().find(i=>edible.test(i.name));if(!food)throw Error('背包没有安全食物，需要采集或合成食物');
      const before=bot.food;await equip(food);await run(()=>bot.consume(),10000);await pause(350);
      return {ok:bot.food>before,text:'进食后饥饿值 '+before+' → '+bot.food};
    }
    if(step.skill==='explore'){
      let moved=0;
      for(let i=0;i<step.count;i++){
        check();const view=observe(bridge); // 观察时临时去掉活动标记，只生成安全地面候选。
        bridge.state.activity=null;const free=observe(bridge);bridge.state.activity=activity;
        const pattern=step.item==='water'?/^water$/:COLLECT[step.item]||(step.item?new RegExp('^'+step.item+'$'):null);
        const hints=pattern?nearby(b=>pattern.test(b.name),48,16).map(b=>b.position):[];
        const job={anchor:view.position,visited:h.visited,round:h.round++,searchTargets:hints};
        const options=explorationChoices(free,job).filter(c=>(h.avoided.get(c.key)||0)<Date.now());let walked=false;
        for(const c of options.slice(0,4))try{
          const before=bot.entity.position.clone();
          await travel(new GoalNear(c.position.x,c.position.y,c.position.z,1),10000);check();
          if(bot.entity.position.distanceTo(before)<.8)throw Error('没有实际移动到新位置');
          h.visited.push([Math.floor(c.position.x),Math.floor(c.position.y),Math.floor(c.position.z)].join(','));h.visited=h.visited.slice(-32);moved++;walked=true;break;
        }catch(e){check();h.avoided.set(c.key,Date.now()+60000);}
        if(!walked)break;progress('继续寻找 '+(step.item||'安全地形')+'，已走 '+moved+'/'+step.count+' 段',moved);
      }
      return {ok:moved>0,text:'已探索 '+moved+' 段安全地面，需要重新观察资源位置'};
    }
    if(step.skill==='prepare_tools'){
      let n=0;
      while(!gearReady(observe(bridge).inventory)&&n++<30){
        check();const stock=inventory(bot),items=bot.inventory.items(),log=items.find(i=>/_log$/.test(i.name));
        const boards=items.filter(i=>/_planks$/.test(i.name)).reduce((n,i)=>n+i.count,0),pick=items.some(i=>/_pickaxe$/.test(i.name)),goodPick=items.some(i=>/^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name));
        let next;
        if(boards<4)next=log?{skill:'craft',item:log.name.replace(/_log$/,'_planks'),count:4}:{skill:'collect',item:'logs',count:4};
        else if(!stock.crafting_table&&!bot.findBlock({matching:b=>b.name==='crafting_table',maxDistance:24}))next={skill:'craft',item:'crafting_table',count:1};
        else if((stock.stick||0)<3)next={skill:'craft',item:'stick',count:4};
        else if(!pick)next={skill:'craft',item:'wooden_pickaxe',count:1};
        else if((stock.cobblestone||0)<(goodPick?2:5))next={skill:'collect',item:'cobblestone',count:(goodPick?2:5)-(stock.cobblestone||0)};
        else next={skill:'craft',item:goodPick?'stone_sword':'stone_pickaxe',count:1};
        progress('补工具前置：'+next.skill+' '+next.item);
        const result=await executeSkill(bridge,next,signal,progress,dependencies);check();if(!result.ok)throw Error(result.text);
      }
      return {ok:gearReady(observe(bridge).inventory),text:'已重新核对石镐与石剑是否在自己的背包'};
    }
    if(step.skill==='wait'){await pause(step.count*1000);return {ok:true,text:'短暂等待结束，重新检查条件'};}
    throw Error('未实现该技能');
  }finally{
    clearTimeout(timeout);parentSignal.removeEventListener('abort',cancel);
    if(active()){halt();bot.pathfinder.setMovements(oldMovements);if(bridge.state.activity===activity)bridge.state.activity=null;}
  }
}
