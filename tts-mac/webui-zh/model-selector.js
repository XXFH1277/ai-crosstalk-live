/* Local model control: explicit switching, generation leases, and in-place refresh. */
(() => {
  "use strict";
  const select = document.getElementById("model-select");
  const apply = document.getElementById("model-apply");
  const retry = document.getElementById("model-refresh");
  const current = document.getElementById("model-current");
  const message = document.getElementById("model-message");
  const box = document.getElementById("model-control");
  const outputStatus = document.getElementById("status");
  const actions = () => document.querySelectorAll(".panel:not(#library) .go, .save-voice");
  let status = { models: [], current_model: null, state: "loading", generation_busy: false };
  let csrfToken = "";
  let selectedOnce = false;
  let operationBusy = false;
  let requestPending = false;
  let refreshing = null;
  let pollTimer = null;
  let notice = "";
  let leaseId = null;
  let renewalTimer = null;

  const modelLabel = id => {
    const model = status.models.find(m => m.id === id);
    return model ? model.label : (id || "尚未加载");
  };
  const modelMismatch = () => !!select.value && select.value !== status.current_model;

  function render() {
    const switching = requestPending || status.state === "switching";
    const remoteBusy = status.generation_busy && !operationBusy;
    const busy = operationBusy || remoteBusy;
    const unavailable = status.state !== "idle" || !status.current_model;
    actions().forEach(button => { button.disabled = switching || busy || unavailable || modelMismatch(); });
    select.disabled = switching || busy || !status.models.length;
    const chosen = status.models.find(m => m.id === select.value);
    apply.disabled = switching || busy || !chosen || !chosen.available ||
      (select.value === status.current_model && status.state === "idle");
    retry.disabled = requestPending;
    apply.textContent = switching ? "正在切换…" : "切换模型";
    current.textContent = "当前模型：" + modelLabel(status.current_model);
    box.setAttribute("aria-busy", String(switching));
    box.dataset.state = notice || status.state === "error" ? "error" : status.state;
    if (notice) message.textContent = notice;
    else if (switching) message.textContent = status.message || "正在加载所选模型，请稍候。";
    else if (busy) message.textContent = "语音任务进行中，完成后即可切换模型。";
    else if (status.state === "error") message.textContent = status.message || "模型尚未就绪，请选择模型后重试。";
    else if (status.state === "loading") message.textContent = "正在读取模型状态…";
    else if (modelMismatch()) message.textContent = "已选择 " + modelLabel(select.value) + "，点击“切换模型”后即可生成。";
    else message.textContent = "生成前可选择模型。切换需要重新加载，请等待就绪；已保存的声音会保留。";
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        cache: "no-store", credentials: "same-origin", signal: controller.signal, ...options,
        headers: { "Content-Type": "application/json", "X-Breeze-Token": csrfToken, ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || ("本地服务请求失败（" + response.status + "）"));
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("本地服务响应超时，请稍后点击“刷新状态”。");
      if (error instanceof TypeError) throw new Error("无法连接本地服务，请确认启动窗口没有报错。");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function refreshStatus() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const data = await api("/local/models");
      if (!Array.isArray(data.models) || typeof data.csrf_token !== "string") {
        throw new Error("模型控制接口返回异常，请重新运行一键启动入口。");
      }
      const before = status;
      const chosen = select.value;
      status = data;
      csrfToken = data.csrf_token;
      const signature = JSON.stringify(data.models.map(m => [m.id, m.label, m.bytes, m.available]));
      if (select.dataset.options !== signature) {
        select.textContent = "";
        data.models.forEach(model => {
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = model.label + (model.available ? "" : "（模型文件缺失）");
          option.disabled = !model.available;
          select.appendChild(option);
        });
        select.dataset.options = signature;
      }
      if (!selectedOnce) {
        select.value = data.current_model || (data.models.find(m => m.available) || {}).id || "";
        selectedOnce = true;
      } else if (data.models.some(m => m.id === chosen)) select.value = chosen;
      const becameReady = data.state === "idle" && data.current_model &&
        (before.current_model !== data.current_model || before.state !== "idle");
      if (becameReady) document.dispatchEvent(new CustomEvent("breeze:model-ready"));
      render();
      return data;
    })().catch(error => {
      status = { ...status, state: "error", message: error.message };
      render();
      throw error;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try { await refreshStatus(); } catch (_) { /* rendered above */ }
      schedulePoll();
    }, status.state === "switching" || requestPending ? 1000 : 5000);
  }

  async function switchModel() {
    if (operationBusy || requestPending) return;
    notice = "";
    requestPending = true;
    render();
    try {
      await refreshStatus();
      if (status.generation_busy) throw new Error("其他页面正在处理语音，请等任务结束后再切换。");
      const model = status.models.find(m => m.id === select.value && m.available);
      if (!model) throw new Error("所选模型文件不存在，请检查解压后的 models 文件夹。");
      await api("/local/model", { method: "POST", body: JSON.stringify({ model: model.id }) });
      await refreshStatus();
    } catch (error) { notice = error.message; }
    finally { requestPending = false; render(); schedulePoll(); }
  }

  async function runOperation(work) {
    if (operationBusy || requestPending) return;
    operationBusy = true;
    notice = "";
    render();
    try {
      await refreshStatus();
      if (status.state !== "idle" || !status.current_model) throw new Error(status.message || "模型尚未就绪，请先完成模型切换。");
      if (modelMismatch()) throw new Error("请先点击“切换模型”，等待所选模型加载完成。");
      const lease = await api("/local/generation/lease", { method: "POST", body: "{}" });
      if (!lease.lease_id) throw new Error("无法取得语音任务锁，请刷新状态后重试。");
      leaseId = lease.lease_id;
      renewalTimer = setInterval(async () => {
        if (!leaseId) return;
        try {
          await api("/local/generation/lease", { method: "POST", body: JSON.stringify({ lease_id: leaseId }) });
        } catch (error) {
          notice = "语音任务状态连接中断：" + error.message;
          render();
        }
      }, 10000);
      await work();
    } catch (error) {
      outputStatus.textContent = "操作未完成：" + error.message;
    } finally {
      clearInterval(renewalTimer);
      renewalTimer = null;
      const releasing = leaseId;
      leaseId = null;
      if (releasing) {
        try { await api("/local/generation/lease", { method: "DELETE", body: JSON.stringify({ lease_id: releasing }) }); }
        catch (_) { notice = "任务已结束，正在等待服务刷新任务状态。"; }
      }
      operationBusy = false;
      try { await refreshStatus(); } catch (_) { /* rendered above */ }
      render();
      schedulePoll();
    }
  }

  select.addEventListener("change", () => { notice = ""; render(); });
  apply.addEventListener("click", switchModel);
  retry.addEventListener("click", async () => {
    notice = "";
    try { await refreshStatus(); } catch (_) { /* rendered above */ }
    schedulePoll();
  });
  window.addEventListener("pagehide", () => {
    if (leaseId) fetch("/local/generation/lease", {
      method: "DELETE", keepalive: true,
      headers: { "Content-Type": "application/json", "X-Breeze-Token": csrfToken },
      body: JSON.stringify({ lease_id: leaseId })
    }).catch(() => {});
  });
  window.BreezeModels = { runOperation, refreshStatus };
  render();
  refreshStatus().catch(() => {}).finally(schedulePoll);
})();
