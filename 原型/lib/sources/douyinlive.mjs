// Source: the local douyinLive service (github.com/jwwsjlm/douyinLive), which connects to the
// Douyin room itself and relays its messages as JSON over a local WebSocket.

export class DouyinLiveSource {
  constructor({ url, key, push, log }) {
    Object.assign(this, { url: url.replace(/\/$/, ''), key, push, log });
    this.roomId = '';
    this.ws = null;
    this.retry = 0;
    this.timer = null;
    this.status = '未启用';
    this.anchor = '';
  }

  // Connected to the douyinLive service: gifts from the browser extension are then ignored.
  get online() {
    return this.ws?.readyState === 1;
  }

  setRoom(roomId) {
    if (roomId === this.roomId && this.ws) return;
    this.roomId = roomId;
    this.close();
    if (roomId) this.connect();
    else this.status = '未设置房间号';
  }

  close() {
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  connect() {
    this.status = '连接中';
    const ws = new WebSocket(`${this.url}/${encodeURIComponent(this.roomId)}`, {
      headers: this.key ? { Authorization: `Bearer ${this.key}` } : {},
    });
    this.ws = ws;
    ws.onopen = () => {
      if (this.retry) this.log?.('douyinLive：重新连上了');
      this.retry = 0;
      this.status = '已连接，等待直播间状态';
    };
    ws.onmessage = e => {
      try {
        this.handle(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The service keeps one connection open across offline/online, so a close means the
      // service itself is down or the room id is invalid; back off before retrying.
      if (!this.retry) this.log?.('douyinLive：连不上（douyinLive 没运行？）。礼物只能靠浏览器插件读评论区，按小礼物各谢一次');
      const wait = Math.min(60, 5 * 2 ** this.retry++);
      this.status = `连接断开（douyinLive 没运行？），${wait} 秒后重连`;
      this.timer = setTimeout(() => this.connect(), wait * 1000);
    };
  }

  handle(d) {
    if (d.type === 'system') {
      this.anchor = d.live_name || this.anchor;
      this.status = `${d.status_text || d.code}${d.live_name ? `（${d.live_name}）` : ''}`;
      if (d.code !== 'ROOM_ONLINE') this.log?.(`douyinLive：${this.status}`);
      return;
    }
    const user = d.user?.nickname;
    if (d.method === 'WebcastChatMessage' && user && d.content) {
      this.push('douyinLive', { type: 'danmaku', user, text: d.content });
    } else if (d.method === 'WebcastGiftMessage' && user) {
      const gift = d.gift || {};
      const count = Number(d.repeatCount || d.comboCount || d.totalCount || d.groupCount || 1);
      // Combo gifts send one message per tap with a growing count; repeatEnd marks the last one.
      const final = d.repeatEnd === 1 || d.repeatEnd === true || gift.combo === false;
      this.push('douyinLive', { type: 'gift', user, gift: gift.name || '礼物', coins: Number(gift.diamondCount) || 0, count, final });
    }
  }
}
