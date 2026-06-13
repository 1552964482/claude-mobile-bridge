"use strict";

const elements = {
  connectionStatus: document.querySelector("#connection-status"),
  conversation: document.querySelector("#conversation"),
  emptyState: document.querySelector("#empty-state"),
  messageTemplate: document.querySelector("#message-template"),
  mode: document.querySelector("#mode"),
  newSession: document.querySelector("#new-session"),
  pairButton: document.querySelector("#pair-button"),
  pairError: document.querySelector("#pair-error"),
  pairingCode: document.querySelector("#pairing-code"),
  pairingPanel: document.querySelector("#pairing-panel"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  statusDot: document.querySelector("#status-dot"),
  stop: document.querySelector("#stop"),
  taskState: document.querySelector("#task-state"),
  workspace: document.querySelector("#workspace"),
};

const STORAGE_KEY = "claude-mobile-state-v1";
const url = new URL(window.location.href);
const urlToken = url.searchParams.get("token");
if (urlToken) {
  sessionStorage.setItem("claude-mobile-token", urlToken);
  url.searchParams.delete("token");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
let token = sessionStorage.getItem("claude-mobile-token") || "";

function createUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function freshState() {
  return {
    sessionId: createUuid(),
    hasStarted: false,
    activeTaskId: null,
    lastSequence: 0,
    history: [],
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed && typeof parsed.sessionId === "string" && Array.isArray(parsed.history)) {
      return { ...freshState(), ...parsed };
    }
  } catch {
    // Start clean if browser storage is corrupt.
  }
  return freshState();
}

let state = loadState();
let pollTimer = null;
let assistantMessage = null;

function saveState() {
  state.history = state.history.slice(-80);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Claude-Mobile-Token": token,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({ error: "电脑返回了无法读取的响应" }));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function pair() {
  const code = elements.pairingCode.value.trim();
  if (code.length < 6 || code.length > 64) {
    elements.pairError.textContent = "请输入电脑窗口中显示的访问码";
    return;
  }

  elements.pairButton.disabled = true;
  elements.pairError.textContent = "";
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "配对失败");
    token = data.token;
    sessionStorage.setItem("claude-mobile-token", token);
    elements.pairingPanel.hidden = true;
    elements.send.disabled = false;
    await connect();
  } catch (error) {
    elements.pairError.textContent = error.message;
  } finally {
    elements.pairButton.disabled = false;
  }
}

function setConnection(kind, text) {
  elements.statusDot.className = `status-dot ${kind || ""}`;
  elements.connectionStatus.textContent = text;
}

function showPairing(message = "电脑端服务已打开，请输入启动窗口中的访问码。") {
  token = "";
  sessionStorage.removeItem("claude-mobile-token");
  setConnection("", "等待手机配对");
  elements.workspace.textContent = message;
  elements.pairingPanel.hidden = false;
  elements.send.disabled = true;
  elements.pairingCode.focus();
}

function addMessage(role, text, options = {}) {
  elements.emptyState.hidden = true;
  const fragment = elements.messageTemplate.content.cloneNode(true);
  const article = fragment.querySelector(".message");
  const label = fragment.querySelector(".message-label");
  const body = fragment.querySelector(".message-body");
  article.classList.add(role);
  label.textContent = options.label || (
    role === "user" ? "YOU" : role === "assistant" ? "CLAUDE" : "ACTIVITY"
  );
  body.textContent = text;
  elements.conversation.append(article);
  window.scrollTo({ top: document.body.scrollHeight, behavior: options.instant ? "auto" : "smooth" });
  return article;
}

function recordMessage(role, text) {
  state.history.push({ role, text, at: Date.now() });
  saveState();
}

function renderHistory() {
  elements.conversation.replaceChildren();
  assistantMessage = null;
  if (!state.history.length) {
    elements.emptyState.hidden = false;
    return;
  }
  for (const item of state.history) {
    const article = addMessage(item.role, item.text, { instant: true });
    if (item.role === "assistant" && item.pending === true) assistantMessage = article;
  }
}

function setRunning(running) {
  elements.send.disabled = running;
  elements.newSession.disabled = running;
  elements.mode.disabled = running;
  elements.stop.hidden = !running;
  elements.taskState.textContent = running ? "任务运行中" : "准备就绪";
}

