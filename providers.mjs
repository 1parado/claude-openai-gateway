import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SLOTS = ['default', 'small', 'big', 'think'];

export class ProviderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderError('请填写上游 URL');
  let url;
  try { url = new URL(value.trim()); } catch { throw new ProviderError('上游 URL 格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('请使用不含账号、查询参数和片段的 HTTP(S) URL');
  }
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/i, '');
  if (!pathname) pathname = '/v1';
  return url.origin + pathname;
}

export function writeJsonAtomic(filename, value) {
  const tmp = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, filename);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export class ProviderStore {
  constructor(filename) {
    this.filename = filename;
    this.config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { models: {}, sendStreamOptions: true };
    this.config.models ||= {};
    this.providers = this.config.providers || [];
    this.activeId = this.config.activeProviderId || null;
    if (!Array.isArray(this.providers)) throw new Error('config.providers must be an array');
    if (!this.providers.length && this.config.upstreamBaseUrl) {
      this.providers = [{ id: 'legacy-current', name: '原有上游', baseUrl: this.config.upstreamBaseUrl.replace(/\/+$/, ''),
        apiKey: this.config.upstreamApiKey || '', models: { ...this.config.models }, modelAliases: { ...this.config.modelAliases }, catalog: [] }];
      this.activeId = 'legacy-current';
    }
    const active = this.providers.find(p => p.id === this.activeId);
    if (this.activeId && !active) throw new Error('activeProviderId does not match a provider');
    if (active) this.applyActive(this.config, active);
  }

  applyActive(config, active) {
    config.upstreamBaseUrl = active?.baseUrl || '';
    config.upstreamApiKey = active?.apiKey || '';
    config.models = { ...active?.models };
    config.modelAliases = { ...active?.modelAliases };
  }

  get active() { return this.providers.find(p => p.id === this.activeId); }
  get upstream() { return { baseUrl: this.config.upstreamBaseUrl || '', apiKey: this.config.upstreamApiKey || '' }; }

  list() {
    return { activeProviderId: this.activeId, providers: this.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: !!apiKey })) };
  }

  credentials(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProviderError('请提交供应商配置对象');
    const existing = input.id ? this.providers.find(p => p.id === input.id) : null;
    if (input.id && !existing) throw new ProviderError('供应商不存在', 404);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || /[\r\n]/.test(input.apiKey))) throw new ProviderError('API Key 格式不正确');
    // 空字符串表示保留原 Key；显式勾选免密时清除。
    const apiKey = input.clearApiKey === true ? '' : (input.apiKey?.trim() || existing?.apiKey || '');
    if (existing?.apiKey && baseUrl !== existing.baseUrl && !input.apiKey?.trim() && input.clearApiKey !== true) {
      throw new ProviderError('更换 URL 时请重新输入 API Key，或选择免密，避免将原密钥发送到其他地址');
    }
    return { baseUrl, apiKey, existing };
  }

  commit(providers, activeId) {
    const next = { ...this.config, providers, activeProviderId: activeId };
    this.applyActive(next, providers.find(p => p.id === activeId));
    writeJsonAtomic(this.filename, next);
    this.providers = providers;
    this.activeId = activeId;
    Object.assign(this.config, next);
  }

  save(input) {
    const { baseUrl, apiKey, existing } = this.credentials(input);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new ProviderError('请填写 1–100 字的供应商名称');
    if (!input.models || typeof input.models.default !== 'string' || !input.models.default.trim()) throw new ProviderError('请选择或填写默认模型');
    const models = {};
    for (const slot of SLOTS) {
      const model = input.models[slot] || input.models.default;
      if (typeof model !== 'string' || model.length > 300 || /[\r\n]/.test(model)) throw new ProviderError('模型 ID 格式不正确');
      models[slot] = model.trim();
    }
    const catalog = input.catalog === undefined ? (existing?.catalog || []) : cleanCatalog(input.catalog);
    const modelAliases = Object.fromEntries(Object.entries(existing?.modelAliases || {}).map(([alias, target]) => {
      const slot = SLOTS.find(slot => existing.models?.[slot] === target);
      return [alias, slot ? models[slot] : target];
    }));
    const provider = { id: existing?.id || crypto.randomUUID(), name: input.name.trim(), baseUrl, apiKey, models,
      modelAliases, catalog };
    const providers = existing ? this.providers.map(p => p.id === provider.id ? provider : p) : [...this.providers, provider];
    this.commit(providers, this.activeId);
    return provider.id;
  }

  activate(id) {
    if (!this.providers.some(p => p.id === id)) throw new ProviderError('供应商不存在', 404);
    this.commit(this.providers, id);
  }

  remove(id) {
    if (!this.providers.some(p => p.id === id)) throw new ProviderError('供应商不存在', 404);
    if (id === this.activeId) throw new ProviderError('请先启用其他供应商，再删除当前供应商');
    this.commit(this.providers.filter(p => p.id !== id), this.activeId);
  }
}

export function cleanCatalog(data) {
  if (!Array.isArray(data) || data.length > 10000) throw new ProviderError('上游未返回有效模型列表');
  const seen = new Set();
  return data.flatMap(item => {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 300 || seen.has(id)) return [];
    seen.add(id);
    const positive = value => Number.isFinite(value) && value > 0 ? value : undefined;
    return [{ id, context_length: positive(item?.context_length || item?.max_allowed_size), max_output_tokens: positive(item?.max_output_tokens) }];
  });
}
