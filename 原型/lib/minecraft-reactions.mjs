// 游戏即时反应判定。纯本地逻辑，不联网、不配音、不控制 bot。
// 接入方只传自己的 bot 血量；表情和音频由前端另行映射。
export class MinecraftReactions {
  constructor({ characters = ['深深', '月月', '豆姐'], now = Date.now } = {}) {
    this.characters = new Set(characters);
    this.now = now;
    this.states = new Map();
    this.revision = 0;
  }

  // 出生、重生或重新连接时调用，旧世界的生成结果随之失效。
  reset(who) {
    if (!this.characters.has(who)) throw new Error('未知角色');
    this.states.set(who, {
      revision: ++this.revision, health: null, danger: false,
      lastHit: -Infinity, lastCue: -Infinity, lastNow: -Infinity,
    });
  }

  observeHealth(who, health) {
    if (!this.characters.has(who)) throw new Error('未知角色');
    if (!Number.isFinite(health) || health < 0 || health > 20) {
      throw new Error('原版血量必须为 0 到 20 的有限数值');
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('无效时间');
    if (!this.states.has(who)) this.reset(who);
    const s = this.states.get(who);
    if (now < s.lastNow) throw new Error('时钟倒退，需重置会话');
    s.lastNow = now;
    if (s.health === 0 && health > 0) throw new Error('重生前需调用 reset');
    const hit = s.health !== null && health < s.health;
    if (hit) s.lastHit = now;
    const dead = health === 0;
    const enteringDanger = health > 0 && health <= 6 && !s.danger;
    const recovered = s.danger && health >= 10 && now - s.lastHit >= 4000;
    let kind = null;
    if (dead && s.health !== 0) kind = 'death';
    else if (enteringDanger) kind = 'danger';
    else if (recovered) kind = 'recovered';
    else if (hit && !dead && now - s.lastCue >= 2500) kind = 'hurt';
    if (enteringDanger || dead) s.danger = true;
    if (recovered) s.danger = false;
    if (health !== s.health || kind) s.revision = ++this.revision;
    s.health = health;

    // 冷却期间仍更新事实和危险状态，只抑制重复叫声。
    const result = {
      who, health, revision: s.revision, dead, danger: s.danger,
      safety: dead ? 'stop' : s.danger ? 'seek_safety' : null,
      reaction: null,
    };
    if (!kind) return result;
    s.lastCue = now;
    result.reaction = {
      kind, who, revision: s.revision, createdAt: now,
      expiresAt: now + (kind === 'death' ? 8000 : 4000),
      cue: `${who}/${kind}`, // 素材标识，不代表音频文件已制作。
      interrupt: kind === 'death' || kind === 'danger',
      fact: kind === 'death' ? '角色死亡，原因未知' :
        kind === 'danger' ? '角色血量较低，原因未知' :
        kind === 'recovered' ? '血量已回升，近期未再次掉血' :
        '角色血量下降，原因未知',
    };
    return result;
  }

  // 写词结束、配音前和播放前均检查，防止死亡后仍播放旧的采矿计划。
  isCurrent(reaction) {
    if (!reaction) return false;
    const s = this.states.get(reaction.who);
    const now = this.now();
    return !!s && reaction.revision === s.revision &&
      now >= reaction.createdAt && now < reaction.expiresAt;
  }
}