function handleTaskEvent(event) {
  if (event.type === "assistant") {
    if (!assistantMessage) {
      assistantMessage = addMessage("assistant", "");
    }
    const body = assistantMessage.querySelector(".message-body");
    body.textContent += event.text;
    const previous = state.history[state.history.length - 1];
    if (previous?.role === "assistant" && previous.pending === true) {
      previous.text = body.textContent;
    } else {
      state.history.push({ role: "assistant", text: body.textContent, pending: true, at: Date.now() });
    }
    saveState();
    return;
  }

  if (event.type === "tool") {
    const detail = event.detail ? ` · ${event.detail}` : "";
    addMessage("activity", `${event.name}${detail}`);
    return;
  }

  if (event.type === "warning" || event.type === "error") {
    addMessage("error", event.text, { label: event.type.toUpperCase() });
    return;
  }

  if (event.type === "meta" || event.type === "status") {
    elements.taskState.textContent = event.text;
    return;
  }

  if (event.type === "result") {
    const cost = event.costUsd == null ? "" : ` · $${event.costUsd.toFixed(3)}`;
    const duration = event.durationMs == null ? "" : ` · ${(event.durationMs / 1000).toFixed(1)} 秒`;
    const denials = event.permissionDenials ? ` · ${event.permissionDenials} 项操作未获权限` : "";
    addMessage(
      event.isError ? "error" : "activity",
      `${event.text}${duration}${cost}${denials}`,
      { label: event.isError ? "ERROR" : "DONE" },
    );
  }
}

function finishTask(status) {
  clearTimeout(pollTimer);
  pollTimer = null;
  state.activeTaskId = null;
  if (status === "completed") state.hasStarted = true;
  const previous = state.history[state.history.length - 1];
  if (previous?.pending) delete previous.pending;
  saveState();
  assistantMessage = null;
  setRunning(false);
  elements.taskState.textContent = {
    completed: "任务完成",
    failed: "任务失败",
    stopped: "任务已停止",
  }[status] || "准备就绪";
}

async function pollTask() {
  if (!state.activeTaskId) return;
  try {
    const task = await api(`/api/tasks/${state.activeTaskId}?after=${state.lastSequence}`);
    for (const event of task.events) {
      handleTaskEvent(event);
      state.lastSequence = event.sequence;
    }
    state.lastSequence = task.lastSequence;
    saveState();
    if (["completed", "failed", "stopped"].includes(task.status)) {
      finishTask(task.status);
      return;
    }
    pollTimer = setTimeout(pollTask, 850);
  } catch (error) {
    if (error.status === 404) {
      addMessage("error", "电脑上的服务已经重启，无法继续读取上一个任务。请重新发送任务。");
      finishTask("failed");
      return;
    }
    elements.taskState.textContent = "连接中断，正在重试";
    pollTimer = setTimeout(pollTask, 1800);
  }
}

async function sendTask() {
  const prompt = elements.prompt.value.trim();
  if (!prompt || state.activeTaskId) return;

  if (
    elements.mode.value === "autonomous"
    && !window.confirm(
      "自主模式允许 Claude 以你的电脑账户执行命令。只应在可信工作目录和明确任务下使用。确定继续吗？",
    )
  ) {
    elements.mode.value = "safe";
    return;
  }

  addMessage("user", prompt);
  recordMessage("user", prompt);
  elements.prompt.value = "";
  setRunning(true);
  assistantMessage = null;
  state.lastSequence = 0;

  try {
    const task = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        sessionId: state.sessionId,
        hasStarted: state.hasStarted,
        mode: elements.mode.value,
      }),
    });
    state.activeTaskId = task.taskId;
    saveState();
    pollTask();
  } catch (error) {
    if (error.status === 409 && error.data?.activeTaskId) {
      state.activeTaskId = error.data.activeTaskId;
      saveState();
      addMessage("activity", "已重新连接电脑上正在运行的任务。");
      pollTask();
      return;
    }
    addMessage("error", error.message);
    setRunning(false);
  }
}

async function stopTask() {
  if (!state.activeTaskId) return;
  elements.stop.disabled = true;
  elements.taskState.textContent = "正在停止";
  try {
    await api(`/api/tasks/${state.activeTaskId}/stop`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    addMessage("error", error.message);
  } finally {
    elements.stop.disabled = false;
  }
}

function newSession() {
  if (state.activeTaskId) return;
  if (state.history.length && !window.confirm("新建会话会清空手机上显示的当前对话。确定继续吗？")) {
    return;
  }
  state = freshState();
  saveState();
  assistantMessage = null;
  renderHistory();
  elements.taskState.textContent = "新会话已建立";
}

async function connect() {
  if (!token) {
    showPairing();
    return;
  }

  try {
    const status = await api("/api/status");
    setConnection("online", "已连接这台电脑");
    elements.workspace.textContent = status.workspace;
    if (state.activeTaskId || status.activeTaskId) {
      state.activeTaskId = state.activeTaskId || status.activeTaskId;
      saveState();
      setRunning(true);
      pollTask();
    }
  } catch (error) {
    if (error.status === 401) {
      showPairing("服务已重新启动，请输入电脑窗口中新的访问码。");
      return;
    }
    setConnection("error", "无法连接电脑");
    elements.workspace.textContent = error.message;
    elements.send.disabled = true;
  }
}

elements.send.addEventListener("click", sendTask);
elements.stop.addEventListener("click", stopTask);
elements.newSession.addEventListener("click", newSession);
elements.pairButton.addEventListener("click", pair);
elements.pairingCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") pair();
});
elements.prompt.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") sendTask();
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.prompt.value = button.dataset.prompt;
    elements.prompt.focus();
  });
});

renderHistory();
connect();
