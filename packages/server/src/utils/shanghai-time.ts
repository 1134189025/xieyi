const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function getShanghaiDayRange(now = new Date()) {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const start = new Date(
    Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate()) -
      SHANGHAI_OFFSET_MS,
  );
  const end = new Date(start.getTime() + ONE_DAY_MS);
  return { start, end };
}

export function getShanghaiWeekRange(now = new Date()) {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const dayOfWeek = shanghaiNow.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const start = new Date(
    Date.UTC(
      shanghaiNow.getUTCFullYear(),
      shanghaiNow.getUTCMonth(),
      shanghaiNow.getUTCDate() - daysSinceMonday,
    ) - SHANGHAI_OFFSET_MS,
  );
  const end = new Date(start.getTime() + 7 * ONE_DAY_MS);
  return { start, end };
}
