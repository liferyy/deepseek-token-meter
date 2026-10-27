'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsage, UsageCollector } = require('../src/usage');
const { costFor, rateFor, validateConfig, DEFAULT_CONFIG } = require('../src/config');
const { isPeak, configure } = require('../src/peak');
const { apply } = require('../src/holidays');

// Holiday dates normally come from the cached holiday-cn file; tests seed them directly.
apply({ source: 'test', updatedAt: '2026-01-01T00:00:00Z', days: [
  { date: '2026-10-01', isOffDay: true },
  { date: '2026-06-19', isOffDay: true },
  { date: '2026-02-16', isOffDay: true },
  { date: '2026-10-10', isOffDay: false }
]});

test('DeepSeek cache hits and reasoning are not double counted', () => {
  const usage = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 150 }, total_tokens: 1200 });
  assert.deepEqual(usage, { input: 100, cacheRead: 900, cacheWrite: 0, output: 200, reasoning: 150, prompt: 1000, total: 1200 });
  const rate = { input: 2, cacheRead: .2, cacheWrite: 2, output: 8 };
  const peak = costFor(usage, rate, Date.parse('2026-10-26T02:00:00Z')); // 周一 10:00 北京时间
  assert.equal(peak.peak, true); assert.ok(Math.abs(peak.total - .00198) < 1e-10);
  const offPeak = costFor(usage, rate, Date.parse('2026-10-26T04:00:00Z')); // 周一 12:00 北京时间
  assert.equal(offPeak.peak, false); assert.ok(Math.abs(offPeak.total - .00099) < 1e-10);
});
test('peak windows follow Beijing weekday hours and Chinese holidays', () => {
  const at = value => Date.parse(value);
  assert.equal(isPeak(at('2026-10-26T01:00:00Z')), true); // 周一 09:00
  assert.equal(isPeak(at('2026-10-26T03:59:00Z')), true); // 周一 11:59
  assert.equal(isPeak(at('2026-10-26T04:00:00Z')), false); // 12:00 午休
  assert.equal(isPeak(at('2026-10-26T06:00:00Z')), true); // 14:00
  assert.equal(isPeak(at('2026-10-26T10:00:00Z')), false); // 18:00
  assert.equal(isPeak(at('2026-10-25T02:00:00Z')), false); // 周日
  assert.equal(isPeak(at('2026-10-01T02:00:00Z')), false); // 国庆节（周四）
  assert.equal(isPeak(at('2026-06-19T02:00:00Z')), false); // 端午节（周五）
  assert.equal(isPeak(at('2026-02-16T02:00:00Z')), false); // 春节（周一）
  assert.equal(isPeak(at('2025-10-09T02:00:00Z')), true); // 假期结束后的周四
  assert.equal(isPeak(at('2026-10-10T02:00:00Z')), true); // 周六调休上班
  assert.equal(isPeak(at('2026-10-11T02:00:00Z')), false); // 周日
});
test('manual fallback ignores holidays and makeup workdays', () => {
  const at = value => Date.parse(value);
  configure({ ignoreHolidays: true });
  try {
    assert.equal(isPeak(at('2026-10-01T02:00:00Z')), true); // 国庆节周四按普通工作日
    assert.equal(isPeak(at('2026-10-10T02:00:00Z')), false); // 调休周六按周末
    assert.equal(isPeak(at('2026-10-26T02:00:00Z')), true); // 普通周一
    assert.equal(isPeak(at('2026-10-26T04:00:00Z')), false); // 午休仍空闲
  } finally { configure({}); }
});
test('cached details fallback and unknown usage', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 4 }).input, 20);
  assert.equal(normalizeUsage(null), null); assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }).total, 0);
});
test('inconsistent upstream values cannot create negative inputs or excess reasoning', () => {
  const usage = normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 100, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 15 } });
  assert.equal(usage.input, 0); assert.equal(usage.cacheRead, 10); assert.equal(usage.reasoning, 2);
});
test('SSE handles arbitrary UTF8 byte splits, CRLF and repeated cumulative usage exactly once', () => {
  const payload = 'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":900,"completion_tokens":200}}\r\n\r\n' +
    'data: {"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":900,"completion_tokens":200},"choices":[{"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const size of [1, 3, 19, 512]) {
    const parser = new UsageCollector(true), bytes = Buffer.from(payload);
    for (let i = 0; i < bytes.length; i += size) parser.push(bytes.subarray(i, i + size));
    assert.equal(parser.finish().total, 1200); assert.equal(parser.finish().total, 1200);
    assert.equal(parser.complete, true); assert.equal(parser.model, 'deepseek-chat');
  }
});
test('JSON responses and incomplete SSE preserve missing usage', () => {
  const parser = new UsageCollector(false); parser.push(Buffer.from('{"model":"deepseek-reasoner","usage":{"prompt_tokens":100,"completion_tokens":25}}'));
  assert.equal(parser.finish().total, 125);
  const sse = new UsageCollector(true); sse.push(Buffer.from('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
  assert.equal(sse.finish(), null); assert.equal(sse.complete, false);
});
test('final cache classification replaces uncached input and partial usage updates preserve input', () => {
  const parser = new UsageCollector(true);
  parser.acceptObject({ usage: { prompt_tokens: 1000, completion_tokens: 1 } });
  parser.acceptObject({ usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 200 } });
  assert.equal(parser.usage.input, 100); assert.equal(parser.usage.total, 1200);
  const anthropic = new UsageCollector(true);
  anthropic.acceptObject({ type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 1 } } });
  anthropic.acceptObject({ type: 'message_delta', usage: { output_tokens: 20 } });
  assert.equal(anthropic.usage.prompt, 150); assert.equal(anthropic.usage.total, 170);
});
test('Responses and Anthropic format usage parsing', () => {
  const response = new UsageCollector(true); response.push(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"model":"deepseek-test","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":90},"output_tokens":20}}}\n\n'));
  assert.equal(response.finish().total, 120); assert.equal(response.usage.input, 10);
  assert.equal(normalizeUsage({ input_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 10 }).total, 180);
});
test('pricing matches response ID, requested alias, then most specific wildcard', () => {
  const p = [{ model: '*', input: 1 }, { model: 'deepseek-*', input: 2 }, { model: 'alias', input: 3 }, { model: 'deepseek-chat', input: 4 }];
  assert.equal(rateFor(p, 'deepseek-chat', 'alias').input, 4);
  assert.equal(rateFor(p, 'deepseek-version', 'alias').input, 3);
  assert.equal(rateFor(p, 'deepseek-version').input, 2);
  assert.equal(costFor({ input: 100 }, null), null);
});
test('config validation rejects loopbacks, duplicate IDs and invalid prices', () => {
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, upstream: 'http://127.0.0.1:18765/v1' }, 18765), /自身/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, timezone: 'foo' }, 18765), /时区/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, prices: [{ model: 'm', input: -1 }] }, 18765), /价格/);
  const row = { model: 'm', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, prices: [row, row] }, 18765), /重复/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, upstream: 'https://user:password@api.deepseek.com' }, 18765));
  assert.equal(validateConfig({ ...DEFAULT_CONFIG }, 18765).upstream, 'https://api.deepseek.com');
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, ignoreHolidays: true }, 18765).ignoreHolidays, true);
});
