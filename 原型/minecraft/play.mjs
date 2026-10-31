// 只向模型提供可执行的有限选项；不执行模型生成的代码或任意坐标。
export function observe(bridge) {
  const bot = bridge.bot;
  const state = bridge.snapshot();
  const choices = [{ id: 'wait', label: '停下来观察', type: 'wait' }];
  if (!bot || state.status !== '已入服') return { ...state, choices };
  for (const name of state.players) {
    choices.push({ id: `look:${name}`, label: `看向 ${name}`, type: 'look', target: name });
    if (!state.danger && !state.activity) choices.push({ id: `follow:${name}`, label: `跟随 ${name}`, type: 'follow', target: name });
  }
  const p = bot.entity.position;
  if (!state.danger && !state.activity) {
    // 只走附近实心地面，允许安全上下一级台阶；实际路径仍由不挖掘、不搭桥的寻路器计算。
    for (const [i, [x, z]] of [[3,0],[-3,0],[0,3],[0,-3],[1,0],[-1,0],[0,1],[0,-1],[3,3],[-3,3],[3,-3],[-3,-3]].entries()) for(const dy of [0,1,-1]) {
      const dest = p.offset(x, dy, z).floored();
      const floor = bot.blockAt(dest.offset(0, -1, 0));
      const foot = bot.blockAt(dest), head = bot.blockAt(dest.offset(0, 1, 0));
      if (floor?.boundingBox === 'block' && !/magma|cactus|campfire/.test(floor.name) &&
          [foot, head].every(b => b && ['air', 'cave_air', 'snow', 'short_grass'].includes(b.name))) {
        choices.push({ id: `walk:${i}:${dy}`, label: `向附近空地 ${i + 1} 走几步`, type: 'walk', position: { x: dest.x+.5, y: dest.y, z: dest.z+.5 } });
        break;
      }
    }
    const log = bot.findBlock?.({ matching: b => /_log$/.test(b.name), maxDistance: 3 });
    if (log && bot.canDigBlock(log)) choices.push({ id: 'wood', label: '采一块伸手可及的原木', type: 'wood', position: { x: log.position.x, y: log.position.y, z: log.position.z } });
  }
  const nearby = Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && e.position.distanceTo(p) <= 10)
    .slice(0, 10).map(e => ({ name: e.username || e.name || '未知实体', distance: Math.round(e.position.distanceTo(p)) }));
  return { who: state.who, status: state.status, health: state.health, food: state.food, danger: state.danger,
    position: state.position, target: state.target, players: state.players, nearby,
    activity: state.activity || null,
    lastTask: bridge.events.findLast(e => e.type === 'task') || null,
    recentEvents: bridge.events.filter(e => bridge.now() - e.at < 30000).slice(-5).map(e => ({ type: e.type, text: e.text })),
    inventory: (bot.inventory?.items() || []).map(i => ({ name: i.name, count: i.count })), choices };
}

export function act(bridge, choice, GoalNear) {
  if (!choice) throw new Error('模型选择了不可用动作');
  const bot = bridge.bot;
  if (!bot || bridge.state.status !== '已入服') throw new Error('角色尚未入服');
  if (bridge.state.danger && !['wait', 'look'].includes(choice.type)) throw new Error('低血量时禁止继续冒险');
  if (choice.type === 'wait') return;
  if (choice.type === 'look') {
    const entity = bot.players[choice.target]?.entity;
    if (!entity) throw new Error('目标已离开视野');
    Promise.resolve(bot.lookAt(entity.position.offset(0, 1.4, 0))).catch(() => {});
    return;
  }
  if(bridge.state.activity) return;
  if (choice.type === 'follow') { if(bridge.state.target!==choice.target)bridge.follow(choice.target); return; }
  bridge.stop();
  if (choice.type === 'walk') {
    const { x, y, z } = choice.position;
    bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
    const epoch = bridge.actionEpoch;
    const activity=bridge.state.activity={kind:'walk',label:choice.label};
    setTimeout(() => { if (bridge.bot === bot && bridge.actionEpoch === epoch && bridge.state.activity===activity) bridge.stop(); }, 10000).unref?.();
  } else if (choice.type === 'wood') {
    const p = bot.entity.position;
    const { x, y, z } = choice.position;
    const block = bot.blockAt(p.offset(x - p.x, y - p.y, z - p.z));
    if (!block || !/_log$/.test(block.name) || !bot.canDigBlock(block) || block.position.distanceTo(p) > 3.5) throw new Error('原木已不可采集');
    const epoch = bridge.actionEpoch;
    const activity=bridge.state.activity={kind:'wood',label:choice.label};
    Promise.resolve(bot.dig(block)).then(() => {
      if (bridge.bot === bot && bridge.actionEpoch === epoch){bridge.state.activity=null;bridge.event('task', '完成一块原木的挖掘，是否拾取以背包为准');}
    }).catch(() => { if (bridge.bot === bot && bridge.actionEpoch === epoch){bridge.state.activity=null;bridge.event('task', '采集未完成');} });
    setTimeout(() => { if (bridge.bot === bot && bridge.actionEpoch === epoch && bridge.state.activity===activity){bridge.stop();bridge.event('task','采集超时，已停止');} }, 10000).unref?.();
  } else throw new Error('不支持的动作');
}
