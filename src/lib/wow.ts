/**
 * Week-over-Week comparison helper.
 *
 * "This week"  = last 7 days ending today (today inclusive)
 * "Last week"  = the 7 days before that
 *
 * Rolling 7-day window (not ISO Mon–Sun) so the comparison is always
 * apples-to-apples: 7 full days vs 7 full days, regardless of what day it
 * is when the page loads.
 */

import { format, subDays } from "date-fns";

export type WeekTotals = {
  spend: number;
  atm: number;
  sqls: number;
  cpl: number | null;
  costPerSql: number | null;
};

export type WoWData = {
  thisWeek: WeekTotals;
  lastWeek: WeekTotals;
  deltas: {
    spend: number | null;
    atm: number | null;
    sqls: number | null;
    cpl: number | null;
    costPerSql: number | null;
  };
  thisWeekLabel: string;
  lastWeekLabel: string;
  weekly: Array<{
    weekStart: string;
    label: string;
    spend: number;
    atm: number;
    sqls: number;
    cpl: number | null;
    costPerSql: number | null;
  }>;
};

function pctDelta(curr: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function shortRangeLabel(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${format(start, "MMM d")}–${format(end, "d")}`;
  }
  return `${format(start, "MMM d")}–${format(end, "MMM d")}`;
}

export function computeWoW({
  dailySpend,
  dailyAtm,
  dailySqls,
  now,
  weeksBack = 8,
}: {
  dailySpend: Map<string, number>;
  dailyAtm: Map<string, number>;
  dailySqls: Map<string, number>;
  now: Date;
  weeksBack?: number;
}): WoWData {
  const sumWindow = (start: Date, end: Date): WeekTotals => {
    let spend = 0, atm = 0, sqls = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = format(d, "yyyy-MM-dd");
      spend += dailySpend.get(key) || 0;
      atm += dailyAtm.get(key) || 0;
      sqls += dailySqls.get(key) || 0;
    }
    return {
      spend: Math.round(spend * 100) / 100,
      atm,
      sqls,
      cpl: atm > 0 ? Math.round((spend / atm) * 100) / 100 : null,
      costPerSql: sqls > 0 ? Math.round((spend / sqls) * 100) / 100 : null,
    };
  };

  const thisEnd = new Date(now);
  thisEnd.setHours(0, 0, 0, 0);
  const thisStart = subDays(thisEnd, 6);
  const lastEnd = subDays(thisEnd, 7);
  const lastStart = subDays(thisEnd, 13);

  const thisWeek = sumWindow(thisStart, thisEnd);
  const lastWeek = sumWindow(lastStart, lastEnd);

  const deltas = {
    spend: pctDelta(thisWeek.spend, lastWeek.spend),
    atm: pctDelta(thisWeek.atm, lastWeek.atm),
    sqls: pctDelta(thisWeek.sqls, lastWeek.sqls),
    cpl:
      thisWeek.cpl != null && lastWeek.cpl != null
        ? pctDelta(thisWeek.cpl, lastWeek.cpl)
        : null,
    costPerSql:
      thisWeek.costPerSql != null && lastWeek.costPerSql != null
        ? pctDelta(thisWeek.costPerSql, lastWeek.costPerSql)
        : null,
  };

  const weekly: WoWData["weekly"] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const end = subDays(thisEnd, i * 7);
    const start = subDays(end, 6);
    const w = sumWindow(start, end);
    weekly.push({
      weekStart: format(start, "yyyy-MM-dd"),
      label: shortRangeLabel(start, end),
      ...w,
    });
  }

  return {
    thisWeek,
    lastWeek,
    deltas,
    thisWeekLabel: shortRangeLabel(thisStart, thisEnd),
    lastWeekLabel: shortRangeLabel(lastStart, lastEnd),
    weekly,
  };
}
