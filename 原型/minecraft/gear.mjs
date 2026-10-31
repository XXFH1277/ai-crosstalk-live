// 生存准备只使用已有物品和正常配方，不调用游戏命令。
export const gearReady = items => items.some(i => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)) && items.some(i => /^(stone|iron|diamond|netherite)_sword$/.test(i.name));
export function gearOptions(bridge, resources, job={}) {
  const bot=bridge.bot,items=bot.inventory.items(),p=bot.entity.position;
  const count=name=>items.filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
  const table=bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:12});
  const craft=(name,atTable=false)=>({choices:[{kind:'craft',key:'craft:'+bridge.who,label:'制作 '+name,item:name,table:atTable&&table?{x:table.position.x,y:table.position.y,z:table.position.z}:null}]});
  const wood=()=>resources(bridge,{stage:'wood'});
  const planks=()=>{const log=items.find(i=>/_log$/.test(i.name));return log?craft(log.name.replace(/_log$/,'_planks')):wood();};
  const boardCount=items.filter(i=>/_planks$/.test(i.name)).reduce((n,i)=>n+i.count,0);
  if(!table){
    if(!count('crafting_table'))return boardCount>=4?craft('crafting_table'):planks();
    const places=[];
    for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]]){
      const pos=p.floored().offset(x,0,z),floor=bot.blockAt(pos.offset(0,-1,0)),space=bot.blockAt(pos),head=bot.blockAt(pos.offset(0,1,0));
      const occupied=Object.values(bot.entities).some(e=>e.position&&Math.abs(e.position.y-pos.y)<2&&Math.hypot(e.position.x-pos.x-.5,e.position.z-pos.z-.5)<.9);
      if(!occupied&&floor?.boundingBox==='block'&&!/magma|cactus|campfire/.test(floor.name)&&space?.name==='air'&&head?.boundingBox==='empty')places.push({kind:'table',key:'place:'+pos.x+','+pos.y+','+pos.z,label:'在身边空地放置工作台',position:{x:pos.x,y:pos.y,z:pos.z}});
    }
    return {choices:places,reason:'身边没有可以放工作台的安全空位'};
  }
  const pick=items.some(i=>/_pickaxe$/.test(i.name)),goodPick=items.some(i=>/^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name));
  const sword=items.some(i=>/^(stone|iron|diamond|netherite)_sword$/.test(i.name));
  if(goodPick&&sword)return {choices:[],ready:true};
  const needSticks=pick?(goodPick?1:2):2;
  if(count('stick')<needSticks)return boardCount>=2?craft('stick'):planks();
  if(!pick)return boardCount>=3?craft('wooden_pickaxe',true):planks();
  if(count('cobblestone')<(goodPick?2:3))return resources(bridge,{...job,stage:'mine'});
  return craft(goodPick?'stone_sword':'stone_pickaxe',true);
}
