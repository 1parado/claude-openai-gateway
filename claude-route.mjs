// CLI 包装器读取专用配置中的地址，以支持自定义网关端口。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let baseUrl = `http://127.0.0.1:${process.env.PORT || 8787}`;
try {
  const settings = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./claude-profile/settings.json', import.meta.url)), 'utf8'));
  const configured = settings.env?.ANTHROPIC_BASE_URL;
  const url = new URL(configured);
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) baseUrl = configured.replace(/\/+$/, '');
} catch { /* 首次生成配置前使用默认地址 */ }
console.log(baseUrl);
