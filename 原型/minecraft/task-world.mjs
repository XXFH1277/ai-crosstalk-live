import {gearOptions} from './gear.mjs';
const resource=(name,mode)=>mode==='wood'?/_log$/.test(name):/^(stone|deepslate|coal_ore|iron_ore|copper_ore|deepslate_coal_ore|deepslate_iron_ore)$/.test(name);
const loot=(name,mode)=>mode==='wood'?/_log$/.test(name):/^(cobblestone|cobbled_deepslate|coal|raw_iron|raw_copper)$/.test(name);
const hostiles=new Set(['zombie','skeleton','spider','husk','stray','drowned']);
function visibleFrom(bot,feet,target,allowLeaves=false){
  const current=bot.entity.position,head=current.offset(feet.x-current.x,feet.y-current.y+1.65,feet.z-current.z);
  const end=target.offset(.5,.5,.5),length=head.distanceTo(end),steps=Math.ceil(length/.15);
  for(let i=1;i<=steps;i++){
    const p=head.offset((end.x-head.x)*i/steps,(end.y-head.y)*i/steps,(end.z-head.z)*i/steps).floored();
    if(p.x===target.x&&p.y===target.y&&p.z===target.z)return true;
    const block=bot.blockAt(p);if(!block||(block.boundingBox==='block'&&!(allowLeaves&&/_leaves$/.test(block.name))))return false;
  }return true;
}
function stand(bot,position,allowLeaves=false){
  const candidates=[];
  for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2],[3,0],[-3,0],[0,3],[0,-3],[2,2],[-2,2],[2,-2],[-2,-2]])for(const y of [0,-1,1,-2,-3,-4,-5]){
    const p=position.offset(x,y,z),floor=bot.blockAt(p.offset(0,-1,0)),foot=bot.blockAt(p),head=bot.blockAt(p.offset(0,1,0));
    if(position.offset(.5,.5,.5).distanceTo(p.offset(.5,1.65,.5))<=5&&floor?.boundingBox==='block'&&!/magma|cactus|campfire/.test(floor.name)&&[foot,head].every(b=>b&&['air','cave_air','short_grass','snow'].includes(b.name)))candidates.push({x:p.x+.5,y:p.y,z:p.z+.5});
  }
  return candidates.filter(p=>visibleFrom(bot,p,position,allowLeaves)).sort((a,b)=>bot.entity.position.distanceTo(a)-bot.entity.position.distanceTo(b))[0];
}
function blockingLeaf(bot,target){
  const head=bot.entity.position.offset(0,1.65,0),end=target.offset(.5,.5,.5),steps=Math.ceil(head.distanceTo(end)/.15);
  for(let i=1;i<=steps;i++){
    const p=head.offset((end.x-head.x)*i/steps,(end.y-head.y)*i/steps,(end.z-head.z)*i/steps).floored();
    if(p.x===target.x&&p.y===target.y&&p.z===target.z)return null;
    const b=bot.blockAt(p);if(!b)return null;if(b.boundingBox==='block')return /_leaves$/.test(b.name)?b:null;
  }return null;
}
export function taskOptions(bridge,job){
  const bot=bridge.bot,p=bot?.entity?.position;if(!p)return {choices:[]};
  if(job.stage==='gear')return gearOptions(bridge,taskOptions,job);
  const items=bot.inventory.items();
  if(job.stage==='fight'){
    const weapon=items.find(i=>/_sword$|_axe$/.test(i.name));
    if(bot.health<12||!weapon)return {choices:[],blocked:'打怪需要至少 12 点血和斧/剑；条件不足，未开战'};
    return {choices:Object.values(bot.entities).filter(e=>hostiles.has(e.name)&&e.position.distanceTo(p)<8).map(e=>({key:'fight:'+bridge.who+':'+e.id,kind:'fight',entity:e.id,weapon:weapon.type,label:'协作处理附近的 '+e.name}))};
  }
  if(job.stage==='mine'&&!items.some(i=>/_pickaxe$/.test(i.name)))return {choices:[],blocked:'缺少镐，无法有效挖矿；请先给我一把镐再下令'};
  const wantedBlock=name=>job.resource==='cobblestone'?name==='stone':resource(name,job.stage);
  const wantedLoot=name=>job.resource==='cobblestone'?name==='cobblestone':loot(name,job.stage);
  const drops=Object.values(bot.entities).filter(e=>e.getDroppedItem&&e.position&&e.position.distanceTo(p)<8&&wantedLoot(e.getDroppedItem()?.name||''))
    .map(e=>({key:'entity:'+e.id,kind:'collect',entity:e.id,label:'拾取附近的掉落物'}));
  const blocks=(bot.findBlocks?.({matching:b=>wantedBlock(b.name),maxDistance:24,count:256})||[]).map(pos=>bot.blockAt(pos)).filter(Boolean).sort((a,b)=>p.distanceTo(a.position)-p.distanceTo(b.position));
  const choices=[];
  for(const block of blocks){
    if(Math.abs(block.position.y-p.y)>5)continue;
    if(block.position.x===Math.floor(p.x)&&block.position.z===Math.floor(p.z)&&block.position.y< p.y&&block.position.y>=Math.floor(p.y)-1)continue;
    const tool=bot.pathfinder.bestHarvestTool(block);
    if(!block.canHarvest(tool?.type??null))continue;
    const position=bot.canDigBlock?.(block)&&bot.canSeeBlock?.(block)?{x:p.x,y:p.y,z:p.z}:stand(bot,block.position,job.stage==='wood');if(!position)continue;
    choices.push({key:'block:'+block.position.x+','+block.position.y+','+block.position.z,kind:'dig',mode:job.stage,block:{x:block.position.x,y:block.position.y,z:block.position.z},position,tool:tool?.type,label:'靠近并采集 '+block.name});
  }
  if(job.stage==='mine'&&!drops.length&&!choices.length&&blocks.length&&(job.accessSteps||0)<6){
    const base=p.floored();
    for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const feet=base.offset(x,-1,z),ground=bot.blockAt(feet.offset(0,-1,0)),soil=bot.blockAt(feet),head=bot.blockAt(feet.offset(0,1,0)),above=bot.blockAt(feet.offset(0,2,0));
      const safeGround=ground&&['dirt','grass_block','stone','granite','diorite','andesite','deepslate'].includes(ground.name);
      const safeSoil=soil&&['dirt','grass_block'].includes(soil.name);
      const safeHead=[head,above].every(b=>b&&['air','cave_air','snow','short_grass'].includes(b.name));
      const sealed=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].every(([dx,dy,dz])=>{const b=bot.blockAt(feet.offset(dx,dy,dz));return b&&!/water|lava|sand|gravel/.test(b.name);});
      if(safeGround&&safeSoil&&safeHead&&sealed)choices.push({kind:'access',key:'access:'+feet.x+','+feet.y+','+feet.z,label:'检查地面后开一阶浅采矿入口',position:{x:feet.x,y:feet.y,z:feet.z}});
    }
  }
  const searchTargets=blocks.filter(b=>Math.abs(b.position.y-p.y)<=5).slice(0,8).map(b=>({x:b.position.x,y:b.position.y,z:b.position.z}));
  return {choices:[...drops,...choices],searchTargets,reason:blocks.length?'附近有 '+blocks.length+' 个资源方块，但尚未找到合适工具或安全落脚点':'24 格内没有发现对应资源'};
}
export async function executeTask(bridge,choice,signal,GoalNear){
  if(signal.aborted)throw Error('动作已取消');
  const bot=bridge.bot;bridge.stop();const epoch=bridge.actionEpoch;
  const valid=()=>!signal.aborted&&bridge.bot===bot&&bridge.actionEpoch===epoch&&bridge.state.status==='已入服'&&!bridge.state.danger;
  const check=()=>{if(!valid())throw Error('动作已取消');};
  const stop=()=>{if(bridge.bot===bot&&bridge.actionEpoch===epoch)bridge.stop();};
  signal.addEventListener('abort',stop,{once:true});
  bridge.state.activity={kind:choice.kind,label:choice.label};
  let timeout;
  const operation=async()=>{
    check();
    const move=async(pos,r=1)=>{check();await bot.pathfinder.goto(new GoalNear(pos.x,pos.y,pos.z,r));check();};
    if(choice.kind==='access'){
      const p=bot.entity.position,q=choice.position,pos=p.offset(q.x-p.x,q.y-p.y,q.z-p.z);
      const ground=bot.blockAt(pos.offset(0,-1,0)),soil=bot.blockAt(pos),head=bot.blockAt(pos.offset(0,1,0));
      const clear=bot.blockAt(pos.offset(0,2,0)),sealed=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]].every(([x,y,z])=>{const b=bot.blockAt(pos.offset(x,y,z));return b&&!/water|lava|sand|gravel/.test(b.name);});
      if(!sealed||!['air','cave_air','snow','short_grass'].includes(clear?.name)||!ground||!['dirt','grass_block','stone','granite','diorite','andesite','deepslate'].includes(ground.name)||!['dirt','grass_block'].includes(soil?.name)||!['air','cave_air','snow','short_grass'].includes(head?.name))throw Error('浅阶梯条件已变化');
      if(['snow','short_grass'].includes(head.name)){check();await bot.dig(head);check();}
      await bot.dig(soil);check();await move({x:q.x+.5,y:q.y,z:q.z+.5},0);return {accessStep:true,text:'浅阶梯下降一格，重新检查可见石头'};
    }
    if(choice.kind==='craft'){
      let table=null;
      if(choice.table){await move(choice.table,2);table=bot.blockAt(bot.entity.position.offset(choice.table.x-bot.entity.position.x,choice.table.y-bot.entity.position.y,choice.table.z-bot.entity.position.z));if(table?.name!=='crafting_table')throw Error('工作台已消失');}
      const item=bot.registry.itemsByName[choice.item],recipe=item&&bot.recipesFor(item.id,null,1,table)[0];
      if(!recipe)throw Error('配方材料不足');
      check();const crafting=bridge.crafting=bot.craft(recipe,1,table);
      try{await crafting;check();return {text:'制作结束，按背包核对 '+choice.item};}finally{if(bridge.crafting===crafting)bridge.crafting=null;}
    }
    if(choice.kind==='table'){
      const v=bot.entity.position,pos=choice.position,base=bot.blockAt(v.offset(pos.x-v.x,pos.y-v.y-1,pos.z-v.z));
      const space=base&&bot.blockAt(base.position.offset(0,1,0)),item=bot.inventory.items().find(i=>i.name==='crafting_table');
      if(!base||space?.name!=='air'||!item)throw Error('工作台位置已不可用');
      await bot.equip(item,'hand');check();await bot.placeBlock(base,v.offset(-v.x,1-v.y,-v.z));check();return {text:'工作台已放置'};
    }
    if(choice.kind==='walk'){await move(choice.position);return {text:'已走到附近空地，继续查看资源'};}
    if(choice.kind==='collect'){
      const e=bot.entities[choice.entity];if(!e)throw Error('掉落物已消失');await move(e.position,.5);
      await new Promise(r=>setTimeout(r,400));check();return {text:'已到掉落物附近，以背包变化核实拾取'};
    }
    if(choice.kind==='dig'){
      await move(choice.position,0);
      const p=bot.entity.position,bp=choice.block,block=bot.blockAt(p.offset(bp.x-p.x,bp.y-p.y,bp.z-p.z));
      if(bp.x===Math.floor(p.x)&&bp.z===Math.floor(p.z)&&bp.y<p.y&&bp.y>=Math.floor(p.y)-1)throw Error('不能挖掉脚下支撑方块');
      if(!block||!resource(block.name,choice.mode)||!bot.canDigBlock(block))throw Error('方块已不可采集');
      // 砍树允许先清理视线上少量树叶；不挖土石开路，不碰未知遮挡物。
      if(choice.mode==='wood')for(let i=0;i<4&&!bot.canSeeBlock(block);i++){
        const leaf=blockingLeaf(bot,block.position);if(!leaf||!bot.canDigBlock(leaf))break;
        check();await bot.dig(leaf);check();
      }
      if(!bot.canSeeBlock(block))throw Error('方块已不可采集');
      const tool=bot.inventory.items().find(i=>i.type===choice.tool);
      if(tool){await bot.equip(tool,'hand');check();}
      if(!block.canHarvest(bot.heldItem?.type??null))throw Error('工具不足');
      await bot.dig(block);check();return {text:'方块已挖掉，接下来核对掉落与背包'};
    }
    if(choice.kind==='fight'){
      let target=bot.entities[choice.entity];if(!target||!hostiles.has(target.name))throw Error('目标已消失');
      const weapon=bot.inventory.items().find(i=>i.type===choice.weapon);if(!weapon||bot.health<12)throw Error('战斗条件不足');
      await bot.equip(weapon,'hand');check();await move(target.position,2);
      let defeated=false;const dead=e=>{if(e.id===choice.entity)defeated=true;};bot.on('entityDead',dead);
      try{for(let i=0;i<8;i++){check();if(defeated)return {defeated:true};target=bot.entities[choice.entity];if(!target||bot.health<12||target.position.distanceTo(bot.entity.position)>3.5)throw Error('目标丢失或需要停止战斗');bot.attack(target);await new Promise(r=>setTimeout(r,650));}if(defeated)return {defeated:true};throw Error('本轮战斗未完成');}finally{bot.removeListener('entityDead',dead);}
    }
    throw Error('不支持的动作');
  };
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timeout=setTimeout(()=>{stop();reject(Error('动作超时'));},12000);timeout.unref?.();})]);}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',stop);stop();}
}
