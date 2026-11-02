// 2026-11-02 日常场景（全员大学生）：教室、图书馆、活动室、宿舍卧谈，四个人都是头摆正的上半身立绘。
// 小克也是学生，这里用学生常服；教师装（小克职业装）只用于第 9 话视频，直播不用。
// 改 config.json（保持两格缩进，和控制台保存的格式一样）。重复运行结果相同。
// 注意：tools/万圣多组合.mjs 会整个重写 sets，跑完它要再跑一次本脚本。
// 用法：node tools/日常场景.mjs
import fs from 'node:fs';

const path = new URL('../config.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
const SET = '常服'; // 日常便服
const SET_PJ = '睡衣';
const SET_BOOK = '书斋'; // 芊芊穿设定图上的盘扣外袍，其他人穿常服

// ---- 新角色 芊芊（千问娘）----
// 中转站还没有千问的 key，先用台上空闲的 GLM 写台词；有 key 后在 providers 里加一个 qwen 换上。
const QIANQIAN_POSES = ['摇扇', '掩扇笑', '捧书', '举手', '托腮', '扇指', '摸辫子', '行礼', '挥手', '害怕'];
const motionOf = { 摇扇: 'nod', 掩扇笑: 'tilt', 捧书: 'nod', 举手: 'hop', 托腮: 'tilt', 扇指: 'lean', 摸辫子: 'tilt', 行礼: 'bow', 挥手: 'nod', 害怕: 'tremble' };
config.characters.芊芊 = {
  provider: 'glm',
  fallbackProvider: 'kimi',
  officialProvider: 'deepseekOfficial',
  role: '文哏（中文系新社员，文静，爱轻声提问）',
  voice: 'qianqian_01',
  color: '#8fa8ff',
  x: 960,
  badge: '千问娘',
  directionPrefix: '文静温柔的大学女生，普通话标准，声音轻柔、吐字清楚，',
  moods: {
    基础: { direction: '轻声细语，语速偏慢，句尾轻轻收住。', actions: ['', '', '点头', '歪头', '捧书'] },
    轻快互动: { direction: '轻声带笑地接观众的话，真诚又有点害羞，语速适中。', actions: ['', '点头', '挥手', '歪头'] },
    追问: { direction: '轻轻地、真诚地问，语速慢，问句尾音轻轻上扬，毫无恶意。', after: '坏笑', react: '无语', actions: ['举手', '托腮', '歪头', ''], reactActions: ['', '点头', '捧书'] },
    念诗: { direction: '放慢语速，像念一句诗，字字清楚、有韵味，最后一个字轻轻收住。', after: '开心', react: '惊讶', actions: ['摇扇', '捧书', '扇指'] },
    害羞: { direction: '声音越来越小，有点结巴，抿着嘴笑。', after: '害羞', actions: ['摸辫子', '掩扇笑'] },
    开心: { direction: '抿嘴轻轻地笑出声，声音明亮了一点，还是很轻。', after: '开心', actions: ['掩扇笑', '摇扇', '点头'] },
    惊讶: { direction: '轻轻吸一口气，小声地惊呼，然后笑了。', after: '惊讶', actions: ['', '害怕'] },
    撒娇: { direction: '轻声软软地拖一点尾音，有点不好意思。', after: '撒娇', actions: ['摸辫子'] },
    委屈: { direction: '声音很轻，带一点鼻音，还是很有礼貌。', after: '委屈', actions: ['摸辫子', ''] },
    生气: { direction: '难得生气，声音还是轻的，但一字一顿，气鼓鼓的。', after: '生气', react: '吓呆', actions: ['扇指', ''] },
    害怕: { direction: '声音发紧、发抖，越说越小声。', after: '害怕', actions: ['害怕', '发抖'] },
    谢礼物: { direction: '轻声而真诚地道谢，带着害羞的笑。', after: '开心', react: '开心', actions: ['行礼', '挥手', '点头'] },
  },
  actions: {
    点头: { motion: 'nod' }, 摇头: { motion: 'shake' }, 歪头: { motion: 'tilt' }, 凑近: { motion: 'lean' }, 发抖: { motion: 'tremble' }, 蹦跳: { motion: 'hop' },
    ...Object.fromEntries(QIANQIAN_POSES.map(p => [p, { pose: p, motion: motionOf[p], sets: { [SET_BOOK]: p } }])),
    抱枕: { motion: 'nod', sets: { [SET_PJ]: '抱枕' } },
  },
  sets: {
    [SET_BOOK]: { sprite: '芊芊' },
    [SET]: { sprite: '芊芊常服' },
    [SET_PJ]: { sprite: '芊芊睡衣' },
  },
};
Object.assign(config.characters.芊芊.actions.举手.sets, { [SET]: '举手', [SET_PJ]: '举手' });
Object.assign(config.characters.芊芊.actions.挥手.sets, { [SET]: '挥手' });
Object.assign(config.characters.芊芊.actions.捧书.sets, { [SET]: '捧书' });
Object.assign(config.characters.芊芊.actions.摸辫子.sets, { [SET]: '摸辫子' });
Object.assign(config.characters.芊芊.actions.害怕.sets, { [SET_PJ]: '害怕' });
config.director.fillers.lines.芊芊 = [
  { text: '嗯？', mood: '基础' },
  { text: '这样呀。', mood: '基础' },
  { text: '那后来呢？', mood: '追问' },
  { text: '好厉害呀。', mood: '开心' },
  { text: '等、等一下……', mood: '害羞' },
];

// ---- 小克：学生，不是老师 ----
config.characters.小克.role = '腻缝儿（鲸云社的学生导演，傲娇，和深深相爱相杀）';
config.characters.小克.directionPrefix = '活泼干练的大学女生，社团里的导演，普通话标准，明亮有指挥感，';

// ---- 立绘套 ----
for (const set of [SET, SET_BOOK]) {
  config.characters.深深.sets[set] = { sprite: '深深常服' };
  config.characters.月月.sets[set] = { sprite: '月月常服' };
  config.characters.小克.sets[set] = { sprite: '小克常服' };
}

// 动作 → 常服套里的姿势（没列的动作在常服里只播 motion）
for (const a of Object.values(config.characters.小克.actions)) if (a.sets) delete a.sets[SET];
config.characters.小克.actions.挥手 = { motion: 'nod' };
const map = {
  深深: { 挥手: '挥手', 举手: '挥手', 比心: '比心', 撒娇: '比心' },
  月月: { 小本本: '小本本', 翻书: '小本本', 讲故事: '小本本', 指人: '指人' },
  小克: { 打板: '打板', 喊卡: '打板', 场记板: '打板', 叉腰: '叉腰', 抱臂: '抱臂', 傲娇: '抱臂', 指挥: '指挥', 挥手: '挥手' },
};
for (const [name, actions] of Object.entries(map)) {
  const all = config.characters[name].actions;
  for (const [action, pose] of Object.entries(actions)) {
    all[action].sets = { ...(all[action].sets || {}), [SET]: pose, [SET_BOOK]: pose };
  }
}

// ---- 豆姐：头摆正（店长装、大褂）----
const SET_GOWN = '大褂正头';
config.characters.豆姐.sets[SET] = { sprite: '豆姐店长' };
config.characters.豆姐.sets[SET_BOOK] = { sprite: '豆姐店长' };
config.characters.豆姐.sets[SET_GOWN] = { sprite: '豆姐大褂' };
const dou = config.characters.豆姐.actions;
for (const [action, pose] of Object.entries({ 抱臂: '抱臂', 指人: '指人', 举杯: '举杯', 招手: '招手' })) {
  dou[action].sets = { ...(dou[action].sets || {}), [SET]: pose, [SET_BOOK]: pose };
}
for (const [action, pose] of Object.entries({ 拍醒木: '拍醒木', 抱臂: '抱臂', 指人: '指人' })) {
  dou[action].sets = { ...(dou[action].sets || {}), [SET_GOWN]: pose };
}
// 深深、月月的大褂也摆正了
config.characters.深深.sets[SET_GOWN] = { sprite: '深深大褂' };
config.characters.月月.sets[SET_GOWN] = { sprite: '月月大褂' };
const gown = {
  深深: { 开扇: '开扇', 敬礼: '拱手', 指人: '扇指' },
  月月: { 拱手: '拱手', 小本本: '小本本', 摊手: '摊手', 捂嘴笑: '捂嘴笑' },
};
for (const [name, actions] of Object.entries(gown)) {
  const all = config.characters[name].actions;
  for (const [action, pose] of Object.entries(actions)) all[action].sets = { ...(all[action].sets || {}), [SET_GOWN]: pose };
}
config.scenes.鲸云社.set = SET_GOWN;
config.scenes['鲸云社·群口'].set = SET_GOWN;

// ---- 场景 ----
const ORDER = ['教室·入社', '图书馆', '教室·对口', '活动室·排练', '宿舍卧谈', '教室·深克', '鲸云社·群口'];
const CAMPUS = '四个人都是大学同学，没有老师在场，谁也不是老师。';
const CLASS = `现在是放学后的教室，鲸云社的同学们留下来排节目，夕阳从窗户照进来。${CAMPUS}`;
const DRESS = {
  深深: '深深穿浅蓝色鲸鱼卫衣、背着小书包',
  月月: '月月穿米白针织开衫和格子裙',
  小克: '小克穿白衬衫、橙色针织背心和格子短裙，是学生，只有排练时才拿场记板',
  芊芊: '芊芊穿淡蓝紫色盘扣上衣和藏青长裙，抱着书',
};
const dress = cast => `${cast.map(n => DRESS[n]).join('；')}。`;
const QIANQIAN = '芊芊最文静，声音轻、话最少，爱真诚地轻轻提问，常常一句话把人问住；她不抬杠、不吐槽、不喊卡。';
const TRAD = '多用相声的活儿：垫话、贯口、三翻四抖、子母哏、腿子活，包袱贴着校园和日常生活。';
const two = (a, b) => ({ positions: { [a]: 640, [b]: 1280 }, scale: 1 });
const four = (a, b, c, d) => ({ positions: { [a]: 390, [b]: 730, [c]: 1070, [d]: 1410 }, scale: 0.72 });
const base = { background: '背景/教室-1920x1080.png', title: '放学后', outfit: null, set: SET, plaque: null, segments: 1 };
const scenes = {
  '教室·入社': {
    ...base, subtitle: '鲸云社 · 四人同台', cast: ['深深', '小克', '月月', '芊芊'], ...four('深深', '小克', '月月', '芊芊'), segments: 2,
    topics: ['鲸云社·招新', '放学后的教室·四人'],
    note: `${CLASS}今天鲸云社来了新社员芊芊（千问娘，中文系）。小克是社团里管排练的学生导演，深深爱吹牛，月月爱翻旧账。${QIANQIAN}${dress(['深深', '小克', '月月', '芊芊'])}${TRAD}`,
  },
  图书馆: {
    ...base, set: SET_BOOK, background: '背景/图书馆-1920x1080.png', title: '图书馆', subtitle: '深深 × 芊芊', cast: ['深深', '芊芊'], ...two('深深', '芊芊'),
    topics: ['图书馆·轻声对口'],
    note: `现在是傍晚的大学图书馆阅览区。芊芊（千问娘）在这里勤工俭学，今天穿盘扣上衣、披藏青外袍，拿着折扇和书；深深穿鲸鱼卫衣来找她。图书馆里不能大声，两个人都压低声音说话：深深小声吹牛，芊芊认真地信了，轻轻地追问。${QIANQIAN}${TRAD}`,
  },
  '教室·对口': {
    ...base, subtitle: '深深 × 月月', cast: ['深深', '月月'], ...two('深深', '月月'),
    topics: ['校园吹牛', '校园贯口', '校园歪批', '学说学像', '文字游戏', '柳活·学唱', '子母哏·抬杠', '怯行当', '入冬时令', 'AI 同学的日常', '校园生活'],
    note: `${CLASS}别人都走了，深深和月月留在教室里练对口，深深逗、月月捧。${dress(['深深', '月月'])}${TRAD}`,
  },
  '活动室·排练': {
    ...base, set: SET_BOOK, background: '背景/相声社活动室-1920x1080.png', title: '活动室', subtitle: '小克 × 芊芊', cast: ['小克', '芊芊'], ...two('小克', '芊芊'),
    topics: ['活动室·排练'],
    note: `现在是傍晚的相声社活动室，小克给新社员芊芊排练。两人都是学生，小克是社团里管排练的导演，认真、傲娇、爱喊卡；${QIANQIAN}芊芊今天穿盘扣上衣、披藏青外袍，拿着折扇。${TRAD}`,
  },
  '教室·深克': {
    ...base, subtitle: '深深 × 小克', cast: ['深深', '小克'], ...two('深深', '小克'),
    topics: ['教室·相爱相杀'],
    note: `${CLASS}这一段只有深深和小克两个人，都是学生：小克是社团导演，一板一眼；深深最让她头疼，捣蛋、撒娇、耍赖。两人互相嫌弃、互相拆台，关键时候又护着对方，嘴上谁都不承认。${dress(['深深', '小克'])}${TRAD}`,
  },
  宿舍卧谈: {
    ...base, set: SET_PJ, background: '背景/宿舍夜话-1920x1080.png', title: '宿舍夜话', subtitle: '熄灯卧谈会', cast: ['深深', '小克', '月月', '芊芊'], ...four('深深', '小克', '月月', '芊芊'), segments: 2,
    topics: ['宿舍·四人卧谈'],
    note: `现在是熄灯后的女生宿舍“卧谈会”：上床下桌，只开着一盏暖黄的小台灯，窗外一轮大月亮。四个人是同宿舍的大学同学，芊芊是刚搬进来的新舍友，穿着睡衣抱着枕头，聊的是大学生活里的大事小情。宿管阿姨是豆姐（不在台上，只能在台词里出现，比如“嘘——宿管阿姨查寝了！”）。${QIANQIAN}声音放轻放慢，像怕吵醒隔壁宿舍，很多观众是听着睡觉的；不讲鬼故事，讲好笑又温暖的日常。`,
  },
};
delete config.scenes.教室; // 小克当老师的旧场景
for (const [name, s] of Object.entries(scenes)) config.scenes[name] = s;
config.director.sceneRotation.order = ORDER;
// 万圣节场景留着（控制台还能手动选），默认换成芊芊入社这一场。
config.scene = ORDER[0];
fs.writeFileSync(path, JSON.stringify(config, null, 2));
console.log('默认场景：', config.scene, '；轮换：', ORDER.join(' → '));
