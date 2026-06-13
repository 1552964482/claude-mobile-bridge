"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const CLOUDFLARED = path.join(ROOT, "tools", "cloudflared.exe");
const PORT = Number(process.env.CLAUDE_REMOTE_PORT || 3211);
const workspace = path.resolve(process.argv[2] || ROOT);

if (!fs.existsSync(CLOUDFLARED)) {
  console.error("未找到 cloudflared。请先右键 install-remote-access.ps1，选择“使用 PowerShell 运行”。");
  process.exit(1);
}

if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`工作目录不存在: ${workspace}`);
  process.exit(1);
}

const accessCode = crypto.randomBytes(12).toString("base64url");
const childEnvironment = {
  ...process.env,
  CLAUDE_MOBILE_PAIRING_CODE: accessCode,
};

const server = spawn(
  process.execPath,
  ["server.js", "--host", "127.0.0.1", "--port", String(PORT), "--workspace", workspace],
  {
    cwd: ROOT,
    env: childEnvironment,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  },
);

let shuttingDown = false;
let tunnel = null;
let printedUrl = false;

function stopChild(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(tunnel);
  stopChild(server);
  setTimeout(() => process.exit(exitCode), 300).unref();
}

server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => process.stderr.write(chunk));
server.on("error", (error) => {
  console.error(`无法启动网页服务: ${error.message}`);
  shutdown(1);
});
server.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`网页服务已退出，代码 ${code}`);
    shutdown(code || 1);
  }
});

setTimeout(() => {
  if (server.exitCode !== null) return;

  tunnel = spawn(
    CLOUDFLARED,
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const inspectOutput = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !printedUrl) {
      printedUrl = true;
      console.log("");
      console.log("============================================================");
      console.log("Claude 远程控制台已就绪");
      console.log(`手机访问地址: ${match[0]}`);
      console.log(`访问码: ${accessCode}`);
      console.log(`工作目录: ${workspace}`);
      console.log("============================================================");
      console.log("");
      console.log("手机可使用 Wi-Fi 或移动数据访问。关闭此窗口即停止远程访问。");
    }
  };

  tunnel.stdout.on("data", inspectOutput);
  tunnel.stderr.on("data", inspectOutput);
  tunnel.on("error", (error) => {
    console.error(`无法启动 Cloudflare Tunnel: ${error.message}`);
    shutdown(1);
  });
  tunnel.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`Cloudflare Tunnel 已退出，代码 ${code}`);
      shutdown(code || 1);
    }
  });
}, 800);

console.log("正在启动 Claude 网页服务和 HTTPS 隧道，请稍候...");
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
