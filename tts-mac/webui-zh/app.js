// 本地中文错误提示；未知后端消息保留原文，便于排查。
function translateError(value) {
  const message = String(value);
  const messages = {
    "unknown": "未知错误",
    "busy": "服务忙碌，请等待当前生成完成",
    "unknown voice_id": "未找到所选声音，请刷新声音库后重试",
    "text is required": "请填写朗读文本",
    "a source wav file is required": "请上传原始 WAV 音频",
    "ref_audio or voice_id is required": "请上传参考音频或选择已保存的声音",
    "ref_text is required": "请填写参考音频的准确文字稿",
    "conversion failed": "变声失败，请检查音频文件后重试",
    "send start first": "实时连接尚未初始化，请重新生成",
    "unknown type": "实时连接收到无法识别的消息类型",
    "ref_audio and ref_text are required": "需要参考音频及其准确文字稿",
    "name can only use letters, digits, dash and underscore": "声音名称只能包含英文字母、数字、短横线和下划线",
    "could not read ref_audio": "无法读取参考音频，请检查文件格式",
    "could not write the voice file": "无法保存声音文件，请检查磁盘空间和目录权限",
    "request body must be a json object": "请求数据格式错误，需要 JSON 对象",
    "metadata must be a json object": "附加字段格式错误，需要 JSON 对象",
    "description must be a string": "声音备注必须为文本",
    "metadata keys are 1 to 64 letters, digits, dot, dash or underscore, and not description": "字段名须为 1–64 个英文字母、数字、点、短横线或下划线，且不能是 description",
    "metadata values must be strings": "附加字段内容必须为文本",
    "Failed to fetch": "无法连接本地服务，请确认服务已启动",
    "NetworkError when attempting to fetch resource.": "网络请求失败，请检查本地服务是否正在运行",
    "Load failed": "请求加载失败，请检查本地服务是否正在运行"
  };
  if (messages[message]) return messages[message];
  let match = message.match(/^description is longer than (\d+) bytes$/);
  if (match) return "声音备注超过 " + match[1] + " 字节上限";
  match = message.match(/^metadata values are limited to (\d+) bytes$/);
  if (match) return "每个附加字段内容最多 " + match[1] + " 字节";
  match = message.match(/^a voice can have at most (\d+) metadata fields$/);
  if (match) return "每个声音最多可添加 " + match[1] + " 个附加字段";
  return message;
}

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const statusEl = document.getElementById("status");
const player = document.getElementById("player");
const download = document.getElementById("download");
const streamToggle = document.getElementById("stream");
const bufferInput = document.getElementById("buffer");
const bufferOut = document.getElementById("bufval");
const stopBtn = document.getElementById("stop");
let wsPort = 0;
let voices = [];

function syncBuffer() {
  bufferOut.textContent = Number(bufferInput.value).toFixed(2) + " 秒";
  bufferInput.disabled = !streamToggle.checked;
  bufferInput.parentElement.classList.toggle("off", !streamToggle.checked);
}

bufferInput.addEventListener("input", syncBuffer);
streamToggle.addEventListener("change", syncBuffer);
syncBuffer();

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    panels.forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
    // conversion hands back the whole clip at once, so the streaming controls do nothing there
    document.querySelector(".output .row").classList.toggle("hide", tab.dataset.tab === "changer");
    document.querySelector(".output").classList.toggle("hide", tab.dataset.tab === "library");
  });
});

function fields(panel) {
  const out = {};
  panel.querySelectorAll("[data-f]").forEach(el => { out[el.dataset.f] = el; });
  return out;
}

// picking a saved voice replaces the upload, so the clip fields get out of the way
function syncVoice(panel) {
  const f = fields(panel);
  if (!f.voice_id) return;
  const block = panel.querySelector(".refblock");
  if (block) block.classList.toggle("hide", !!f.voice_id.value);
  const note = panel.querySelector(".voice-desc");
  if (note) {
    const v = voices.find(x => x.id === f.voice_id.value);
    note.textContent = v ? v.description || "" : "";
    note.classList.toggle("show", !!note.textContent);
  }
}

