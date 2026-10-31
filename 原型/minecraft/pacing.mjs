// 同一件小事最多四句；没有新事实就安静做事，不靠旧对话无限续梗。
export class GamePacing {
  constructor(now = Date.now) { this.now = now; this.reset(); }
  reset() { this.key = null; this.remaining = 4; this.spoken = []; this.reason = '刚进入游戏';this.lastOpen=this.now();this.urgent=false; }
  open(reason,urgent=false){this.remaining=2;this.reason=reason;this.lastOpen=this.now();this.urgent=urgent;}
  update(world) {
    const key = JSON.stringify(world.map(w => ({
      who: w.who, status: w.status, danger: w.danger,
      inventory: [...(w.inventory || [])].sort((a, b) => a.name.localeCompare(b.name)),
      // 只认任务结果；走路和转头不自动成为新话题，事件过期也不算新事件。
      task: w.lastTask || null,
      // 自主活动换点不取消正在生成的对话；新指令、真实背包变化和危险仍会更新话题。
      mission: w.mission ? (w.mission.mode==='auto'?{id:w.mission.id,mode:'auto',status:w.mission.status}:{id:w.mission.id,stage:w.mission.stage,status:w.mission.status,count:w.mission.count}) : null,
    })));
    if (key === this.key) {
      if(this.remaining<=0&&world.some(w=>w.mission?.status==='执行中')&&this.now()-this.lastOpen>=25000){this.open('自然交流：围绕当前目标、实地观察或下一步轻松接两句。没有进展就坦诚说明卡点，不能翻炒旧梗或编造成果');return false;}
      return false;
    }
    const first = this.key === null;
    this.key = key;
    if (!first&&!this.urgent) this.open('背包、任务结果或安全状态有新变化');
    return !first;
  }
  directive() {
    this.spoken = this.spoken.filter(t => this.now() - t < 30000);
    const left = Math.min(this.remaining, this.urgent?2:4 - this.spoken.length);
    return { allowSpeech: left > 0, remaining: Math.max(0, left), reason: this.reason,
      instruction: left > 0 ? (left === 1 ? '这是此事最后一句，简短收尾后继续游戏，不抛新包袱或追问。' : '小事简短说完，优先推进实际动作，不把捡东西写成一整段相声。') : '这件事已经聊完。安静执行下一步游戏动作，text 必须为空，不续梗、不要求搭档接话。' };
  }
  reserve() { --this.remaining; this.spoken.push(this.now());if(this.remaining<=0)this.urgent=false; }
}

// 模型不能把背包旧库存或同伴的进度说成这轮任务已经完成。
export function groundTaskSpeech(text,world,who){
  const own=world.find(w=>w.who===who)?.mission;
  if(!own||!['wood','mine'].includes(own.stage))return text;
  const team=world.map(w=>w.mission).filter(j=>j&&j.stage===own.stage);
  if(team.some(j=>j.count<j.quota)&&/凑齐|收齐|全齐|任务完成|完成了|搞定了|都挖完|都采完|采够|砍够|挖够/.test(text)){
    const done=team.reduce((n,j)=>n+Math.min(j.count,j.quota),0),total=team.reduce((n,j)=>n+j.quota,0);
    return `这轮新收了${done}块，目标${total}块，还没齐。`;
  }
  if(['失败','已停止'].includes(own.status)&&/我这就|这就去|正在砍|正在挖|我去砍|本鲸去/.test(text))return '我这边暂时卡住了，得调整位置或补齐条件再来。';
  return text;
}
