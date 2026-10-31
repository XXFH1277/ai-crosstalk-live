// 2026-10-31 中转分流：四个角色和导演各用一个 key（your-relay 按模型系列分 key、分开计量），
// 不再五份活挤一个 DeepSeek key。依据当天实测（scratchpad bench-*.mjs）：
//   导演编排 gpt-6.1-sol 两次都约 10 秒且提纲合格，其余模型 30~45 秒、一半超时；
//   台词各模型中位 3~6 秒，差别主要是同一时刻中转站的负载，分 key 后互不拖累。
// 火山（豆包官方）达到账号设的用量上限、一直 429，小克和豆姐的官方备用改成 DeepSeek 官方。
// 改 config.json（两格缩进，和控制台保存的格式一样）。重复运行结果相同。用法：node tools/中转分流.mjs
import fs from 'node:fs';

const path = new URL('../config.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const relay = 'https://your-relay.example.com/v1';
const p = config.providers;

p.deepseek.model = 'deepseek-v4-flash-0731';
p.glm = { baseUrl: relay, model: 'glm-5.3-flash', apiKeyEnv: 'GLM_API_KEY', match: 'glm' };
p.gpt = { baseUrl: relay, model: 'gpt-6.1-sol', apiKeyEnv: 'GPT_API_KEY', match: 'gpt' };

const roles = {
  深深: { provider: 'deepseek', fallbackProvider: 'kimi', officialProvider: 'deepseekOfficial' },
  月月: { provider: 'kimi', fallbackProvider: 'deepseek', officialProvider: 'deepseekOfficial' },
  豆姐: { provider: 'glm', fallbackProvider: 'deepseek', officialProvider: 'deepseekOfficial' },
  小克: { provider: 'gpt', fallbackProvider: 'glm', officialProvider: 'deepseekOfficial' },
};
for (const [name, r] of Object.entries(roles)) Object.assign(config.characters[name], r);
config.director.planner = 'gpt';
config.director.reviewer = 'glm';
// 抢答：自己的模型 4 秒没写出来，备用一起写，谁先写好用谁（导演提纲 15 秒、弹幕审核 5 秒）。
config.director.hedgeMs = 4000;
config.director.planHedgeMs = 15000;

fs.writeFileSync(path, JSON.stringify(config, null, 2));
console.log(Object.entries(roles).map(([n, r]) => `${n}→${p[r.provider].model}`).join('，'), `；导演→${p.gpt.model}，审核→${p.glm.model}`);
