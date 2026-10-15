#!/usr/bin/env node
/**
 * claude-openai-gateway
 * Anthropic Messages API (/v1/messages) <-> OpenAI Chat Completions 双向协议网关
 *
 * 特性：
 *  - 完整 Anthropic /v1/messages 协议（system / content blocks / 图片 / 工具调用 / stop_reason / usage）
 *  - SSE 流式无损转换（message_start -> content_block_* -> message_delta -> message_stop）
 *  - 工具调用流式增量输出（input_json_delta）
 *  - thinking 支持：reasoning_content / <think> 标签 -> Anthropic thinking block（自动生成 signature）
 *  - 请求侧 thinking 控制：budget_tokens -> reasoning_effort 分档；关闭时可显式下发禁用体
 *  - 模型映射（haiku/sonnet/opus -> small/default/big，thinking -> think；显式选真实模型时不覆盖）
 *  - 网关服务端 web_search（magpie 同款）：内部执行搜索，server_tool_use/web_search_tool_result 块回传
 *  - 上游重试（429/5xx 指数退避 + retry-after，LiteLLM 同款）；流中断发 SSE error 事件
 *  - count_tokens 中英文混合估算、/v1/models(/:id)、Anthropic 错误格式
 *  - 内置极简 WebUI（magpie 风格）：/ui 概览 / 请求日志 / Token 计数
 *  - 请求日志（JSONL 落盘 + 内存缓冲，按 retentionHours 自动过期清理）
 *
 * 零依赖，Node >= 18。启动：node gateway.mjs（或双击 start-gateway.cmd）
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = Number(process.env.PORT || config.port || 8787);
const UPSTREAM = (config.upstreamBaseUrl || '').replace(/\/+$/, '');
const UPSTREAM_KEY = config.upstreamApiKey || '';
const LOG = config.logRequests !== false;
const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const log = (...args) => LOG && console.log(new Date().toISOString().slice(11, 19), ...args);

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Anthropic 错误响应 */
function anthropicError(res, status, type, message, extraHeaders = {}) {
  const body = { type: 'error', error: { type, message } };
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': genId('req'), ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** 上游 HTTP 状态 -> Anthropic 错误类型（Claude Code 的重试逻辑按 error.type 匹配） */
function anthropicErrorTypeForStatus(status, errText = '') {
  // 上游明确说模型不存在/未接入时，按永久性错误快速失败，避免客户端按 529 退避空转
  if ((status === 503 || status === 529) && /no such model|model.{0,40}(not (found|exist|available|connected))|service info not found|no_healthy/i.test(errText)) {
    return 'invalid_request_error';
  }
  if (status === 400) return 'invalid_request_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 408 || status === 504) return 'timeout_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 503 || status === 529) return 'overloaded_error'; // 529 是 Anthropic 官方 overloaded 状态码
  return 'api_error';
}

/** 上游非 200 -> 带正确 error.type 的 Anthropic 错误（含 retry-after 透传） */
function upstreamErrorToAnthropic(res, status, errText, upstreamHeaders = {}) {
  const type = anthropicErrorTypeForStatus(status, errText);
  // 429/503/529 映射回 Anthropic 语义状态码，让客户端按官方节奏退避重试
  const outStatus = type === 'overloaded_error' ? 529 : status;
  const headers = {};
  if (type === 'rate_limit_error' || type === 'overloaded_error') {
    headers['retry-after'] = upstreamHeaders['retry-after'] || '5';
  }
  log(`[upstream ${status}] -> ${type} ${errText.slice(0, 200)}`);
  return anthropicError(res, outStatus, type, `upstream ${status}: ${errText.slice(0, 500)}`, headers);
}

/** 读取并丢弃响应体，返回文本（用于错误信息提取） */
function drainBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 带重试的上游调用（LiteLLM 同款策略）：429/5xx/网络错误指数退避重试，
 * 尊重上游 retry-after 头；"模型不存在"类永久错误不重试快速失败。
 * 只在向客户端写出任何字节之前使用。
 */
async function callUpstreamWithRetry(openaiBody) {
  const retries = Number.isFinite(config.upstreamRetries) ? config.upstreamRetries : 2;
  let last = { resp: null, errText: 'upstream unreachable', headers: {} };
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp = null;
    try {
      resp = await upstreamRequest('POST', `${UPSTREAM}/chat/completions`, openaiBody);
    } catch (e) {
      last = { resp: null, errText: e.message, headers: {} };
    }
    if (resp) {
      if (resp.statusCode === 200) return { resp, errText: '', headers: resp.headers };
      const errText = await drainBody(resp);
      last = { resp, errText, headers: resp.headers };
      const transient = [429, 500, 502, 503, 504, 529].includes(resp.statusCode);
      const permanentModelErr = [503, 529].includes(resp.statusCode)
        && anthropicErrorTypeForStatus(resp.statusCode, errText) === 'invalid_request_error';
      if (!transient || permanentModelErr || attempt === retries) return last;
    } else if (attempt === retries) {
      return last;
    }
    const ra = parseInt(last.headers?.['retry-after'], 10);
    const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 15) * 1000 : Math.min(1000 * 2 ** attempt, 8000);
    log(`[retry] upstream 失败（${last.resp?.statusCode ?? last.errText}），${delay}ms 后重试`);
    await new Promise((r) => setTimeout(r, delay));
  }
  return last;
}