async function loadVoices() {
  let list = [];
  try {
    const res = await fetch("/v1/voices");
    if (!res.ok) return;
    list = await res.json();
  } catch (e) { return; }
  voices = list;
  renderLibrary();
  document.querySelectorAll("select[data-f=voice_id]").forEach(sel => {
    const keep = sel.value;
    sel.innerHTML = "<option value=\"\">上传参考音频</option>";
    for (const v of list) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.id + "  (" + v.seconds.toFixed(1) + " 秒)" + (v.saved ? "" : "  临时声音");
      if (v.description) o.title = v.description;
      sel.appendChild(o);
    }
    const stillExists = list.some(v => v.id === keep);
    if (keep && !stillExists) sel.dataset.missingVoice = keep;
    else if (stillExists) delete sel.dataset.missingVoice;
    sel.value = stillExists ? keep : "";
    syncVoice(sel.closest(".panel"));
  });
}

async function saveVoice(panel) {
  const f = fields(panel);
  const name = (f.save_name.value || "").trim();
  if (!name) { statusEl.textContent = "请先填写声音名称"; return; }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    statusEl.textContent = "声音名称只能包含英文字母、数字、短横线和下划线";
    return;
  }
  if (!f.ref_audio.files.length || !(f.ref_text.value || "").trim()) {
    statusEl.textContent = "保存声音需要参考音频和对应的准确文字稿";
    return;
  }
  const btn = panel.querySelector(".save-voice");
  btn.disabled = true;
  statusEl.textContent = "正在保存声音……";
  try {
    const form = new FormData();
    form.append("name", name);
    form.append("ref_audio", await wavFile(f.ref_audio.files[0]));
    form.append("ref_text", f.ref_text.value);
    const desc = (f.save_desc.value || "").trim();
    if (desc) form.append("description", desc);
    const res = await fetch("/v1/voices", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = res.status === 409 ? "服务忙碌，请等待当前生成完成"
                                               : "错误：" + translateError(body.error || res.status);
    } else {
      await loadVoices();
      document.querySelectorAll("select[data-f=voice_id]").forEach(sel => { sel.value = body.id; delete sel.dataset.missingVoice; });
      document.querySelectorAll(".panel").forEach(syncVoice);
      statusEl.textContent = "已保存：" + body.id + " - " + body.seconds.toFixed(2) + " 秒";
      f.save_desc.value = "";
    }
  } catch (e) {
    statusEl.textContent = "错误：" + translateError(e.message);
  }
  btn.disabled = false;
}

function makeWav(pcm, sampleRate) {
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, dataLen, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm));
  return new Blob([buf], { type: "audio/wav" });
}

// the server only parses WAV, so MP3/M4A/etc. are decoded here and re-encoded as 24 kHz mono 16-bit WAV
async function wavFile(file) {
  if (/\.wav$/i.test(file.name) || file.type === "audio/wav" || file.type === "audio/x-wav") return file;
  let audio;
  try {
    audio = await new OfflineAudioContext(1, 1, 24000).decodeAudioData(await file.arrayBuffer());
  } catch (e) {
    throw new Error("无法读取音频文件「" + file.name + "」，请换成 WAV 或 MP3 格式");
  }
  const channels = [];
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = 0;
    for (const data of channels) s += data[i];
    s = Math.max(-1, Math.min(1, s / channels.length));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new File([makeWav(pcm.buffer, 24000)], file.name.replace(/\.[^.]+$/, "") + ".wav", { type: "audio/wav" });
}

function join(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

let audioCtx = null;

function openContext(sampleRate) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (audioCtx) audioCtx.close().catch(() => {});
  try {
    audioCtx = new Ctor({ sampleRate });
  } catch (e) {
    audioCtx = new Ctor();
  }
  audioCtx.resume().catch(() => {});
  return audioCtx;
}

// holds chunks back until there is a real cushion of audio, then plays them gapless
function makePlayer(sr, lead) {
  const ac = openContext(sr);
  const parts = [];
  let leftover = new Uint8Array(0);
  let playhead = 0;
  let samples = 0;
  let underruns = 0;
  let queued = [];
  let queuedSecs = 0;
  let started = false;

  const play = buf => {
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    let at = playhead;
    if (playhead <= ac.currentTime) {
      at = ac.currentTime + 0.02;
      // ran dry, so rebuild a deeper cushion before letting it happen again
      if (started) { underruns++; lead = Math.min(lead * 1.5 + 0.25, 5); }
    }
    src.start(at);
    started = true;
    playhead = at + buf.duration;
  };

  return {
    push(value) {
      parts.push(value);
      let bytes = value;
      if (leftover.length) {
        bytes = new Uint8Array(leftover.length + value.length);
        bytes.set(leftover, 0);
        bytes.set(value, leftover.length);
      }
      const n = bytes.length >> 1;
      // a chunk boundary can split a sample, so carry the odd byte over
      leftover = bytes.slice(n * 2);
      if (!n) return;

      const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
      const buf = ac.createBuffer(1, n, sr);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;

      if (queued) {
        queued.push(buf);
        queuedSecs += buf.duration;
        // generation outruns playback, so once the cushion exists it only ever grows
        if (queuedSecs >= lead) { queued.forEach(play); queued = null; }
      } else {
        play(buf);
      }
      samples += n;
    },
    finish() {
      if (queued) queued.forEach(play);
      queued = null;
      return join(parts);
    },
    stop() { try { ac.close(); } catch (e) {} return join(parts); },
    get samples() { return samples; },
    get underruns() { return underruns; }
  };
}

