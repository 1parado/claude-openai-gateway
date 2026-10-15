# claude-gateway-ui

Anthropic `/v1/messages` ↔ OpenAI `chat/completions` 双向协议网关 + magpie 风格极简 WebUI。
零依赖，Node >= 18 单文件网关（`gateway.mjs`），前端为纯静态单页（`ui/index.html`）。

- 本目录为**现役套件**（网关 + WebUI + CLI 包装器 + 测试）。
- **协议转换原理讲解页**：[docs](https://1parado.github.io/claude-openai-gateway/)（Chloé Maillot 风格笔记）

## 快速启动

Windows：双击 **`start-gateway.cmd`** —— 自动打开浏览器进入控制台，网关监听 `http://127.0.0.1:8787`。

macOS / Linux（或 Windows 终端）：

```bash
node gateway.mjs        # 或指定端口 PORT=9000 node gateway.mjs
```

- WebUI：<http://127.0.0.1:8787/ui>（`/` 同样直达）
- 健康：`GET /health`
- Claude Code CLI（可选）：目录内 `claude.cmd`（cmd/PowerShell）/ `claude`（Git Bash）是智能路由包装器——网关在线走网关，离线回落你原有的 claude 配置。**首次使用前**把 `examples/claude-profile-settings.json` 复制为 `claude-profile/settings.json`（`env` 里的模型名可改成你 `config.json` 中配置的别名）
- Claude 桌面端：把桌面端的自定义网关（inference gateway）地址指向 `http://127.0.0.1:8787`、API Key 随意（`config.gatewayApiKey` 为空时不校验），模型列表会从网关自动发现

## WebUI 功能（http://127.0.0.1:8787/ui）

| 页面 | 功能 |
|---|---|
| 概览 | 今日请求 / 输入 / 输出 tokens、缓存命中率、错误数、web_search 次数；近 14 天用量柱状图；按模型统计表；网关信息 |
| 请求日志 | 最近请求明细（模型路由、流式/思考/工具标签、tokens、耗时、状态码），5s 自动刷新，一键清空 |
| Token 计数 | 系统提示 + 文本粘贴 → 走 `/v1/messages/count_tokens` 实时估算（CJK ≈1 字/token），附字符/词数统计 |

浅色/深色跟随系统，右上角可手动切换（记忆选择）。

## 请求日志与保留策略

- 记录内容：时间、路由（messages / count_tokens）、模型映射、tokens（in/out/cached）、耗时、状态、错误摘要、web_search 次数。**不记录消息正文**。
- 存储：内存最近 500 条 + `logs/req-YYYY-MM-DD.jsonl` 按天落盘（重启不丢统计）。
- 自动清理：`config.json → logs.retentionHours`（默认 **24 小时**），启动时及每 15 分钟扫描，过期日志文件直接删除；内存缓冲同步截断。想保留更久改这个值即可。

## 管理端点（仅本机，不走 gatewayApiKey）

- `GET /admin/stats` —— 聚合统计（today / total / byModel / daily）
- `GET /admin/logs?limit=100` —— 最近日志
- `POST /admin/logs/clear` —— 清空全部日志

## 配置（config.json）

新用户：**复制 `config-template.json` 为 `config.json`**，按其中 `_说明` 字段逐项填写（带 `_` 前缀的键只是注释，网关会忽略）。`config.json` 含 API Key，已被 `.gitignore` 排除，不要提交。

`port`、`upstreamBaseUrl`、`upstreamApiKey`、`models`（small/default/big/think）、`modelAliases`、`thinking`（budget_tokens→reasoning_effort 分档）、`webSearch.enabled`、`upstreamRetries`、`logs.retentionHours` 等。

## 上下文窗口（1M 长上下文）

客户端看到的 200K 不是网关截断，而是 Claude 客户端按"自己认识的模型"假设的窗口。网关按 magpie 同款方案把真实窗口告诉客户端：

- **自动发现**：上游 `/v1/models` 自报的 `context_length` / `max_output_tokens` 会被透传为模型目录的 `context_window` / `context_length` / `max_input_tokens` / `max_output_tokens` 字段；`max_input_tokens >= 1M` 时桌面端自动在模型旁加 "1M context window" 条目。
- **`[1m]` 变体**：窗口 ≥ 1M 的槽位会在目录里额外输出 `...[1m]` 后缀条目（Claude Code CLI 官方的长上下文标记，`/model` 里直接选，或用环境变量指定）。带 `[1m]` 的请求网关会自动剥掉后缀再路由。
- **手工覆盖**：`config.json → contextWindows`，按上游模型 id 精确指定，未列出的用 `default`：
  ```json
  "contextWindows": {
    "cn:glm-5.3-flash": 1000000,
    "default": 200000
  }
  ```
- **CLI 长上下文（可选）**：在 `claude-profile/settings.json` 的模型环境变量后加 `[1m]` 后缀（Claude Code 官方长上下文标记），CLI 会按 1M 规划上下文；去掉后缀则按 200K 规划（更早自动压缩、更低首 token 延迟）。
- 注意：窗口按 1M 规划后，上下文累积很大时首 token 延迟会明显上升（magpie 文档实测 550K 时 70–90s），属上游推理耗时，不是网关问题。

## 测试

```bash
node test/run-tests.mjs          # 25 项端到端
node test/verify-review-fixes.mjs # 12 项抽查
node test/verify-interleaved.mjs  # 交错推理流式回归
```