/** 流式过程中上游失败 -> Anthropic SSE error 事件（客户端 SDK 据此触发重试，magpie 同款） */
function emitStreamError(res, status, errText, headers = {}) {
  const type = status ? anthropicErrorTypeForStatus(status, errText || '') : 'api_error';
  const message = `upstream ${status || 'unreachable'}: ${(errText || '').slice(0, 300)}`.trim();
  log(`[stream-error] ${type}: ${message.slice(0, 150)}`);
  noteStats(res, { status: status || 502, error: (errText || 'upstream unreachable').slice(0, 200) });
  const ra = headers?.['retry-after'];
  res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message, ...(ra ? { 'retry-after': ra } : {}) } })}\n\n`);
  res.end();
}

/** 粗略 token 估算（给 count_tokens / usage 兜底） */
const estimateTokens = (text) => Math.ceil((text || '').length / 3.5);

/** 安全解析工具参数 JSON */
function safeJsonParse(s) {
  if (!s || typeof s !== 'string') return {};
  try { return JSON.parse(s); } catch { /* 尝试单引号修复 */ }
  try { return JSON.parse(s.replace(/'/g, '"')); } catch { return {}; }
}

/** 模型名解析：别名 -> 精确映射；haiku/sonnet/opus -> small/default/big；claude-* 兜底 default */
let lastResolveExplicit = false; // 最近一次 resolveModel 是否命中了显式选择的真实模型（非 Claude 别名）
function resolveModel(requested) {
  const m = config.models || {};
  const aliases = config.modelAliases || {};
  lastResolveExplicit = false;
  let target = null;
  const bare = requested ? String(requested).replace(/\[1m\]$/i, '') : requested; // [1m] 只是客户端的长上下文标记，路由用去后缀 id
  if (requested && aliases[requested]) target = aliases[requested];
  else if (requested && aliases[bare]) target = aliases[bare];
  else if (!requested) target = m.default;
  else {
    let req = bare.replace(/^anthropic\//i, '');
    const ids = upstreamModelCache.ids;
    if (ids.length) {
      if (ids.includes(req)) { target = req; lastResolveExplicit = true; }
      else {
        const mag = req.match(/^magpie-(\d{10})$/i); // 桌面端别名 anthropic/magpie-<hash>
        if (mag) {
          const hit = ids.find((id) => aliasNumber(id) === mag[1]);
          if (hit) { target = hit; lastResolveExplicit = true; }
        } else {
          const hit = ids.find(
            (id) => slugForModel(id) === req.toLowerCase() || id.replace(/^[^:]*:/, '') === req
          );
          if (hit) { target = hit; lastResolveExplicit = true; }
        }
      }
    }
  }
  if (!target) {
    if (/haiku/i.test(requested)) target = m.small || m.default;
    else if (/opus/i.test(requested)) target = m.big || m.default;
    else if (/sonnet/i.test(requested)) target = m.default;
    else if (/^claude/i.test(requested)) target = m.default;
  }
  return target || requested;
}

/** thinking 请求参数 -> 注入到 OpenAI 请求体的附加字段 */
function applyThinking(openaiBody, thinking, explicitModel = false) {
  const t = config.thinking || {};
  const enabled = thinking && thinking.type === 'enabled';
  if (enabled) {
    const budget = Number(thinking.budget_tokens) || 0;
    if (t.strategy === 'drop') { /* 不下发，让后端默认 */ }
    else if (t.strategy === 'custom' && t.enabledBody) {
      Object.assign(openaiBody, structuredClone(t.enabledBody));
    } else { // reasoning_effort 分档
      const tiers = t.tiers || [{ body: { reasoning_effort: 'high' } }];
      const tier = tiers.find((x) => !x.maxBudgetTokens || budget <= x.maxBudgetTokens) || tiers[tiers.length - 1];
      Object.assign(openaiBody, structuredClone(tier.body || {}));
    }
    // think 模型路由：仅在客户端用通用别名（未显式选真实模型）时生效；
    // 用户显式选了某个上游模型（如 Step 5 preview）就不覆盖，配置 thinkModel:"always" 可强制
    const overrideAllowed = !(explicitModel && t.thinkModel !== 'always');
    if (t.thinkModel !== false && config.models.think && overrideAllowed) {
      openaiBody.model = config.models.think; // thinking 请求优先路由到推理模型
    }
    if (t.dropTemperatureWhenThinking) {
      delete openaiBody.temperature;
      delete openaiBody.top_p;
      delete openaiBody.top_k;
    }
  } else if (thinking && thinking.type === 'disabled' && t.disabledBody && Object.keys(t.disabledBody).length) {
    // 混合推理模型（如 Qwen3）需要显式关闭，否则默认烧推理
    Object.assign(openaiBody, structuredClone(t.disabledBody));
  }
  return openaiBody;
}

// ---------------------------------------------------------------------------
// 请求转换：Anthropic -> OpenAI
// ---------------------------------------------------------------------------

/**
 * 转换 tools。Anthropic 服务端工具（web_search_*）按 magpie 方案在网关内部实现：
 * 注入同名 OpenAI function 工具，模型调用时网关自己执行搜索并把结果以
 * server_tool_use / web_search_tool_result 块回给客户端（见 handleMessages 的内部循环）。
 */
function convertTools(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) {
    return { tools: null, webSearch: null };
  }
  const out = [];
  let webSearch = null;
  for (const t of anthropicTools) {
    if (t.type && String(t.type).startsWith('web_search')) {
      if (config.webSearch?.enabled === false) { log('[tools] web_search 已在配置中禁用，剥离'); continue; }
      webSearch = { maxUses: Math.min(Number(t.max_uses) || 5, 10) };
      continue;
    }
    if (t.type && t.type !== 'custom') {
      // 其它服务端工具（code_execution 等）暂不支持，剥离
      log(`[tools] 剥离服务端工具: ${t.type}`);
      continue;
    }
    if (!t.input_schema) continue;
    out.push({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    });
  }
  if (webSearch) {
    out.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information. Returns a list of pages with title, url and snippet.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
    });
  }
  return { tools: out.length ? out : null, webSearch };
}

function convertToolChoice(tc) {
  if (!tc) return { choice: undefined, parallel: undefined };
  let choice;
  let disableParallel = false;
  if (typeof tc === 'object' && tc.disable_parallel_tool_use) disableParallel = true;
  if (tc === 'auto' || (typeof tc === 'object' && tc.type === 'auto')) choice = 'auto';
  else if (tc === 'any') choice = 'required';
  else if (tc === 'none') choice = 'none';
  else if (typeof tc === 'object' && tc.type === 'tool' && tc.name) {
    choice = { type: 'function', function: { name: tc.name } };
  }
  return { choice, parallel: disableParallel ? false : undefined };
}

/** 提取 tool_result 的文本内容 */
function toolResultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  }
  return c == null ? '' : String(c);
}

/** 图片 block -> OpenAI image_url part */
function imagePart(block) {
  const src = block.source || {};
  let url = '';
  if (src.type === 'base64') url = `data:${src.media_type};base64,${src.data}`;
  else if (src.type === 'url') url = src.url;
  return { type: 'image_url', image_url: { url } };
}

/**
 * 转换 messages。关键规则：
 *  - assistant 的 tool_use block -> tool_calls
 *  - user 的 tool_result block -> 独立的 role:"tool" 消息，且必须紧跟对应 assistant 消息
 *  - user 消息里 tool_result 与文本并存时：先发 tool 消息，再发 user 文本消息
 *  - 孤儿 tool_calls / tool 消息做兜底清洗（部分后端严格校验会 400）
 */
function convertMessages(anthropicBody) {
  const out = [];
  const sys = anthropicBody.system;
  if (sys) {
    const text = typeof sys === 'string'
      ? sys
      : (Array.isArray(sys) ? sys.map((b) => b?.text || '').join('\n') : String(sys));
    if (text.trim()) out.push({ role: 'system', content: text });
  }

  for (const msg of anthropicBody.messages || []) {
    const { role } = msg;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const toolResults = [];
    const toolCalls = [];
    const textParts = [];
    const images = [];

    for (const b of msg.content) {
      if (!b || typeof b !== 'object') { textParts.push({ type: 'text', text: String(b) }); continue; }
      if (b.type === 'tool_result') {
        toolResults.push({ tool_call_id: b.tool_use_id || '', content: toolResultText(b), is_error: !!b.is_error });
        // tool_result 内嵌图片（桌面端截图反馈流程）：单独转成带 image_url 的 user 消息
        if (Array.isArray(b.content)) {
          for (const p of b.content) {
            if (p && typeof p === 'object' && p.type === 'image') images.push(imagePart(p));
          }
        }
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id || genId('call'),
          type: 'function',
          function: { name: b.name || '', arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'server_tool_use') {
        // 推理块 / 网关服务端工具调用不回传（OpenAI 协议不接受），跳过
      } else if (b.type === 'web_search_tool_result') {
        // 网关自己做的搜索：把标题/URL 保留为文本，模型跨轮仍有上下文
        const lines = (Array.isArray(b.content) ? b.content : [])
          .filter((r) => r?.type === 'web_search_result')
          .map((r) => `- ${r.title || ''} ${r.url || ''}`.trim());
        if (lines.length) {
          textParts.push({ type: 'text', text: `[web search results]\n${lines.join('\n')}`.slice(0, 2000) });
        }
      } else if (b.type === 'image') {
        textParts.push(imagePart(b));
      } else if (b.type === 'document') {
        // PDF 等文档块：OpenAI chat 协议无标准对应，降级为占位文本（至少不 400）
        log('[blocks] document 块降级为占位文本');
        textParts.push({ type: 'text', text: '[document attachment omitted]' });
      } else if (b.type === 'text') {
        if (b.text) textParts.push({ type: 'text', text: b.text });
      } else {
        log(`[blocks] 忽略未知块类型: ${b.type}`);
      }
    }

    if (role === 'assistant') {
      const m = { role: 'assistant', content: textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : (textParts.length ? textParts : null) };
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (m.content !== null || m.tool_calls) out.push(m);
    } else {
      // user：先 tool_result（必须紧跟 assistant 的 tool_calls），再文本，再图片
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: (tr.is_error ? '[ERROR] ' : '') + tr.content });
      }
      if (textParts.length) {
        out.push({
          role: 'user',
          content: textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : textParts,
        });
      } else if (!toolResults.length) {
        out.push({ role: 'user', content: '' });
      }
      if (images.length) out.push({ role: 'user', content: images });
    }
  }
  return sanitizeToolSequence(out);
}

/** 清洗孤儿 tool_calls / tool 消息（很多 OpenAI 兼容后端严格校验顺序） */
function sanitizeToolSequence(messages) {
  // 先收集所有被 tool 消息引用的 tool_call_id
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const issued = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const complete = m.tool_calls.filter((c) => answered.has(c.id));
      if (complete.length) {
        m.tool_calls = complete;
        complete.forEach((c) => issued.add(c.id));
      } else {
        delete m.tool_calls; // 孤儿 tool_calls：去掉，保留文本
      }
      if (m.content === null && !m.tool_calls) m.content = '';
    }
  }
  return messages.filter((m) => m.role !== 'tool' || issued.has(m.tool_call_id));
}

/** 构造发往上游的 OpenAI 请求体 */
function buildOpenAIRequestBody(anthropicBody) {
  const wantThink = !!(anthropicBody.thinking && anthropicBody.thinking.type === 'enabled');
  const body = {
    model: resolveModel(anthropicBody.model),
    messages: convertMessages(anthropicBody),
    stream: !!anthropicBody.stream,
    max_tokens: Math.min(anthropicBody.max_tokens || 4096, config.maxTokensLimit || 32768),
  };
  if (anthropicBody.temperature !== undefined) body.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p !== undefined) body.top_p = anthropicBody.top_p;
  if (anthropicBody.stop_sequences?.length) body.stop = anthropicBody.stop_sequences;

  const { tools, webSearch } = convertTools(anthropicBody.tools);
  if (tools) {
    body.tools = tools;
    const { choice, parallel } = convertToolChoice(anthropicBody.tool_choice);
    if (choice) body.tool_choice = choice;
    if (parallel === false) body.parallel_tool_calls = false;
  }
  if (anthropicBody.stream && config.sendStreamOptions) body.stream_options = { include_usage: true };
  if (wantThink && anthropicBody.max_tokens) {
    // 预留推理预算：部分后端要求 max_tokens 覆盖 reasoning 输出
    body.max_tokens = Math.min((config.maxTokensLimit || 32768), Math.max(body.max_tokens, (anthropicBody.thinking.budget_tokens || 0) + 4096));
  }
  applyThinking(body, anthropicBody.thinking, lastResolveExplicit);
  return { body, webSearch };
}

// ---------------------------------------------------------------------------
// 响应转换（非流式）：OpenAI -> Anthropic
// ---------------------------------------------------------------------------

const FINISH_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };

/** 解析 content 中的 <think>...</think> 内联思考 */
function splitInlineThink(text) {
  const m = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/);
  if (!m) return { thinking: null, text };
  return { thinking: m[1], text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

function convertUsage(usage) {
  const u = usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? (u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : 0);
  return {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached ?? 0,
  };
}

function convertResponse(openaiResp, originalModel, { hideInternalTools = false } = {}) {
  const choice = openaiResp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  // 1) reasoning_content -> thinking block（生成 signature，Claude Code 显示思考必需）
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: genId('sig') });

  // 2) 文本（含内联 <think>）
  let text = typeof msg.content === 'string' ? msg.content : '';
  if (text) {
    const split = splitInlineThink(text);
    if (split.thinking) content.push({ type: 'thinking', thinking: split.thinking, signature: genId('sig') });
    if (split.text) content.push({ type: 'text', text: split.text });
  }

  // 3) tool_calls -> tool_use blocks（网关内部工具 web_search 不下发给客户端）
  let sawTool = false;
  for (const tc of msg.tool_calls || []) {
    if (hideInternalTools && tc.function?.name === 'web_search') continue;
    sawTool = true;
    content.push({
      type: 'tool_use',
      id: tc.id || genId('call'),
      name: tc.function?.name || '',
      input: safeJsonParse(tc.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model: originalModel || openaiResp.model,
    content,
    stop_reason: sawTool ? 'tool_use' : (FINISH_MAP[choice.finish_reason] || 'end_turn'),
    stop_sequence: null,
    usage: convertUsage(openaiResp.usage),
  };
}

// ---------------------------------------------------------------------------
// 流式转换：OpenAI SSE -> Anthropic SSE（状态机）
// ---------------------------------------------------------------------------

const TAGS_OPEN = ['<think>', '<thinking>'];
const TAGS_CLOSE = ['</think>', '</thinking>'];
const couldBeTag = (buf, tags) => tags.some((t) => t.startsWith(buf) || buf.startsWith(t));

class StreamConverter {
  constructor(originalModel, controller, encoder) {
    this.originalModel = originalModel;
    this.controller = controller;
    this.enc = encoder;
    this.started = false;
    this.finished = false;
    this.paused = false; // 暂停等待网关执行内部 web_search，随后同流继续
    this.pendingSearches = null; // [{id, query}]
    this.sawToolCall = false;
    this.sawInternalSearch = false;
    this.blockIndex = 0;
    this.openBlock = null; // 'text' | 'thinking' | 'tool'
    this.pendingThinking = ''; // 推理缓冲：避免与文本逐 chunk 交替开关 block（撕裂显示）
    this.thinkMode = null; // null | 'tag' | 'reasoning'
    this.buf = ''; // 标签扫描缓冲
    this.toolCalls = new Map(); // openai index -> {id, name, args, block, internal}
    this.usageAcc = { prompt: 0, cached: 0, completion: 0 }; // 跨内部轮次累计
    this.lastFinishReason = null;
    this.roundText = ''; // 当前内部轮次的文本（续轮时作为 assistant 消息回传上游）
    this.outputChars = 0;
  }

  addUsage(u) {
    if (!u) return;
    this.usageAcc.prompt += u.prompt_tokens ?? 0;
    this.usageAcc.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
    this.usageAcc.completion += u.completion_tokens ?? 0;
  }

  emit(type, data) {
    this.controller.write(this.enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  messageStart() {
    this.started = true;
    this.emit('message_start', {
      type: 'message_start',
      message: {
        id: genId('msg'), type: 'message', role: 'assistant', model: this.originalModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: {
          input_tokens: this.usageAcc.prompt, output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: this.usageAcc.cached,
        },
      },
    });
  }

  openBlockOfType(kind, init = {}) {
    if (this.openBlock) this.closeCurrentBlock();
    this.openBlock = { kind, index: this.blockIndex, ...init };
    this.emit('content_block_start', { type: 'content_block_start', index: this.blockIndex, content_block: init.decl });
    this.emit('ping', { type: 'ping' });
    this.blockIndex += 1;
  }

  delta(payload) {
    if (!this.openBlock) return;
    this.emit('content_block_delta', { type: 'content_block_delta', index: this.openBlock.index, delta: payload });
  }

  closeCurrentBlock() {
    if (!this.openBlock) return;
    const b = this.openBlock;
    if (b.kind === 'thinking') {
      this.emit('content_block_delta', {
        type: 'content_block_delta', index: b.index,
        delta: { type: 'signature_delta', signature: genId('sig') },
      });
    }
    this.emit('content_block_stop', { type: 'content_block_stop', index: b.index });
    this.openBlock = null;
  }

  /** 推理增量 -> 缓冲；在文本开始前 / 工具调用前 / 收尾时由 flushThinking 统一落盘 */
  feedThinking(s) {
    if (!s) return;
    this.outputChars += s.length;
    this.pendingThinking += s;
  }

  /** 把缓冲的推理落盘为一个完整 thinking block（在打开的 text block 之前） */
  flushThinking() {
    if (!this.pendingThinking) return;
    const s = this.pendingThinking;
    this.pendingThinking = '';
    if (this.openBlock && this.openBlock.kind !== 'thinking') this.closeCurrentBlock();
    this.openBlockOfType('thinking', { decl: { type: 'thinking', thinking: '' } });
    this.delta({ type: 'thinking_delta', thinking: s });
    this.closeCurrentBlock();
  }

  /** 普通文本 -> 标签扫描 -> text delta */
  feedText(s) {
    this.buf += s;
    for (;;) {
      if (this.thinkMode === 'tag') {
        // 找闭合标签
        let closeIdx = -1, closeTag = null;
        for (const t of TAGS_CLOSE) {
          const i = this.buf.indexOf(t);
          if (i !== -1 && (closeIdx === -1 || i < closeIdx)) { closeIdx = i; closeTag = t; }
        }
        if (closeIdx !== -1) {
          this.feedThinking(this.buf.slice(0, closeIdx));
          this.thinkMode = null;
          this.buf = this.buf.slice(closeIdx + closeTag.length);
          continue;
        }
        // 可能是闭合标签前缀：保留尾部等待更多数据
        const safeLen = this.safeCut(this.buf, TAGS_CLOSE);
        if (safeLen > 0) { this.feedThinking(this.buf.slice(0, safeLen)); this.buf = this.buf.slice(safeLen); }
        return;
      }

      // 普通文本模式：找开放标签
      let openIdx = -1, openTag = null;
      for (const t of TAGS_OPEN) {
        const i = this.buf.indexOf(t);
        if (i !== -1 && (openIdx === -1 || i < openIdx)) { openIdx = i; openTag = t; }
      }
      if (openIdx !== -1) {
        if (openIdx > 0) this.emitTextDelta(this.buf.slice(0, openIdx));
        this.buf = this.buf.slice(openIdx + openTag.length);
        this.thinkMode = 'tag';
        continue;
      }
      // 无完整标签。先吐出不含 '<' 的前缀，再判断残留是否可能是标签前缀
      const lt = this.buf.indexOf('<');
      if (lt === -1) { this.emitTextDelta(this.buf); this.buf = ''; return; }
      if (lt > 0) { this.emitTextDelta(this.buf.slice(0, lt)); this.buf = this.buf.slice(lt); }
      // buf 以 '<' 开头
      if (couldBeTag(this.buf, TAGS_OPEN)) return; // 等更多数据
      this.emitTextDelta('<'); // 不是标签，'<' 按字面输出
      this.buf = this.buf.slice(1);
    }
  }

  /** 返回可安全输出的长度（保留可能是标签前缀的尾巴） */
  safeCut(buf, tags) {
    let cut = buf.length;
    for (const t of tags) {
      for (let k = 1; k <= t.length && k <= buf.length; k++) {
        if (t.startsWith(buf.slice(buf.length - k))) cut = Math.min(cut, buf.length - k);
      }
    }
    return cut;
  }

  emitTextDelta(s) {
    if (!s) return;
    if (!this.openBlock || this.openBlock.kind !== 'text') {
      this.flushThinking(); // 推理在文本之前：先落盘 thinking block 再开文本
      this.openBlockOfType('text', { decl: { type: 'text', text: '' } });
    }
    this.outputChars += s.length;
    this.roundText += s;
    this.delta({ type: 'text_delta', text: s });
  }

  /** 工具调用 delta（web_search 是网关内部工具：收集参数，不向客户端开 tool_use 块） */
  feedToolCalls(toolCalls) {
    for (const tc of toolCalls) {
      const idx = tc.index ?? 0;
      let entry = this.toolCalls.get(idx);
      if (!entry) {
        const id = tc.id || genId('call');
        const name = tc.function?.name || '';
        const internal = name === 'web_search';
        entry = { id, name, args: '', block: -1, internal };
        this.toolCalls.set(idx, entry);
        if (internal) {
          this.sawInternalSearch = true;
        } else {
          this.flushThinking(); // 文本/推理段结束后再开工具块，保持事件顺序合法
          this.openBlockOfType('tool', { decl: { type: 'tool_use', id, name, input: {} } });
          this.sawToolCall = true;
        }
      } else if (tc.id && tc.function?.name && entry.name.startsWith('tool_')) {
        entry.id = tc.id; entry.name = tc.function.name;
      }
      const args = tc.function?.arguments;
      if (args) {
        entry.args += args;
        this.outputChars += args.length;
        if (!entry.internal) this.delta({ type: 'input_json_delta', partial_json: args });
      }
    }
  }

  /** 处理一个上游 OpenAI chunk */
  processChunk(chunk) {
    if (!this.started) this.messageStart();
    if (chunk.usage) this.addUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.reasoning_content != null && delta.reasoning_content !== '') {
      this.thinkMode = 'reasoning';
      this.feedThinking(delta.reasoning_content);
    }
    if (delta.reasoning != null && delta.reasoning !== '') {
      this.feedThinking(delta.reasoning);
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.feedText(delta.content);
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      this.feedToolCalls(delta.tool_calls);
    }
    if (choice.finish_reason) this.lastFinishReason = choice.finish_reason;
  }

  /**
   * 内部 web_search 暂停点：模型只调用了网关内部工具。
   * 收尾当前轮（不发 message_delta/stop），把搜索调用交给外层循环执行后续轮。
   */
  pauseForSearch() {
    // 冲刷标签缓冲
    if (this.thinkMode === 'tag' && this.buf) { this.feedThinking(this.buf); this.buf = ''; }
    else if (this.buf) { this.emitTextDelta(this.buf); this.buf = ''; }
    this.flushThinking();
    this.closeCurrentBlock();
    const internal = [...this.toolCalls.values()].filter((e) => e.internal);
    this.pendingSearches = internal.map((e) => ({ id: e.id, query: safeJsonParse(e.args).query || e.args }));
    this.paused = true;
    log(`[web_search] 模型发起 ${this.pendingSearches.length} 次搜索: ${this.pendingSearches.map((s) => JSON.stringify(s.query)).join(', ').slice(0, 200)}`);
  }

  /** 把搜索结果以 server_tool_use / web_search_tool_result 块写入客户端流（magpie 同款结构） */
  emitSearchBlocks(id, query, hits) {
    this.closeCurrentBlock();
    this.emit('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} },
    });
    this.emit('content_block_delta', {
      type: 'content_block_delta', index: this.blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
    });
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
    this.blockIndex += 1;
    this.emit('content_block_start', {
      type: 'content_block_start', index: this.blockIndex,
      content_block: {
        type: 'web_search_tool_result', tool_use_id: id,
        content: hits.map((h) => ({ type: 'web_search_result', title: h.title || '', url: h.url || '', encrypted_content: '', page_age: h.pageAge ?? null })),
      },
    });
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
    this.blockIndex += 1;
  }

  /** 上游结束 / 出错时兜底收尾 */
  finalize(finishReason = 'stop') {
    if (this.finished) return;
    this.finished = true;
    if (!this.started) this.messageStart();
    // 冲刷标签缓冲
    if (this.thinkMode === 'tag' && this.buf) { this.feedThinking(this.buf); this.buf = ''; }
    else if (this.buf) { this.emitTextDelta(this.buf); this.buf = ''; }
    this.flushThinking(); // 落盘缓冲的推理（若有）
    this.closeCurrentBlock();
    if (this.blockIndex === 0) {
      // 空响应兜底：给一个空 text block
      this.openBlockOfType('text', { decl: { type: 'text', text: '' } });
      this.closeCurrentBlock();
    }
    const stopReason = this.sawToolCall ? 'tool_use' : (FINISH_MAP[finishReason] || 'end_turn');
    const outTokens = this.usageAcc.completion || estimateTokens(String(this.outputChars));
    noteStats(this.controller, { status: 200, usage: { in: this.usageAcc.prompt, out: outTokens, cached: this.usageAcc.cached } });
    this.emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: this.usageAcc.prompt,
        output_tokens: outTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: this.usageAcc.cached,
      },
    });
    this.emit('message_stop', { type: 'message_stop' });
    log(`[stream] 完成 stop_reason=${stopReason} usage=(${this.usageAcc.prompt}/${outTokens})`);
  }
}

// ---------------------------------------------------------------------------
// 上游调用（node:http 直连；若存在 HTTP_PROXY 环境变量则走标准正向代理）
// ---------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';

function upstreamRequest(method, urlStr, bodyObj) {
  const target = new URL(urlStr);
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
  const headers = {
    authorization: `Bearer ${UPSTREAM_KEY}`,
    'content-type': 'application/json',
    ...(bodyStr ? { 'content-length': Buffer.byteLength(bodyStr) } : {}),
  };
  const opts = proxy
    ? (() => { const p = new URL(proxy); return { host: p.hostname, port: p.port || 80, path: target.href, headers: { ...headers, host: target.host } }; })()
    : { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, headers };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ method, ...opts }, (res) => resolve(res));
    req.setTimeout((config.requestTimeoutSeconds || 300) * 1000, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** 收集完整 JSON 响应 */
function readJsonResponse(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error(`invalid upstream JSON: ${e.message}`)); }
    });
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 网关服务端 web_search（照搬 magpie internal/gateway 的思路，搜索源 best-effort）
// ---------------------------------------------------------------------------

const proxyEnv = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';

/** 经 HTTP 代理建立 CONNECT 隧道，返回 TLS socket */
function connectTunneled(host, port) {
  const proxy = new URL(proxyEnv());
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      const onData = (buf) => {
        if (!/^HTTP\/1\.[01] 200/.test(buf.toString('utf8'))) {
          socket.destroy();
          return reject(new Error('proxy CONNECT failed'));
        }
        socket.removeListener('data', onData);
        const tlsSock = tls.connect({ socket, servername: host }, () => resolve(tlsSock));
        tlsSock.once('error', reject);
      };
      socket.on('data', onData);
    });
  });
}

/** 外部 HTTP(S) GET：https 直连；有代理环境变量时走 CONNECT 隧道；跟随最多 3 次 30x 重定向 */
async function extRequest(urlStr, headers = {}, hop = 0) {
  const target = new URL(urlStr);
  const isHttps = target.protocol === 'https:';
  const proxy = proxyEnv();
  const base = {
    method: 'GET',
    host: target.hostname,
    port: Number(target.port) || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...headers,
    },
  };
  const resp = await new Promise(async (resolve, reject) => {
    try {
      let createConnection;
      if (isHttps && proxy) {
        const sock = await connectTunneled(target.hostname, Number(target.port) || 443);
        createConnection = () => sock;
      }
      const lib = isHttps ? https : http;
      const req = createConnection ? lib.request({ ...base, createConnection }, resolve) : lib.request(base, resolve);
      req.setTimeout(15000, () => req.destroy(new Error('search request timeout')));
      req.on('error', reject);
      req.end();
    } catch (e) { reject(e); }
  });
  if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && hop < 3) {
    resp.resume(); // 丢弃重定向响应体
    const next = new URL(resp.headers.location, target).href;
    return extRequest(next, headers, hop + 1);
  }
  return resp;
}

const stripTags = (s) => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function bingSearch(query) {
  // cn.bing.com 国内可达；www.bing.com 海外/跳转后同源
  let html;
  try {
    const r = await extRequest(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=8&mkt=zh-CN`);
    html = await drainBody(r);
  } catch {
    const r2 = await extRequest(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=8&mkt=zh-CN`);
    html = await drainBody(r2);
  }
  const hits = [];
  const re = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<h2|$)/g;
  let m;
  while ((m = re.exec(html)) && hits.length < 6) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (!title || !/^https?:/i.test(url)) continue;
    const snipM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    hits.push({ title, url, snippet: snipM ? stripTags(snipM[1]).slice(0, 300) : '' });
  }
  if (!hits.length) throw new Error('bing: no results parsed');
  return hits;
}

async function duckduckgoSearch(query) {
  const r = await extRequest(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const html = await drainBody(r);
  const hits = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && hits.length < 6) {
    let url = m[1];
    const uM = url.match(/[?&]uddg=([^&]+)/);
    if (uM) url = decodeURIComponent(uM[1]);
    if (!/^https?:/i.test(url)) continue;
    hits.push({ title: stripTags(m[2]), url, snippet: '' });
  }
  if (!hits.length) throw new Error('ddg: no results parsed');
  return hits;
}

/** 依次尝试各搜索源，全失败返回 error（模型会看到失败说明） */
async function doWebSearch(query) {
  for (const fn of [bingSearch, duckduckgoSearch]) {
    try {
      const hits = await fn(query);
      log(`[web_search] "${String(query).slice(0, 80)}" -> ${hits.length} 条 (${fn.name})`);
      return { hits };
    } catch (e) {
      log(`[web_search] ${fn.name} 失败: ${e.message}`);
    }
  }
  return { hits: [], error: 'all search providers failed' };
}

/** 搜索结果 -> 回传给模型的文本（模型需要 snippet 内容） */
function hitsForModel(hits) {
  return JSON.stringify(hits.length ? hits : { error: 'search failed' }).slice(0, 4000);
}

// ---------------------------------------------------------------------------
// 请求日志与用量统计（WebUI 数据源）：内存缓冲 + 按天 JSONL 落盘 + 自动过期
// ---------------------------------------------------------------------------

const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_RETENTION_HOURS = Math.max(1, Number(config.logs?.retentionHours ?? 24));
const LOG_MEM_MAX = Math.max(50, Number(config.logs?.maxMemoryEntries ?? 500));
const logMem = [];
const reqMeta = new WeakMap(); // res -> 本次请求统计上下文（流式/并发安全）

/** 在 handleMessages 内部回填请求元数据（按 res 定位，避免全局变量在并发流式下串号） */
function noteStats(res, patch) {
  const s = reqMeta.get(res);
  if (s) Object.assign(s, patch);
}

/** 请求结束（连接关闭）时落一条日志 */
function trackRequest(req, res, route) {
  const t0 = Date.now();
  reqMeta.set(res, { route, ts: t0 });
  res.on('close', () => {
    const s = reqMeta.get(res);
    if (!s || s.recorded) return;
    s.recorded = true;
    s.status ??= res.statusCode;
    if (res.statusCode >= 400 && !s.error) s.error = `http ${res.statusCode}`;
    s.durationMs = Date.now() - t0;
    recordRequest(s);
  });
}

function recordRequest(entry) {
  entry.ts = Date.now();
  logMem.push(entry);
  if (logMem.length > LOG_MEM_MAX) logMem.shift();
  const day = new Date(entry.ts).toISOString().slice(0, 10);
  fs.mkdir(LOGS_DIR, { recursive: true }, () => {
    fs.appendFile(path.join(LOGS_DIR, `req-${day}.jsonl`), JSON.stringify(entry) + '\n', () => {});
  });
}

/** 过期清理：内存按时间戳截断，磁盘按文件名日期删除（每次启动 + 每 15 分钟） */
function pruneOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_HOURS * 3600_000;
  while (logMem.length && logMem[0].ts < cutoff) logMem.shift();
  fs.readdir(LOGS_DIR, (err, files) => {
    if (err) return;
    for (const f of files) {
      const m = f.match(/^req-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00Z`) + 86_400_000 < cutoff) {
        fs.unlink(path.join(LOGS_DIR, f), () => {});
      }
    }
  });
}

