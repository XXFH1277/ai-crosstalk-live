// OpenAI-compatible chat calls (DeepSeek and Moonshot both speak this protocol).
import { setTimeout as delay } from 'node:timers/promises';

export class Provider {
  constructor(name, { baseUrl, model, apiKeyEnv, match, systemInUser }) {
    this.name = name;
    // Some relays drop the system message (kimi on your-relay did); then send it inside the user turn.
    this.systemInUser = !!systemInUser;
    // Which model ids belong to this provider, for picking a replacement on a relay that serves many.
    this.match = new RegExp(match || name, 'i');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.key = process.env[apiKeyEnv] || '';
    this.apiKeyEnv = apiKeyEnv;
    this.status = this.key ? 'unchecked' : `缺少环境变量 ${apiKeyEnv}`;
    this.usable = false;
  }

  // One quick retry for the relay's transient failures (502/503/504, dropped connections).
  async request(path, init = {}, timeoutMs = 20000, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(path, init, timeoutMs, signal);
      } catch (e) {
        const transient = / 50[234]:/.test(e.message) || e.cause?.code === 'ECONNRESET' || e.message === 'fetch failed';
        if (attempt > 0 || !transient || signal?.aborted) throw e;
        await delay(500, undefined, { signal });
      }
    }
  }

  async requestOnce(path, init, timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...init.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  }

  // Validate the key once at startup; if the configured model is missing, fall back to a listed one.
  async check() {
    if (!this.key) return false;
    try {
      const { data } = await this.request('/models', {}, 10000);
      const ids = data.map(m => m.id);
      if (!ids.includes(this.model)) {
        const own = ids.filter(id => this.match.test(id) && !/embed|vision|reasoner|thinking|r1/i.test(id));
        const pick = own[0] || ids.find(id => this.match.test(id));
        if (!pick) throw new Error(`中转站里没有匹配 ${this.match.source} 的模型`);
        this.status = `模型 ${this.model} 不存在，改用 ${pick}`;
        this.model = pick;
      } else {
        this.status = `可用（${this.model}）`;
      }
      this.usable = true;
    } catch (e) {
      this.status = `不可用：${e.cause?.code || e.message}`;
      this.usable = false;
      // Relays often don't implement /models; a one-token chat call tells whether the key works.
      if (/ (404|405|500|502):/.test(e.message)) {
        try {
          await this.request('/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          }, 15000);
          this.status = `可用（${this.model}，无模型列表）`;
          this.usable = true;
        } catch (e2) {
          this.status = `不可用：${e2.cause?.code || e2.message}`;
        }
      }
    }
    return this.usable;
  }

  // Returns the parsed JSON object the model was asked to produce. deepseek-v4.1-flash sometimes
  // "thinks aloud" before the JSON and runs out of tokens, so one retry gets twice the budget.
  async json(system, user, opts = {}) {
    // One end-to-end deadline covers HTTP, format and response_format retries. Previously
    // each nested retry restarted the clock and a nominal 20-second call could take minutes.
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? 20000);
    opts = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline };
    try {
      return await this.jsonOnce(system, user, opts);
    } catch (e) {
      if (opts.signal?.aborted || !(e instanceof SyntaxError || /没有返回 JSON/.test(e.message))) throw e;
      return this.jsonOnce(system, user, { ...opts, maxTokens: (opts.maxTokens || 300) * 2 });
    }
  }

  async jsonOnce(system, user, { temperature = 0.9, maxTokens = 300, timeoutMs = 20000, signal } = {}) {
    const messages = this.systemInUser
      ? [{ role: 'user', content: `${system}\n\n---\n\n${user}` }]
      : [{ role: 'system', content: system }, { role: 'user', content: user }];
    const body = { model: this.model, messages, temperature, max_tokens: maxTokens };
    let out;
    if (this.jsonMode !== false) {
      try {
        out = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify({ ...body, response_format: { type: 'json_object' } }) }, timeoutMs, signal);
      } catch (e) {
        // Some relays reject response_format; the prompt already asks for JSON, so retry without it.
        if (signal?.aborted || !/ 400:/.test(e.message)) throw e;
        this.jsonMode = false;
      }
    }
    out ??= await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(body) }, timeoutMs, signal);
    const content = out.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${this.name} 没有返回 JSON：${content.slice(0, 80)}`);
    return JSON.parse(match[0]);
  }
}
