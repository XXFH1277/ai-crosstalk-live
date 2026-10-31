// mindcraft 台词 → 配音 → 画面播放。只做“听写和播报”，不替 mindcraft 做决定。
// 台词按到达顺序配音；配音跟不上时丢掉过时的，宁可少说一句也不说旧事。

export const names = { ShenshenBot: '深深', YueyueBot: '月月' };

// 把 mindcraft 发到聊天里的一句话整理成可以念的台词；不能念的返回空串。
export function cleanLine(raw) {
  let text = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  text = text.replace(/^\(To [^)]*\)\s*/, '');           // 两人私聊时的前缀
  const cmd = text.search(/![a-zA-Z]+/);                 // 命令及之后的内容不念
  if (cmd >= 0) text = text.slice(0, cmd);
  text = text.replace(/\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!/[一-鿿]/.test(text)) return '';          // 英文播报、系统提示不念
  if ([...text].length > 60) text = [...text].slice(0, 60).join('');
  return text;
}

export class SpeechQueue {
  constructor({ voice, publish, now = Date.now, staleMs = 25000, maxWaiting = 3 }) {
    Object.assign(this, { voice, publish, now, staleMs, maxWaiting });
    this.waiting = [];      // 等配音
    this.ready = [];        // 配好了等播放
    this.pending = null;    // 正在播放
    this.history = [];
    this.sequence = 0;
    this.voicing = false;
    this.enabled = false;
    this.owner = null;
    this.leaseAt = 0;
    this.playAt = 0;
    this.phase = '未开启声音';
    this.dropped = 0;
  }

  snapshot() {
    return { enabled: this.enabled, phase: this.phase, pending: this.pending, waiting: this.waiting.length,
      buffered: this.ready.length, dropped: this.dropped, history: this.history.slice(-12) };
  }

  hear(bot, raw) {
    const who = names[bot], text = cleanLine(raw);
    if (!who || !text) return false;
    const line = { who, text, at: this.now() };
    if (!this.enabled) { this.remember(line, '未开声音'); return true; }
    this.waiting.push(line);
    while (this.waiting.length > this.maxWaiting) { this.remember(this.waiting.shift(), '来不及配音，已跳过'); this.dropped++; }
    return true;
  }

  remember(line, status) {
    this.history.push({ who: line.who, text: line.text, status });
    this.history = this.history.slice(-24);
    this.publish({ type: 'line', who: line.who, text: line.text, status });
  }

  start(client) {
    if (typeof client !== 'string' || client.length < 8 || client.length > 100) throw Error('播放页面标识无效');
    if (this.enabled && client !== this.owner) throw Error('另一页面正在播放，请先在那边暂停');
    this.owner = client; this.leaseAt = this.now(); this.enabled = true; this.phase = '等两人说话';
  }

  stop(phase = '已暂停') {
    this.enabled = false; this.waiting = []; this.ready = []; this.phase = phase;
    if (this.pending) { this.publish({ type: 'cancel', id: this.pending.id }); this.pending = null; }
  }

  heartbeat(client) { if (client === this.owner) this.leaseAt = this.now(); }

  acknowledge(client, id, status) {
    if (client !== this.owner || this.pending?.id !== id) return false;
    this.remember(this.pending, status === 'played' ? '已播放' : '播放失败');
    this.pending = null; this.playAt = this.now() + 300;
    if (status === 'error') this.stop('播放失败，已暂停；请在页面上重新开启声音');
    return true;
  }

  fresh(line) { return this.now() - line.at <= this.staleMs; }

  // canPlay：当前是否拿到播放权（7860 相声台已让出，或它没在运行）
  async tick(canPlay) {
    if (!this.enabled) return;
    if (this.now() - this.leaseAt > 15000) { this.stop('播放页面离线，已暂停'); return; }
    if (this.pending && this.now() > this.pending.deadline) { this.stop('播放未确认，已暂停'); return; }
    for (const list of [this.waiting, this.ready]) {
      while (list.length && !this.fresh(list[0])) { this.remember(list.shift(), '过时，已跳过'); this.dropped++; }
    }
    if (!canPlay) { this.phase = '等相声台让出播放权'; return; }
    if (!this.pending) this.phase = this.ready.length || this.waiting.length ? '配音中' : '等两人说话';
    if (!this.pending && this.ready.length && this.now() >= this.playAt) {
      const line = this.ready.shift();
      this.pending = { type: 'speech', id: ++this.sequence, who: line.who, text: line.text, audio: line.audio,
        seconds: line.seconds, owner: this.owner, deadline: this.now() + line.seconds * 1000 + 20000 };
      this.phase = line.who + '说话中';
      this.publish(this.pending);
    }
    if (this.voicing || !this.waiting.length || this.ready.length >= 2) return;
    this.voicing = true;
    const line = this.waiting.shift();
    try {
      const audio = await this.voice(line.who, line.text);
      if (this.enabled && this.fresh(line)) this.ready.push({ ...line, audio: audio.url, seconds: audio.seconds });
    } catch {
      this.remember(line, '配音失败');
      this.phase = '配音暂不可用（检查 Breeze F16）';
    } finally { this.voicing = false; }
  }
}

// 根据 mindcraft 每秒推送的血量判断受击、倒下、缓过来，触发预录短音
export class HealthWatch {
  constructor(publish, now = Date.now) { this.publish = publish; this.now = now; this.last = {}; this.at = {}; }
  update(bot, health) {
    const who = names[bot];
    if (!who || typeof health !== 'number') return null;
    const prev = this.last[bot]; this.last[bot] = health;
    if (prev === undefined) return null;
    let kind = null;
    if (health <= 0 && prev > 0) kind = 'death';
    else if (health < prev - 1) kind = health <= 6 ? 'danger' : 'hurt';
    else if (prev <= 6 && health >= 12) kind = 'recovered';
    if (!kind || (kind !== 'death' && this.now() - (this.at[bot] || 0) < 3000)) return null;
    this.at[bot] = this.now();
    const event = { type: 'reaction', reaction: { who, kind, expiresAt: this.now() + 3000 } };
    this.publish(event);
    return event;
  }
}