async function readStreaming(res, sr, lead, onProgress) {
  const p = makePlayer(sr, lead);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    p.push(value);
    onProgress(p.samples / sr, p.underruns);
  }
  return p.finish();
}

async function readBuffered(res, onProgress) {
  const reader = res.body.getReader();
  const parts = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    bytes += value.length;
    onProgress(bytes);
  }
  return join(parts);
}

// the socket protocol takes a voice id, so an uploaded clip is registered first. that caches it
// too, so picking the same file again skips the encode
async function resolveVoice(f) {
  if (f.voice_id && f.voice_id.value) return f.voice_id.value;
  if (!f.ref_audio || !f.ref_audio.files.length) return "";
  statusEl.textContent = "正在处理参考音频……";
  const form = new FormData();
  form.append("ref_audio", await wavFile(f.ref_audio.files[0]));
  form.append("ref_text", f.ref_text ? f.ref_text.value || "" : "");
  const r = await fetch("/v1/voices", { method: "POST", body: form });
  if (!r.ok) throw new Error("参考音频处理失败，请检查音频文件和文字稿");
  return (await r.json()).id;
}

let liveSocket = null;

function wsGenerate(panel, tabName) {
  const f = fields(panel);
  const text = (f.text.value || "").trim();
  if (!text) { statusEl.textContent = "请先填写朗读文本"; return Promise.resolve(); }

  const btn = panel.querySelector(".go");
  const lead = Number(bufferInput.value);
  const streaming = streamToggle.checked;

  return resolveVoice(f).then(voice => new Promise(resolve => {
    const url = (location.protocol === "https:" ? "wss://" : "ws://") +
                location.hostname + ":" + wsPort;
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    liveSocket = sock;
    btn.disabled = true;
    stopBtn.classList.add("live");
    download.classList.remove("ready");
    player.pause();
    player.removeAttribute("src");
    statusEl.textContent = "正在连接……";

    let sr = 24000;
    let p = null;
    const done = () => {
      const pcm = p ? p.finish() : new Uint8Array(0);
      if (pcm.length) {
        const url2 = URL.createObjectURL(makeWav(pcm.buffer, sr));
        player.src = url2;
        download.href = url2;
        download.classList.add("ready");
      }
      btn.disabled = false;
      stopBtn.classList.remove("live");
      liveSocket = null;
      try { sock.close(); } catch (e) {}
      resolve(pcm);
    };

    sock.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) {
        if (!p) p = makePlayer(sr, streaming ? lead : 1e9);
        p.push(new Uint8Array(ev.data));
        statusEl.textContent = (streaming ? "正在生成并播放：" : "正在生成：") +
                               (p.samples / sr).toFixed(2) + " 秒" +
                               (p.underruns ? "  (" + p.underruns + " 次重新缓冲)" : "");
        return;
      }
      const m = JSON.parse(ev.data);
      if (m.type === "ready") {
        sr = m.sample_rate || 24000;
        sock.send(JSON.stringify({
          type: "start",
          voice_id: voice,
          instruction: f.instruction ? (f.instruction.value || "Speak clearly and naturally.")
                                     : "Speak clearly and naturally.",
          ref_text: f.ref_text ? f.ref_text.value || "" : "",
          cfg_scale: Number(f.cfg ? f.cfg.value : 1),
          seed: Number(f.seed ? f.seed.value : 42)
        }));
        sock.send(JSON.stringify({ type: "end", text }));
        statusEl.textContent = "正在生成……";
      } else if (m.type === "queued") {
        statusEl.textContent = "正在排队，等待显卡空闲……";
      } else if (m.type === "cancelled") {
        statusEl.textContent = "已停止" + (p ? " - " + (p.samples / sr).toFixed(2) + " 秒" : "");
        done();
      } else if (m.type === "done") {
        const secs = p ? p.samples / sr : 0;
        done();
        statusEl.textContent = "生成完成：" + secs.toFixed(2) + " 秒 · 采样率 " + sr + " Hz";
        if (!streaming) player.play().catch(() => {});
      } else if (m.type === "error") {
        statusEl.textContent = "错误：" + translateError(m.message || "unknown");
        done();
      }
    };
    sock.onerror = () => { statusEl.textContent = "实时连接失败，请检查本地服务是否正在运行"; done(); };
    sock.onclose = () => { if (liveSocket === sock) done(); };
  })).catch(e => {
    statusEl.textContent = "错误：" + translateError(e.message);
    btn.disabled = false;
    stopBtn.classList.remove("live");
  });
}

