'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRefreshQueue } = require('../src/refresh-queue');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('a refresh requested during a run is repeated instead of dropped', async () => {
  let runs = 0, release;
  const queue = createRefreshQueue(async () => {
    runs++;
    if (runs === 1) await new Promise(resolve => { release = resolve; });
  });
  const first = queue();
  const second = queue();
  const third = queue();
  await tick();
  assert.equal(runs, 1);
  release();
  await first; await second; await third;
  await tick();
  assert.equal(runs, 2); // 三次请求合并成“当前一次 + 结束后一次”
});

test('a failing refresh does not block the next one', async () => {
  let runs = 0;
  const queue = createRefreshQueue(async () => {
    runs++;
    if (runs === 1) throw new Error('boom');
  });
  await assert.rejects(queue(), /boom/);
  await tick();
  await queue();
  assert.equal(runs, 2);
});

test('calls that do not overlap still run separately', async () => {
  let runs = 0;
  const queue = createRefreshQueue(async () => { runs++; });
  await queue();
  await queue();
  assert.equal(runs, 2);
});
