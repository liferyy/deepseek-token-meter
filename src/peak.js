'use strict';

// DeepSeek bills by Beijing time: peak on weekday 09:00-12:00 and 14:00-18:00,
// off-peak at half price the rest of the time, including weekends and public holidays.
// Only holiday weekdays matter here; weekend dates are already off-peak.
// Sources: 国办发明电〔2024〕12号 (2025) and 国办发明电〔2025〕7号 (2026).
const HOLIDAYS = new Set([
  // 2025
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
]);

const PEAK_WINDOWS = [[9, 12], [14, 18]];
const BEIJING_OFFSET = 8 * 3600000; // China has no daylight saving time.
const OFF_PEAK_FACTOR = 0.5;

function beijingTime(ms) {
  const date = new Date(ms + BEIJING_OFFSET);
  return { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), hour: date.getUTCHours() };
}

function isPeak(ms) {
  if (!Number.isFinite(ms)) return false;
  const { date, weekday, hour } = beijingTime(ms);
  if (weekday === 0 || weekday === 6 || HOLIDAYS.has(date)) return false;
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
}

module.exports = { beijingTime, isPeak, HOLIDAYS, OFF_PEAK_FACTOR, PEAK_WINDOWS };
