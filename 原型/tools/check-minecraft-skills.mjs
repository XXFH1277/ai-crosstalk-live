import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {executeSkill,hydrated} from '../minecraft/skills.mjs';
const require=createRequire(new URL('../minecraft/package.json',import.meta.url));
const {Vec3}=require('vec3');
globalThis.fetch=()=>{throw Error('离线检查禁止联网');};
class Moves{constructor(){this.canDig=true;}safeToBreak(){return this.canDig;}}
const deps={Movements:Moves};
function fixture({drops=true,water=true,plant=true}={}){
 const stock=[],blocks=new Map();let digs=0,goals=0;
 const set=(x,y,z,name)=>{const position=new Vec3(x,y,z),b={name,position,canHarvest:()=>true,boundingBox:name==='air'?'empty':'block',getProperties:()=>({age:7})};blocks.set(position.toString(),b);return b;};
 for(let x=2;x<5;x++)set(x,64,0,'oak_log');
 const soil=set(3,63,3,'dirt');set(3,64,3,'air');if(water)set(4,63,3,'water');
 const bot={entity:{position:new Vec3(0,64,0)},entities:{},world:{},food:10,registry:{blocksByName:{oak_log:{id:1}},itemsByName:{}},
  inventory:{items:()=>stock},blockAt:p=>blocks.get(p.toString())||{name:'air',position:p,boundingBox:'empty'},
  findBlocks:({matching})=>[...blocks.values()].filter(matching).map(b=>b.position),canDigBlock:()=>true,canSeeBlock:()=>true,
  pathfinder:{movements:{original:true},setMovements(m){this.movements=m;},setGoal(){},async goto(){goals++;}},stopDigging(){},clearControlStates(){},
  async equip(i){this.heldItem=i;},async dig(b){digs++;set(b.position.x,b.position.y,b.position.z,'air');if(drops&&b.name==='oak_log'){let i=stock.find(i=>i.name==='oak_log');if(!i){i={name:'oak_log',count:0};stock.push(i);}i.count++;}},
  async activateBlock(b){if(this.heldItem.name.endsWith('_hoe'))set(b.position.x,b.position.y,b.position.z,'farmland');else if(plant)set(b.position.x,b.position.y+1,b.position.z,'wheat');}
 };
 const bridge={who:'深深',bot,session:1,actionEpoch:0,state:{status:'已入服'},snapshot(){return {...this.state,who:this.who,players:[]};},events:[],now:Date.now};
 return {bridge,bot,stock,soil,get digs(){return digs;},get goals(){return goals;}};
}
let f=fixture();let result=await executeSkill(f.bridge,{skill:'collect',item:'logs',count:3},new AbortController().signal,()=>{},deps);
assert.equal(result.ok,true);assert.equal(f.digs,3,'同一技能连续采集到配额，不挖一块就换任务');assert.equal(f.bot.pathfinder.movements.original,true);
f=fixture({drops:false});result=await executeSkill(f.bridge,{skill:'collect',item:'logs',count:3},new AbortController().signal,()=>{},deps);assert.equal(result.ok,false,'只挖掉不入包不得报成功');assert.match(result.text,/0\/3/);
f=fixture();f.stock.push({name:'wooden_hoe',count:1},{name:'wheat_seeds',count:2});
result=await executeSkill(f.bridge,{skill:'farm',item:'wheat_seeds',count:1},new AbortController().signal,()=>{},deps);assert.equal(result.ok,true);assert.equal(f.bot.blockAt(f.soil.position).name,'farmland');assert.equal(f.bot.blockAt(f.soil.position.offset(0,1,0)).name,'wheat');
f=fixture({water:false});assert.equal(hydrated(f.bot,f.soil.position),false);result=await executeSkill(f.bridge,{skill:'farm',item:'wheat_seeds',count:1},new AbortController().signal,()=>{},deps);assert.equal(result.ok,false);assert.equal(f.digs,0);
f=fixture({plant:false});f.stock.push({name:'wooden_hoe',count:1},{name:'wheat_seeds',count:1});await assert.rejects(executeSkill(f.bridge,{skill:'farm',item:'wheat_seeds',count:1},new AbortController().signal,()=>{},deps),/未观察到作物/);
f=fixture();const cancelled=new AbortController();cancelled.abort();await assert.rejects(executeSkill(f.bridge,{skill:'collect',item:'logs',count:3},cancelled.signal,()=>{},deps));assert.equal(f.digs,0);
f=fixture();let crafts=0;
f.stock.push({name:'oak_log',count:4});f.bot.registry.itemsByName.oak_planks={id:2};f.bot.registry.items={1:{name:'oak_log'}};
const recipe={result:{id:2,count:4},delta:[{id:1,count:-1},{id:2,count:4}]};f.bot.findBlock=()=>null;f.bot.recipesFor=()=>[recipe];
f.bot.craft=async(r,count)=>{assert.equal(count,1);crafts++;setTimeout(()=>{f.stock[0].count--;let out=f.stock.find(i=>i.name==='oak_planks');if(!out){out={name:'oak_planks',count:0};f.stock.push(out);}out.count+=4;},50);};
result=await executeSkill(f.bridge,{skill:'craft',item:'oak_planks',count:12},new AbortController().signal,()=>{},deps);assert.equal(result.ok,true);assert.equal(crafts,3,'每份等待真实入包后再合成下一份');
f=fixture();f.bridge.snapshot=()=>({...f.bridge.state,who:'深深',players:[],position:{x:0,y:64,z:0}});
f.bot.blockAt=p=>({name:p.y===63?'stone':'air',boundingBox:p.y===63?'block':'empty',position:p});
result=await executeSkill(f.bridge,{skill:'explore',item:'',count:1},new AbortController().signal,()=>{},deps);
assert.equal(result.ok,false,'寻路回调成功但位置没有变化，不得宣称探索成功');
console.log('连续采集、实际入包、水源、耕种结果与取消检查通过');