async function generate(panel, tabName) {
  const f = fields(panel);
  const text = (f.text.value || "").trim();
  if (!text) { statusEl.textContent = "请先填写朗读文本"; return; }

  const form = new FormData();
  form.append("text", text);
  form.append("seed", f.seed ? f.seed.value : "42");
  form.append("cfg_scale", f.cfg ? f.cfg.value : "1.0");
  form.append("instruction", f.instruction ? (f.instruction.value || "Speak clearly and naturally.")
                                           : "Speak clearly and naturally.");
  if (f.ref_text) form.append("ref_text", f.ref_text.value || "");
  if (f.voice_id && f.voice_id.value) form.append("voice_id", f.voice_id.value);
  else if (f.ref_audio && f.ref_audio.files.length) {
    try {
      form.append("ref_audio", await wavFile(f.ref_audio.files[0]));
    } catch (e) {
      statusEl.textContent = "错误：" + e.message;
      return;
    }
  }

  const streaming = streamToggle.checked;
  const btn = panel.querySelector(".go");
  btn.disabled = true;
  statusEl.textContent = streaming ? "正在生成并播放……" : "正在生成……";
  download.classList.remove("ready");
  player.pause();
  player.removeAttribute("src");

  try {
    const res = await fetch("/v1/audio/speech", { method: "POST", body: form });
    if (!res.ok) {
      statusEl.textContent = res.status === 409 ? "服务忙碌，请等待当前生成完成" : "请求失败，状态码：" + res.status;
      btn.disabled = false;
      return;
    }
    const sr = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);

    const pcm = streaming
      ? await readStreaming(res, sr, Number(bufferInput.value),
                            (s, under) => {
                              statusEl.textContent = "正在生成并播放：" + s.toFixed(2) + " 秒"
                                + (under ? "  (" + under + " 次重新缓冲" + ")" : "");
                            })
      : await readBuffered(res, b => { statusEl.textContent = "正在生成：" + (b / 2 / sr).toFixed(2) + " 秒"; });

    const url = URL.createObjectURL(makeWav(pcm.buffer, sr));
    player.src = url;
    download.href = url;
    download.classList.add("ready");
    statusEl.textContent = "生成完成：" + (pcm.length / 2 / sr).toFixed(2) + " 秒 · 采样率 " + sr + " Hz";
    if (!streaming) player.play().catch(() => {});
  } catch (e) {
    statusEl.textContent = "错误：" + translateError(e.message);
  }
  btn.disabled = false;
}

async function convert(panel) {
  const f = fields(panel);
  const voice = f.voice_id ? f.voice_id.value : "";
  if (!f.source.files.length) {
    statusEl.textContent = "请上传需要变声的原始 WAV 音频";
    return;
  }
  if (!voice && !f.ref_audio.files.length) {
    statusEl.textContent = "请选择已保存的声音，或上传目标声音 WAV 音频";
    return;
  }
  if (!voice && !(f.ref_text.value || "").trim()) {
    statusEl.textContent = "请填写目标声音的准确文字稿";
    return;
  }
  const form = new FormData();
  try {
    statusEl.textContent = "正在读取音频……";
    form.append("source", await wavFile(f.source.files[0]));
    if (voice) form.append("voice_id", voice);
    else {
      form.append("ref_audio", await wavFile(f.ref_audio.files[0]));
      form.append("ref_text", f.ref_text.value);
    }
  } catch (e) {
    statusEl.textContent = "错误：" + e.message;
    return;
  }
  form.append("text", (f.text.value || "").trim());
  form.append("keep_acoustic", f.keep_acoustic.value);
  form.append("seed", f.seed.value);

  const btn = panel.querySelector(".go");
  btn.disabled = true;
  statusEl.textContent = "正在变声……";
  download.classList.remove("ready");
  player.pause();
  player.removeAttribute("src");

  try {
    const res = await fetch("/v1/audio/convert", { method: "POST", body: form });
    if (!res.ok) {
      statusEl.textContent = res.status === 409 ? "服务忙碌，请等待当前生成完成" : "请求失败，状态码：" + res.status;
      btn.disabled = false;
      return;
    }
    const sr = parseInt(res.headers.get("X-Sample-Rate") || "24000", 10);
    const pcm = await readBuffered(res, b => {
      statusEl.textContent = "正在接收音频：" + (b / 2 / sr).toFixed(2) + " 秒";
    });
    const url = URL.createObjectURL(makeWav(pcm.buffer, sr));
    player.src = url;
    download.href = url;
    download.classList.add("ready");
    statusEl.textContent = "生成完成：" + (pcm.length / 2 / sr).toFixed(2) + " 秒 · 采样率 " + sr + " Hz";
    player.play().catch(() => {});
  } catch (e) {
    statusEl.textContent = "错误：" + translateError(e.message);
  }
  btn.disabled = false;
}

