'use strict';

// DeepSeek bills by Beijing time: peak on weekday 09:00-12:00 and 14:00-18:00,
// off-peak at half price the rest of the time, including weekends and public holidays.
// Holiday and makeup-workday dates come from the holiday-cn open data, refreshed when the extension starts.
const { isHoliday, isMakeupWorkday } = require('./holidays');

const PEAK_WINDOWS = [[9, 12], [14, 18]];
const BEIJING_OFFSET = 8 * 3600000; // China has no daylight saving time.
const OFF_PEAK_FACTOR = 0.5;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// Manual fallback: when holiday data is unavailable or does not match the real schedule, users can
// ignore the open-data calendar and only distinguish weekday working hours from weekends.
let ignoreHolidays = false;
function configure(options = {}) { ignoreHolidays = options?.ignoreHolidays === true; }

// `isPeak` runs once per row inside the SQL aggregate, so the Beijing calendar day is memoised
// instead of allocating a Date object and a formatted string for every request.
const dayCache = new Map();
const DAY_CACHE_LIMIT = 800;
function beijingDay(beijingMs) {
  const index = Math.floor(beijingMs / DAY_MS);
  let value = dayCache.get(index);
  if (value === undefined) {
    const date = new Date(index * DAY_MS);
    value = { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay() };
    if (dayCache.size >= DAY_CACHE_LIMIT) dayCache.clear();
    dayCache.set(index, value);
  }
  return value;
}

function beijingTime(ms) {
  const beijing = ms + BEIJING_OFFSET;
  const day = beijingDay(beijing);
  return { date: day.date, weekday: day.weekday, hour: Math.floor(beijing / HOUR_MS) % 24 };
}

function isPeak(ms) {
  if (!Number.isFinite(ms)) return false;
  const beijing = ms + BEIJING_OFFSET;
  const hour = Math.floor(beijing / HOUR_MS) % 24;
  // Reject the 17 non-peak hours before touching the holiday calendar.
  const [morning, afternoon] = PEAK_WINDOWS;
  if (!((hour >= morning[0] && hour < morning[1]) || (hour >= afternoon[0] && hour < afternoon[1]))) return false;
  const day = beijingDay(beijing);
  if (!ignoreHolidays && isHoliday(day.date)) return false;
  // 调休上班的周末按工作日处理；其余周末全天空闲。
  return (day.weekday >= 1 && day.weekday <= 5) || (!ignoreHolidays && isMakeupWorkday(day.date));
}

module.exports = { beijingTime, isPeak, configure, OFF_PEAK_FACTOR, PEAK_WINDOWS };
