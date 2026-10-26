'use strict';

const DEFAULT_CONFIG = Object.freeze({ upstream: 'https://api.deepseek.com', timezone: 'Asia/Shanghai', includeUsage: false, prices: [] });
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function validateConfig(value, port) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置格式不正确');
  let upstream;
  try { upstream = new URL(value.upstream); } catch { throw new Error('上游地址必须是完整的 HTTP / HTTPS 地址'); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('上游地址仅支持 HTTP / HTTPS，不应包含密钥、查询参数或片段');
  if (/\/(?:chat\/completions|responses|completions|messages|models)\/?$/.test(upstream.pathname)) throw new Error('请填写上游 API 基础地址，不要包含 /chat/completions 等接口路径');
  if (['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) && Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)) === port) throw new Error('上游地址不能指向本机统计代理自身');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); } catch { throw new Error('时区无效，例如 Asia/Shanghai'); }
  if (!Array.isArray(value.prices) || value.prices.length > 200) throw new Error('最多可配置 200 个模型单价');
  const seen = new Set();
  const prices = value.prices.map(row => {
    if (!row || typeof row.model !== 'string' || !row.model.trim() || row.model.length > 200 || /[\x00-\x1f]/.test(row.model)) throw new Error('模型 ID 不能为空，且不超过 200 个字符');
    const model = row.model.trim();
    if (seen.has(model)) throw new Error('模型单价重复：' + model);
    seen.add(model);
    const result = { model };
    for (const key of PRICE_KEYS) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1e8) throw new Error('价格必须为非负数，单位为人民币 / 百万 Tokens');
      result[key] = row[key];
    }
    return result;
  });
  return { upstream: upstream.toString().replace(/\/$/, ''), timezone: String(value.timezone), includeUsage: value.includeUsage === true, prices };
}

function rateFor(prices, model, requestedModel) {
  const exact = prices.find(row => row.model === model) || prices.find(row => row.model === requestedModel);
  if (exact) return exact;
  const patterns = prices.filter(row => row.model.endsWith('*')).sort((a, b) => b.model.length - a.model.length);
  return patterns.find(row => model.startsWith(row.model.slice(0, -1)) || (requestedModel || '').startsWith(row.model.slice(0, -1))) || null;
}
function costFor(usage, rate) {
  if (!usage || !rate) return null;
  const parts = Object.fromEntries(PRICE_KEYS.map(key => [key, usage[key] * rate[key] / 1000000]));
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

module.exports = { DEFAULT_CONFIG, PRICE_KEYS, validateConfig, rateFor, costFor };
