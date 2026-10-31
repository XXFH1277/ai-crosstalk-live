// 假 bot，不连接 Minecraft、不调用模型或 TTS。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MinecraftBridge } from '../minecraft/bridge.mjs';

globalThis.fetch = () => { throw new Error('禁止联网'); };
let now = 10000;
let created = 0;
const bots = [];
const published = [];
const bridge = new MinecraftBridge({
  now: () => now, publish: e => published.push(e), pathfinder: () => {},
  Movements: class {}, GoalFollow: class { constructor(entity, range) { Object.assign(this, { entity, range }); } },
  createBot(options) {
    assert.equal(options.host, '127.0.0.1');
    assert.equal(options.respawn, false);
    created++;
    const bot = new EventEmitter();
    Object.assign(bot, { username: options.username, health: 20, food: 20, players: { Player: { entity: { id: 1 } } }, entity: { position: { x: 1, y: 64, z: 1 } },
      loadPlugin() {}, clearControlStates() { this.cleared = true; }, quit() { this.closed = true; }, respawn() { this.respawnCalled = true; },
      pathfinder: { setMovements(m) { this.movements = m; }, setGoal(g) { this.goal = g; } },
    });
    bots.push(bot);
    return bot;
  },
});
for (const port of [0, 80, 65536, 25565.5, '25565', NaN]) assert.throws(() => bridge.connect(port), /端口/);
assert.equal(created, 0);
bridge.connect(25565);
assert.throws(() => bridge.connect(25565), /断开/);
assert.throws(() => bridge.follow('Player'), /尚未/);
const first = bots[0];
first.emit('spawn');
assert.equal(bridge.state.status, '已入服');
assert.equal(first.pathfinder.movements.canDig, false);
assert.deepEqual(first.pathfinder.movements.scafoldingBlocks, []);
bridge.follow('Player');
assert.equal(first.pathfinder.goal.range, 2);
first.health = 6; first.emit('health');
assert.equal(bridge.state.target, null);
assert.equal(first.pathfinder.goal, null, '低血量中止寻路');
assert.equal(first.cleared, true);
assert.throws(() => bridge.follow('Player'), /血量/);
first.emit('death'); first.emit('death');
assert.equal(published.filter(e => e.reaction?.kind === 'death').length, 1);
bridge.tick();
assert.equal(bridge.state.health, 0, '死亡后不读取尚未刷新的旧血量');
bridge.respawn();
assert.equal(first.respawnCalled, true);
first.emit('respawn'); first.health = 20; first.emit('spawn');
assert.equal(bridge.state.danger, false);
bridge.follow('Player');
delete first.players.Player;
bridge.tick();
assert.equal(bridge.state.target, null);
bridge.disconnect();
assert.equal(first.closed, true);
bridge.connect(25566);
const second = bots[1]; second.emit('spawn');
first.emit('end'); first.emit('death');
assert.equal(bridge.bot, second, '旧连接的迟到事件不能清掉新连接');
assert.equal(bridge.state.health, 20);
second.emit('end');
assert.equal(bridge.bot, null);
assert.equal(bridge.state.position, null);
assert.equal(bridge.state.health, null);
console.log('PASS 游戏接入：连接约束、跟随停止、低血量中止、死亡重生、失去目标与会话隔离');
