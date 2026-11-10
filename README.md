# claude-gateway-ui

Anthropic `/v1/messages` ↔ OpenAI `chat/completions` 双向协议网关 + magpie 风格极简 WebUI。
零依赖，Node >= 18，网关入口为 `gateway.mjs`，供应商配置逻辑为 `providers.mjs`，前端为 `ui/` 下的纯静态单页。

- 本目录为**现役套件**（网关 + WebUI + CLI 包装器 + 测试）。
- **协议转换原理讲解页**：[docs](https://1parado.github.io/claude-openai-gateway/)（Chloé Maillot 风格笔记）

## 快速启动

Windows：双击 **`start-gateway.cmd`** —— 自动打开浏览器进入控制台，网关监听 `http://127.0.0.1:8787`。

macOS / Linux（或 Windows 终端）：

```bash
node gateway.mjs        # 或指定端口 PORT=9000 node gateway.mjs
```

- WebUI：<http://127.0.0.1:8787/ui>（`/` 同样直达）
- 首次启动无需手动创建 `config.json`：进入 **供应商** 页面，添加 URL、API Key，获取模型并选择 **保存并启用**。
- 健康：`GET /health`；服务仅监听本机 `127.0.0.1`。
- Claude Code CLI：在供应商页面点击 **生成 Claude Code 专用配置**，然后在项目目录执行 `sh ./claude`（Git Bash / macOS / Linux）或 `.\claude.cmd`（PowerShell）。包装器会读取 `claude-profile/settings.json` 中的地址，在线走网关，离线回落原有配置。重复生成会合并原设置，并备份为 `settings.json.bak`。
- 支持自定义推理网关的 Claude 客户端：把 inference gateway 地址指向 `http://127.0.0.1:8787`；`gatewayApiKey` 为空时 Key 可填 `local-gateway`，否则使用配置中的网关 Key。模型目录由网关提供。

## WebUI 功能（http://127.0.0.1:8787/ui）

| 页面 | 功能 |
|---|---|
| 概览 | 今日请求 / 输入 / 输出 tokens、缓存命中率、错误数、web_search 次数；近 14 天用量柱状图；按模型统计表；网关信息 |
| 供应商 | 添加 / 编辑 / 删除上游，自动获取模型，可搜索选择或手填默认、轻量、主力、思考模型；一键启用，无需重启；生成 Claude Code 专用配置 |
| 请求日志 | 最近请求明细（模型路由、流式/思考/工具标签、tokens、耗时、状态码），5s 自动刷新，一键清空 |
| Token 计数 | 系统提示 + 文本粘贴 → 走 `/v1/messages/count_tokens` 实时估算（CJK ≈1 字/token），附字符/词数统计 |

浅色/深色跟随系统，右上角可手动切换（记忆选择）。

### 供应商接入说明

1. 填写名称、上游 URL 和 Key。本地免密服务勾选「本地服务 / 免密访问」。域名自动补 `/v1`；`/chat/completions` 和 `/models` 后缀会自动移除；其他自定义路径保留。
2. 点击「获取模型」，从默认模型输入框的候选列表选择模型。其他槽位留空使用默认模型。没有模型列表权限时，可直接填写供应商提供的模型 ID。
3. 点击「保存并启用」。也可只保存，再从供应商卡片点击「启用」。切换后新请求使用新供应商，进行中的请求及其重试继续使用原上游。
4. 在下方生成 Claude Code 专用配置并通过项目包装器启动。后续切换供应商无需再次生成配置。更改网关端口或 `gatewayApiKey` 后需重新生成。

当前支持 **OpenAI Chat Completions 兼容上游**（`/models`、`/chat/completions`）。原生 Anthropic Messages、仅 Responses API 的服务需要另加适配器；用于 Claude 编程的模型需要支持工具调用。

供应商及 Key 保存在本机 `config.json`（已被 git 忽略）；管理 API 只返回 `hasApiKey`，编辑留空保留已存 Key。更换上游 URL 时需要重新填写 Key 或显式选择免密。原有单上游配置会作为「原有上游」加载，首次保存后迁移为多供应商配置；高级配置保留。

## 请求日志与保留策略

- 记录内容：时间、路由（messages / count_tokens）、模型映射、tokens（in/out/cached）、耗时、状态、错误摘要、web_search 次数。**不记录消息正文**。
- 存储：内存最近 500 条 + `logs/req-YYYY-MM-DD.jsonl` 按天落盘（重启不丢统计）。
- 自动清理：`config.json → logs.retentionHours`（默认 **24 小时**），启动时及每 15 分钟扫描，过期日志文件直接删除；内存缓冲同步截断。想保留更久改这个值即可。

## 管理端点（仅本机，不走 gatewayApiKey）

- `GET /admin/stats` —— 聚合统计（today / total / byModel / daily）
- `GET /admin/logs?limit=100` —— 最近日志
- `POST /admin/logs/clear` —— 清空全部日志
- `GET /admin/providers` —— 供应商列表与当前启用项（不返回 Key）
- `POST /admin/providers` —— 新增或编辑供应商（编辑提交 `id`）
- `POST /admin/providers/discover` —— 通过 URL、Key 获取模型
- `POST /admin/providers/:id/activate` —— 启用供应商
- `DELETE /admin/providers/:id` —— 删除非当前供应商
- `POST /admin/claude-profile` —— 合并生成项目内的 Claude Code 专用配置

管理接口校验本机连接、Host 与 Origin；写入请求使用 `application/json`。不对外开放跨域管理。

## 配置（config.json）

可在供应商页面自动生成配置；需要高级选项时，也可**复制 `config-template.json` 为 `config.json`**，按其中 `_说明` 字段填写（带 `_` 前缀的键只是注释）。`config.json` 含 API Key，已被 `.gitignore` 排除。供应商页面的修改立即生效，手工修改配置文件后需重启。

启用供应商后，`providers` 保存完整列表，`activeProviderId` 指向启用项；顶层 `upstreamBaseUrl`、`upstreamApiKey`、`models`、`modelAliases` 自动同步为启用项。其他高级选项仍为网关全局设置。

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
node --test test/providers.test.mjs # 隔离配置 + 模拟上游，无需真实 Key
node test/run-tests.mjs          # 25 项端到端
node test/verify-review-fixes.mjs # 12 项抽查
node test/verify-interleaved.mjs  # 交错推理流式回归
```
