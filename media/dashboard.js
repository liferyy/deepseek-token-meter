(function () {
  'use strict';
  const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.__METER_PREVIEW__;
  const $ = id => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const colors = { input: '#19a5ff', cacheRead: '#39c971', cacheWrite: '#526fda', output: '#e7b823' };
  const labels = { input: '输入（非缓存）', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '模型输出' };
  const priceKeys = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const saved = bridge?.getState?.() || {};
  let query = { range: 'today', model: '', page: 1, size: 20, ...saved.query }, state, prices = [], pricesDirty = false, settingsDirty = false, editingConfig;
  let toastTimer, resizeTimer, pendingSave;
  const short = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
  const number = n => Number(n || 0).toLocaleString('zh-CN');
  const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < .01 ? 6 : 4 });
  const post = (type, data = {}) => bridge?.postMessage({ type, ...data });
  function node(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
  function svg(tag, attrs = {}, text) { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text != null) n.textContent = text; return n; }
  function notice(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 4500);
  }
  function persist() { bridge?.setState?.({ query, tab: editingConfig || 'overview' }); }
  function refresh() { persist(); post('refresh', { query }); }
  function tab(name) {
    editingConfig = name;
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== name;
    for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('selected', button.dataset.tab === name);
    persist(); if (name === 'overview') requestAnimationFrame(drawChart);
  }
  function updateRangeButtons() {
    for (const b of document.querySelectorAll('[data-range]')) b.classList.toggle('selected', b.dataset.range === query.range);
    $('custom-dates').hidden = query.range !== 'custom';
  }
  function formatTime(value, date = false) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: state?.timezone || 'Asia/Shanghai', ...(date ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: date ? undefined : '2-digit', hourCycle: 'h23' }).format(new Date(value));
  }
  function formatDate(value) {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: state?.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  }
  function render(value) {
    state = value;
    const t = value.totals, service = value.service;
    $('service-pill').classList.toggle('stopped', !service.running);
    $('service-pill').lastElementChild.textContent = service.running ? '代理运行中 · ' + service.port : '代理已停止';
    $('toggle-service').textContent = service.running ? '停止代理' : '启动代理';
    $('base-url').textContent = 'http://127.0.0.1:' + service.port + '/v1';
    $('full-url').textContent = 'http://127.0.0.1:' + service.port + '/v1/chat/completions';
    $('data-directory').textContent = service.dataDirectory;
    $('range-caption').textContent = '按请求开始时间统计 · ' + value.timezone + ' · 峰谷按北京时间' + (query.model ? ' · ' + query.model : '');
    $('requests').textContent = number(t.requests);
    $('request-detail').textContent = '成功 ' + number(t.success) + ' / 异常 ' + number(t.errors) + (t.cancelled ? ' / 取消 ' + number(t.cancelled) : '');
    $('tokens').textContent = short(t.total);
    $('tokens').title = number(t.total) + ' Tokens';
    $('token-detail').textContent = '输入 ' + short(t.prompt) + ' / 输出 ' + short(t.output);
    const measured = t.requests - t.missingUsage;
    $('cost').textContent = measured && t.unpriced === measured ? '未定价' : !measured && t.requests ? '—' : money(t.cost);
    $('cost-detail').textContent = measured && t.unpriced === measured ? '全部请求未定价'
      : '高峰 ' + money(t.costPeak) + ' · 空闲 ' + money(t.costOffPeak) + (t.unpriced ? ' · ' + t.unpriced + ' 次未定价' : '');
    $('cost-detail').title = '缓存读写 ' + money(t.cacheCost) + ' · 高峰时段按高峰单价，空闲时段按 50%';
    const messages = [];
    if (!service.running) messages.push('代理已停止，启动后继续采集；历史统计仍可查看。');
    if (service.active) messages.push(service.active + ' 个请求正在进行，结束后计入统计。');
    if (t.missingUsage) messages.push(t.missingUsage + ' 次请求未收到 usage，未纳入 Token 与费用；这不表示零消耗。');
    if (t.partialUsage) messages.push(t.partialUsage + ' 次中断请求仅收到部分 usage，实际消耗可能更高。');
    if (t.unpriced) messages.push(t.unpriced + ' 次请求未设置模型单价。');
    messages.push(...(value.warnings || []));
    $('data-notice').hidden = !messages.length; $('data-notice').textContent = messages.join(' ');
    $('updated-at').textContent = '更新于 ' + formatTime(value.generatedAt) + ' · ' + value.timezone;
    const bucketStats = value.bucketStats || { count: 0, average: 0, median: 0 };
    $('chart-summary').textContent = bucketStats.count
      ? '单位：Tokens · 有请求时段平均 ' + short(Math.round(bucketStats.average)) + ' / 中位数 ' + short(Math.round(bucketStats.median)) + '（' + bucketStats.count + ' 个时段）'
      : '单位：Tokens · 当前区间没有请求';
    const holiday = value.holidays;
    $('holiday-status').textContent = holiday && holiday.updatedAt
      ? '法定节假日数据：' + formatDate(holiday.updatedAt) + ' 更新 · 覆盖 ' + (holiday.years.length ? holiday.years.join('、') : '—') + ' 年 · 来源 holiday-cn，启动插件时自动刷新'
      : '法定节假日数据尚未获取，暂时只按周末与工作时间判断峰谷；联网启动插件后会自动写入本地缓存。';
    $('page-size').value = String(query.size);
    const selected = $('model-filter').value || query.model;
    $('model-filter').replaceChildren(node('option', '全部模型'));
    $('model-filter').firstChild.value = '';
    for (const model of value.allModels) { const option = node('option', model); option.value = model; $('model-filter').append(option); }
    $('model-filter').value = selected;
    if (!pricesDirty && !pendingSave) { prices = structuredClone(value.config.prices); renderPrices(); }
    if (!settingsDirty && !pendingSave) {
      $('upstream').value = value.config.upstream; $('timezone').value = value.config.timezone; $('include-usage').checked = value.config.includeUsage;
    }
    $('known-models').replaceChildren();
    for (const model of [...new Set([...value.allModels, 'deepseek-chat', 'deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-pro'])]) { const option = node('option'); option.value = model; $('known-models').append(option); }
    drawGauge(t.cacheHitRate); drawChart(); drawHeatmap(); renderModels(); renderRecent(); updateRangeButtons();
  }
  function drawGauge(rate) {
    const s = svg('svg', { viewBox: '0 0 220 112', role: 'img', 'aria-label': rate == null ? '缓存命中率暂无数据' : '缓存命中率 ' + (rate * 100).toFixed(2) + '%' });
    const path = 'M 25 96 A 85 85 0 0 1 195 96';
    s.append(svg('path', { d: path, fill: 'none', stroke: '#292f2c', 'stroke-width': 12, 'stroke-linecap': 'round' }));
    if (rate != null) s.append(svg('path', { d: path, fill: 'none', stroke: colors.cacheRead, 'stroke-width': 12, 'stroke-linecap': 'round', pathLength: 100, 'stroke-dasharray': Math.max(0, Math.min(1, rate)) * 100 + ' 100' }));
    s.append(svg('text', { x: 110, y: 95, 'text-anchor': 'middle', fill: '#edf0ee', 'font-size': 24, 'font-weight': 500 }, rate == null ? '—' : (rate * 100).toFixed(2) + '%'));
    $('gauge').replaceChildren(s);
  }
  function drawChart() {
    if (!state || $('overview').hidden) return;
    const chart = $('trend-chart'), width = Math.max(300, $('chart-wrap').clientWidth), height = $('chart-wrap').clientHeight;
    chart.replaceChildren(); chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const buckets = state.buckets, left = 46, right = 9, top = 13, bottom = 31, w = width - left - right, h = height - top - bottom;
    const largest = Math.max(1, ...buckets.map(b => b.total));
    const max = largest * 1.12;
    for (let i = 0; i <= 4; i++) {
      const y = top + h * i / 4;
      chart.append(svg('line', { x1: left, y1: y, x2: width - right, y2: y, stroke: '#262c2f', 'stroke-width': 1, 'stroke-dasharray': i === 4 ? '' : '3 5' }));
      chart.append(svg('text', { x: left - 9, y: y + 3, fill: '#6f7b82', 'font-size': 9, 'text-anchor': 'end' }, short(Math.round(max * (1 - i / 4)))));
    }
    const gap = w / Math.max(1, buckets.length), barWidth = Math.max(2, Math.min(30, gap * .4)), labelEvery = Math.max(1, Math.ceil(buckets.length / (width < 700 ? 7 : 13)));
    buckets.forEach((bucket, i) => {
      const x = left + gap * (i + .5), g = svg('g', { tabindex: '0', role: 'img', 'aria-label': bucket.label + '，总量 ' + number(bucket.total) + ' Tokens' });
      if (!bucket.total) g.append(svg('rect', { x: x - barWidth / 2, y: top + h - 3, width: barWidth, height: 3, fill: '#303639', rx: 1 }));
      let accumulated = 0;
      for (const key of Object.keys(colors)) {
        const barHeight = h * bucket[key] / max;
        if (barHeight) g.append(svg('rect', { x: x - barWidth / 2, y: top + h - accumulated - barHeight, width: barWidth, height: Math.max(.5, barHeight), fill: colors[key] }));
        accumulated += barHeight;
      }
      g.append(svg('rect', { x: left + gap * i, y: top, width: Math.max(1, gap), height: h + 8, fill: 'transparent' }));
      const show = () => showTooltip(bucket, x, width);
      g.addEventListener('mouseenter', show); g.addEventListener('focus', show); g.addEventListener('mouseleave', () => { $('chart-tooltip').hidden = true; }); g.addEventListener('blur', () => { $('chart-tooltip').hidden = true; });
      chart.append(g);
      if (i % labelEvery === 0 || (i === buckets.length - 1 && i % labelEvery > labelEvery / 2)) chart.append(svg('text', { x, y: height - 8, fill: '#858f96', 'font-size': 10, 'text-anchor': 'middle' }, bucket.label));
    });
    const stats = state.bucketStats || { average: 0, median: 0 };
    const average = stats.average || 0, median = stats.median || 0;
    const lineLabel = (text, x, y, color, anchor) => {
      const width = text.replace(/[^\x00-\xff]/g, '00').length * 5.6 + 10;
      const boxX = anchor === 'end' ? x - width : x - 3;
      chart.append(svg('rect', { x: boxX, y: y - 10, width, height: 14, rx: 3, fill: '#111314', opacity: .82 }));
      chart.append(svg('text', { x, y, fill: color, 'font-size': 10, 'text-anchor': anchor }, text));
    };
    if (average > 0) {
      const y = top + h - average / max * h;
      chart.append(svg('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: colors.output, 'stroke-width': 1.4, 'stroke-dasharray': '6 5', opacity: .85 }));
      lineLabel('平均 ' + short(Math.round(average)), left + 4, y - 7, '#c9a839', 'start');
    }
    if (median > 0) {
      const y = top + h - median / max * h;
      chart.append(svg('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: '#8f7bff', 'stroke-width': 1.4, 'stroke-dasharray': '2 4', opacity: .9 }));
      lineLabel('中位数 ' + short(Math.round(median)), width - right - 2, y + 13, '#a99cff', 'end');
    }
  }
  function showTooltip(bucket, x, width) {
    const tip = $('chart-tooltip'); tip.replaceChildren(node('h4', formatTime(bucket.at, true)));
    for (const key of Object.keys(colors)) { const p = node('p'); const label = node('span', labels[key]); label.style.color = colors[key]; p.append(label, node('span', number(bucket[key]))); tip.append(p); }
    const total = node('p', null, 'tooltip-total'); total.append(node('span', '总量 / 调用'), node('span', number(bucket.total) + ' / ' + bucket.requests)); tip.append(total);
    tip.hidden = false; tip.style.left = Math.max(0, Math.min(width - 220, x - 100)) + 'px'; tip.style.top = '9px';
  }
  function drawHeatmap() {
    if (!state) return;
    const days = state.heatmap, first = new Date(days[0].date + 'T00:00:00Z').getUTCDay(), totalCells = Math.ceil((days.length + first) / 7) * 7;
    const grid = node('div', null, 'heat-grid'); grid.style.gridTemplateColumns = 'repeat(' + totalCells / 7 + ',1fr)';
    const peak = Math.max(1, ...days.map(d => d.total));
    let active = 0;
    for (let i = 0; i < totalCells; i++) {
      const day = days[i - first];
      if (!day) { const empty = node('span'); empty.style.visibility = 'hidden'; grid.append(empty); continue; }
      const c = node('button', null, 'heat-cell');
      const intensity = !day.total ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(day.total / peak) * 4)));
      const color = ['#292d2f', '#17452a', '#206a3d', '#28904e', '#39c971'][intensity];
      c.style.background = color; c.style.setProperty('--cell-color', color);
      const title = day.date + ' · ' + number(day.total) + ' Tokens · ' + day.requests + ' 次调用';
      c.title = title; c.setAttribute('aria-label', title);
      c.addEventListener('click', () => { query.range = 'custom'; query.from = query.to = day.date; query.page = 1; $('date-from').value = $('date-to').value = day.date; updateRangeButtons(); refresh(); });
      grid.append(c); if (day.requests) active++;
    }
    const months = node('div', null, 'heat-months');
    for (let i = 0; i < 12; i++) { const at = Math.floor(i * (days.length - 1) / 11); months.append(node('span', Number(days[at].date.slice(5, 7)) + '月')); }
    $('heatmap').replaceChildren(grid, months); $('activity-count').textContent = active + ' 个活跃日';
  }
  function renderModels() {
    $('model-rows').replaceChildren(); $('empty-guide').hidden = state.models.length > 0;
    for (const model of state.models) {
      const row = node('tr'), cell = node('td'), title = node('span', null, 'model-name'), button = node('button', model.model, 'model-link');
      button.addEventListener('click', () => { query.model = model.model; refresh(); });
      title.append(node('i', null, 'model-dot'), button); if (model.unpriced) title.append(node('span', '未定价', 'mini-badge')); cell.append(title); row.append(cell);
      for (const key of ['requests', 'input', 'cacheRead', 'cacheWrite', 'output', 'total']) { const c = node('td', key === 'requests' ? number(model[key]) : short(model[key])); c.title = number(model[key]); row.append(c); }
      const cost = node('td', model.unpriced === model.requests - model.missingUsage && model.unpriced > 0 ? '未定价' : money(model.cost) + (model.unpriced ? ' + 待定价' : ''));
      if (model.missingUsage === model.requests) cost.textContent = '—';
      cost.title = '高峰 ' + money(model.costPeak) + ' · 空闲 ' + money(model.costOffPeak);
      row.append(cost); $('model-rows').append(row);
    }
  }
  function renderRecent() {
    const recent = state.recent || { items: [], total: 0, page: 1, size: 20, pages: 1 };
    query.page = recent.page;
    $('recent-rows').replaceChildren();
    if (!recent.items.length) {
      const tr = node('tr'), td = node('td', '当前筛选条件下没有请求记录。', 'recent-empty');
      td.colSpan = 7; tr.append(td); $('recent-rows').append(tr);
    }
    for (const event of recent.items) {
      const tr = node('tr');
      tr.append(node('td', formatTime(event.startedAt, true)),
        node('td', event.peak ? '高峰' : '空闲', event.peak ? 'peak-label' : 'offpeak-label'), node('td', event.model));
      const info = node('td', null, 'recent-info');
      if (event.title) info.append(node('span', event.title, 'request-title'));
      if (event.summary) info.append(node('span', event.summary, 'request-summary'));
      if (!event.title && !event.summary) info.append(node('span', '未记录概要', 'unknown-label'));
      info.title = [event.title, event.summary].filter(Boolean).join(' · ');
      tr.append(info);
      const status = node('td', event.status === 'success' ? '成功' : event.status === 'cancelled' ? '已取消' : '异常');
      status.className = event.status === 'success' ? 'success-label' : 'error-label'; status.title = event.errorCode || ('HTTP ' + event.httpStatus); tr.append(status);
      const tokens = node('td', event.usage ? short(event.usage.total) + (event.partial ? '（部分）' : '') : '用量未知'); if (!event.usage) tokens.className = 'unknown-label'; tr.append(tokens, node('td', (event.durationMs / 1000).toFixed(1) + 's')); $('recent-rows').append(tr);
    }
    $('recent-total').textContent = '共 ' + number(recent.total) + ' 条 · 每页 ' + recent.size + ' 条';
    $('page-label').textContent = recent.page + ' / ' + recent.pages;
    $('page-prev').disabled = recent.page <= 1;
    $('page-next').disabled = recent.page >= recent.pages;
  }
  function renderPrices() {
    const tbody = $('price-rows'); tbody.replaceChildren();
    if (!prices.length) { const tr = node('tr'), td = node('td', '尚未配置模型价格。添加模型后，填写平台当前的高峰时段人民币单价。'); td.colSpan = 6; td.style.padding = '30px 12px'; tr.append(td); tbody.append(tr); }
    prices.forEach((price, index) => {
      const tr = node('tr');
      for (const key of ['model', ...priceKeys]) {
        const td = node('td'), input = node('input'); input.type = key === 'model' ? 'text' : 'number'; input.value = price[key]; input.setAttribute('aria-label', price.model + ' ' + (key === 'model' ? '模型 ID' : labels[key] + '高峰价格'));
        if (key !== 'model') { input.min = '0'; input.step = 'any'; input.inputMode = 'decimal'; input.required = true; } else input.maxLength = 200;
        input.addEventListener('input', () => { price[key] = key === 'model' ? input.value : input.value === '' ? null : Number(input.value); pricesDirty = true; }); td.append(input); tr.append(td);
      }
      const td = node('td'), remove = node('button', '×', 'delete-price'); remove.title = '删除该模型定价'; remove.setAttribute('aria-label', '删除 ' + price.model + ' 定价'); remove.addEventListener('click', () => { prices.splice(index, 1); pricesDirty = true; renderPrices(); }); td.append(remove); tr.append(td); tbody.append(tr);
    });
  }
  function addPrice() {
    const model = $('new-model').value.trim();
    if (!model) return notice('请先输入模型 ID', true);
    if (prices.some(p => p.model === model)) return notice('该模型已经在价格列表中', true);
    prices.push({ model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); pricesDirty = true; $('new-model').value = ''; renderPrices();
  }
  function saveConfig(kind) {
    if (!state) return;
    const config = structuredClone(state.config);
    if (kind === 'prices') {
      if (prices.some(row => !row.model.trim() || priceKeys.some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0))) return notice('请填写完整的模型 ID 和非负高峰单价', true);
      config.prices = structuredClone(prices);
    } else { config.upstream = $('upstream').value.trim(); config.timezone = $('timezone').value.trim(); config.includeUsage = $('include-usage').checked; }
    pendingSave = kind; $('save-prices').disabled = $('save-settings').disabled = true; post('saveConfig', { value: config });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.preview) $('preview-badge').hidden = false;
    if (message.type === 'state') render(message.value);
    if (message.type === 'saved') {
      if (pendingSave === 'prices') pricesDirty = false; else settingsDirty = false;
      pendingSave = null; $('save-prices').disabled = $('save-settings').disabled = false; notice('已保存，费用已按当前单价重新计算');
    }
    if (message.type === 'error') { pendingSave = null; $('save-prices').disabled = $('save-settings').disabled = false; notice(message.message, true); }
    if (message.type === 'notice') notice(message.message);
  });
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => tab(button.dataset.tab));
  for (const button of document.querySelectorAll('[data-range]')) button.addEventListener('click', () => {
    query.range = button.dataset.range; query.page = 1; updateRangeButtons();
    if (query.range === 'custom') {
      if (!query.from) { query.from = state?.heatmap.at(-1)?.date || new Date().toISOString().slice(0, 10); query.to = query.from; }
      $('date-from').value = query.from; $('date-to').value = query.to;
    } else refresh();
  });
  $('apply-dates').addEventListener('click', () => { if (!$('date-from').value || !$('date-to').value) return notice('请选择开始和结束日期', true); query.from = $('date-from').value; query.to = $('date-to').value; query.page = 1; refresh(); });
  $('model-filter').addEventListener('change', () => { query.model = $('model-filter').value; query.page = 1; refresh(); });
  $('page-prev').addEventListener('click', () => { if (state?.recent?.page > 1) { query.page = state.recent.page - 1; refresh(); } });
  $('page-next').addEventListener('click', () => { if (state?.recent && state.recent.page < state.recent.pages) { query.page = state.recent.page + 1; refresh(); } });
  $('page-size').addEventListener('change', () => { query.size = Number($('page-size').value); query.page = 1; refresh(); });
  $('refresh').addEventListener('click', refresh);
  $('save-prices').addEventListener('click', () => saveConfig('prices')); $('save-settings').addEventListener('click', () => saveConfig('settings'));
  $('add-price').addEventListener('click', addPrice); $('new-model').addEventListener('keydown', e => { if (e.key === 'Enter') addPrice(); });
  for (const id of ['upstream', 'timezone', 'include-usage']) $(id).addEventListener('input', () => { settingsDirty = true; });
  $('toggle-service').addEventListener('click', () => post(state?.service.running ? 'stop' : 'start'));
  $('copy-url').addEventListener('click', () => post('copyUrl')); $('copy-full').addEventListener('click', () => post('copyUrl', { full: true }));
  for (const type of ['export', 'backup', 'import']) $(type).addEventListener('click', () => post(type));
  $('open-data').addEventListener('click', () => post('openData')); $('empty-connect').addEventListener('click', () => tab('settings'));
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 100); });
  updateRangeButtons(); tab(saved.tab || 'overview'); if (query.from) $('date-from').value = query.from; if (query.to) $('date-to').value = query.to;
  if (![10, 20, 50, 100].includes(Number(query.size))) query.size = 20;
  if (!Number.isFinite(Number(query.page)) || Number(query.page) < 1) query.page = 1;
  $('page-size').value = String(query.size);
  post('ready', { query });
})();
