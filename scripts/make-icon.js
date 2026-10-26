'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); }
const raw = Buffer.alloc(128 * (128 * 4 + 1));
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
  const i = y * 513 + 1 + x * 4;
  let color = [19, 30, 24, 255];
  const bars = [{ x: 29, h: 28 }, { x: 48, h: 49 }, { x: 67, h: 38 }, { x: 86, h: 64 }];
  if (bars.some(b => x >= b.x && x < b.x + 12 && y >= 94 - b.h && y < 94)) color = [57, 201, 113, 255];
  if (y >= 102 && y < 105 && x >= 26 && x < 103) color = [78, 103, 87, 255];
  for (let c = 0; c < 4; c++) raw[i + c] = color[c];
}
const header = Buffer.alloc(13); header.writeUInt32BE(128, 0); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 6;
fs.writeFileSync(path.join(__dirname, '..', 'media', 'icon.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
