// Stream overlay: plays each line the director sends, and animates the two characters.
//
// Each character is drawn as two layers: a body pose (基础 or an action such as 叉腰) and, on
// poses whose face matches the base, a small face patch (mouth / blink / expression) on top.
// Reaction poses (hands over the face, bowing…) are shown whole without a face patch.
// Small motions (nod, hop, lean…) are CSS animations on a wrapper, so they combine with any pose.

const $ = id => document.getElementById(id);
let NAMES = []; // every character in config (filled at start)
let cast = ['深深', '月月']; // who is on stage in the current scene
const CANVAS = { w: 1024, h: 1536 };

let cfg;
const chars = {};
let ctx, analyser, audio, samples;
let level = 0;
let current = null;
const queue = [];
let started = false;
// A silent layout preview must never join the playback queue or start the director.
const previewMode = new URLSearchParams(location.search).has('preview');
let latestState = null;
let nextPlaybackAt = 0;
let playbackTimer = null;

// ---- honest viewer-facing status (no fake clock, progress or generated-content counter) ----
function describeStatus(s, preview, activeLine) {
  if (preview) return { title: '画面预览 · 未开始演出', detail: '预览不播放声音，也不发送测试评论', source: '预览', tone: 'idle', interaction: '互动说明预览', reply: '精选评论参与相声，不保证逐条回复' };
  if (!s) return { title: '节目状态暂不可用', detail: '正在等待节目状态恢复', source: '待连接', tone: 'idle', interaction: '互动状态待确认', reply: '回复状态暂不可用' };
  const source = s.segment?.source === 'llm' ? 'AI 编排' : s.segment?.source === 'script' ? '预设段子' : '准备中';
  const prepared = s.prepared || [];
  let title = '节目待开始', detail = 'AI 虚拟角色 · 语音由 AI 合成', tone = 'idle';
  if (s.overlayReady) {
    if (activeLine?.kind === 'danmaku') {
      title = `${activeLine.who}正在回应弹幕`; detail = '根据观众评论接话，回应后继续节目'; tone = 'working';
    } else if (activeLine?.kind === 'invite') {
      title = '聊聊你的看法'; detail = '欢迎在评论区接话，我们会挑选合适的评论回应'; tone = 'working';
    } else if (prepared.some(l => l.kind === 'danmaku')) {
      title = '正在准备弹幕回应'; detail = '选中的评论正在准备，稍后接话'; tone = 'working';
    } else if (s.segment?.source === 'llm' && prepared.some(l => l.kind === 'beat' && l.status === '写作中')) {
      title = 'AI 正在生成台词'; detail = '当前节目继续，下一句正在创作'; tone = 'working';
    } else if (prepared.some(l => l.status === '配音中')) {
      title = '正在准备下一句语音'; detail = '声音由 AI 合成'; tone = 'working';
    } else if (prepared.some(l => l.status === '等待配音')) {
      title = '下一句等待配音'; detail = '台词已生成，语音按顺序准备'; tone = 'working';
    } else if (s.segment?.source === 'script') {
      title = '正在演绎预设段子'; detail = '当前使用段子库内容'; tone = 'preset';
    } else if (activeLine) {
      title = `${activeLine.who}正在说相声`; detail = '节目包含 AI 生成内容与预设串场';
    } else {
      title = '节目准备中'; detail = '正在准备下一句内容';
    }
  }
  let interaction, reply;
  if (!s.replyDanmaku) {
    interaction = '弹幕回应已暂停'; reply = '当前暂停语音回应评论';
  } else if (s.mock) {
    interaction = '本地模拟互动'; reply = '当前已开启模拟观众';
  } else if (!s.douyin?.roomId) {
    interaction = '弹幕尚未接入'; reply = '等待接入直播间评论';
  } else {
    interaction = '评论可参与互动';
    const count = Math.max(0, Number(s.pendingDanmaku) || 0);
    reply = count ? `候选弹幕 ${count} 条 · 筛选后回应` : '欢迎发评论 · 筛选后回应';
  }
  return { title, detail, source, tone, interaction, reply };
}

function renderStatus() {
  const s = describeStatus(latestState, previewMode, current);
  $('generation-status').textContent = s.title;
  $('generation-detail').textContent = s.detail;
  $('program-source').textContent = s.source;
  $('status-dot').dataset.tone = s.tone;
  $('interaction-chip').textContent = s.interaction;
  $('reply-status').textContent = s.reply;
  if (latestState?.segment?.title) $('segment-title').textContent = `《${latestState.segment.title}》`;
}

