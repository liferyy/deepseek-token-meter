'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'package.json');
const text = fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(text);
const parts = String(pkg.version).split('.');
if (parts.length !== 3 || !parts.every(part => /^\d+$/.test(part))) throw new Error('package.json 的 version 必须是 x.y.z 形式');
const version = parts[0] + '.' + parts[1] + '.' + (Number(parts[2]) + 1);
const pattern = new RegExp('("version"\\s*:\\s*")' + pkg.version.replace(/\./g, '\\.') + '(")');
if (!pattern.test(text)) throw new Error('无法在 package.json 中定位 version 字段');
// Only the version line is replaced so the rest of the hand-formatted manifest keeps its layout.
fs.writeFileSync(file, text.replace(pattern, '$1' + version + '$2'));
console.log('版本号已递增：' + pkg.version + ' -> ' + version);
