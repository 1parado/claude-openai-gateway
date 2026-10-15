#!/usr/bin/env node
/**
 * 网关端到端验证脚本：依次跑 4 组测试并校验 Anthropic 协议要点
 * 用法：node test/run-tests.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.GATEWAY || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;

const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

function post(file, stream) {
  const body = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  body.stream = stream;
  return fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
    body: JSON.stringify(body),
  });
}

// ---------- 测试 1：非流式 ----------
async function test1() {
  console.log('\n[1] 非流式基本对话');
  const r = await post('01-basic-stream.json', false);
  ok(r.status === 200, `HTTP ${r.status}`);
  const j = await r.json();
  ok(j.type === 'message' && j.role === 'assistant', 'type/role 正确');
  ok(Array.isArray(j.content) && j.content.some((b) => b.type === 'text'), '包含 text block');
  ok(['end_turn', 'max_tokens', 'tool_use', 'stop_sequence'].includes(j.stop_reason), `stop_reason=${j.stop_reason}`);
  ok(typeof j.usage?.input_tokens === 'number' && typeof j.usage?.output_tokens === 'number', 'usage 字段完整');
  return j;
}

// ---------- 测试 2：流式 ----------
async function test2() {
  console.log('\n[2] 流式 SSE 事件序列');
  const r = await post('01-basic-stream.json', true);
  ok(r.status === 200, `HTTP ${r.status}`);
  const text = await r.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  const iStart = events.indexOf('message_start');
  const iDelta = events.indexOf('content_block_delta');
  const iMDelta = events.indexOf('message_delta');
  const iStop = events.indexOf('message_stop');
  ok(iStart !== -1, '有 message_start');
  ok(iDelta !== -1 && iStart < iDelta, 'message_start 在 content_block_delta 之前');
  ok(iMDelta !== -1 && iDelta < iMDelta, 'delta 在 message_delta 之前');
  ok(iStop === events.length - 1, 'message_stop 是最后一个事件');
  // 提取拼接文本，验证 SSE 内容完整
  const textParts = [...text.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  ok(textParts.trim().length > 0, `拼接文本非空: ${textParts.slice(0, 30)}...`);
  const stopReason = text.match(/"stop_reason":"(\w+)"/)?.[1];
  ok(['end_turn', 'max_tokens', 'tool_use'].includes(stopReason), `stop_reason=${stopReason}`);
  // 事件序号单调性：每个 content_block_stop 的 index >= 0 且 start/stop 配对
  const starts = [...text.matchAll(/"type":"content_block_start","index":(\d+)/g)].map((m) => +m[1]);
  const stops = [...text.matchAll(/"type":"content_block_stop","index":(\d+)/g)].map((m) => +m[1]);
  ok(JSON.stringify(starts) === JSON.stringify(stops), `block start/stop 配对 [${starts}] vs [${stops}]`);
  return text;
}

// ---------- 测试 3：工具调用往返 ----------
async function test3() {
  console.log('\n[3] 工具调用（模型发起）');
  const r = await post('02-tool-call.json', true);
  const text = await r.text();
  const toolStart = text.match(/"type":"tool_use","id":"([^"]+)","name":"get_weather"/);
  ok(!!toolStart, '模型发起 get_weather tool_use block');
  const argsParts = [...text.matchAll(/"type":"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  let input = {};
  try { input = JSON.parse(argsParts); } catch { /* ignore */ }
  ok(input.city === '北京', `input_json_delta 拼接可解析: ${JSON.stringify(input)}`);
  ok(text.includes('"stop_reason":"tool_use"'), 'stop_reason=tool_use');
  const toolUseId = toolStart?.[1];

  console.log('\n[3b] 工具结果回传（tool_result -> 最终回答）');
  const body = JSON.parse(fs.readFileSync(path.join(__dirname, '03-tool-result.json'), 'utf8'));
  body.stream = false;
  if (toolUseId) {
    body.messages[1].content[1].id = toolUseId;
    body.messages[2].content[0].tool_use_id = toolUseId;
  }
  const r2 = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j2 = await r2.json();
  ok(r2.status === 200, `HTTP ${r2.status}`);
  const finalText = j2.content?.filter((b) => b.type === 'text').map((b) => b.text).join('');
  ok(finalText && (finalText.includes('12') || finalText.includes('晴')), `最终回答引用了工具结果: ${finalText?.slice(0, 40)}...`);
  ok(j2.stop_reason === 'end_turn', 'stop_reason=end_turn');
}

// ---------- 测试 4：thinking ----------
async function test4() {
  console.log('\n[4] thinking 显式开启（budget_tokens -> 推理模型 + thinking block）');
  const r = await post('04-thinking.json', true);
  const text = await r.text();
  ok(text.includes('"type":"thinking_delta"'), '流式含 thinking_delta');
  ok(text.includes('"signature_delta"'), 'thinking 块结束带 signature_delta');
  const thinkParts = [...text.matchAll(/"type":"thinking_delta","thinking":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  ok(thinkParts.trim().length > 20, `推理内容非空: ${thinkParts.slice(0, 40)}...`);
  const textParts = [...text.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  ok(/\d{3}/.test(textParts), `最终答案含三位数: ${textParts.slice(0, 60)}...`);
  // thinking 块应在 text 块之前
  const tIdx = text.indexOf('"type":"thinking_delta"');
  const dIdx = text.indexOf('"type":"text_delta"');
  ok(tIdx !== -1 && (dIdx === -1 || tIdx < dIdx), 'thinking 在 text 之前');
}

// ---------- 测试 5：count_tokens ----------
async function test5() {
  console.log('\n[5] count_tokens');
  const r = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world this is a test' }] }),
  });
  const j = await r.json();
  ok(r.status === 200 && j.input_tokens > 0, `input_tokens=${j.input_tokens}`);
}

const tests = [test1, test2, test3, test4, test5];
for (const t of tests) {
  try { await t(); } catch (e) { fail++; console.log(`  ❌ 测试异常: ${e.message}`); }
}
console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
