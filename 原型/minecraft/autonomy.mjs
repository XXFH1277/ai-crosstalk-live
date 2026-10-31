// 每次选择近处安全目标，探索完成后向前更新活动区，不追随玩家坐标。
export const AUTO_RADIUS=18;
const distance=(a,b)=>!a||!b?Infinity:Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
export const stock=(view,stage)=>(view.inventory||[]).filter(i=>stage==='wood'?/_log$/.test(i.name):/^(cobblestone|cobbled_deepslate|coal|raw_iron|raw_copper)$/.test(i.name)).reduce((n,i)=>n+i.count,0);
export function chooseActivity(view,job,now,plan=null){
  job.anchor ||= view.position?{...view.position}:null;
  if(plan){if(job.goal?.id!==plan.id)job.searchTargets=[];job.goal=plan;}
  if(!job.anchor)return {stage:'rest',note:'等待有效位置，暂不走动'};
  if((Number.isFinite(view.food)&&view.food<6)||(view.nearby||[]).some(e=>e.distance<6&&/^(creeper|zombie|skeleton|spider|husk|stray|drowned|witch|pillager|warden)$/.test(e.name)))return {stage:'rest',note:'附近有危险或饥饿，暂时停下来观察'};
  if(plan){
    if(plan.stage==='blocked')return plan;
    if(job.forceExplore){job.forceExplore=false;return {...plan,stage:'explore',quota:1,note:'换地方寻找条件，仍在推进：'+plan.title};}
    return plan;
  }
  if(job.forceExplore){job.forceExplore=false;return {stage:'explore',note:'这里没有可达目标，主动换个地方寻找'};}
  if(distance(view.position,job.anchor)>AUTO_RADIUS)return {stage:'explore',note:'回到自己的活动范围，不跟随玩家'};
  const order=(job.round++%2)?['mine','wood']:['wood','mine'];
  for(const stage of order){
    if(stage==='mine'&&!(view.inventory||[]).some(i=>/_pickaxe$/.test(i.name)))continue;
    const moved=job.lastAutoPosition?.[stage]&&distance(view.position,job.lastAutoPosition[stage])>=6;
    if(stock(view,stage)>=(stage==='wood'?8:12)||(!moved&&now-(job.lastAuto[stage]??-Infinity)<45000))continue;
    job.lastAuto[stage]=now;
    job.lastAutoPosition||={};job.lastAutoPosition[stage]={...view.position};
    return {stage,note:stage==='wood'?'自己找附近原木，少量补充背包':'自己找附近可达矿物，少量补充背包'};
  }
  return {stage:'explore',note:'到附近另一处安全空地看看'};
}
export function inActivityArea(choice,job,bridge){
  if(choice.kind==='craft'&&!choice.table)return true;
  const position=choice.block||choice.position||choice.table||bridge.bot?.entities?.[choice.entity]?.position;
  return !!position&&distance(position,job.anchor)<=AUTO_RADIUS;
}
export function explorationChoices(view,job){
  const current=distance(view.position,job.anchor),outside=current>AUTO_RADIUS;
  const candidates=(view.choices||[]).filter(c=>c.type==='walk'&&c.position&&distance(c.position,view.position)>=.8&&
    (outside?distance(c.position,job.anchor)<current:distance(c.position,job.anchor)<=AUTO_RADIUS));
  const key=p=>[Math.floor(p.x),Math.floor(p.y),Math.floor(p.z)].join(',');
  const hints=job.searchTargets||[];
  const ordered=candidates.map((c,i)=>({c,score:(job.visited.includes(key(c.position))?100:0)+(outside?distance(c.position,job.anchor):hints.length?Math.min(...hints.map(p=>distance(p,c.position)))*2:((i+job.round)%4)-distance(c.position,view.position)*.2)})).sort((a,b)=>a.score-b.score);
  return ordered.map(({c})=>({...c,key:'explore:'+key(c.position),kind:'walk',label:hints.length?'沿安全地面靠近已发现的目标资源':'寻找资源：探索附近未走过的安全空地'}));
}