async function pollStatus() {
  try {
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    if (!response.ok) throw new Error('节目状态读取失败');
    latestState = await response.json();
  } catch {
    latestState = null;
  }
  renderStatus();
  setTimeout(pollStatus, 1500);
}

// ---- layout: keep the 1920x1080 canvas fitted to the window ----
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const stage = $('stage');
  stage.style.transform = `scale(${s})`;
  stage.style.left = `${(innerWidth - 1920 * s) / 2}px`;
  stage.style.top = `${(innerHeight - 1080 * s) / 2}px`;
}
addEventListener('resize', fit);
fit();

const getJSON = async url => {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
};
const pct = (v, total) => `${(v / total) * 100}%`;

// ---- characters ----
// A character can have whole extra picture sets (config `characters.<name>.sets`, e.g. the upright
// 万圣 set drawn with its own face patches). Each set is built as its own element; a scene with
// `set` shows that one instead of the usual pictures, and chars[name] points at whichever is shown.
const skins = {}; // name -> { sprite -> character object }
let currentSet = null;

async function buildCharacter(name, sprite = name, fr = cfg.characters[name].frame) {
  const face = await getJSON(`/assets/透明/${sprite}-脸.json`);
  const poseMeta = (await getJSON(`/assets/透明/${sprite}-动作.json`)) || {};
  poseMeta.基础 = { talk: true, dx: 0, dy: 0 };

  const el = document.createElement('div');
  el.className = 'char';
  el.style.left = `${cfg.characters[name].x - 667 / 2}px`;
  // Leaning goes toward the partner: 深深 stands on the left, 月月 on the right.
  el.style.setProperty('--lean', name === '深深' ? '34px' : '-34px');
  el.style.setProperty('--lean-rot', name === '深深' ? '1.5deg' : '-1.5deg');
  const motion = document.createElement('div');
  motion.className = 'motion';
  const body = document.createElement('div');
  body.className = 'body';
  motion.appendChild(body);
  el.appendChild(motion);
  // A character drawn at another framing (小克's pictures are full length) is zoomed about her head,
  // set in config `characters.<name>.frame`, so heads match on stage; legs run off the bottom edge.
  const frame = document.createElement('div');
  frame.className = 'frame';
  if (fr) {
    frame.style.transformOrigin = `${pct(fr.originX ?? CANVAS.w / 2, CANVAS.w)} ${pct(fr.originY ?? 0, CANVAS.h)}`;
    frame.style.transform = `scale(${fr.zoom})`;
  }
  body.appendChild(frame);

  const poses = {};
  for (const pose of Object.keys(poseMeta)) {
    const img = new Image();
    img.src = pose === '基础' ? `/assets/透明/${sprite}-基础.png` : `/assets/透明/${sprite}-动作-${pose}.png`;
    frame.appendChild(img);
    poses[pose] = img;
  }

  // Face patches live in a box positioned over the face area of the canvas.
  const faceBox = document.createElement('div');
  faceBox.className = 'face';
  const patches = {};
  if (face) {
    const [x0, y0, x1, y1] = face.box;
    Object.assign(faceBox.style, { width: pct(x1 - x0, CANVAS.w), height: pct(y1 - y0, CANVAS.h) });
    faceBox.dataset.x = x0;
    faceBox.dataset.y = y0;
    for (const p of face.patches) {
      const img = new Image();
      img.src = `/assets/透明/${sprite}-脸-${p}.png`;
      faceBox.appendChild(img);
      patches[p] = img;
    }
  }
  frame.appendChild(faceBox);
  // Name plate at the waist (viewers mix the characters up): name plus whose 娘 she is, in her colour.
  if (cfg.overlay.nameplates !== false) {
    const plate = document.createElement('div');
    plate.className = 'nameplate';
    plate.style.setProperty('--c', cfg.characters[name].color);
    plate.innerHTML = '<b></b><small></small>';
    plate.querySelector('b').textContent = name;
    plate.querySelector('small').textContent = cfg.characters[name].badge || '';
    el.appendChild(plate);
  }
  $('chars').appendChild(el);

  return {
    name, el, motion, body, poses, poseMeta, faceBox, patches,
    shownPose: null, shownFace: null,
    pose: null, poseUntil: 0, // body pose override
    expr: null, exprUntil: 0, // face expression override
    nextBlink: performance.now() + 2000 + Math.random() * 3000,
    blinkUntil: 0,
  };
}

