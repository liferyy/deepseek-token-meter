'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let files = 0;
for (const directory of ['src', 'media', 'scripts', 'test']) {
  for (const file of fs.readdirSync(path.join(root, directory))) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, file)], { encoding: 'utf8' });
    if (result.status) { process.stderr.write(result.stderr); process.exit(1); }
    files++;
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(root, pkg.main)) || !fs.existsSync(path.join(root, pkg.icon))) throw new Error('Missing extension entry or icon');
console.log('Syntax and manifest assets OK: ' + files + ' JavaScript files');