/** 读取保留窗口内的全部日志（磁盘为准，重启不丢统计） */
function readLogEntries() {
  return new Promise((resolve) => {
    fs.readdir(LOGS_DIR, (err, files) => {
      if (err) return resolve([]);
      const jobs = files.filter((f) => /^req-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => new Promise((done) => {
        fs.readFile(path.join(LOGS_DIR, f), 'utf8', (e, txt) => {
          if (e) return done([]);
          const out = [];
          for (const line of txt.split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
          }
          done(out);
        });
      }));
      Promise.all(jobs).then((arrs) => resolve(arrs.flat()));
    });
  });
}

function emptyAgg() {
  return { requests: 0, input: 0, output: 0, cached: 0, errors: 0, searches: 0 };
}

/** 聚合：today（本地日）+ 窗口内总计 + 按模型 + 按天序列 */
function aggregateStats(entries) {
  const cutoff = Date.now() - LOG_RETENTION_HOURS * 3600_000;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const today = emptyAgg();
  const total = emptyAgg();
  const byModel = new Map();
  const daily = new Map();
  for (const e of entries) {
    if (typeof e.ts !== 'number' || e.ts < cutoff) continue;
    const u = e.usage || {};
    const inTok = u.in || 0, outTok = u.out || 0, cached = u.cached || 0;
    const err = e.status && e.status >= 400 ? 1 : 0;
    const searches = e.searches || 0;
    total.requests++; total.input += inTok; total.output += outTok;
    total.cached += cached; total.errors += err; total.searches += searches;
    if (e.ts >= todayStart) {
      today.requests++; today.input += inTok; today.output += outTok;
      today.cached += cached; today.errors += err; today.searches += searches;
    }
    const mk = e.resolved || e.model || 'unknown';
    const m = byModel.get(mk) || emptyAgg();
    m.requests++; m.input += inTok; m.output += outTok; m.cached += cached; m.errors += err;
    byModel.set(mk, m);
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const d = daily.get(day) || emptyAgg();
    d.requests++; d.input += inTok; d.output += outTok; d.errors += err;
    daily.set(day, d);
  }
  return {
    today, total,
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.input + b.output - (a.input + a.output)),
    daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-14),
  };
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

