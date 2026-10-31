// 完全离线：验证事件风暴、紧急升级、过期台词和角色隔离。
import assert from 'node:assert/strict';
import { MinecraftReactions } from '../lib/minecraft-reactions.mjs';

globalThis.fetch = () => { throw new Error('离线测试禁止联网'); };
let time = 1000;
const rules = new MinecraftReactions({ now: () => time });
assert.equal(rules.observeHealth('深深', 20).reaction, null);
const hurt = rules.observeHealth('深深', 19).reaction;
assert.equal(hurt.kind, 'hurt');
assert.equal(rules.isCurrent(hurt), true);
time += 100;
const storm = rules.observeHealth('深深', 18);
assert.equal(storm.reaction, null, '连续受伤不重复叫喊');
assert.equal(rules.isCurrent(hurt), false, '新伤情使旧生成结果失效');
const danger = rules.observeHealth('深深', 6);
assert.equal(danger.reaction.kind, 'danger', '危险升级不受普通叫声冷却限制');
assert.equal(danger.safety, 'seek_safety');
assert.equal(danger.reaction.interrupt, true);
assert.equal(rules.observeHealth('深深', 7).danger, true, '阈值附近不来回切换');
time += 100;
assert.equal(rules.observeHealth('深深', 10).reaction, null, '回血后仍等待稳定期');
time += 4000;
const recovered = rules.observeHealth('深深', 10).reaction;
assert.equal(recovered.kind, 'recovered');
assert.equal(rules.observeHealth('深深', 10).reaction, null, '不重复播报恢复');
assert.equal(rules.isCurrent(recovered), true);
rules.observeHealth('月月', 20);
assert.equal(rules.observeHealth('月月', 18).reaction.kind, 'hurt');
assert.equal(rules.isCurrent(recovered), true, '其他角色的事件不误杀本角色台词');
time += 4000;
assert.equal(rules.isCurrent(recovered), false, '超时即丢弃');
const death = rules.observeHealth('深深', 0);
assert.equal(death.reaction.kind, 'death');
assert.equal(death.safety, 'stop');
assert.equal(rules.observeHealth('深深', 0).reaction, null, '死亡事件只触发一次');
assert.throws(() => rules.observeHealth('深深', 20), /reset/);
rules.reset('深深');
assert.equal(rules.isCurrent(death.reaction), false, '重生使旧台词失效');
assert.equal(rules.observeHealth('深深', 20).reaction, null);
assert.throws(() => rules.observeHealth('陌生人', 20), /未知角色/);
for (const health of [NaN, Infinity, -1, 21, '10']) {
  assert.throws(() => rules.observeHealth('深深', health), /血量/);
}
time -= 1;
assert.throws(() => rules.observeHealth('深深', 20), /时钟倒退/);
console.log('PASS 游戏反应：连续受伤合并、危险升级、恢复迟滞、死亡去重、过期丢弃、角色隔离');
