# Claude 手机控制台

这是一个纯浏览器方案。手机不需要安装 Claude App，只需要电脑上已有的 Claude CLI。

## 使用方法

1. 双击 `start-mobile-web.cmd`。
2. 启动窗口会显示一个局域网地址和访问码。
3. 让手机与电脑连接同一 Wi-Fi。
4. 在手机浏览器中打开该地址，例如 `http://192.168.1.20:3210`。
5. 在网页中输入访问码。
6. 第一次出现 Windows 防火墙提示时，只允许“专用网络”。

指定其他项目目录：

```powershell
.\start-mobile-web.cmd "D:\你的项目"
```

也可以直接运行：

```powershell
npm start -- --workspace "D:\你的项目"
```

默认端口为 `3210`。更改端口：

```powershell
$env:CLAUDE_MOBILE_PORT=4321
npm start
```

## 权限模式

- **安全模式**：只向 Claude 开放 `Read`、`Edit`、`Write`、`Glob` 和 `Grep`，适合阅读和修改工作区文件，不能执行命令。
- **自主模式**：允许 Claude 执行命令并跳过逐项权限询问，适合远程完成测试、构建等完整任务。

自主模式拥有当前 Windows 用户能够使用的权限。只对可信目录使用，并给出明确的任务范围和完成标准。

## 安全说明

- 每次启动都会生成新的访问码和内部随机访问口令。
- 同一手机标签页配对一次即可，刷新页面不需要重复输入。
- 同一时间只允许一个任务运行。
- 不要把局域网页直接映射到公网，也不要在路由器上做端口转发。
- 当前版本仅用于同一局域网。不要通过路由器端口转发把它直接暴露到公网。
- 若以后需要使用手机流量远程访问，应在现有网页前增加可信 VPN 或 HTTPS 隧道。
- 关闭启动窗口或按 `Ctrl+C` 即可停止手机访问。

## 测试

```powershell
npm test
```

## 无账户远程访问

先运行一次 `install-remote-access.ps1` 下载 Cloudflare 官方 `cloudflared`，之后双击
`start-remote-web.cmd`。窗口会显示临时 HTTPS 地址和随机 16 位访问码。

Quick Tunnel 不需要 Cloudflare 账户、银行卡或域名。其网址每次启动都会变化，仅适合个人临时使用。
