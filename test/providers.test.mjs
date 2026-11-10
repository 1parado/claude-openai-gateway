/** 自包含集成测试：临时配置 + 本机模拟上游，不调用真实模型或修改用户配置。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProviderStore, normalizeBaseUrl } from '../providers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mockUpstream(name) {
  const calls = [];
  let modelStatus = 200, modelDelay = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/v1/models') {
      const status = modelStatus, delay = modelDelay;
      await pause(delay);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(status === 200 ? { data: [{ id: `${name}-chat`, context_length: 1_000_000, max_output_tokens: 8192 }, { id: `${name}-small` }, { id: `${name}-think` }] } : { error: 'private upstream diagnostic, must not be echoed' }));
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    if (body.messages.some(message => message.content === 'retry') && calls.filter(call => call.body?.messages?.some(message => message.content === 'retry')).length === 1) {
      res.writeHead(429, { 'retry-after': '1' });
      return res.end('{"error":"retry once"}');
    }
    if (body.messages.some(message => message.content === 'slow')) await pause(150);
    const tool = body.tools?.find(item => item.function?.name === 'get_weather');
    const hasResult = body.messages.some(message => message.role === 'tool');
    const content = hasResult ? '北京晴，12度' : `${name}:ok`;
    const reasoning = '这里是一段足够长的模拟推理，用于验证流式思考块可以正常结束并带有签名。';
    const toolCalls = tool && !hasResult ? [{ id: 'call_test', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] : undefined;
    const finish = toolCalls ? 'tool_calls' : 'stop';
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'mock', model: body.model, choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (body.reasoning_effort) emit({ choices: [{ delta: { reasoning_content: reasoning } }] });
    if (toolCalls) emit({ choices: [{ delta: { tool_calls: toolCalls.map((item, index) => ({ ...item, index })) } }] });
    else {
      emit({ choices: [{ delta: { content: content.slice(0, 2) } }] });
      emit({ choices: [{ delta: { content: content.slice(2) } }] });
    }
    emit({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 8 } });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  return { server, calls, baseUrl: `http://127.0.0.1:${port}/v1`, status(value) { modelStatus = value; }, delay(value) { modelDelay = value; } };
}

async function startGateway(configPath, extraEnv = {}) {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const child = spawn(process.execPath, [path.join(ROOT, 'gateway.mjs')], {
    cwd: path.dirname(configPath), env: { ...process.env, PORT: String(port), GATEWAY_CONFIG: configPath, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`gateway exited: ${output}`);
    try { if ((await fetch(base + '/health')).ok) return { child, base }; } catch { /* wait for listen */ }
    await pause(40);
  }
  child.kill();
  throw new Error(`gateway did not start: ${output}`);
}

async function stopGateway(gateway) {
  if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
  const stopped = new Promise(resolve => gateway.child.once('exit', resolve));
  gateway.child.kill();
  await stopped;
}