document.querySelectorAll(".panel").forEach(panel => {
  if (panel.id === "library") return;
  const btn = panel.querySelector(".go");
  btn.addEventListener("click", () => window.BreezeModels.runOperation(async () => {
    await loadHealth();
    const selectedVoice = panel.querySelector("select[data-f=voice_id]");
    const referenceAudio = panel.querySelector("input[data-f=ref_audio]");
    if (selectedVoice && selectedVoice.dataset.missingVoice && !(referenceAudio && referenceAudio.files.length)) {
      throw new Error("之前选择的临时声音已失效，请重新选择已保存声音或上传参考音频。");
    }
    if (panel.id === "changer") return convert(panel);
    return wsPort ? wsGenerate(panel, panel.id) : generate(panel, panel.id);
  }));
  const save = panel.querySelector(".save-voice");
  if (save) save.addEventListener("click", () => window.BreezeModels.runOperation(() => saveVoice(panel)));
  const sel = panel.querySelector("select[data-f=voice_id]");
  if (sel) sel.addEventListener("change", () => { delete sel.dataset.missingVoice; syncVoice(panel); });
});

stopBtn.addEventListener("click", () => {
  if (liveSocket) liveSocket.send(JSON.stringify({ type: "cancel" }));
});

const libList = document.getElementById("liblist");
const libFilter = document.getElementById("libfilter");
const libCount = document.getElementById("libcount");
const META_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function matches(v, q) {
  if (!q) return true;
  const hay = [v.id, v.description, v.ref_text]
    .concat(Object.entries(v.metadata || {}).map(([k, val]) => k + " " + val))
    .join("\n").toLowerCase();
  return hay.includes(q);
}

