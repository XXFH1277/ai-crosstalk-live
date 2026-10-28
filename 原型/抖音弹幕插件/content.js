// Reads the chat list of a live.douyin.com room page and forwards danmaku and gifts.
// Only active when this page's room id equals the one set in the local control panel.
(() => {
  const ITEM = '.webcast-chatroom___item';
  const room = location.pathname.split('/').filter(Boolean)[0] || '';
  let active = false;
  let queue = [];
  const seen = new WeakSet();

  // "用户：送出 嘉年华 x1" / "用户：内容" / "用户 来了" / system notices.
  function parse(text) {
    const t = text.replace(/\s*\n\s*/g, ' ').trim();
    let m = t.match(/^(.{1,40}?)[：:]\s*送出了?\s*(.*?)\s*[x×]\s*(\d+)\s*$/);
    if (m) return { type: 'gift', user: m[1].trim(), gift: m[2].trim() || '礼物', count: Number(m[3]) };
    if (/ 来了$|为主播点赞|分享了直播间|关注了主播|加入了粉丝团/.test(t)) return null;
    m = t.match(/^(.{1,40}?)[：:]\s*(.+)$/);
    if (m) return { type: 'danmaku', user: m[1].trim(), text: m[2].trim() };
    return null;
  }

  function scan(root) {
    const items = root.matches?.(ITEM) ? [root] : [...(root.querySelectorAll?.(ITEM) || [])];
    for (const el of items) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!active) continue;
      const ev = parse(el.innerText || '');
      if (ev) queue.push(ev);
    }
  }

  // Gift bar: leaf nodes like "99钻" sit next to the gift name.
  function prices() {
    const out = {};
    for (const el of document.querySelectorAll('div, span, p')) {
      if (el.children.length || !/^\d+钻$/.test(el.textContent.trim())) continue;
      let box = el.parentElement;
      for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
        const name = box.innerText.split('\n').map(s => s.trim()).find(s => s && !/钻$/.test(s));
        if (name) {
          out[name] = parseInt(el.textContent, 10);
          break;
        }
      }
    }
    return out;
  }

  const send = events => chrome.runtime.sendMessage({ kind: 'events', events }).catch(() => {});

  async function refreshConfig() {
    try {
      const cfg = await chrome.runtime.sendMessage({ kind: 'config' });
      const want = String(cfg?.roomId || '');
      const next = !!want && want === room;
      if (next && !active) send([{ type: 'prices', prices: prices() }]);
      active = next;
    } catch {
      active = false;
    }
  }

  // Messages already on the page when it loads are history, not new events.
  scan(document.body);
  new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    if (!queue.length) return;
    send(queue);
    queue = [];
  }, 500);
  setInterval(() => active && send([{ type: 'heartbeat' }, { type: 'prices', prices: prices() }]), 15000);
  // This page is only read for its chat; its own sound would be picked up again by the
  // streaming software's system-audio capture and echo, so keep every player muted.
  setInterval(() => {
    if (active) for (const m of document.querySelectorAll('video, audio')) m.muted = true;
  }, 1000);
  setInterval(refreshConfig, 10000);
  refreshConfig();

  // For testing in the console without the extension around it.
  globalThis.__jingyueParse = parse;
})();