async function buildSkins(name) {
  const sets = cfg.characters[name].sets || {};
  const sprites = { [name]: cfg.characters[name].frame };
  for (const s of Object.values(sets)) sprites[s.sprite] = s.frame || null;
  skins[name] = {};
  for (const [sprite, fr] of Object.entries(sprites)) {
    skins[name][sprite] = await buildCharacter(name, sprite, fr);
    skins[name][sprite].el.style.display = 'none';
  }
  chars[name] = skins[name][name];
}

// The pose image an action uses in the current scene: a picture set maps actions to its own poses
// (`sets: { <set>: <pose> }`); otherwise outfit actions only in that outfit, and in an outfit the
// maid-dress pose images are skipped and only the motion plays.
function poseFor(def) {
  if (currentSet) return def.sets?.[currentSet] || null;
  const fits = def.outfit ? def.outfit === outfit : !(outfit && def.pose);
  return fits ? def.pose : null;
}

const MID_MS = 150;

function showPose(c, pose) {
  if (!c.poses[pose]) pose = c.base || '基础';
  if (c.shownPose === pose) return;
  c.poses[c.shownPose]?.classList.remove('on');
  c.poses[pose].classList.add('on');
  c.shownPose = pose;
  const m = c.poseMeta[pose];
  c.faceBox.style.left = pct(+c.faceBox.dataset.x + (m.dx || 0), CANVAS.w);
  c.faceBox.style.top = pct(+c.faceBox.dataset.y + (m.dy || 0), CANVAS.h);
}

function showFace(c, face) {
  if (face && !c.patches[face]) face = null;
  if (c.shownFace === face) return;
  c.patches[c.shownFace]?.classList.remove('on');
  if (face) c.patches[face].classList.add('on');
  c.shownFace = face;
}

function playMotion(c, motion) {
  if (!motion) return;
  c.motion.className = 'motion';
  void c.motion.offsetWidth; // restart the animation even if the same class is applied again
  c.motion.classList.add(`m-${motion}`);
}

// Apply a named action from config: body pose for `seconds`, plus its motion.
function act(name, action, seconds) {
  const c = chars[name];
  const def = cfg.characters[name].actions[action];
  if (!c || !def) return;
  const pose = poseFor(def);
  if (pose && c.poses[pose]) {
    c.pose = pose;
    c.poseUntil = performance.now() + seconds * 1000;
  }
  playMotion(c, def.motion);
}

function talkable(name, action) {
  const def = cfg.characters[name].actions[action];
  const pose = def && poseFor(def);
  return !pose || chars[name].poseMeta[pose]?.talk !== false;
}

function tick(now) {
  if (analyser && current) {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    level = Math.max(Math.sqrt(sum / samples.length), level * 0.82);
  } else {
    level *= 0.8;
  }

  for (const c of Object.values(chars)) {
    const speaking = current?.who === c.name;
    c.el.classList.toggle('speaking', speaking);
    if (now > c.nextBlink) {
      c.blinkUntil = now + 130;
      c.nextBlink = now + 2500 + Math.random() * 3500;
    }
    const blinking = now < c.blinkUntil;
    // An in-between frame ("<pose>-中", arms halfway) flashes on the way into a pose and out of it.
    const want = c.pose && now < c.poseUntil ? c.pose : c.base || '基础';
    if (want !== c.want) {
      c.mid = [`${want}-中`, `${c.want}-中`].find(p => c.poses[p]) || null;
      c.midUntil = c.mid && c.want ? now + MID_MS : 0;
      c.want = want;
    }
    const pose = now < c.midUntil ? c.mid : want;
    showPose(c, pose);

    let face = null;
    if (c.poseMeta[pose]?.talk === false) face = null; // reaction pose: drawn whole
    else if (speaking) {
      if (level > cfg.overlay.mouthOpen) face = '嘴-张大';
      else if (level > cfg.overlay.mouthHalf) face = '嘴-半张';
      else if (blinking) face = '眼-闭';
    } else if (c.expr && now < c.exprUntil) face = `表情-${c.expr}`;
    else if (blinking) face = '眼-闭';
    showFace(c, face);

    // Talking bounce plus a slow idle breath.
    const bounce = speaking ? -Math.min(level, 0.25) * 60 : 0;
    const breath = 1 + 0.006 * Math.sin(now / 560 + (c.name === '深深' ? 0 : 1.7));
    c.body.style.transform = `translateY(${bounce}px) scaleY(${breath})`;
  }
  requestAnimationFrame(tick);
}