function useVoice(id) {
  document.querySelectorAll("select[data-f=voice_id]").forEach(sel => { sel.value = id; delete sel.dataset.missingVoice; });
  document.querySelectorAll(".panel").forEach(syncVoice);
  document.querySelector(".tab[data-tab=clone]").click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fieldRow(box, key, value, onChange) {
  const row = el("div", "vfield");
  const k = el("input");
  k.type = "text";
  k.placeholder = "字段名（英文、数字等）";
  k.value = key;
  const val = el("input");
  val.type = "text";
  val.placeholder = "字段内容";
  val.value = value;
  const del = el("button", "ghost", "移除");
  del.title = "移除此字段";
  del.addEventListener("click", () => { row.remove(); onChange(); });
  k.addEventListener("input", onChange);
  val.addEventListener("input", onChange);
  row.append(k, val, del);
  box.appendChild(row);
  return row;
}

function voiceCard(v) {
  const card = el("div", "vcard");
  const head = el("div", "vhead");
  head.append(el("span", "vname", v.id), el("span", "vtag", v.seconds.toFixed(1) + " 秒"),
              el("span", "vtag" + (v.saved ? "" : " temp"), v.saved ? "已保存" : "临时声音"));
  const use = el("button", "ghost", "使用");
  use.title = "在声音克隆页面使用此声音";
  use.addEventListener("click", () => useVoice(v.id));
  head.appendChild(use);
  card.appendChild(head);
  if (v.ref_text) card.appendChild(el("p", "vtext", "\u201c" + v.ref_text + "\u201d"));

  const label = el("label", "", "声音备注");
  const desc = el("textarea");
  desc.rows = 2;
  desc.maxLength = 4096;
  desc.placeholder = "描述声音特点、来源或适合的用途";
  desc.value = v.description || "";
  label.appendChild(desc);
  card.appendChild(label);

  const fieldsLabel = el("label", "", "附加字段");
  card.appendChild(fieldsLabel);
  const box = el("div", "vfields");
  card.appendChild(box);

  const actions = el("div", "vactions");
  const add = el("button", "ghost", "+ 添加字段");
  const save = el("button", "go", "保存修改");
  const status = el("span", "vstatus", v.saved ? "" : "临时声音的备注会在服务重启后丢失");
  actions.append(add, save, status);
  card.appendChild(actions);

  const current = () => {
    const meta = {};
    let bad = "";
    box.querySelectorAll(".vfield").forEach(row => {
      const [k, val] = row.querySelectorAll("input");
      const key = k.value.trim();
      if (!key && !val.value.trim()) return;
      if (!META_KEY.test(key) || key === "description") bad = bad || key || "（空字段名）";
      else meta[key] = val.value;
    });
    return { description: desc.value, meta, bad };
  };
  const dirty = () => {
    const c = current();
    const before = v.metadata || {};
    const same = c.description === (v.description || "") &&
                 Object.keys(c.meta).length === Object.keys(before).length &&
                 Object.keys(c.meta).every(k => before[k] === c.meta[k]);
    card.classList.toggle("dirty", !same);
    save.disabled = same;
    if (!same) { status.classList.remove("err"); status.textContent = "有未保存的修改"; }
    else if (status.textContent === "有未保存的修改") status.textContent = "";
  };

  for (const [k, val] of Object.entries(v.metadata || {})) fieldRow(box, k, val, dirty);
  fieldsLabel.style.display = box.children.length ? "" : "none";
  add.addEventListener("click", () => {
    fieldsLabel.style.display = "";
    fieldRow(box, "", "", dirty).querySelector("input").focus();
  });
  desc.addEventListener("input", dirty);
  desc.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !save.disabled) save.click(); });
  save.disabled = true;

  save.addEventListener("click", async () => {
    const c = current();
    if (c.bad) {
      status.classList.add("err");
      status.textContent = "字段名须为 1–64 个英文字母、数字、点、短横线或下划线，且不能是 description：" + c.bad;
      return;
    }
    const metadata = Object.assign({}, c.meta);
    for (const k of Object.keys(v.metadata || {})) if (!(k in metadata)) metadata[k] = null;
    save.disabled = true;
    status.classList.remove("err");
    status.textContent = "正在保存……";
    try {
      const res = await fetch("/v1/voices/" + encodeURIComponent(v.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: c.description, metadata })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.status);
      Object.assign(v, body);
      dirty();
      status.textContent = v.saved ? "已保存" : "已更新，服务重启后失效";
      document.querySelectorAll(".panel").forEach(syncVoice);
      document.querySelectorAll("select[data-f=voice_id] option").forEach(o => {
        if (o.value === v.id) o.title = v.description || "";
      });
    } catch (e) {
      status.classList.add("err");
      status.textContent = "错误：" + translateError(e.message);
      save.disabled = false;
    }
  });

  card.dataset.id = v.id;
  return card;
}

function renderLibrary() {
  const q = (libFilter.value || "").trim().toLowerCase();
  // keep cards with unsaved edits instead of wiping them on a refresh
  const keep = new Map();
  libList.querySelectorAll(".vcard.dirty").forEach(c => keep.set(c.dataset.id, c));
  libList.textContent = "";
  let shown = 0;
  for (const v of voices) {
    if (!matches(v, q)) continue;
    libList.appendChild(keep.get(v.id) || voiceCard(v));
    shown++;
  }
  libCount.textContent = !voices.length
    ? "声音库还是空的。可在声音克隆、声音演绎或音频变声页面保存声音。"
    : shown === voices.length ? voices.length + " 个声音" : "显示 " + shown + " 个，共 " + voices.length + " 个声音";
}

libFilter.addEventListener("input", renderLibrary);
document.getElementById("librefresh").addEventListener("click", loadVoices);

async function loadHealth() {
  try {
    const r = await fetch("/health");
    wsPort = r.ok ? (await r.json()).ws_port || 0 : 0;
  } catch (e) { wsPort = 0; }
}

loadHealth();
loadVoices();

document.addEventListener("breeze:model-ready", async () => {
  await loadHealth();
  await loadVoices();
  if (document.querySelector("select[data-missing-voice]")) {
    statusEl.textContent = "模型已就绪。之前选择的临时声音已失效，请重新选择已保存声音或上传参考音频。";
  }
});
