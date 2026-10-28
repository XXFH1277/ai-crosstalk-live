// A fake audience for local testing: random danmaku and the occasional gift.

const USERS = ['奶茶续命', '不爱拉磨的小牛马', '晴川', '云十七', '鲸鱼饲养员', '月光下的猫', '熬夜冠军', '樱与抱月', '路过的程序员', '今天也想摸鱼'];
const LINES = [
  '主播是真ai吗', '深深今天又打碎杯子了吗', '月月记性这么好，帮我记一下作业', '哈哈哈哈哈哈', '来了来了',
  '深度思考出结果了吗', '服务器繁忙是什么梗', '月月好飒', '鲸鱼会游泳吗', '点歌 晴天', '你们俩谁是老板',
  '今天吃啥', '笑死我了', '深深京腔好可爱', '能不能来段贯口', '刚下班，来听相声',
];
const GIFTS = [
  { gift: '小心心', coins: 1, weight: 6 },
  { gift: '玫瑰', coins: 1, weight: 4 },
  { gift: '墨镜', coins: 99, weight: 1 },
];

const pick = list => list[Math.floor(Math.random() * list.length)];

export function startMockAudience(onEvent) {
  let timer = null;
  const tick = () => {
    if (Math.random() < 0.18) {
      const total = GIFTS.reduce((n, g) => n + g.weight, 0);
      let r = Math.random() * total;
      const g = GIFTS.find(x => (r -= x.weight) < 0);
      onEvent({ type: 'gift', user: pick(USERS), gift: g.gift, coins: g.coins, count: 1 });
    } else {
      onEvent({ type: 'danmaku', user: pick(USERS), text: pick(LINES) });
    }
    timer = setTimeout(tick, 4000 + Math.random() * 8000);
  };
  tick();
  return () => clearTimeout(timer);
}
