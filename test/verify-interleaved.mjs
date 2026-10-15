// 验证交错推理模型的流式转换：text block 应只有一个、文本完整连续
import fs from 'node:fs';

const body = {
  model: 'anthropic/magpie-3784521155', // cn:step-5-preview
  max_tokens: 2048,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 1024 },
  messages: [{ role: 'user', content: '用三句话介绍一下 HTTP 协议。' }],
};

const resp = await fetch('http://127.0.0.1:8787/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

if (!resp.ok) { console.error('HTTP', resp.status, (await resp.text()).slice(0, 300)); process.exit(1); }

const events = [];
let cur = null;
const reader = resp.body.getReader();
const dec = new TextDecoder();
let sse = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  sse += dec.decode(value, { stream: true });
  let nl;
  while ((nl = sse.indexOf('\n\n')) !== -1) {
    const raw = sse.slice(0, nl); sse = sse.slice(nl + 2);
    const evLine = raw.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    if (!evLine || !dataLine) continue;
    cur = { event: evLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) };
    events.push(cur);
  }
}

// 分析 block 结构
const starts = events.filter((e) => e.event === 'content_block_start');
const textDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta');
const textBlocks = starts.filter((e) => e.data.content_block?.type === 'text');
const thinkBlocks = starts.filter((e) => e.data.content_block?.type === 'thinking');
const fullText = textDeltas.map((e) => e.data.delta.text).join('');

// 校验事件顺序：index 单调、每个 start 有对应 stop
const indices = starts.map((e) => e.data.index);
const monotonic = indices.every((v, i) => i === 0 || v > indices[i - 1]);
const stopCount = events.filter((e) => e.event === 'content_block_stop').length;

console.log('总事件数:', events.length);
console.log('text block 数:', textBlocks.length, '(应为 1)');
console.log('thinking block 数:', thinkBlocks.length);
console.log('index 单调递增:', monotonic);
console.log('start/stop 配对:', starts.length === stopCount ? 'OK' : `不配对 start=${starts.length} stop=${stopCount}`);
console.log('文本总长:', fullText.length, '字符');
console.log('文本是否连续(无怪异断口):', fullText.includes('HTTP') ? '含关键词' : '(检查内容)');
console.log('--- 文本前 300 字 ---');
console.log(fullText.slice(0, 300));

const pass = textBlocks.length === 1 && monotonic && starts.length === stopCount && fullText.length > 50;
console.log(pass ? '\n[PASS] 流式结构正常' : '\n[FAIL] 结构异常');
process.exit(pass ? 0 : 1);
