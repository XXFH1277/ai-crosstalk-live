// 配方来自当前连接版本的注册表；查资料不能越过执行器的能力边界。
export const SKILLS = {
  collect: '连续收集指定物品，count 为新增入包数量（1～16）。支持 logs、各类原木、cobblestone、coal、raw_iron、raw_copper、wheat_seeds、dirt、sand。缺工具或无可达资源会报告阻碍。',
  craft: '按当前版本配方合成 item；count 为希望新增的物品数（1～16）。只消耗自己的材料，需要工作台时会寻找或放置已有工作台；不会凭空补材料。',
  prepare_tools: '按生存配方补齐自己的石镐、石剑；自动收集前置材料。',
  explore: '向附近未走过的安全地面连续探索，item 可指定寻找资源或 water；count 为移动段数（1～6）。不能跨维度或跟随玩家。',
  farm: '在附近现有水源四格内的空地上耕地并播种。item 为 wheat_seeds / carrot / potato，count 为本次新种植格数（1～8）。需自己有锄头和种子，不搬水、不破坏建筑或现有作物。',
  harvest: '收获附近成熟小麦并用掉落种子补种；count 为处理格数（1～8），未成熟作物不动。',
  eat: '吃背包中安全食物，恢复饥饿；没有食物就报告缺口。',
  wait: '有明确条件才短暂等待，count 为秒数（1～10）。不能用连续等待代替推进目标。'
};
export const COLLECT = {
  logs: /_log$/, cobblestone: /^(stone|cobblestone)$/, coal: /^(coal_ore|deepslate_coal_ore)$/,
  raw_iron: /^(iron_ore|deepslate_iron_ore)$/, raw_copper: /^(copper_ore|deepslate_copper_ore)$/,
  wheat_seeds: /^(short_grass|tall_grass)$/, dirt: /^(dirt|grass_block)$/, sand: /^sand$/
};
export const matchesItem = (name, item) => item === 'logs' ? /_log$/.test(name) : name === item;
export function inventory(bot) {
  const result={}; for(const i of bot.inventory.items()) result[i.name]=(result[i.name]||0)+i.count; return result;
}
export function itemCount(bot,item){return Object.entries(inventory(bot)).reduce((n,[name,count])=>n+(matchesItem(name,item)?count:0),0);}
export function recipes(bot,name){
  const item=bot.registry.itemsByName[name]; if(!item)return {item:name,error:'当前版本没有此物品'};
  const stock=inventory(bot);
  const all=bot.recipesAll(item.id,null,true).map(r=>({
    output:r.result.count,table:!!r.requiresTable,
    ingredients:r.delta.filter(d=>d.count<0).map(d=>({item:bot.registry.items[d.id]?.name,count:-d.count,have:stock[bot.registry.items[d.id]?.name]||0}))
  }));
  const deficit=r=>r.ingredients.reduce((n,i)=>n+Math.max(0,i.count-i.have),0);
  all.sort((a,b)=>deficit(a)-deficit(b));
  return {item:name,tableInInventory:stock.crafting_table||0,nearbyTable:!!bot.findBlock?.({matching:b=>b.name==='crafting_table',maxDistance:24}),recipes:all.slice(0,4)};
}
export function validatePlan(raw){
  if(!raw||typeof raw!=='object')throw Error('规划结果不是对象');
  if(raw.lookup){
    if(!['recipe','skill'].includes(raw.lookup.kind)||typeof raw.lookup.query!=='string'||!/^[a-z_]{1,48}$/.test(raw.lookup.query))throw Error('资料查询格式不正确');
    return {lookup:{kind:raw.lookup.kind,query:raw.lookup.query}};
  }
  if(typeof raw.goal!=='string'||!raw.goal.trim()||raw.goal.length>100||!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>6)throw Error('计划需要目标和 1～6 个步骤');
  const steps=raw.steps.map(s=>{
    if(!s||!Object.hasOwn(SKILLS,s.skill)||!Number.isInteger(s.count)||s.count<1||s.count>({farm:8,harvest:8,explore:6,wait:10,prepare_tools:1,eat:1}[s.skill]||16))throw Error('计划的技能或数量无效');
    const item=s.item||'';if(typeof item!=='string'||(item&&!/^[a-z_]{1,48}$/.test(item)))throw Error('物品名称无效');
    if(['collect','craft','farm'].includes(s.skill)&&!item)throw Error('缺少物品名称');
    if(s.skill==='collect'&&!COLLECT[item]&&!/^[a-z_]+_log$/.test(item))throw Error('尚未支持采集该物品');
    if(s.skill==='farm'&&!['wheat_seeds','carrot','potato'].includes(item))throw Error('尚未支持这种作物');
    return {skill:s.skill,item,count:s.count};
  });
  return {goal:raw.goal.trim(),steps};
}
export function knowledge(bot,query){
  return query.kind==='recipe'?recipes(bot,query.query):{skill:query.query,description:SKILLS[query.query]||'没有这个技能，请使用已公布技能'};
}
