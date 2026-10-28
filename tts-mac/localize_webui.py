"""Localize the v0.1.3 UI without changing endpoint names or protocol fields."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent
source = root / 'webui-original'
target = root / 'webui-zh'
target.mkdir(exist_ok=True)

html = (source / 'index.html').read_text(encoding='utf-8')
html_replacements = {
    '<html lang="en">': '<html lang="zh-CN">',
    '<title>breeze-tts-2.cpp</title>': '<title>Breeze TTS 2 · 本地语音合成</title>',
    'BREEZE-TTS-2.CPP': 'Breeze TTS 2',
    'open-weight bilingual text to speech, running on ggml. voice design, cloning, direction, conversion.': '中英文语音合成，支持声音设计、声音克隆、声音演绎和音频变声。',
    'VOICE DESIGN': '声音设计',
    'VOICE CLONE': '声音克隆',
    'VOICE DIRECTION': '声音演绎',
    'VOICE CHANGER': '音频变声',
    'VOICE LIBRARY': '声音库',
    'TEXT TO SPEAK': '朗读文本',
    'Welcome aboard. Your journey begins now.': '欢迎来到今天的故事时间，让我们一起开始吧。',
    'VOICE DESCRIPTION': '声音描述',
    'A warm, thoughtful young woman with a clear, calm delivery.': '一位温柔自然的年轻女性，普通话标准，声音清晰，语气平静亲切。',
    'CFG SCALE': '指令强度（CFG）',
    'SEED': '随机种子',
    'GENERATE': '生成语音',
    'It is good to hear your voice again after all this time.': '过了这么久，还能再次听到你的声音，真好。',
    'SAVED VOICE': '已保存的声音',
    'upload a clip instead': '上传参考音频',
    'REFERENCE AUDIO (WAV)': '参考音频（WAV）',
    'REFERENCE TRANSCRIPT (EXACT)': '参考音频文字稿（需与音频完全一致）',
    'This is the exact transcript of the reference audio.': '请填写参考音频中说出的全部内容，保持文字与音频一致。',
    'DESCRIPTION (OPTIONAL, SAVED WITH THE VOICE)': '声音备注（选填，与声音一同保存）',
    'Gravelly older narrator, slow and warm. Good for audiobooks.': '嗓音略带沙哑的年长讲述者，语速舒缓、温暖，适合有声书。',
    'SAVE AS': '声音名称（英文、数字、- 或 _）',
    'placeholder="my_voice"': 'placeholder="例如：my_voice"',
    'SAVE VOICE': '保存声音',
    'We need to discuss what happened last night.': '我们需要谈谈昨晚发生的事情。',
    '>DIRECTION\n': '>演绎要求（语气、情绪和语速）\n',
    'Speak slowly with a restrained, serious tone.': '请放慢语速，用克制、严肃的语气朗读。',
    'respeaks an existing recording in another voice, keeping its words and timing. no text needed. pitch normally comes from the target voice, so raise KEEP MELODY if the source is sung or strongly intonated.': '将已有录音转换为另一种声音，保留原有内容和节奏，无需提供文字。音高通常跟随目标声音；如果原音频包含歌唱或明显的语调变化，可提高“旋律保留程度”。',
    'SOURCE AUDIO (WAV)': '原始音频（WAV）',
    'TARGET VOICE (WAV)': '目标声音音频（WAV）',
    'TARGET VOICE TRANSCRIPT (EXACT)': '目标声音文字稿（需与音频完全一致）',
    'This is the exact transcript of the target voice clip.': '请填写目标声音音频中说出的全部内容。',
    'SOURCE TRANSCRIPT (OPTIONAL, SHARPENS THE WORDS)': '原始音频文字稿（选填，可提高吐字清晰度）',
    'Leave empty unless you have the exact words of the source.': '如有原始音频的准确文字稿，请填写；否则留空。',
    'KEEP MELODY': '旋律保留程度',
    '>CONVERT<': '>开始变声<',
    '>FILTER ': '>筛选 ',
    'name, description, transcript or field': '搜索名称、备注、文字稿或附加字段',
    '>REFRESH<': '>刷新<',
    'STREAM WHILE GENERATING': '边生成边播放',
    '>BUFFER ': '>播放缓冲 ',
    '>1.25s<': '>1.25 秒<',
    '>IDLE<': '>就绪<',
    '>STOP<': '>停止生成<',
    '>DOWNLOAD WAV<': '>下载音频（WAV）<',
    'vocal events go inline in parentheses, (laugh) (sigh) (gasp) (yawn) (whispers), or square brackets in chinese, [笑] [叹气]. the tag is plain text so other ones often work too, reroll the seed if it gets read out loud instead': '可在朗读文本中加入声音动作：中文使用 [笑]、[叹气]、[咳嗽]、[清嗓子]；英文使用 (laugh)、(sigh)、(gasp)、(yawn)、(whispers)。如果动作标签被直接读出，可更换随机种子后重新生成。',
}
for old, new in html_replacements.items():
    if old not in html:
        raise ValueError(f'Missing HTML translation source: {old}')
    html = html.replace(old, new)

# Instructions are submitted once per generation; edits do not update queued audio.
instruction_panels = iter(('design', 'direction'))
def add_instruction_hint(match):
    panel = next(instruction_panels)
    hint_id = f'{panel}-instruction-hint'
    return (
        f'{match[1]} aria-describedby="{hint_id}"{match[2]}\n'
        f'      <span class="field-hint" id="{hint_id}">'
        '修改描述后，请点击“生成语音”重新生成；若仍在生成，请先停止。'
        '修改不会改变已生成或正在播放的音频。</span>'
    )
html, hint_count = re.subn(r'(<textarea data-f="instruction")([^>]*></textarea>)', add_instruction_hint, html)
if hint_count != 2:
    raise ValueError(f'Expected two instruction fields, found {hint_count}')
model_control = '''
<section class="model-control" id="model-control" aria-label="选择语音模型" aria-busy="true">
  <div class="model-heading"><strong>语音模型</strong><span id="model-current">当前模型：正在读取…</span></div>
  <div class="model-row">
    <label for="model-select">生成前选择模型
      <select id="model-select" aria-describedby="model-message" disabled><option value="">正在读取…</option></select>
    </label>
    <button id="model-apply" class="ghost" type="button" disabled>切换模型</button>
    <button id="model-refresh" class="ghost" type="button">刷新状态</button>
  </div>
  <p id="model-message" role="status" aria-live="polite">正在读取模型状态…</p>
</section>
'''
html = html.replace('</header>', '</header>\n' + model_control, 1)
html = html.replace('<script src="/app.js"></script>', '<script src="/model-selector.js"></script>\n<script src="/app.js"></script>')
(target / 'index.html').write_text(html, encoding='utf-8')

js = (source / 'app.js').read_text(encoding='utf-8')
js_replacements = {
    'upload a clip instead': '上传参考音频',
    '"s)"': '" 秒)"',
    '"  temporary"': '"  临时声音"',
    '"NAME THE VOICE FIRST"': '"请先填写声音名称"',
    '"NAME CAN ONLY USE LETTERS, DIGITS, DASH AND UNDERSCORE"': '"声音名称只能包含英文字母、数字、短横线和下划线"',
    '"A CLIP AND ITS TRANSCRIPT ARE REQUIRED TO SAVE A VOICE"': '"保存声音需要参考音频和对应的准确文字稿"',
    '"SAVING VOICE ..."': '"正在保存声音……"',
    '"BUSY - ONE REQUEST AT A TIME"': '"服务忙碌，请等待当前生成完成"',
    '"SAVED "': '"已保存："',
    '"ENCODING REFERENCE ..."': '"正在处理参考音频……"',
    '"could not encode the reference"': '"参考音频处理失败，请检查音频文件和文字稿"',
    '"TEXT IS REQUIRED"': '"请先填写朗读文本"',
    '"CONNECTING ..."': '"正在连接……"',
    '"STREAMING - "': '"正在生成并播放："',
    '"GENERATING - "': '"正在生成："',
    '" REBUFFER)"': '" 次重新缓冲)"',
    '"GENERATING ..."': '"正在生成……"',
    '"QUEUED, WAITING FOR THE GPU ..."': '"正在排队，等待显卡空闲……"',
    '"STOPPED"': '"已停止"',
    '"DONE - "': '"生成完成："',
    '"s @ "': '" 秒 · 采样率 "',
    '"Hz"': '" Hz"',
    '"WEBSOCKET ERROR"': '"实时连接失败，请检查本地服务是否正在运行"',
    '"STREAMING ..."': '"正在生成并播放……"',
    '" REBUFFER" + (under > 1 ? "S" : "")': '" 次重新缓冲"',
    '"A SOURCE WAV IS REQUIRED"': '"请上传需要变声的原始 WAV 音频"',
    '"PICK A SAVED VOICE OR UPLOAD A TARGET VOICE WAV"': '"请选择已保存的声音，或上传目标声音 WAV 音频"',
    '"TARGET VOICE TRANSCRIPT IS REQUIRED"': '"请填写目标声音的准确文字稿"',
    '"CONVERTING ..."': '"正在变声……"',
    '"RECEIVING - "': '"正在接收音频："',
    'k.placeholder = "field";': 'k.placeholder = "字段名（英文、数字等）";',
    'val.placeholder = "value";': 'val.placeholder = "字段内容";',
    'el("button", "ghost", "X")': 'el("button", "ghost", "移除")',
    '"remove field"': '"移除此字段"',
    'v.saved ? "SAVED" : "TEMPORARY"': 'v.saved ? "已保存" : "临时声音"',
    'el("button", "ghost", "USE")': 'el("button", "ghost", "使用")',
    '"pick this voice in the clone tab"': '"在声音克隆页面使用此声音"',
    'el("label", "", "DESCRIPTION")': 'el("label", "", "声音备注")',
    '"what this voice sounds like, where it came from, what it is good for"': '"描述声音特点、来源或适合的用途"',
    'el("label", "", "EXTRA FIELDS")': 'el("label", "", "附加字段")',
    'el("button", "ghost", "+ FIELD")': 'el("button", "ghost", "+ 添加字段")',
    'el("button", "go", "SAVE CHANGES")': 'el("button", "go", "保存修改")',
    '"temporary voices lose their notes when the server restarts"': '"临时声音的备注会在服务重启后丢失"',
    '"(empty)"': '"（空字段名）"',
    '"unsaved changes"': '"有未保存的修改"',
    '"field names are letters, digits, dot, dash or underscore: "': '"字段名须为 1–64 个英文字母、数字、点、短横线或下划线，且不能是 description："',
    '"saving ..."': '"正在保存……"',
    'v.saved ? "saved" : "updated until the server restarts"': 'v.saved ? "已保存" : "已更新，服务重启后失效"',
    '"no voices yet, save one from the clone, direction or changer tab"': '"声音库还是空的。可在声音克隆、声音演绎或音频变声页面保存声音。"',
    'voices.length + " voices" : shown + " of " + voices.length + " voices"': 'voices.length + " 个声音" : "显示 " + shown + " 个，共 " + voices.length + " 个声音"',
    '"ERROR: " + (body.error || res.status)': '"错误：" + translateError(body.error || res.status)',
    '"ERROR: " + e.message': '"错误：" + translateError(e.message)',
    '"ERROR: " + (m.message || "unknown")': '"错误：" + translateError(m.message || "unknown")',
    '"ERROR " + res.status': '"请求失败，状态码：" + res.status',
    '"error: " + e.message': '"错误：" + translateError(e.message)',
    '+ "s"': '+ " 秒"',
}
for old, new in js_replacements.items():
    if old not in js:
        raise ValueError(f'Missing JS translation source: {old}')
    js = js.replace(old, new)

helper = '''// 本地中文错误提示；未知后端消息保留原文，便于排查。
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
  let match = message.match(/^description is longer than (\\d+) bytes$/);
  if (match) return "声音备注超过 " + match[1] + " 字节上限";
  match = message.match(/^metadata values are limited to (\\d+) bytes$/);
  if (match) return "每个附加字段内容最多 " + match[1] + " 字节";
  match = message.match(/^a voice can have at most (\\d+) metadata fields$/);
  if (match) return "每个声音最多可添加 " + match[1] + " 个附加字段";
  return message;
}

'''
js = helper + js
# Model management wraps the existing generation paths without changing the TTS protocol.
old_generation_handler = '''  btn.addEventListener("click", () => {
    if (panel.id === "changer") return convert(panel);
    // conversion has no socket path, everything else prefers it when the server opened one
    return wsPort ? wsGenerate(panel, panel.id) : generate(panel, panel.id);
  });'''
new_generation_handler = '''  btn.addEventListener("click", () => window.BreezeModels.runOperation(async () => {
    await loadHealth();
    const selectedVoice = panel.querySelector("select[data-f=voice_id]");
    const referenceAudio = panel.querySelector("input[data-f=ref_audio]");
    if (selectedVoice && selectedVoice.dataset.missingVoice && !(referenceAudio && referenceAudio.files.length)) {
      throw new Error("之前选择的临时声音已失效，请重新选择已保存声音或上传参考音频。");
    }
    if (panel.id === "changer") return convert(panel);
    return wsPort ? wsGenerate(panel, panel.id) : generate(panel, panel.id);
  }));'''
if old_generation_handler not in js:
    raise ValueError('Missing generation handler for portable model controls')
js = js.replace(old_generation_handler, new_generation_handler)
js = js.replace('if (save) save.addEventListener("click", () => saveVoice(panel));',
                'if (save) save.addEventListener("click", () => window.BreezeModels.runOperation(() => saveVoice(panel)));')
js = js.replace('if (sel) sel.addEventListener("change", () => syncVoice(panel));',
                'if (sel) sel.addEventListener("change", () => { delete sel.dataset.missingVoice; syncVoice(panel); });')
js = js.replace('sel => { sel.value = id; }', 'sel => { sel.value = id; delete sel.dataset.missingVoice; }')
js = js.replace('sel => { sel.value = body.id; }', 'sel => { sel.value = body.id; delete sel.dataset.missingVoice; }')
js = js.replace('if (res.ok) list = await res.json();', 'if (!res.ok) return;\n    list = await res.json();', 1)
js = js.replace('    sel.value = list.some(v => v.id === keep) ? keep : "";',
                '    const stillExists = list.some(v => v.id === keep);\n'
                '    if (keep && !stillExists) sel.dataset.missingVoice = keep;\n'
                '    else if (stillExists) delete sel.dataset.missingVoice;\n'
                '    sel.value = stillExists ? keep : "";')
js = js.replace('if (r.ok) wsPort = (await r.json()).ws_port || 0;',
                'wsPort = r.ok ? (await r.json()).ws_port || 0 : 0;')
js += '''
document.addEventListener("breeze:model-ready", async () => {
  await loadHealth();
  await loadVoices();
  if (document.querySelector("select[data-missing-voice]")) {
    statusEl.textContent = "模型已就绪。之前选择的临时声音已失效，请重新选择已保存声音或上传参考音频。";
  }
});
'''
(target / 'app.js').write_text(js, encoding='utf-8')

css = (source / 'style.css').read_text(encoding='utf-8')
css = css.replace('font-family: "JetBrains Mono", "Consolas", ui-monospace, monospace;',
                  'font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", sans-serif;')
css = css.replace('line-height: 1.4;', 'line-height: 1.65;')
css = css.replace('font-size: 12px; letter-spacing: 1px; color: var(--dim); }',
                  'font-size: 13px; letter-spacing: 0.3px; color: var(--dim); }', 1)
css += '\n/* 中文文本的输入行距与窄屏换行。 */\ntextarea { line-height: 1.65; resize: vertical; }\n.tab { white-space: nowrap; }\n.status, .note, footer { overflow-wrap: anywhere; }\n'
css += '.field-hint { display: block; margin-top: 8px; font-size: 12px; line-height: 1.65; letter-spacing: 0; }\n'
css += '''
.model-control { max-width: 900px; margin: 0 auto 24px; border: 2px solid var(--line); background: var(--panel); padding: 16px 20px; }
.model-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 12px; }
.model-heading strong { font-size: 15px; }
#model-current { color: var(--accent); font-size: 13px; }
.model-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.model-row label { flex: 1 1 300px; margin: 0; }
.model-row .ghost { flex: none; min-height: 43px; }
#model-message { color: var(--dim); font-size: 12px; margin: 10px 0 0; overflow-wrap: anywhere; }
.model-control[data-state="error"] #model-message { color: #ff9292; }
.model-control[aria-busy="true"] #model-message { color: var(--accent); }
select:disabled { opacity: 0.65; }
'''
(target / 'style.css').write_text(css, encoding='utf-8')
print('Localized index.html, app.js and style.css into', target)
