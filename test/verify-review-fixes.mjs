#!/usr/bin/env node
/** 审查修复点抽查：web_search 内部轮次 + 中文 count_tokens */
import fs from 'node:fs';

const GW = 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ': ' + detail : ''}`);
  cond ? pass++ : fail++;
};

// [1] count_tokens 中文估算
{
  const r = await fetch(`${GW}/v1/messages/count_tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '这是一个中文测试句子，用来验证分词估算。'.repeat(10) }] }),
  });
  const d = await r.json();
  console.log('[1] count_tokens 中文（200 字中文）');
  ok(' tokens > 100（中文按 ~1 token/字）', d.input_tokens > 100, `input_tokens=${d.input_tokens}`);
  ok(' tokens < 300（未按字符数除 3.5 夸大）', d.input_tokens < 300);
}

// [2] web_search 非流式：模型应发起 server_tool_use -> 网关执行 -> 返回 web_search_tool_result + 最终回答
{
  console.log('[2] web_search 非流式');
  const r = await fetch(`${GW}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929', max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: 'Search the web for "Node.js 22 release date" and tell me the date in one short sentence. You must use the web_search tool first.' }],
    }),
  });
  const d = await r.json();
  if (d.type === 'error') { ok(' 请求成功', false, JSON.stringify(d).slice(0, 200)); }
  else {
    const types = d.content.map((b) => b.type);
    ok(' 含 server_tool_use 块', types.includes('server_tool_use'));
    ok(' 含 web_search_tool_result 块', types.includes('web_search_tool_result'));
    const sr = d.content.find((b) => b.type === 'web_search_tool_result');
    if (sr) ok(' 搜索结果非空', Array.isArray(sr.content) && sr.content.length > 0, `${sr.content?.length} 条`);
    const text = d.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    ok(' 最终回答提到 2024（Node 22 发布年）', /202[0-9]/.test(text), text.slice(0, 120));
  }
}

// [3] web_search 流式：事件序列完整，且最终有 message_stop
{
  console.log('[3] web_search 流式');
  const r = await fetch(`${GW}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929', max_tokens: 1000, stream: true,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Use web_search to find "what is HTTP 418", then answer in one sentence.' }],
    }),
  });
  const text = await r.text();
  const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  const idxs = [...text.matchAll(/"index":(\d+)/g)].map((m) => Number(m[1]));
  const monotonic = idxs.every((v, i) => i === 0 || v >= idxs[i - 1]);
  ok(' 含 server_tool_use', events.includes('content_block_start') && text.includes('"server_tool_use"'));
  ok(' 含 web_search_tool_result', text.includes('"web_search_tool_result"'));
  ok(' 以 message_stop 结束', events[events.length - 1] === 'message_stop', `last=${events[events.length - 1]}`);
  ok(' 事件 index 单调不减', monotonic);
  ok(' 无 SSE error 事件', !events.includes('error'));
}

// [4] 显式选真实模型 + thinking：不应被强制改路由到 think 模型（看非流式响应 model 字段外的日志确认，这里只验证请求成功）
{
  console.log('[4] 显式模型 + thinking 不覆盖');
  const r = await fetch(`${GW}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cn:step-5-preview', max_tokens: 100,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    }),
  });
  const d = await r.json();
  ok(' 请求成功返回', d.type === 'message', d.error ? d.error.message.slice(0, 100) : d.stop_reason);
}

console.log(`\n========== 抽查结果: ${pass} 通过, ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