test('供应商管理、热切换和 Claude 协议集成', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-providers-'));
  const configPath = path.join(temp, 'config.json');
  const a = await mockUpstream('a'), b = await mockUpstream('b');
  let gateway;
  t.after(async () => { if (gateway) await stopGateway(gateway); await close(a.server); await close(b.server); fs.rmSync(temp, { recursive: true, force: true }); });
  gateway = await startGateway(configPath);
  const api = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(gateway.base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const message = (model = 'claude-sonnet-4-5', extra = {}) => api('/v1/messages', 'POST', { model, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], ...extra });
  let aid, bid;

  await t.test('无配置首次启动与 URL 归一化', async () => {
    assert.equal((await api('/admin/providers')).data.providers.length, 0);
    assert.equal((await message()).status, 503);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal((await fetch(gateway.base + '/')).status, 200);
    assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com/v1');
    assert.equal(normalizeBaseUrl('https://example.com/custom/chat/completions/'), 'https://example.com/custom');
    assert.equal(normalizeBaseUrl('https://example.com/v1/models'), 'https://example.com/v1');
    for (const value of ['ftp://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'bad']) assert.throws(() => normalizeBaseUrl(value));
  });
  await t.test('发现模型，保存 Key 不回传，启用并持久化', async () => {
    const discovery = await api('/admin/providers/discover', 'POST', { baseUrl: a.baseUrl + '/chat/completions', apiKey: 'secret-a' });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.data.catalog[0].context_length, 1_000_000);
    assert.equal(a.calls.at(-1).auth, 'Bearer secret-a');
    const saved = await api('/admin/providers', 'POST', { name: '服务 A <test>', baseUrl: a.baseUrl, apiKey: 'secret-a', models: { default: 'a-chat', small: 'a-small', think: 'a-think' }, catalog: discovery.data.catalog });
    aid = saved.data.savedId;
    assert.equal(JSON.stringify(saved.data).includes('secret-a'), false);
    assert.equal(saved.data.providers[0].hasApiKey, true);
    assert.equal(saved.data.activeProviderId, null);
    assert.equal((await api(`/admin/providers/${aid}/activate`, 'POST', {})).status, 200);
    const config = JSON.parse(fs.readFileSync(configPath));
    assert.equal(config.activeProviderId, aid);
    assert.equal(config.upstreamApiKey, 'secret-a');
    const result = await message();
    assert.equal(result.data.content[0].text, 'a:ok');
    assert.equal(a.calls.at(-1).body.model, 'a-chat');
  });
  await t.test('模型目录别名、上下文窗口及显式模型思考路由', async () => {
    const catalog = (await api('/v1/models')).data.data;
    const model = catalog.find(model => model.display_name === 'a chat');
    assert.equal(model.context_window, 1_000_000);
    assert.equal(model.supports_1m, true);
    await message('claude-haiku-4-5');
    assert.equal(a.calls.at(-1).body.model, 'a-small');
    await message('claude-sonnet-4-5', { thinking: { type: 'enabled', budget_tokens: 4096 } });
    assert.equal(a.calls.at(-1).body.model, 'a-think');
    await message(model.id, { thinking: { type: 'enabled', budget_tokens: 4096 } });
    assert.equal(a.calls.at(-1).body.model, 'a-chat');
  });
  await t.test('流式思考、文本、工具调用与工具结果协议回归', async () => {
    async function stream(extra) {
      const response = await fetch(gateway.base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, max_tokens: 500, messages: [{ role: 'user', content: 'hello' }], ...extra }) });
      assert.equal(response.status, 200);
      return response.text();
    }
    const text = await stream({ thinking: { type: 'enabled', budget_tokens: 1000 } });
    for (const event of ['message_start', 'thinking_delta', 'signature_delta', 'text_delta', 'message_delta', 'message_stop']) assert.ok(text.includes(event), event);
    assert.ok(text.indexOf('thinking_delta') < text.indexOf('text_delta'));
    const tools = [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
    const toolStream = await stream({ tools });
    assert.ok(toolStream.includes('"name":"get_weather"'));
    assert.ok(toolStream.includes('"stop_reason":"tool_use"'));
    const result = await message('claude-sonnet-4-5', { tools, messages: [{ role: 'user', content: '天气' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_test', name: 'get_weather', input: { city: '北京' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_test', content: '晴，12度' }] }] });
    assert.equal(result.data.content[0].text, '北京晴，12度');
    assert.ok(a.calls.at(-1).body.messages.some(message => message.role === 'tool'));
    assert.ok((await api('/v1/messages/count_tokens', 'POST', { messages: [{ role: 'user', content: '中文测试' }] })).data.input_tokens >= 4);
  });
  await t.test('编辑保留密钥；错误输入不覆盖磁盘配置', async () => {
    const before = fs.readFileSync(configPath, 'utf8');
    const invalid = await api('/admin/providers', 'POST', { id: aid, name: 'A', baseUrl: 'ftp://bad', models: { default: 'a-chat' } });
    assert.equal(invalid.status, 400);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.equal((await api('/admin/providers/discover', 'POST', { id: aid, baseUrl: b.baseUrl })).status, 400);
    const saved = await api('/admin/providers', 'POST', { id: aid, name: 'A edited', baseUrl: a.baseUrl, apiKey: '', models: { default: 'a-chat', small: 'a-small', think: 'a-think' } });
    assert.equal(saved.status, 200);
    await message();
    assert.equal(a.calls.at(-1).auth, 'Bearer secret-a');
    a.status(401);
    const failure = await api('/admin/providers/discover', 'POST', { id: aid, baseUrl: a.baseUrl });
    assert.equal(failure.status, 502);
    assert.match(failure.data.error.message, /401/);
    assert.equal(JSON.stringify(failure).includes('private upstream'), false);
    a.status(200);
  });
  await t.test('切换时进行中的请求仍使用原上游，新请求使用新上游', async () => {
    const saved = await api('/admin/providers', 'POST', { name: 'B', baseUrl: b.baseUrl, apiKey: 'secret-b', models: { default: 'b-chat' } });
    bid = saved.data.savedId;
    const count = a.calls.length;
    const pending = message('claude-sonnet-4-5', { messages: [{ role: 'user', content: 'slow' }] });
    for (let i = 0; i < 100 && a.calls.length === count; i++) await pause(5);
    assert.ok(a.calls.length > count);
    await api(`/admin/providers/${bid}/activate`, 'POST', {});
    assert.equal((await message()).data.content[0].text, 'b:ok');
    assert.equal(b.calls.at(-1).auth, 'Bearer secret-b');
    assert.equal((await pending).data.content[0].text, 'a:ok');
    assert.equal((await api(`/admin/providers/${bid}`, 'DELETE', {})).status, 400);
  });
  await t.test('旧供应商的延迟模型发现不能覆盖切换后的缓存', async () => {
    a.delay(180);
    await api(`/admin/providers/${aid}/activate`, 'POST', {});
    const count = a.calls.length;
    const pending = api('/v1/models');
    for (let i = 0; i < 100 && a.calls.length === count; i++) await pause(5);
    await api(`/admin/providers/${bid}/activate`, 'POST', {});
    await api('/v1/models');
    await pending;
    const health = (await api('/health')).data;
    assert.equal(health.upstream, b.baseUrl);
    const models = (await api('/v1/models')).data.data;
    assert.ok(models.some(model => model.display_name === 'b chat'));
    assert.ok(!models.some(model => model.display_name === 'a chat'));
    a.delay(0);
  });
  await t.test('切换期间的上游重试仍保留原 URL、Key 和模型', async () => {
    await api(`/admin/providers/${aid}/activate`, 'POST', {});
    const count = a.calls.length;
    const pending = message('claude-sonnet-4-5', { messages: [{ role: 'user', content: 'retry' }] });
    for (let i = 0; i < 100 && a.calls.length === count; i++) await pause(5);
    await api(`/admin/providers/${bid}/activate`, 'POST', {});
    assert.equal((await pending).data.content[0].text, 'a:ok');
    const retryCalls = a.calls.filter(call => call.body?.messages?.some(message => message.content === 'retry'));
    assert.equal(retryCalls.length, 2);
    assert.ok(retryCalls.every(call => call.auth === 'Bearer secret-a' && call.body.model === 'a-chat'));
  });
  await t.test('管理接口拒绝跨域、DNS 重绑定及表单提交', async () => {
    assert.equal((await api('/admin/providers', 'GET', undefined, { origin: 'https://evil.example' })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => {
      http.get(gateway.base + '/admin/providers', { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await api('/admin/providers', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await api('/admin/providers', 'POST', {}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await api('/admin/providers', 'POST', { padding: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
    assert.equal((await api('/admin/providers', 'GET', undefined, { origin: gateway.base })).status, 200);
  });
  await t.test('生成专用 Claude 配置，合并并备份已有设置', async () => {
    const dir = path.join(temp, 'claude-profile');
    fs.mkdirSync(dir);
    const previous = { permissions: { allow: ['Read'] }, env: { KEEP_ME: 'yes' } };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(previous));
    assert.equal((await api('/admin/claude-profile', 'POST', {})).status, 200);
    const profile = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
    assert.deepEqual(profile.permissions, previous.permissions);
    assert.equal(profile.env.KEEP_ME, 'yes');
    assert.equal(profile.env.ANTHROPIC_BASE_URL, gateway.base);
    assert.equal(profile.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-1');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'))), previous);
    const routeScript = path.join(temp, 'claude-route.mjs');
    fs.copyFileSync(path.join(ROOT, 'claude-route.mjs'), routeScript);
    assert.equal(execFileSync(process.execPath, [routeScript], { encoding: 'utf8' }).trim(), gateway.base);
  });
  await t.test('重启后保留供应商与启用状态；手填模型及删除', async () => {
    await stopGateway(gateway);
    gateway = await startGateway(configPath);
    assert.equal((await api('/admin/providers')).data.activeProviderId, bid);
    assert.equal((await message()).data.content[0].text, 'b:ok');
    assert.equal((await api(`/admin/providers/${aid}`, 'DELETE', {})).status, 200);
    assert.equal((await api('/admin/providers')).data.providers.length, 1);
    const manual = await api('/admin/providers', 'POST', { name: '免密手填', baseUrl: a.baseUrl, clearApiKey: true, models: { default: 'manual-only' } });
    await api(`/admin/providers/${manual.data.savedId}/activate`, 'POST', {});
    await message();
    assert.equal(a.calls.at(-1).body.model, 'manual-only');
    assert.equal(a.calls.at(-1).auth, undefined);
  });
  await t.test('旧单上游配置迁移保留别名和其他配置', () => {
    const filename = path.join(temp, 'legacy.json');
    fs.writeFileSync(filename, JSON.stringify({ upstreamBaseUrl: a.baseUrl, upstreamApiKey: 'legacy-secret', models: { default: 'old' }, modelAliases: { 'claude-sonnet-4-5': 'old' }, thinking: { strategy: 'drop' }, gatewayApiKey: 'gateway-secret' }));
    const store = new ProviderStore(filename);
    assert.equal(store.activeId, 'legacy-current');
    store.save({ id: store.activeId, name: '原有上游', baseUrl: a.baseUrl, models: { default: 'new' } });
    assert.equal(store.config.modelAliases['claude-sonnet-4-5'], 'new');
    assert.equal(store.config.upstreamApiKey, 'legacy-secret');
    assert.equal(store.config.gatewayApiKey, 'gateway-secret');
    assert.deepEqual(store.config.thinking, { strategy: 'drop' });
  });
  await t.test('原有日志清理管理操作可用', async () => {
    assert.equal((await api('/admin/logs/clear', 'POST', {})).status, 200);
    assert.equal((await api('/admin/logs')).data.entries.length, 0);
  });
});

test('HTTPS 直连与 HTTP 代理 CONNECT：模型发现和对话都使用 TLS', async t => {
  // 此证书和私钥仅用于本机测试，无任何生产用途。
  const certPath = path.join(ROOT, 'test/fixtures/localhost-cert.pem');
  const keyPath = path.join(ROOT, 'test/fixtures/localhost-key.pem');
  const calls = [], tunnels = [];
  const secure = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'secure-model' }] }
      : { choices: [{ message: { role: 'assistant', content: 'secure:ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  const tlsPort = await listen(secure);
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const destination = net.connect(tlsPort, '127.0.0.1', () => {
      // 分段返回头，覆盖代理 CONNECT 头被 TCP 拆包的情况。
      socket.write('HTTP/1.1 200 Connection');
      setTimeout(() => {
        socket.write(' Established\r\n\r\n');
        if (head.length) destination.write(head);
        socket.pipe(destination).pipe(socket);
      }, 10);
    });
    destination.on('error', () => socket.destroy());
    socket.on('error', () => destination.destroy());
    socket.on('close', () => destination.destroy());
  });
  const proxyPort = await listen(proxy);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-tls-test-'));
  let gateway;
  t.after(async () => {
    if (gateway) await stopGateway(gateway);
    for (const socket of sockets) socket.destroy();
    await close(proxy); await close(secure);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (const viaProxy of [false, true]) {
    await t.test(viaProxy ? 'HTTPS 经 CONNECT 代理' : 'HTTPS 直连', async () => {
      const configPath = path.join(temp, viaProxy ? 'proxy.json' : 'direct.json');
      fs.writeFileSync(configPath, JSON.stringify({ upstreamBaseUrl: `https://${viaProxy ? 'upstream.test' : '127.0.0.1'}:${tlsPort}/v1`, upstreamApiKey: 'tls-test-key', models: { default: 'secure-model' }, upstreamRetries: 0 }));
      gateway = await startGateway(configPath, { NODE_EXTRA_CA_CERTS: certPath, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: '', https_proxy: '', http_proxy: '', NO_PROXY: '', no_proxy: '' });
      const catalog = await (await fetch(gateway.base + '/v1/models')).json();
      assert.ok(catalog.data.some(model => model.display_name === 'secure model'));
      const response = await fetch(gateway.base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, 'secure:ok');
      assert.equal(calls.at(-1).auth, 'Bearer tls-test-key');
      if (viaProxy) assert.ok(tunnels.length >= 2);
      else assert.equal(tunnels.length, 0);
      await stopGateway(gateway);
    });
  }
});