// ---- playback ----
function setExpr(name, expr, seconds) {
  const c = chars[name];
  if (!c || !expr) return;
  c.expr = expr;
  c.exprUntil = performance.now() + seconds * 1000;
}

async function playNext() {
  if (!started || !audio || current || !queue.length) return;
  // The director can send the next line as soon as /api/played arrives. Gate every
  // entry to playback, including SSE events, so that a prepared line cannot skip the pause.
  const remaining = nextPlaybackAt - performance.now();
  if (remaining > 0) {
    clearTimeout(playbackTimer);
    playbackTimer = setTimeout(playNext, remaining);
    return;
  }
  clearTimeout(playbackTimer);
  current = queue.shift();
  const line = current;
  // A new segment opens here, after the last one has been fully spoken: curtain if the scene
  // changes, the title, and everyone on stage bows before the first word.
  if (line.opening) await openSegment(line.opening);
  renderStatus();
  // Everyone else on stage reacts with an expression; one of them (the reactor) also acts.
  const listeners = cast.filter(n => n !== line.who);
  const reactor = listeners.includes(line.reactor) ? line.reactor : listeners[0];
  const duration = line.seconds / cfg.playbackRate;
  const speaker = chars[line.who];
  speaker.expr = null;
  speaker.pose = null;
  // Poses that hide the face cannot be lip-synced, so they are played after the line instead.
  line.deferred = line.action && !talkable(line.who, line.action) ? line.action : null;
  if (line.action && !line.deferred) act(line.who, line.action, duration + 0.3);
  // The listener reacts while the line is spoken (e.g. 扶额 while 深深 brags).
  if (line.react) for (const n of listeners) setExpr(n, line.react, duration + 0.5);
  if (line.reactAction && reactor) act(reactor, line.reactAction, duration + 0.5);
  showSubtitle(line, duration);
  audio.src = line.audio;
  audio.playbackRate = cfg.playbackRate;
  try {
    await audio.play();
  } catch (e) {
    console.warn('播放失败', e);
    finish(line);
  }
}

const BOW_MS = 1700;
const wait = ms => new Promise(r => setTimeout(r, ms));

function bowAll() {
  for (const name of cast) {
    setExpr(name, '开心', BOW_MS / 1000);
    playMotion(chars[name], 'bow');
  }
}

async function openSegment({ scene, title }) {
  if (scene) {
    $('curtain-scene').textContent = cfg.scenes?.[scene]?.title || scene;
    $('curtain-title').textContent = title ? `《${title}》` : '';
    $('subtitle').classList.add('hidden');
    $('curtain').classList.add('on');
    await wait(900);
    applyScene(scene);
    await wait(1400);
    $('curtain').classList.remove('on');
    await wait(700);
  }
  if (title) $('segment-title').textContent = `《${title}》`;
  bowAll();
  await wait(BOW_MS);
}

function finish(line) {
  if (!line || current !== line) return;
  const hold = cfg.overlay.poseSeconds;
  setExpr(line.who, line.after, hold);
  const after = line.deferred || line.afterAction;
  if (after) act(line.who, after, hold);
  current = null;
  const configuredGap = Number(cfg.overlay.lineGapMs);
  let gap = Number.isFinite(configuredGap) ? Math.min(5000, Math.max(0, configuredGap)) : 500;
  // Last line of a segment ("谢谢各位"): everyone bows before anything else is said.
  if (line.closing) {
    bowAll();
    gap += BOW_MS;
  }
  nextPlaybackAt = performance.now() + gap;
  renderStatus();
  fetch('/api/played', { method: 'POST', body: JSON.stringify({ id: line.id }) });
  clearTimeout(playbackTimer);
  playbackTimer = setTimeout(() => {
    if (!current && !queue.length) $('subtitle').classList.add('hidden');
    playNext();
  }, gap);
}

