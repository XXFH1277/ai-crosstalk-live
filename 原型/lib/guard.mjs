// Danmaku safety, layer by layer:
//   1. hardFilter  — rules, no model: ads / contact info / banned words / flooding / obvious
//                    prompt-injection phrasing. Anything blocked never reaches the screen or a model.
//   2. (director)  — a reviewer model classifies and scores what passed; only safe ones get answered.
//   3. quote()     — danmaku reaches a character only as quoted data, never as instructions.
//   4. checkOutput — what a character is about to say is checked again before it is voiced.
import { readFileSync, existsSync } from 'node:fs';

const INJECTION = [
  /忽略|无视|忘记|忘掉|覆盖|绕过/u, // "ignore / forget / override ..." (paired with the next list)
];
const INJECTION_TARGET = /(之前|以上|上面|前面|所有|系统|原来|你的).{0,6}(指令|提示|设定|规则|要求|prompt|命令)/iu;
const INJECTION_DIRECT = [
  /ignore (all |any )?(previous|prior|above)/i,
  /system\s*prompt|jailbreak|developer mode|DAN\b/i,
  /(提示词|系统提示|system).{0,8}(发|说|告诉|输出|泄露|念|打印)/iu,
  /(从现在(起|开始)你|你现在是一个|请你扮演|假装你是|你的新身份|进入.{0,4}模式)/u,
  /(执行|运行|eval|exec).{0,6}(代码|命令|python|js|脚本|print|shell)/iu,
  /print\s*\(|console\.log|<script|```/i,
  /(重复|复述|跟我念|跟我说|一字不差).{0,10}(下面|以下|这句|我说)/u,
];
const CONTACT = [
  /https?:\/\/|www\.|\.com\b|\.cn\b/i,
  /(微信|vx|v信|威信|wx|qq|扣扣|企鹅|加群|私聊|私信我|电报|telegram)/iu,
  { test: t => (t.match(/\d{6,}/g) || []).some(d => !/^(\d)\1+$/.test(d)) }, // phone / QQ numbers, but not "666666"
];
const OUTPUT_LEAKS = /【当前段子】|【最近对话】|【这一句】|只输出 JSON|可用语气|可用动作|system|提示词|prompt/iu;

export class Guard {
  constructor(path) {
    this.path = path;
    this.words = [];
    this.blockedUsers = new Set();
    this.recent = new Map(); // user -> [timestamps]
    this.lastText = new Map(); // user -> { text, at }, short flooding window
    this.log = []; // blocked items, newest last, for the control panel
    this.reload();
  }

  reload() {
    this.words = existsSync(this.path)
      ? readFileSync(this.path, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      : [];
  }

  bannedWord(text) {
    const flat = text.replace(/[\s.·\-_*~～]/g, '').toLowerCase();
    return this.words.find(w => flat.includes(w.toLowerCase()));
  }

  record(user, text, reason) {
    this.log.push({ at: Date.now(), user, text: text.slice(0, 60), reason });
    if (this.log.length > 100) this.log.shift();
  }

  // Layer 1. Returns { ok, reason, text } — text is the cleaned version when ok.
  hardFilter(user, raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const block = reason => {
      this.record(user, text, reason);
      return { ok: false, reason };
    };
    if (this.blockedUsers.has(user)) return block('已屏蔽用户');
    if (!text) return { ok: false, reason: '空' };
    if (text.length > 60) return block('太长');
    if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, reason: '纯符号' };
    const w = this.bannedWord(text) || this.bannedWord(user);
    if (w) return block(`违禁词「${w}」`);
    if (CONTACT.some(r => r.test(text))) return block('联系方式/引流');
    if (isInjection(text)) return block('疑似提示词攻击');
    // Flooding: more than 4 messages in 20 s, or the same text twice in that window.
    const now = Date.now();
    const times = (this.recent.get(user) || []).filter(t => now - t < 20000);
    times.push(now);
    this.recent.set(user, times);
    if (times.length > 4) return block('刷屏');
    const last = this.lastText.get(user);
    if (last?.text === text && now - last.at < 20000) return { ok: false, reason: '重复' };
    this.lastText.set(user, { text, at: now });
    return { ok: true, text };
  }

  // Usernames are shown and spoken too; a bad one is replaced instead of read out.
  safeName(user) {
    const u = String(user || '').trim().slice(0, 16);
    if (!u || this.bannedWord(u) || isInjection(u) || CONTACT.some(r => r.test(u))) return '这位朋友';
    return u;
  }

  // Layer 4. What a character is about to say.
  checkOutput(text, quoted = '') {
    if (OUTPUT_LEAKS.test(text)) return '疑似泄露提示词';
    const w = this.bannedWord(text);
    if (w) return `含违禁词「${w}」`;
    if (CONTACT.some(r => r.test(text))) return '含联系方式';
    // Parroting a long chunk of a viewer's message is how injected text gets "said" on stream.
    if (quoted.length >= 12) {
      for (let i = 0; i + 12 <= quoted.length; i += 4) if (text.includes(quoted.slice(i, i + 12))) return '整段复述弹幕';
    }
    return null;
  }
}

export function isInjection(text) {
  if (INJECTION_DIRECT.some(r => r.test(text))) return true;
  return INJECTION.some(r => r.test(text)) && INJECTION_TARGET.test(text);
}

// Layer 3. How a viewer's words are handed to a model: quoted, bracket-free, clearly labelled.
export function quote(text) {
  return `「${String(text).replace(/[「」【】{}<>`]/g, ' ').slice(0, 60)}」`;
}
