"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
]);

function parseArgs(argv) {
  const result = {
    host: process.env.CLAUDE_MOBILE_HOST || "0.0.0.0",
    port: Number(process.env.CLAUDE_MOBILE_PORT || 3210),
    workspace: process.env.CLAUDE_WORKSPACE || process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--host" && value) result.host = value;
    if (key === "--port" && value) result.port = Number(value);
    if (key === "--workspace" && value) result.workspace = value;
    if (key.startsWith("--") && value) index += 1;
  }

  result.workspace = path.resolve(result.workspace);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error("端口必须是 1 到 65535 之间的整数。");
  }
  if (!fs.existsSync(result.workspace) || !fs.statSync(result.workspace).isDirectory()) {
    throw new Error(`工作目录不存在: ${result.workspace}`);
  }
  return result;
}

function findClaudeCommand() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const nativeBinary = path.join(
        appData,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (fs.existsSync(nativeBinary)) return nativeBinary;

      const commandShim = path.join(appData, "npm", "claude.cmd");
      if (fs.existsSync(commandShim)) return commandShim;
    }
  }
  return "claude";
}

function buildClaudeArgs({ sessionId, hasStarted, mode }) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    mode === "autonomous" ? "bypassPermissions" : "acceptEdits",
  ];

  if (mode !== "autonomous") {
    args.push("--tools", "Read,Edit,Write,Glob,Grep");
  }

  if (hasStarted) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }
  return args;
}

function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const preferredKeys = ["file_path", "path", "pattern", "query", "command"];
  for (const key of preferredKeys) {
    if (typeof input[key] === "string") {
      const value = input[key].replace(/\s+/g, " ").trim();
      return value.length > 180 ? `${value.slice(0, 177)}...` : value;
    }
  }
  return "";
}

function translateClaudeEvent(event) {
  if (!event || typeof event !== "object") return [];

  if (event.type === "system" && event.subtype === "init") {
    return [{
      type: "meta",
      text: `已连接 ${event.model || "Claude"}`,
      model: event.model || null,
    }];
  }

  if (
    event.type === "system"
    && event.subtype === "hook_response"
    && event.outcome === "error"
  ) {
    return [{ type: "warning", text: event.stderr || event.output || "启动钩子执行失败" }];
  }

  if (event.type === "assistant" && event.message?.content) {
    const translated = [];
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        translated.push({ type: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        translated.push({
          type: "tool",
          name: block.name || "工具",
          detail: summarizeToolInput(block.input),
        });
      }
    }
    return translated;
  }

  if (event.type === "result") {
    return [{
      type: "result",
      text: event.is_error ? (event.result || "任务失败") : "任务完成",
      isError: Boolean(event.is_error),
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
      durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
      permissionDenials: Array.isArray(event.permission_denials)
        ? event.permission_denials.length
        : 0,
    }];
  }

  return [];
}

function privateNetworkScore(address) {
  if (address.startsWith("192.168.")) return 4;
  if (address.startsWith("10.")) return 3;
  const match = address.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return 2;
  return 1;
}

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)].sort(
    (left, right) => privateNetworkScore(right) - privateNetworkScore(left),
  );
}

