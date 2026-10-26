'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { ServiceClient } = require('./service-client');

let client, panel, status, refreshTimer, lastQuery = { range: 'today' }, refreshPromise;
function compact(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }

async function activate(context) {
  const settings = vscode.workspace.getConfiguration('deepseekTokenMeter');
  client = await new ServiceClient(context.globalStorageUri.fsPath, context.extensionPath, settings.get('port', 18765)).init();
  const tree = { getTreeItem: item => item, getChildren: () => [], onDidChangeTreeData: new vscode.EventEmitter().event };
  context.subscriptions.push(vscode.window.registerTreeDataProvider('deepseekTokenMeter.welcome', tree));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'deepseekTokenMeter.open'; status.name = 'DeepSeek 本机用量'; status.text = '$(pulse) DeepSeek'; status.show(); context.subscriptions.push(status);
  const guard = fn => async (...args) => { try { return await fn(...args); } catch (error) { vscode.window.showErrorMessage('DeepSeek 本机用量：' + error.message); } };
  for (const [name, action] of Object.entries({
    open: () => openPanel(context),
    start: async () => { await client.ensure(); await refresh(); vscode.window.showInformationMessage('DeepSeek 本机代理已启动'); },
    stop: async () => { if (await client.health()) await client.request('/_meter/stop', 'POST'); await new Promise(r => setTimeout(r, 180)); await refresh(); },
    copyUrl: async () => { await client.ensure(); await vscode.env.clipboard.writeText('http://127.0.0.1:' + client.port + '/v1'); vscode.window.showInformationMessage('已复制 Trae 基础请求地址，完整 URL 开关请关闭'); },
    export: exportCsv
  })) context.subscriptions.push(vscode.commands.registerCommand('deepseekTokenMeter.' + name, guard(action)));
  if (settings.get('autoStart', true)) { try { await client.ensure(); } catch (error) { vscode.window.showWarningMessage('DeepSeek 本机代理：' + error.message); } }
  await refresh();
  refreshTimer = setInterval(() => refresh().catch(() => {}), 5000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const state = await client.state(lastQuery);
      const today = lastQuery.range === 'today' && !lastQuery.model ? state : await client.state({ range: 'today' });
      status.text = (state.service.running ? '$(pulse) ' : '$(debug-pause) ') + 'DeepSeek · ' + compact(today.totals.total) + ' T';
      status.tooltip = '今日已记录 ' + today.totals.requests + ' 次调用；' + (state.service.running ? '本机代理运行中' : '本机代理已停止') + '\n点击打开统计面板';
      panel?.webview.postMessage({ type: 'state', value: state });
    } catch (error) { if (panel) panel.webview.postMessage({ type: 'error', message: error.message }); status.text = '$(warning) DeepSeek'; }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}

async function openPanel(context) {
  if (panel) { panel.reveal(); await refresh(); return; }
  panel = vscode.window.createWebviewPanel('deepseekTokenMeter.dashboard', 'DeepSeek 本机用量', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
  const webview = panel.webview;
  const nonce = randomBytes(16).toString('hex');
  let html = await fs.readFile(path.join(context.extensionPath, 'media', 'dashboard.html'), 'utf8');
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`;
  html = html.replace('<!--CSP-->', '<meta http-equiv="Content-Security-Policy" content="' + csp + '">')
    .replace('__STYLE_URI__', webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard.css')).toString())
    .replace('__SCRIPT_URI__', webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard.js')).toString())
    .replace('__NONCE__', nonce);
  webview.html = html;
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  webview.onDidReceiveMessage(async message => {
    try {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready' || message.type === 'refresh') { if (message.query) lastQuery = sanitizeQuery(message.query); await refresh(); }
      if (message.type === 'saveConfig') { await client.ensure(); await client.request('/_meter/config', 'POST', message.value); webview.postMessage({ type: 'saved' }); await refresh(); }
      if (message.type === 'start') { await client.ensure(); await refresh(); }
      if (message.type === 'stop') await vscode.commands.executeCommand('deepseekTokenMeter.stop');
      if (message.type === 'copyUrl') { await vscode.env.clipboard.writeText('http://127.0.0.1:' + client.port + (message.full ? '/v1/chat/completions' : '/v1')); webview.postMessage({ type: 'notice', message: '请求地址已复制' }); }
      if (message.type === 'export') await exportCsv();
      if (message.type === 'backup') {
        await client.ensure();
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('node:os').homedir(), 'deepseek-usage-backup.json')), filters: { JSON: ['json'] } });
        if (uri) { await fs.writeFile(uri.fsPath, await client.request('/_meter/backup', 'GET', undefined, true)); webview.postMessage({ type: 'notice', message: '用量备份已保存（不含 API Key）' }); }
      }
      if (message.type === 'import') {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
        if (uris?.length) {
          const stat = await fs.stat(uris[0].fsPath); if (stat.size > 64 * 1024 * 1024) throw new Error('单次导入文件不可超过 64 MB');
          const backup = JSON.parse(await fs.readFile(uris[0].fsPath, 'utf8')); await client.ensure();
          const result = await client.request('/_meter/import', 'POST', backup);
          webview.postMessage({ type: 'notice', message: '导入 ' + result.added + ' 条，跳过重复 ' + result.skipped + ' 条；保留当前价格' }); await refresh();
        }
      }
      if (message.type === 'openData') await vscode.env.openExternal(vscode.Uri.file(client.directory));
    } catch (error) { webview.postMessage({ type: 'error', message: error.message }); }
  }, null, context.subscriptions);
}
function sanitizeQuery(query) {
  const range = ['today', '1h', '10m', 'week', 'month', 'custom'].includes(query.range) ? query.range : 'today';
  return { range, model: typeof query.model === 'string' ? query.model.slice(0, 200) : '', from: typeof query.from === 'string' ? query.from.slice(0, 10) : '', to: typeof query.to === 'string' ? query.to.slice(0, 10) : '' };
}
async function exportCsv() {
  await client.ensure();
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('node:os').homedir(), 'deepseek-daily-usage.csv')), filters: { CSV: ['csv'] } });
  if (!uri) return;
  await fs.writeFile(uri.fsPath, await client.request('/_meter/export', 'GET', undefined, true), 'utf8');
  vscode.window.showInformationMessage('每日模型用量已导出 CSV（人民币估算按当前单价）');
}
function deactivate() { clearInterval(refreshTimer); }
module.exports = { activate, deactivate, sanitizeQuery };