function checkAuth(req, res) {
  const need = config.gatewayApiKey;
  if (!need) return true;
  const provided = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided === need) return true;
  anthropicError(res, 401, 'authentication_error', 'invalid x-api-key');
  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleMessages(req, res, urlObj) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch { return anthropicError(res, 400, 'invalid_request_error', 'invalid JSON body'); }
  if (!body.model || !Array.isArray(body.messages) || !body.messages.length) {
    return anthropicError(res, 400, 'invalid_request_error', 'model and non-empty messages are required');
  }

  const { body: baseBody, webSearch } = buildOpenAIRequestBody(body);
  const maxRounds = webSearch ? (webSearch.maxUses || 5) : 0; // 内部 web_search 最大轮数
  const beta = req.headers['anthropic-beta'];
  if (beta) log(`[beta] ${beta}`); // 只记录不拒绝：anthropic-beta 是逗号分隔的动态特性列表
  log(`[${body.model} -> ${baseBody.model}] stream=${baseBody.stream} tools=${baseBody.tools?.length || 0} msgs=${baseBody.messages.length}${body.thinking?.type === 'enabled' ? ` thinking(${body.thinking.budget_tokens || ''})` : ''}${webSearch ? ' web_search' : ''}`);
  noteStats(res, {
    model: body.model, resolved: baseBody.model, stream: !!baseBody.stream,
    msgs: baseBody.messages.length, tools: baseBody.tools?.length || 0,
    thinking: body.thinking?.type === 'enabled' || false,
  });

  // ---------- 非流式 ----------
  if (!baseBody.stream) {
    let roundBody = baseBody;
    const extraBlocks = [];
    let sumPrompt = 0, sumCompletion = 0, sumCached = 0;
    for (let round = 0; ; round++) {
      const { resp, errText, headers } = await callUpstreamWithRetry(roundBody);
      if (!resp) { noteStats(res, { status: 502, error: errText?.slice(0, 200) }); return anthropicError(res, 502, 'api_error', `upstream request failed: ${errText}`); }
      if (resp.statusCode !== 200) { noteStats(res, { status: resp.statusCode, error: errText?.slice(0, 200) }); return upstreamErrorToAnthropic(res, resp.statusCode, errText, headers); }
      const data = await readJsonResponse(resp);
      const msg = data.choices?.[0]?.message || {};
      const toolCalls = msg.tool_calls || [];
      const searches = toolCalls.filter((tc) => tc.function?.name === 'web_search');
      const clientCalls = toolCalls.filter((tc) => tc.function?.name !== 'web_search');

      if (!searches.length || round >= maxRounds) {
        const out = convertResponse(data, body.model, { hideInternalTools: true });
        if (extraBlocks.length) out.content = [...extraBlocks, ...out.content];
        out.usage.input_tokens += sumPrompt;
        out.usage.output_tokens += sumCompletion;
        out.usage.cache_read_input_tokens += sumCached;
        if (LOG) log(`[done] stop=${out.stop_reason} usage=(${out.usage.input_tokens}/${out.usage.output_tokens}) blocks=[${out.content.map((b) => b.type).join(',')}]`);
        noteStats(res, { status: 200, usage: { in: out.usage.input_tokens, out: out.usage.output_tokens, cached: out.usage.cache_read_input_tokens } });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }

      // 执行内部搜索并续轮
      const intMsgs = [{
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function })),
      }];
      for (const tc of searches) {
        const query = safeJsonParse(tc.function?.arguments).query || String(tc.function?.arguments || '');
        const id = `srvtoolu_${genId('x')}`;
        noteStats(res, { searches: (reqMeta.get(res)?.searches || 0) + 1 });
        const { hits } = await doWebSearch(query);
        extraBlocks.push(
          { type: 'server_tool_use', id, name: 'web_search', input: { query } },
          { type: 'web_search_tool_result', tool_use_id: id, content: hits.map((h) => ({ type: 'web_search_result', title: h.title || '', url: h.url || '', encrypted_content: '' })) },
        );
        intMsgs.push({ role: 'tool', tool_call_id: tc.id || id, content: hitsForModel(hits) });
      }
      // 混合轮：模型同时调了客户端工具 -> 搜索做完就把控制权交回客户端（本轮 usage 由 convertResponse 提供）
      if (clientCalls.length) {
        const out = convertResponse(data, body.model, { hideInternalTools: true });
        out.content = [...extraBlocks, ...out.content];
        out.usage.input_tokens += sumPrompt;
        out.usage.output_tokens += sumCompletion;
        out.usage.cache_read_input_tokens += sumCached;
        noteStats(res, { status: 200, usage: { in: out.usage.input_tokens, out: out.usage.output_tokens, cached: out.usage.cache_read_input_tokens } });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      sumPrompt += data.usage?.prompt_tokens ?? 0;
      sumCompletion += data.usage?.completion_tokens ?? 0;
      sumCached += data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      roundBody = { ...roundBody, messages: [...roundBody.messages, ...intMsgs] };
    }
  }

  // ---------- 流式 ----------
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': genId('req'),
  });
  res.socket?.setNoDelay(true); // 关闭 Nagle，SSE 逐块即发，避免 Claude Code 感知延迟
  res.write(`event: ping\ndata: {"type":"ping"}\n\n`); // 首块保活（上游首 token 可能要等很久）
  const enc = new TextEncoder();
  const conv = new StreamConverter(body.model, res, enc);
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    if (!conv.finished) noteStats(res, { status: 499, error: 'client aborted' });
  });

  const dec = new TextDecoder();
  // 读到 [DONE] 为止（finished/paused 后的 usage 尾块仍要读取累计），但不再处理内容
  const pump = async (upstreamResp) => {
    let sseBuf = '';
    for await (const value of upstreamResp) {
      if (clientGone) { upstreamResp.destroy(); return; }
      sseBuf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = sseBuf.indexOf('\n')) !== -1) {
        const line = sseBuf.slice(0, nl).replace(/\r$/, '');
        sseBuf = sseBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        if (conv.finished || conv.paused) continue;
        try { conv.processChunk(JSON.parse(payload)); } catch (e) { log('[sse] chunk parse error:', e.message); }
      }
    }
  };

  try {
    let roundBody = baseBody;
    for (let round = 0; ; round++) {
      const { resp, errText, headers } = await callUpstreamWithRetry(roundBody);
      if (!resp || resp.statusCode !== 200) {
        return emitStreamError(res, resp?.statusCode, errText, headers); // Anthropic SSE error 事件，客户端 SDK 会重试
      }
      await pump(resp);
      if (clientGone) return;
      // 模型只调用了网关内部工具（web_search）：暂停，执行搜索后同流续轮
      if (!conv.paused && !conv.finished && conv.sawInternalSearch && !conv.sawToolCall) {
        conv.pauseForSearch();
      }
      if (conv.paused && round < maxRounds && conv.pendingSearches?.length) {
        // 执行内部搜索，同一条 message 流内续轮
        const intMsgs = [{
          role: 'assistant',
          content: conv.roundText,
          tool_calls: conv.pendingSearches.map((s) => ({ id: s.id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: s.query }) } })),
        }];
        for (const s of conv.pendingSearches) {
          const { hits } = await doWebSearch(s.query);
          noteStats(res, { searches: (reqMeta.get(res)?.searches || 0) + 1 });
          conv.emitSearchBlocks(s.id, s.query, hits);
          intMsgs.push({ role: 'tool', tool_call_id: s.id, content: hitsForModel(hits) });
        }
        conv.paused = false;
        conv.pendingSearches = null;
        conv.toolCalls.clear();
        conv.sawInternalSearch = false;
        conv.roundText = '';
        roundBody = { ...roundBody, messages: [...roundBody.messages, ...intMsgs] };
        continue;
      }
      if (conv.paused) {
        // 达到 maxRounds 上限仍想搜索：强制收尾为 end_turn（没有客户端 tool_use 块可回）
        conv.paused = false;
        conv.finalize('stop');
      } else {
        conv.finalize(conv.lastFinishReason || 'stop');
      }
      res.end();
      return;
    }
  } catch (e) {
    log('[stream] error:', e.message);
    noteStats(res, { status: res.statusCode || 500, error: e.message?.slice(0, 200) });
    if (!res.writableEnded) {
      if (!conv.finished) {
        // 中途失败：发 Anthropic SSE error 事件而不是静默 stop，客户端才能区分并重试
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `gateway stream error: ${e.message}` } })}\n\n`);
      }
      res.end();
    }
  }
}

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/g;
/** 中英文混合估算：CJK 约 1 字符/token，其余约 3.8 字符/token */
function estimateTokensSmart(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.8);
}

async function handleCountTokens(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw); } catch { /* ignore */ }
  let total = 0;
  if (typeof body.system === 'string') total += estimateTokensSmart(body.system);
  else if (Array.isArray(body.system)) total += estimateTokensSmart(body.system.map((b) => b?.text || '').join('\n'));
  for (const m of body.messages || []) {
    total += typeof m.content === 'string'
      ? estimateTokensSmart(m.content)
      : estimateTokensSmart(JSON.stringify(m.content));
  }
  for (const t of body.tools || []) {
    // 工具 schema 全程占用上下文，必须计入（否则 Claude Code 误判剩余窗口）
    total += estimateTokensSmart(JSON.stringify(t));
  }
  noteStats(res, { model: body.model || '-', status: 200, usage: { in: total, out: 0, cached: 0 } });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: total }));
}

/**
 * GET /v1/models — Anthropic 格式模型目录（动态发现上游真实模型）。
 *
 * 桌面端的模型 ID 校验（magpie 从 app.asar 2.7032 逆向）：小写 id 必须
 * ① 不匹配厂商黑名单（glm/deepseek/kimi/qwen/minimax/hy3/k2. 等），
 * ② 且匹配 ^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$ 或含
 * claude/sonnet/opus/haiku/fable/mythos/anthropic 之一。
 * 不合规的真实模型按 magpie 同款方案包装成 "anthropic/magpie-<fnv64哈希>"
 * （含 anthropic 通过校验、不含厂商词），真实名放 display_name，
 * 请求进来按哈希反解回上游原名（见 resolveModel）。
 */
const MODEL_CATALOG = [
  { id: 'claude-sonnet-4-5-20250929', display: 'Sonnet 4.5 (gateway default)', tier: 'sonnet' },
  { id: 'claude-opus-4-1', display: 'Opus 4.1 (gateway big)', tier: 'opus' },
  { id: 'claude-haiku-4-5', display: 'Haiku 4.5 (gateway small)', tier: 'haiku' },
];

// ---- Claude Desktop 模型 ID 校验（照搬 magpie internal/gateway/desktop.go）----
const DESKTOP_DENIED = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;
const DESKTOP_TIER = /^(sonnet|opus|haiku|fable|mythos)(-[\d.]+)?$/;
const DESKTOP_WORDS = ['claude', 'sonnet', 'opus', 'haiku', 'fable', 'mythos', 'anthropic'];

function desktopAccepts(id) {
  const l = id.toLowerCase();
  if (DESKTOP_TIER.test(l)) return true;
  if (DESKTOP_DENIED.test(l)) return false;
  return DESKTOP_WORDS.some((w) => l.includes(w));
}

/** FNV-1a 64 位哈希（与 Go fnv.New64a 一致），取后 10 位数字作别名号 */
function aliasNumber(id) {
  let h = 14695981039346656037n;
  for (const b of Buffer.from(id, 'utf8')) {
    h ^= BigInt(b);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return String(h % 10000000000n).padStart(10, '0');
}

const DESKTOP_ALIAS = 'anthropic/magpie-';
function aliasFor(id) {
  return DESKTOP_ALIAS + aliasNumber(id);
}

/** 上游模型缓存（TTL 60s），resolveModel 反解时使用 */
const upstreamModelCache = { ids: [], info: {}, at: 0 };
const UPSTREAM_MODELS_TTL = 60_000;
let modelsRefreshInflight = null;

async function refreshUpstreamModels(force = false) {
  if (!force && Date.now() - upstreamModelCache.at < UPSTREAM_MODELS_TTL) return upstreamModelCache.ids;
  if (modelsRefreshInflight) return modelsRefreshInflight; // 并发请求去重
  modelsRefreshInflight = (async () => {
    try {
      const r = await upstreamRequest('GET', `${UPSTREAM}/models`, null);
      const data = await readJsonResponse(r);
      const ids = [];
      const info = {};
      for (const m of data.data || []) {
        const id = typeof m === 'string' ? m : m.id;
        if (!id) continue;
        ids.push(id);
        if (typeof m === 'object') {
          info[id] = {
            context: m.context_length || m.max_allowed_size || null, // 上游自报上下文窗口
            output: m.max_output_tokens || null,
          };
        }
      }
      upstreamModelCache.ids = ids;
      upstreamModelCache.info = info;
      upstreamModelCache.at = Date.now();
      log(`[models] upstream 返回 ${ids.length} 个模型`);
    } catch (e) {
      log('[models] 上游模型发现失败:', e.message);
    } finally {
      modelsRefreshInflight = null;
    }
    return upstreamModelCache.ids;
  })();
  return modelsRefreshInflight;
}

/**
 * 上下文窗口（magpie 同款三字段输出给客户端）：
 * config.contextWindows[模型id] > 上游自报 context_length > config.contextWindows.default
 */
function contextWindowFor(id) {
  const cw = config.contextWindows || {};
  if (cw[id]) return cw[id];
  const inf = upstreamModelCache.info?.[id];
  if (inf?.context) return inf.context;
  return cw.default ?? null;
}

function outputLimitFor(id) {
  const inf = upstreamModelCache.info?.[id];
  return inf?.output || null;
}

/** 客户端可读的窗口字段（magpie gateway.go: "the window, as the names clients read it by"） */
function windowFields(id) {
  const w = contextWindowFor(id);
  const out = outputLimitFor(id);
  const f = {};
  if (w) { f.context_window = w; f.context_length = w; f.max_input_tokens = w; }
  if (out) f.max_output_tokens = out;
  // 桌面端网关模式读取的字段之一（desktop.go: IIt keeps id, display_name,
  // description, supports_1m, anthropic_family_tier）；新版桌面端按它判 1M
  if ((w || 0) >= 1_000_000) f.supports_1m = true;
  return f;
}

/** 目录槽位（claude-sonnet-* 等）实际路由到的上游模型 id，用于查它的窗口 */
function slotTargetModel(slotId) {
  const aliases = config.modelAliases || {};
  if (aliases[slotId]) return aliases[slotId];
  const m = config.models || {};
  if (/haiku/i.test(slotId)) return m.small || m.default;
  if (/opus/i.test(slotId)) return m.big || m.default;
  return m.default;
}

/** GET /v1/models/{id} — Anthropic 单模型查询 */
async function handleModelById(req, res, id) {
  await refreshUpstreamModels();
  const ids = upstreamModelCache.ids;
  const bare = id.replace(/\[1m\]$/i, ''); // [1m] 变体按去掉后缀的原模型应答
  const hit = ids.find((x) => x === bare)
    || ids.find((x) => aliasFor(x) === bare || slugForModel(x) === bare.toLowerCase() || x.replace(/^[^:]*:/, '') === bare)
    || MODEL_CATALOG.find((m) => m.id === bare);
  if (!hit) return anthropicError(res, 404, 'not_found_error', `model not found: ${id}`);
  const cat = typeof hit === 'string' ? null : hit;
  const upstreamId = cat ? null : hit;
  const now = new Date().toISOString();
  const fields = cat ? windowFields(slotTargetModel(cat.id)) : windowFields(upstreamId);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(cat
    ? { type: 'model', id: cat.id, display_name: cat.display, created_at: now, owned_by: 'gateway', ...fields }
    : { type: 'model', id: desktopAccepts(upstreamId) ? upstreamId : aliasFor(upstreamId), display_name: prettyModelName(upstreamId), created_at: now, owned_by: 'gateway', ...fields }));
}

/** "cn:glm-5.3" -> "claude-glm-5-3"（备用 ID 形式，请求侧仍可识别） */
function slugForModel(id) {
  const nsIdx = id.indexOf(':');
  const rest = nsIdx >= 0 ? id.slice(nsIdx + 1) : id;
  return 'claude-' + rest.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 上游模型 ID -> 展示名："cn:glm-5.3-flash" -> "GLM 5.3 Flash" */
const BRAND_NAMES = { glm: 'GLM', deepseek: 'DeepSeek', kimi: 'Kimi', minimax: 'MiniMax', step: 'Step', hy: 'HY', claude: 'Claude' };
function prettyModelName(id) {
  const raw = id.replace(/^.*:/, ''); // 去掉 "cn:" 之类命名空间前缀
  return raw
    .split('-')
    .filter(Boolean)
    .map((w) => {
      const key = w.toLowerCase().replace(/[^a-z]/g, '');
      return BRAND_NAMES[key] ? w.replace(new RegExp(key, 'i'), BRAND_NAMES[key]) : w;
    })
    .join(' ');
}

async function handleModels(req, res) {
  const now = new Date().toISOString();
  const upstreamIds = await refreshUpstreamModels(true);
  const data = [];
  for (const id of upstreamIds) {
    // 桌面端显示 display_name 而非 id；description 保持中性文案（不能含厂商词，防同款校验）
    const fields = windowFields(id);
    const alias = desktopAccepts(id) ? id : aliasFor(id);
    data.push({
      type: 'model',
      object: 'model',
      id: alias,
      display_name: prettyModelName(id),
      description: 'via claude-openai-gateway',
      created_at: now,
      owned_by: 'gateway',
      ...fields,
    });
    // 桌面端把紧跟裸行的 [1m] 行折叠为 "XXX (…[1m])" 一个条目（1M 窗口）；
    // 显式给行比依赖桌面端自己按 max_input_tokens 生成可靠（新版只认 supports_1m）
    if ((fields.max_input_tokens || 0) >= 1_000_000) {
      data.push({
        type: 'model',
        object: 'model',
        id: alias + '[1m]',
        display_name: prettyModelName(id),
        description: 'via claude-openai-gateway (1M context window)',
        created_at: now,
        owned_by: 'gateway',
        ...fields,
      });
    }
  }
  for (const m of MODEL_CATALOG) {
    const fields = windowFields(slotTargetModel(m.id));
    data.push({
      type: 'model',
      object: 'model',
      id: m.id,
      display_name: m.display,
      description: 'via claude-openai-gateway',
      created_at: now,
      owned_by: 'gateway',
      anthropic_family_tier: m.tier, // 桌面端据此设置 ANTHROPIC_DEFAULT_<TIER>_MODEL
      is_family_default: true,
      ...fields,
    });
    // Claude Code CLI 靠 id 的 [1m] 后缀识别 1M 上下文（magpie 同款），窗口 >= 1M 时补一条 1M 变体
    if ((fields.max_input_tokens || 0) >= 1_000_000) {
      data.push({
        type: 'model',
        object: 'model',
        id: m.id + '[1m]',
        display_name: m.display.replace(/ \(gateway.*\)$/, '') + ' [1M context]',
        description: 'via claude-openai-gateway (1M context window)',
        created_at: now,
        owned_by: 'gateway',
        anthropic_family_tier: m.tier,
        is_family_default: true,
        ...fields,
      });
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data, first_id: data[0]?.id ?? null, has_more: false, last_id: data[data.length - 1]?.id ?? null }));
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = urlObj.pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    // ---- 本地管理面（WebUI + admin API）：本机使用，不做 API key 校验 ----
    if (p === '/' || p === '/ui' || p.startsWith('/ui/')) return serveStatic(res, p);
    if (p === '/health') {
      const ageSec = upstreamModelCache.at ? Math.round((Date.now() - upstreamModelCache.at) / 1000) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        upstream: UPSTREAM,
        models: config.models,
        upstreamModelsCached: upstreamModelCache.ids.length,
        upstreamLastFetchAgoSec: ageSec,
        webSearch: config.webSearch?.enabled === false ? false : true,
      }));
    }
    if (p === '/admin/stats') {
      const entries = await readLogEntries();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        startedAt: STARTED_AT,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        retentionHours: LOG_RETENTION_HOURS,
        upstream: UPSTREAM,
        models: config.models,
        webSearch: config.webSearch?.enabled !== false,
        ...aggregateStats(entries),
      }));
    }
    if (p === '/admin/logs') {
      const limit = Math.min(Number(urlObj.searchParams.get('limit')) || 100, LOG_MEM_MAX);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        retentionHours: LOG_RETENTION_HOURS,
        entries: logMem.slice(-limit).reverse(),
      }));
    }
    if (req.method === 'POST' && p === '/admin/logs/clear') {
      logMem.length = 0;
      fs.rm(LOGS_DIR, { recursive: true, force: true }, () => {});
      log('[admin] 日志已清空');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (!checkAuth(req, res)) return;

    if (req.method === 'POST' && (p === '/v1/messages' || p === '/anthropic/v1/messages')) {
      trackRequest(req, res, 'messages');
      return await handleMessages(req, res, urlObj);
    }
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
      trackRequest(req, res, 'count_tokens');
      return await handleCountTokens(req, res);
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return await handleModels(req, res);
    const modelIdMatch = p.match(/^\/v1\/models\/(.+)$/);
    if (req.method === 'GET' && modelIdMatch) return await handleModelById(req, res, decodeURIComponent(modelIdMatch[1]));
    anthropicError(res, 404, 'not_found_error', `unknown route: ${req.method} ${p}`);
  } catch (e) {
    log('[fatal]', e);
    if (!res.headersSent) anthropicError(res, 500, 'api_error', e.message);
  }
});

/** 静态文件：/ 与 /ui/* -> ui/ 目录（防路径穿越） */
const UI_DIR = path.join(__dirname, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(res, p) {
  const rel = p === '/' || p === '/ui' ? 'index.html' : p.replace(/^\/ui\//, '');
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) && file !== UI_DIR) {
    return anthropicError(res, 403, 'invalid_request_error', 'forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) return anthropicError(res, 404, 'not_found_error', `not found: ${rel}`);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`claude-openai-gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`models: default=${config.models.default} think=${config.models.think}`);
  console.log(`WebUI:    http://127.0.0.1:${PORT}/ui`);
  console.log(`Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude`);
  pruneOldLogs();
  setInterval(pruneOldLogs, 15 * 60_000).unref(); // 日志过期清理
  refreshUpstreamModels(true).catch(() => {}); // 预热模型缓存
  setInterval(() => refreshUpstreamModels().catch(() => {}), UPSTREAM_MODELS_TTL).unref();
});