function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("请求内容过大"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("请求不是有效的 JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}

function createApp(options = {}) {
  const config = options.config || parseArgs([]);
  const token = options.token || process.env.CLAUDE_MOBILE_TOKEN || crypto.randomBytes(24).toString("base64url");
  const pairingCode = options.pairingCode
    || process.env.CLAUDE_MOBILE_PAIRING_CODE
    || crypto.randomInt(100000, 1000000).toString();
  const claudeCommand = options.claudeCommand || findClaudeCommand();
  const tasks = new Map();
  const pairingAttempts = new Map();
  let activeTask = null;

  function addEvent(task, event) {
    task.events.push({ ...event, sequence: task.nextSequence, at: Date.now() });
    task.nextSequence += 1;
    if (task.events.length > 1500) task.events.splice(0, task.events.length - 1500);
  }

  function pruneTasks() {
    if (tasks.size <= 20) return;
    const removable = [...tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((left, right) => left.createdAt - right.createdAt);
    while (tasks.size > 20 && removable.length) {
      tasks.delete(removable.shift().id);
    }
  }

  function runTask(task, prompt) {
    const args = buildClaudeArgs(task);
    const childEnvironment = { ...process.env };
    delete childEnvironment.CLAUDE_MOBILE_TOKEN;
    const child = spawn(claudeCommand, args, {
      cwd: config.workspace,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: claudeCommand.toLowerCase().endsWith(".cmd"),
      env: childEnvironment,
    });

    task.child = child;
    task.status = "running";
    activeTask = task;
    addEvent(task, { type: "status", text: "Claude 正在处理任务" });

    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          for (const event of translateClaudeEvent(JSON.parse(line))) addEvent(task, event);
        } catch {
          addEvent(task, { type: "warning", text: `无法解析 Claude 输出: ${line.slice(0, 300)}` });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) addEvent(task, { type: "warning", text: text.slice(0, 1000) });
    });

    child.on("error", (error) => {
      task.status = "failed";
      task.finishedAt = Date.now();
      if (activeTask === task) activeTask = null;
      addEvent(task, { type: "error", text: `无法启动 Claude CLI: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      if (stdoutBuffer.trim()) {
        try {
          for (const event of translateClaudeEvent(JSON.parse(stdoutBuffer))) addEvent(task, event);
        } catch {
          addEvent(task, { type: "warning", text: stdoutBuffer.slice(0, 300) });
        }
      }

      if (task.status === "stopping") {
        task.status = "stopped";
        addEvent(task, { type: "status", text: "任务已停止" });
      } else if (task.status === "running") {
        task.status = code === 0 ? "completed" : "failed";
        if (code !== 0) {
          addEvent(task, {
            type: "error",
            text: `Claude CLI 已退出，代码 ${code}${signal ? `，信号 ${signal}` : ""}`,
          });
        }
      }
      task.finishedAt = Date.now();
      task.child = null;
      if (activeTask === task) activeTask = null;
      pruneTasks();
    });

    child.stdin.end(prompt);
  }

  function authorized(request, url) {
    const supplied = request.headers["x-claude-mobile-token"] || url.searchParams.get("token");
    if (typeof supplied !== "string") return false;
    const expectedBuffer = Buffer.from(token);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  }

  function canAttemptPairing(address) {
    const now = Date.now();
    const previous = pairingAttempts.get(address);
    if (!previous || now - previous.startedAt > 5 * 60 * 1000) {
      pairingAttempts.set(address, { count: 1, startedAt: now });
      return true;
    }
    previous.count += 1;
    return previous.count <= 8;
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");

    if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
      const [fileName, contentType] = STATIC_FILES.get(url.pathname);
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": fileName === "index.html" ? "no-store" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(path.join(PUBLIC_DIR, fileName)).pipe(response);
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "未找到" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair") {
      try {
        const address = request.socket.remoteAddress || "unknown";
        if (!canAttemptPairing(address)) {
          sendJson(response, 429, { error: "配对尝试次数过多，请等待 5 分钟后再试。" });
          return;
        }
        const body = await readJsonBody(request, 2048);
        const suppliedCode = typeof body.code === "string" ? body.code.trim() : "";
        const expectedBuffer = Buffer.from(pairingCode);
        const suppliedBuffer = Buffer.from(suppliedCode);
        const matches = expectedBuffer.length === suppliedBuffer.length
          && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
        if (!matches) {
          sendJson(response, 401, { error: "访问码不正确" });
          return;
        }
        pairingAttempts.delete(address);
        sendJson(response, 200, { token });
      } catch (error) {
        sendJson(response, error.statusCode || 500, { error: error.message });
      }
      return;
    }

    if (!authorized(request, url)) {
      sendJson(response, 401, { error: "访问口令无效，请使用启动窗口中显示的完整链接。" });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, {
          ok: true,
          workspace: config.workspace,
          claudeCommand,
          activeTaskId: activeTask?.id || null,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks") {
        if (activeTask) {
          sendJson(response, 409, {
            error: "已有任务正在运行",
            activeTaskId: activeTask.id,
          });
          return;
        }

        const body = await readJsonBody(request);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const hasStarted = body.hasStarted === true;
        const mode = body.mode === "autonomous" ? "autonomous" : "safe";

        if (!prompt || prompt.length > 20000) {
          sendJson(response, 400, { error: "任务内容不能为空，且不能超过 20000 个字符。" });
          return;
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
          sendJson(response, 400, { error: "会话 ID 无效，请新建会话后重试。" });
          return;
        }

        const task = {
          id: crypto.randomUUID(),
          sessionId,
          hasStarted,
          mode,
          status: "queued",
          createdAt: Date.now(),
          finishedAt: null,
          nextSequence: 1,
          events: [],
          child: null,
        };
        tasks.set(task.id, task);
        runTask(task, prompt);
        sendJson(response, 202, { taskId: task.id, status: task.status });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task) {
          sendJson(response, 404, { error: "任务不存在，服务可能已经重启。" });
          return;
        }
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        sendJson(response, 200, {
          id: task.id,
          sessionId: task.sessionId,
          status: task.status,
          mode: task.mode,
          events: task.events.filter((event) => event.sequence > after),
          lastSequence: task.nextSequence - 1,
          finishedAt: task.finishedAt,
        });
        return;
      }

      const stopMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/stop$/i);
      if (request.method === "POST" && stopMatch) {
        const task = tasks.get(stopMatch[1]);
        if (!task) {
          sendJson(response, 404, { error: "任务不存在" });
          return;
        }
        if (task.status !== "running" || !task.child) {
          sendJson(response, 409, { error: "任务当前没有在运行" });
          return;
        }
        task.status = "stopping";
        stopProcessTree(task.child);
        sendJson(response, 202, { status: "stopping" });
        return;
      }

      sendJson(response, 404, { error: "未找到" });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : `服务器错误: ${error.message}`,
      });
    }
  });

  function close() {
    for (const task of tasks.values()) {
      if (task.child) stopProcessTree(task.child);
    }
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, close, token, pairingCode, config, claudeCommand, tasks };
}

function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`启动失败: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const app = createApp({ config });
  app.server.on("error", (error) => {
    console.error(`服务器错误: ${error.message}`);
    process.exitCode = 1;
  });
  app.server.listen(config.port, config.host, () => {
    const addresses = getLanAddresses();
    console.log("");
    console.log("Claude 手机控制台已启动");
    console.log(`工作目录: ${config.workspace}`);
    console.log("");
    console.log("在手机浏览器打开以下地址（手机和电脑需连接同一 Wi-Fi）：");
    if (addresses.length) {
      for (const address of addresses) {
        console.log(`  http://${address}:${config.port}`);
      }
    } else {
      console.log("  未检测到局域网 IPv4 地址，请检查网络连接。");
    }
    console.log("");
    console.log(`手机访问码: ${app.pairingCode}`);
    console.log(`本机测试: http://127.0.0.1:${config.port}`);
    console.log("按 Ctrl+C 停止服务。请勿将地址和访问码发给不信任的人。");
    console.log("");
  });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = {
  buildClaudeArgs,
  createApp,
  getLanAddresses,
  parseArgs,
  translateClaudeEvent,
};