// ---- subtitle, danmaku, gifts ----
let typing = null;
function showSubtitle(line, seconds) {
  const sub = $('subtitle');
  sub.style.setProperty('--who', cfg.characters[line.who].color);
  $('sub-name').textContent = line.who;
  sub.classList.remove('hidden');
  const text = $('sub-text');
  clearInterval(typing);
  const letters = [...line.text];
  let n = 0;
  const step = Math.max(25, (seconds * 1000 * 0.85) / letters.length);
  text.textContent = '';
  typing = setInterval(() => {
    text.textContent = letters.slice(0, ++n).join('');
    if (n >= letters.length) clearInterval(typing);
  }, step);
}

function addDanmaku(user, text) {
  const li = document.createElement('li');
  const u = document.createElement('span');
  u.className = 'user';
  u.textContent = `${user}：`;
  li.append(u, document.createTextNode(text));
  const list = $('danmaku-list');
  list.querySelector('.empty')?.remove();
  list.appendChild(li);
  while (list.children.length > 9) list.firstChild.remove();
}

// Thanks board: same sender + same gift within a minute just bumps the count.
const board = [];
let lastGiftReaction = 0;
function addThanks(user, gift, count, tier) {
  const hit = board.find(b => b.user === user && b.gift === gift && Date.now() - b.at < 60000);
  if (hit) {
    hit.count += count;
    hit.at = Date.now();
  } else {
    board.unshift({ user, gift, count, tier, at: Date.now() });
  }
  board.splice(6);
  const list = $('thanks-list');
  list.replaceChildren(...board.map(b => {
    const li = document.createElement('li');
    if (b.tier === 'big') li.className = 'big';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = b.user;
    li.append(who, document.createTextNode(` ${b.gift}×${b.count}`));
    return li;
  }));
}

function addGift(user, gift, count, tier) {
  addThanks(user, gift, count, tier);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = `🎁 ${user} 送出 ${gift} ×${count}`;
  $('gift-toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
  while ($('gift-toasts').children.length > 3) $('gift-toasts').firstChild.remove();
  // Instant visual thanks while the spoken one is still being generated; throttled so a gift
  // storm does not keep the characters hopping (big gifts always get it).
  if (tier !== 'big' && performance.now() - lastGiftReaction < 4000) return;
  lastGiftReaction = performance.now();
  for (const name of cast) {
    if (current?.who === name) continue;
    setExpr(name, '开心', 2.5);
    playMotion(chars[name], 'hop');
  }
}

// ---- wiring ----
function connect() {
  const es = new EventSource('/events');
  es.onopen = () => { if (started) fetch('/api/ready', { method: 'POST' }); };
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'line') { queue.push(ev); playNext(); }
    else if (ev.type === 'danmaku') addDanmaku(ev.user, ev.text);
    else if (ev.type === 'gift') addGift(ev.user, ev.gift, ev.count, ev.tier);
    else if (ev.type === 'scene') applyScene(ev.scene);
    else if (ev.type === 'audio-output') { cfg.overlay.audioOutput = ev.device; if (ctx) routeOutput(); }
    else if (ev.type === 'segment') $('segment-title').textContent = `《${ev.title}》`;
  };
}

