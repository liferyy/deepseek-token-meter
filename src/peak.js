'use strict';

// DeepSeek bills by Beijing time: peak on weekday 09:00-12:00 and 14:00-18:00,
// off-peak at half price the rest of the time, including weekends and public holidays.
// Holiday and makeup-workday dates come from the holiday-cn open data, refreshed when the extension starts.
const { isHoliday, isMakeupWorkday } = require('./holidays');

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
  if (isHoliday(date)) return false;
  // 调休上班的周末按工作日处理；其余周末全天空闲。
  const workday = (weekday >= 1 && weekday <= 5) || isMakeupWorkday(date);
  return workday && PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
}

module.exports = { beijingTime, isPeak, OFF_PEAK_FACTOR, PEAK_WINDOWS };
