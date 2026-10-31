import { MinecraftReactions } from '../lib/minecraft-reactions.mjs';

// 依赖注入便于离线验证；模块本身不会创建连接或定时器。
export class MinecraftBridge {
  constructor({ createBot, pathfinder, Movements, GoalFollow, who = '深深', username = 'ShenshenBot', now = Date.now, publish = () => {}, onChat = () => {} }) {
    Object.assign(this, { createBot, pathfinder, Movements, GoalFollow, who, username, now, publish, onChat });
    this.rules = new MinecraftReactions({ characters: [who], now });
    this.actionEpoch = 0;
    this.bot = null;
    this.session = 0;
    this.events = [];
    this.state = { status: '未连接', who, username, target: null, health: null, food: null, position: null, players: [], danger: false };
  }

  snapshot() { return { ...this.state, events: this.events.slice(-30) }; }
  event(type, text, extra = {}) {
    const event = { type, who: this.who, text, at: this.now(), ...extra };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    this.publish(event);
  }

  connect(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('请输入 1024～65535 的局域网端口');
    if (this.bot) throw new Error('请先断开当前连接');
    const session = ++this.session;
    this.rules.reset(this.who);
    Object.assign(this.state, { status: '连接中', port, target: null, health: null, food: null, position: null, players: [], danger: false });
    let bot;
    try {
      bot = this.createBot({ host: '127.0.0.1', port, username: this.username, auth: 'offline', version: '1.21.6', respawn: false, checkTimeoutInterval: 30000 });
    } catch (error) {
      this.state.status = '连接失败';
      throw error;
    }
    this.bot = bot;
    const active = () => this.bot === bot && this.session === session;
    bot.on('chat',(player,text)=>{if(active())this.onChat(player,text);});
    bot.on('error', () => { if (active()) this.event('error', '连接发生错误，请检查游戏是否已开放局域网及端口是否正确'); });
    bot.on('kicked', () => { if (active()) this.event('error', '游戏拒绝或结束了 bot 连接，请检查版本与本地世界认证设置'); });
    bot.on('end', () => {
      if (!active()) return;
      this.bot = null;
      ++this.session;
      ++this.actionEpoch;
      this.rules.reset(this.who);
      Object.assign(this.state, { status: '已断开', target: null, players: [], position: null, health: null, food: null, danger: false });
      this.event('connection', `${this.who}已离开世界`);
    });
    bot.loadPlugin(this.pathfinder);
    bot.on('spawn', () => {
      if (!active()) return;
      this.rules.reset(this.who);
      const movements = new this.Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      movements.allowSprinting = false;
      movements.maxDropDown = 1;
      movements.scafoldingBlocks = [];
      bot.pathfinder.setMovements(movements);
      Object.assign(this.state, { status: '已入服', target: null, danger: false });
      this.event('connection', `${this.who}已进入世界`);
      this.tick();
    });
    bot.on('respawn', () => {
      if (!active()) return;
      this.stop();
      this.rules.reset(this.who);
      this.state.status = '切换世界中';
    });
    bot.on('health', () => { if (active()) this.tick(); });
    bot.on('death', () => { if (active()) this.observeHealth(0); });
    bot.on('path_update', result => {
      if (active() && result.status === 'noPath' && this.state.target) {
        this.stop();
        this.event('movement', '暂时找不到可走的路，已停止跟随');
      }
    });
    this.event('connection', '正在连接本机 Minecraft 世界');
  }

  observeHealth(health) {
    if (!Number.isFinite(health) || health < 0 || health > 20) return;
    const result = this.rules.observeHealth(this.who, health);
    this.state.health = health;
    this.state.danger = result.danger;
    if (result.safety) {
      this.stop();
      if (result.dead) this.state.status = '已死亡';
    }
    if (result.reaction) this.event('reaction', result.reaction.fact, { reaction: result.reaction });
  }

  tick() {
    const bot = this.bot;
    if (!bot || !['已入服', '已死亡'].includes(this.state.status)) return;
    // 死亡后等待显式重生，不使用旧血量将角色误判为复活。
    if (this.state.status !== '已死亡') this.observeHealth(bot.health);
    this.state.food = Number.isFinite(bot.food) ? bot.food : null;
    const p = bot.entity?.position;
    this.state.position = p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null;
    this.state.players = Object.entries(bot.players || {}).filter(([name, p]) => name !== bot.username && p.entity).map(([name]) => name);
    if (this.state.target && !this.state.players.includes(this.state.target)) {
      this.stop();
      this.event('movement', '跟随对象离开可见范围，已停止');
    }
  }

  follow(target) {
    if (!this.bot || this.state.status !== '已入服') throw new Error('bot 尚未进入世界');
    if (this.state.danger || this.state.health === null) throw new Error('血量状态不适合开始跟随');
    const player = this.bot.players?.[target]?.entity;
    if (!player || target === this.bot.username) throw new Error('没有看到这个玩家');
    this.bot.pathfinder.setGoal(new this.GoalFollow(player, 2), true);
    this.state.target = target;
    this.event('movement', '开始跟随选中的玩家');
  }

  stop() {
    ++this.actionEpoch;
    this.state.activity = null;
    this.bot?.stopDigging?.();
    this.bot?.pathfinder?.setGoal(null);
    this.bot?.clearControlStates();
    this.state.target = null;
  }

  respawn() {
    if (!this.bot || this.state.status !== '已死亡') throw new Error('只有死亡后才能重生');
    this.state.status = '重生中';
    this.bot.respawn();
  }

  disconnect() {
    const bot = this.bot;
    if (!bot) return;
    this.stop();
    this.bot = null;
    ++this.session;
    this.rules.reset(this.who);
    bot.quit();
    Object.assign(this.state, { status: '已断开', health: null, food: null, position: null, players: [], danger: false });
    this.event('connection', '已主动断开游戏连接');
  }
}