// Send the show's sound to its own device (config overlay.audioOutput, e.g. the VB-Audio virtual
// cable) so the streaming software can capture exactly this and nothing else from the PC.
// Device names are only visible after a one-time microphone permission; the mic is closed again
// at once. Without the device the sound stays on the default output, and the control panel says so.
// The device list (names only) goes to the server so the control panel can offer a choice; picking
// one there arrives as an 'audio-output' event and re-routes without restarting the show.
async function routeOutput() {
  const want = cfg.overlay.audioOutput;
  let result = '默认播放设备';
  let devices = [];
  try {
    if (ctx.setSinkId) {
      devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some(d => d.kind === 'audiooutput' && d.label)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
    }
    if (want && ctx.setSinkId) {
      // "扬声器 (VB-Audio Virtual Cable)", not the 16-channel variant of the same cable.
      const outs = devices.filter(d => d.kind === 'audiooutput' && d.label.includes(want));
      const dev = outs.find(d => !/16\s*Ch/i.test(d.label)) || outs[0];
      if (dev) {
        await ctx.setSinkId(dev.deviceId);
        result = dev.label;
      } else {
        if (ctx.sinkId) await ctx.setSinkId('');
        result = `默认播放设备（没找到「${want}」）`;
      }
    } else if (ctx.sinkId) {
      await ctx.setSinkId('');
    }
  } catch (e) {
    result = `默认播放设备（切换失败：${e.message}）`;
  }
  const names = devices.filter(d => d.kind === 'audiooutput' && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications').map(d => d.label);
  fetch('/api/overlay-audio', { method: 'POST', body: JSON.stringify({ device: result, devices: names }) });
}

// ?autostart=1 (used by 一键开播, whose Chrome window may autoplay) starts without the click;
// if the browser still blocks audio, the button stays as the fallback.
async function autostart() {
  if (previewMode) return;
  if (!new URLSearchParams(location.search).has('autostart')) return;
  const probe = new AudioContext();
  const ok = probe.state === 'running';
  await probe.close();
  if (ok) $('start-btn').onclick();
}

$('start-btn').onclick = async () => {
  if (previewMode) return;
  if (started) return;
  ctx = new AudioContext();
  await ctx.resume();
  audio = new Audio();
  audio.preservesPitch = true;
  audio.addEventListener('ended', () => finish(current));
  audio.addEventListener('error', () => current && finish(current));
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  samples = new Float32Array(analyser.fftSize);
  ctx.createMediaElementSource(audio).connect(analyser);
  analyser.connect(ctx.destination);
  await routeOutput();
  started = true;
  $('start').classList.add('gone');
  await fetch('/api/ready', { method: 'POST' });
  playNext();
};

// ---- scenes (咖啡厅 / 鲸云社): background, title, plaque text, outfit ----
let outfit = null;
function applyScene(name) {
  const sc = cfg.scenes?.[name];
  if (!sc) return;
  $('bg').src = `/assets/${sc.background}`;
  $('scene-title').textContent = sc.title;
  $('scene-subtitle').textContent = sc.subtitle;
  $('plaque').textContent = sc.plaque || '';
  $('plaque').classList.toggle('hidden', !sc.plaque);
  $('stage').classList.toggle('plaque-scene', !!sc.plaque);
  document.title = `${sc.title} · 直播画面`;
  outfit = sc.outfit || null;
  currentSet = sc.set || null;
  for (const name of NAMES) {
    const sprite = (currentSet && cfg.characters[name].sets?.[currentSet]?.sprite) || name;
    const next = skins[name]?.[sprite] || skins[name]?.[name];
    if (!next || next === chars[name]) continue;
    chars[name].el.style.display = 'none';
    chars[name] = next;
  }
  cast = (sc.cast || ['深深', '月月']).filter(n => chars[n]);
  for (const name of NAMES) {
    const c = chars[name];
    c.base = outfit && c.poses[outfit] ? outfit : '基础';
    c.pose = null;
    // Stage positions: per scene for 群口 (three across, a little smaller), else the default.
    const on = cast.includes(c.name);
    c.el.style.display = on ? '' : 'none';
    const x = sc.positions?.[c.name] ?? cfg.characters[c.name].x;
    const scale = sc.scale ?? 1;
    c.el.style.left = `${x - 667 / 2}px`;
    c.el.style.transformOrigin = '50% 100%';
    c.el.style.transform = scale === 1 ? '' : `scale(${scale})`;
    // Leaning goes toward the middle of the stage.
    const toward = x < 960 ? 1 : x > 960 ? -1 : 0;
    c.el.style.setProperty('--lean', `${34 * toward}px`);
    c.el.style.setProperty('--lean-rot', `${1.5 * toward}deg`);
  }
}

// Debug / preview hook: window.preview('深深', '叉腰') shows an action without the director.
window.preview = (name, action, seconds = 3) => act(name, action, seconds);

(async () => {
  cfg = await (await fetch('/api/config')).json();
  NAMES = Object.keys(cfg.characters);
  await Promise.all(NAMES.map(buildSkins));
  applyScene(cfg.scene);
  requestAnimationFrame(tick);
  renderStatus();
  if (previewMode) {
    $('start').classList.add('gone');
    $('segment-title').textContent = '鲸月咖啡厅 · AI 相声';
    return;
  }
  pollStatus();
  connect();
  autostart();
})();
