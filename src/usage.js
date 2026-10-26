'use strict';

const { StringDecoder } = require('node:string_decoder');

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// DeepSeek prompt_tokens already includes cache hits; reasoning is inside completion_tokens.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'prompt_cache_hit_tokens'].some(k => typeof raw[k] === 'number')) return null;
  const hit = count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens);
  const write = count(raw.cache_creation_input_tokens ?? raw.prompt_tokens_details?.cache_creation_tokens);
  const anthropic = raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined;
  const prompt = raw.prompt_tokens !== undefined ? count(raw.prompt_tokens)
    : raw.input_tokens !== undefined ? count(raw.input_tokens) + (anthropic ? hit + write : 0)
    : count(raw.prompt_cache_miss_tokens) + hit + write;
  const cacheRead = Math.min(prompt, hit);
  const cacheWrite = Math.min(Math.max(0, prompt - cacheRead), write);
  const output = count(raw.completion_tokens ?? raw.output_tokens);
  return { input: Math.max(0, prompt - cacheRead - cacheWrite), cacheRead, cacheWrite, output,
    reasoning: Math.min(output, count(raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens)),
    prompt, total: prompt + output };
}

class UsageCollector {
  constructor(isStream) {
    this.isStream = isStream;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.dataLines = [];
    this.usage = null;
    this.rawUsage = {};
    this.model = '';
    this.complete = false;
    this.apiError = false;
    this.truncated = false;
  }
  acceptObject(object) {
    if (!object || typeof object !== 'object') return;
    const payload = object.response || object.message || object;
    if (typeof payload.model === 'string') this.model = payload.model.slice(0, 200);
    const raw = payload.usage || object.usage;
    if (raw) {
      // Usage blocks are cumulative. Preserve omitted fields in partial updates,
      // then repartition input when the final block supplies cache details.
      for (const key of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (typeof raw[key] === 'number') this.rawUsage[key] = raw[key];
      }
      for (const key of ['prompt_tokens_details', 'completion_tokens_details', 'input_tokens_details', 'output_tokens_details']) {
        if (raw[key] && typeof raw[key] === 'object') this.rawUsage[key] = { ...this.rawUsage[key], ...raw[key] };
      }
      this.usage = normalizeUsage(this.rawUsage);
    }
    if (object.error || object.type === 'error' || ['response.failed', 'response.incomplete'].includes(object.type)) this.apiError = true;
    if (['response.completed', 'message_stop'].includes(object.type)) this.complete = true;
    for (const choice of object.choices || []) {
      if (choice.finish_reason != null) this.complete = true;
      if (['aborted', 'insufficient_system_resource'].includes(choice.finish_reason)) this.apiError = true;
    }
  }
  flushEvent() {
    if (!this.dataLines.length) return;
    const data = this.dataLines.join('\n').trim();
    this.dataLines = [];
    if (data === '[DONE]') { this.complete = true; return; }
    try { this.acceptObject(JSON.parse(data)); } catch { /* Ignore keepalive or non-JSON events. */ }
  }
  consumeLines(final = false) {
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.acceptLine(line);
    }
    if (final && this.buffer) { this.acceptLine(this.buffer.replace(/\r$/, '')); this.buffer = ''; }
    if (final) this.flushEvent();
    if (this.buffer.length > 8 * 1024 * 1024) { this.buffer = ''; this.truncated = true; }
  }
  acceptLine(line) {
    if (!line) this.flushEvent();
    else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
    if (this.dataLines.reduce((s, line) => s + line.length, 0) > 8 * 1024 * 1024) { this.dataLines = []; this.truncated = true; }
  }
  push(chunk) {
    if (!this.isStream && this.truncated) return;
    this.buffer += this.decoder.write(chunk);
    if (this.isStream) this.consumeLines();
    else if (this.buffer.length > 16 * 1024 * 1024) { this.buffer = ''; this.truncated = true; }
  }
  finish() {
    if (this.finished) return this.usage;
    this.finished = true;
    this.buffer += this.decoder.end();
    if (this.isStream) this.consumeLines(true);
    else { try { this.acceptObject(JSON.parse(this.buffer)); this.complete = true; } catch { /* Missing usage stays visibly unknown. */ } }
    return this.usage;
  }
}

module.exports = { normalizeUsage, UsageCollector, count };
