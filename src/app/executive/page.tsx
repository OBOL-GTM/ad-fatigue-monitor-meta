import { db } from "@/lib/db";
import { ads, dailyMetrics } from "@/lib/db/schema";
import { inArray, gte } from "drizzle-orm";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { redirect } from "next/navigation";
import {
  format, startOfMonth, endOfMonth, subMonths, addMonths, isBefore,
  isAfter, startOfYear, subDays,
} from "date-fns";
import { getLeadsFunnelLite } from "@/lib/hubspot/client";
import { computeWoW } from "@/lib/wow";
import ExecutiveClient from "./ExecutiveClient";
import FreshnessGuard from "@/components/FreshnessGuard";
import MetaTokenBanner from "@/components/MetaTokenBanner";
import SyncHealthBanner from "@/components/SyncHealthBanner";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Up to 6 parallel HubSpot queries run below; allow enough headroom.
// Historical ranges (6m, 12m, ytd) need more than the default 60s.
export const maxDuration = 300;

/**
 * Executive View, CEO-friendly dashboard with:
 * - Date range selector (query-driven so links + PDFs are shareable)
 * - KPI cards with month-over-month deltas
 * - Trend lines, CPL trend, campaign breakdown, monthly summary table
 * - Top ad cards
 * - One-click PDF export
 */
export default async function ExecutivePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; preset?: string }>;
}) {
  const session = await getSessionOrPublic();
  if (!session) redirect("/login");
  const accountId = session.accountId;
  if (!accountId) redirect("/login");
  const allAccountIds: string[] = session.allAccountIds;

  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  // Default to this month, it's the most actionable view on page load.
  // Users can switch to 3m/6m/YTD via the preset buttons.
  const defaultFrom = thisMonthStart;

  const params = await searchParams;
  const preset = params.preset || "this-month";
  const fromDate = params.from ? new Date(params.from + "T00:00:00") : defaultFrom;
  const toDate = params.to ? new Date(params.to + "T23:59:59") : now;
  const rangeFromStr = format(fromDate, "yyyy-MM-dd");
  const rangeToStr = format(toDate, "yyyy-MM-dd");

  // MoM card needs this-month + last-month data regardless of selected range.
  // Fetch from min(rangeFrom, last-month-start) so range-scoped buckets and
  // MoM card both have their data in a single metrics query.
  const lastMonthStartLocal = startOfMonth(subMonths(now, 1));
  const momFromStr = format(lastMonthStartLocal, "yyyy-MM-dd");
  // WoW window: trailing 8 weeks (covers WoW + the 8-week weekly trend chart).
  const weeklyTrendFromDate = subDays(now, 13 * 7);
  const weeklyFromStr = format(weeklyTrendFromDate, "yyyy-MM-dd");
  const metricsFromStr = [rangeFromStr, momFromStr, weeklyFromStr].sort()[0];

  const [allAds, metricsRaw, hubspotResult, hubspotMoM, hubspotWoW] = await Promise.all([
    db.select().from(ads).where(inArray(ads.accountId, allAccountIds)).all(),
    db.select().from(dailyMetrics).where(gte(dailyMetrics.date, metricsFromStr)).all(),
    getLeadsFunnelLite(rangeFromStr, rangeToStr).catch(err => {
      console.error("[executive] HubSpot fetch failed:", err);
      return null;
    }),
    // Separate HubSpot query for MoM so this-month/last-month stats are always
    // available, even when user selected e.g. "Last month" (which would
    // otherwise drop April from the main hubspotResult).
    getLeadsFunnelLite(momFromStr, format(now, "yyyy-MM-dd")).catch(err => {
      console.error("[executive] HubSpot MoM fetch failed:", err);
      return null;
    }),
    // Separate HubSpot query for WoW + 8-week trend, always anchored on today.
    getLeadsFunnelLite(weeklyFromStr, format(now, "yyyy-MM-dd")).catch(err => {
      console.error("[executive] HubSpot WoW fetch failed:", err);
      return null;
    }),
  ]);
  // Filter metrics to this owner's ads (including synthetic __unattributed_*
  // reconciliation rows, which the sync creates with accountId set to the
  // owner's account so they ARE in allAds). Dropping the filter would pull in
  // rows from other accounts in the same DB and/or double-count the sync's
  // gap-filler rows. Historical completeness comes from the 90-day rolling
  // sync window which keeps __unattributed_* rows current for the last 3 months.
  const allAdIds = new Set(allAds.map(a => a.id));
  // Dedupe by (ad_id, date) to survive any legacy duplicate rows in Turso.
  const execDedupe = new Map<string, typeof metricsRaw[number]>();
  for (const m of metricsRaw) {
    if (m.date > rangeToStr) continue;
    if (!allAdIds.has(m.adId)) continue;
    const key = `${m.adId}:${m.date}`;
    const existing = execDedupe.get(key);
    if (!existing || (m.spend ?? 0) > (existing.spend ?? 0)) execDedupe.set(key, m);
  }
  const metrics = Array.from(execDedupe.values());

  // Month buckets covering the selected range
  type MonthBucket = {
    key: string;
    label: string;
    monthStart: Date;
    monthEnd: Date;
    spend: number;
    atm: number;
    mqls: number;
    sqls: number;
  };
  const buckets: MonthBucket[] = [];
  let cursor = startOfMonth(fromDate);
  const rangeEnd = endOfMonth(toDate);
  while (isBefore(cursor, addMonths(rangeEnd, 1)) && !isAfter(cursor, rangeEnd)) {
    buckets.push({
      key: format(cursor, "yyyy-MM"),
      label: format(cursor, "MMM yyyy"),
      monthStart: startOfMonth(cursor),
      monthEnd: endOfMonth(cursor),
      spend: 0,
      atm: 0,
      mqls: 0,
      sqls: 0,
    });
    cursor = addMonths(cursor, 1);
  }

  // Index buckets by YYYY-MM string key for O(1) lookup. Using string
  // comparison avoids timezone drift from Date parsing (the previous
  // new Date(ymd + "T00:00:00") approach silently dropped rows on the
  // month boundary in some timezones).
  const bucketByKey = new Map(buckets.map(b => [b.key, b]));
  const keyOf = (yyyyMmDd: string) => yyyyMmDd.slice(0, 7);

  // Meta spend by month
  for (const m of metrics) {
    const bucket = bucketByKey.get(keyOf(m.date));
    if (bucket) bucket.spend += m.spend ?? 0;
  }

  // HubSpot ATM / MQL / SQL by month
  if (hubspotResult) {
    for (const day of hubspotResult.dailyATM) {
      const bucket = bucketByKey.get(keyOf(day.date));
      if (bucket) bucket.atm += day.atm;
    }
    for (const day of hubspotResult.dailyMQLs) {
      const bucket = bucketByKey.get(keyOf(day.date));
      if (bucket) bucket.mqls += day.mqls;
    }
    for (const day of hubspotResult.dailySQLDeals) {
      const bucket = bucketByKey.get(keyOf(day.date));
      if (bucket) bucket.sqls += day.sqlDeals;
    }
  }
  for (const b of buckets) b.spend = Math.round(b.spend * 100) / 100;

  // Current vs previous month (for top cards), computed from the ALL-metrics
  // set (metricsRaw) so the card works regardless of the selected range.
  // MTD-fair: clip last month at the same day-of-month as today so May 1-13
  // is compared against April 1-13, not all of April. Avoids false-cliff
  // deltas mid-month. If today's day exceeds last month's last day (e.g.
  // May 31 vs Feb), cap at last month's last day.
  const lastMonthStart = lastMonthStartLocal;
  const lastMonthFullEnd = endOfMonth(lastMonthStart);
  const todayDay = now.getDate();
  const lastMonthLastDay = lastMonthFullEnd.getDate();
  const cutoffDay = Math.min(todayDay, lastMonthLastDay);
  const lastMonthEnd = new Date(lastMonthStart);
  lastMonthEnd.setDate(cutoffDay);
  lastMonthEnd.setHours(23, 59, 59, 999);
  const thisMonthEnd = endOfMonth(now);
  // True when we're mid-month and comparing to a clipped slice of last month.
  const isPartialMonth = todayDay < endOfMonth(now).getDate();

  let thisSpend = 0, lastSpend = 0;
  for (const m of metricsRaw) {
    if (!allAdIds.has(m.adId)) continue;
    const d = new Date(m.date + "T00:00:00");
    if (d >= thisMonthStart && d <= thisMonthEnd) thisSpend += m.spend ?? 0;
    else if (d >= lastMonthStart && d <= lastMonthEnd) lastSpend += m.spend ?? 0;
  }
  thisSpend = Math.round(thisSpend * 100) / 100;
  lastSpend = Math.round(lastSpend * 100) / 100;

  let thisATM = 0, thisMQLs = 0, thisSQLs = 0, lastATM = 0, lastMQLs = 0, lastSQLs = 0;
  if (hubspotMoM) {
    for (const day of hubspotMoM.dailyATM) {
      const d = new Date(day.date + "T00:00:00");
      if (d >= thisMonthStart && d <= thisMonthEnd) thisATM += day.atm;
      else if (d >= lastMonthStart && d <= lastMonthEnd) lastATM += day.atm;
    }
    for (const day of hubspotMoM.dailyMQLs) {
      const d = new Date(day.date + "T00:00:00");
      if (d >= thisMonthStart && d <= thisMonthEnd) thisMQLs += day.mqls;
      else if (d >= lastMonthStart && d <= lastMonthEnd) lastMQLs += day.mqls;
    }
    for (const day of hubspotMoM.dailySQLDeals) {
      const d = new Date(day.date + "T00:00:00");
      if (d >= thisMonthStart && d <= thisMonthEnd) thisSQLs += day.sqlDeals;
      else if (d >= lastMonthStart && d <= lastMonthEnd) lastSQLs += day.sqlDeals;
    }
  }

  const pctDelta = (curr: number, prev: number): number | null => {
    if (!prev) return null;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  };

  const thisCPL = thisATM > 0 ? Math.round((thisSpend / thisATM) * 100) / 100 : null;
  const lastCPL = lastATM > 0 ? Math.round((lastSpend / lastATM) * 100) / 100 : null;
  const thisCPMQL = thisMQLs > 0 ? Math.round((thisSpend / thisMQLs) * 100) / 100 : null;
  const lastCPMQL = lastMQLs > 0 ? Math.round((lastSpend / lastMQLs) * 100) / 100 : null;
  const deltas = {
    spend: pctDelta(thisSpend, lastSpend),
    atm: pctDelta(thisATM, lastATM),
    mqls: pctDelta(thisMQLs, lastMQLs),
    sqls: pctDelta(thisSQLs, lastSQLs),
    cpl: lastCPL && thisCPL ? pctDelta(thisCPL, lastCPL) : null,
    cpmql: lastCPMQL && thisCPMQL ? pctDelta(thisCPMQL, lastCPMQL) : null,
  };

  // Range-wide totals (for the header stat line + export context)
  const rangeTotals = buckets.reduce(
    (acc, b) => ({
      spend: acc.spend + b.spend,
      atm: acc.atm + b.atm,
      mqls: acc.mqls + b.mqls,
      sqls: acc.sqls + b.sqls,
    }),
    { spend: 0, atm: 0, mqls: 0, sqls: 0 }
  );
  const rangeCPL = rangeTotals.atm > 0 ? Math.round((rangeTotals.spend / rangeTotals.atm) * 100) / 100 : null;
  const rangeCPMQL = rangeTotals.mqls > 0 ? Math.round((rangeTotals.spend / rangeTotals.mqls) * 100) / 100 : null;
  const rangeCostPerSQL = rangeTotals.sqls > 0 ? Math.round((rangeTotals.spend / rangeTotals.sqls) * 100) / 100 : null;

  // Top ad this month
  const adStatsMap = new Map<string, { spend: number; conversions: number }>();
  for (const m of metrics) {
    const d = new Date(m.date + "T00:00:00");
    if (d < thisMonthStart) continue;
    const cur = adStatsMap.get(m.adId) ?? { spend: 0, conversions: 0 };
    cur.spend += m.spend ?? 0;
    cur.conversions += m.actions ?? 0;
    adStatsMap.set(m.adId, cur);
  }
  const adRanks = Array.from(adStatsMap.entries()).map(([adId, stats]) => {
    const ad = allAds.find(a => a.id === adId);
    return {
      adId,
      adName: ad?.adName || "Unknown",
      campaignName: ad?.campaignName || "",
      thumbnailUrl: ad?.imageUrl || ad?.thumbnailUrl || "",
      spend: Math.round(stats.spend * 100) / 100,
      conversions: stats.conversions,
      cpConv: stats.conversions > 0 ? Math.round((stats.spend / stats.conversions) * 100) / 100 : null,
    };
  });
  const topAdByConversions = adRanks
    .filter(a => a.conversions > 0)
    .sort((a, b) => b.conversions - a.conversions)[0] || null;
  const topAdBySpend = adRanks.slice().sort((a, b) => b.spend - a.spend)[0] || null;

  // Top 5 campaigns across the selected range
  const campaignMap = new Map<string, { spend: number; conversions: number }>();
  for (const m of metrics) {
    const ad = allAds.find(a => a.id === m.adId);
    if (!ad) continue;
    const key = ad.campaignName || "(unknown)";
    const cur = campaignMap.get(key) ?? { spend: 0, conversions: 0 };
    cur.spend += m.spend ?? 0;
    cur.conversions += m.actions ?? 0;
    campaignMap.set(key, cur);
  }
  const topCampaigns = Array.from(campaignMap.entries())
    .map(([name, v]) => ({
      name,
      spend: Math.round(v.spend * 100) / 100,
      conversions: v.conversions,
      costPerConv: v.conversions > 0 ? Math.round((v.spend / v.conversions) * 100) / 100 : null,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 5);

  // Presets the selector renders (values stored in URL as ?preset=XXX)
  const presets = {
    "this-month": { from: format(thisMonthStart, "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "last-month": { from: format(lastMonthStart, "yyyy-MM-dd"), to: format(endOfMonth(lastMonthStart), "yyyy-MM-dd") },
    "3m": { from: format(startOfMonth(subMonths(now, 2)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "6m": { from: format(startOfMonth(subMonths(now, 5)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "ytd": { from: format(startOfYear(now), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "12m": { from: format(startOfMonth(subMonths(now, 11)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
  };

  const lastSyncedAt = allAds.reduce((max, ad) => Math.max(max, ad.lastSyncedAt ?? 0), 0);

  // WoW: build daily maps over the last ~8 weeks (always anchored on today,
  // independent of the selected range) and feed them to computeWoW.
  const wowSpendByDate = new Map<string, number>();
  for (const m of metricsRaw) {
    if (!allAdIds.has(m.adId)) continue;
    if (m.date < weeklyFromStr) continue;
    wowSpendByDate.set(m.date, (wowSpendByDate.get(m.date) || 0) + (m.spend ?? 0));
  }
  const wowAtmByDate = new Map<string, number>();
  const wowMqlsByDate = new Map<string, number>();
  const wowSqlsByDate = new Map<string, number>();
  if (hubspotWoW) {
    for (const d of hubspotWoW.dailyATM) {
      wowAtmByDate.set(d.date, (wowAtmByDate.get(d.date) || 0) + d.atm);
    }
    for (const d of hubspotWoW.dailyMQLs) {
      wowMqlsByDate.set(d.date, (wowMqlsByDate.get(d.date) || 0) + d.mqls);
    }
    for (const d of hubspotWoW.dailySQLDeals) {
      wowSqlsByDate.set(d.date, (wowSqlsByDate.get(d.date) || 0) + d.sqlDeals);
    }
  }
  const wow = computeWoW({
    dailySpend: wowSpendByDate,
    dailyAtm: wowAtmByDate,
    dailyMqls: wowMqlsByDate,
    dailySqls: wowSqlsByDate,
    now,
    weeksBack: 13,
  });

  // When the user selects a range other than "this-month", the stat cards
  // should reflect the selected range, not the hardcoded current month.
  const isThisMonthPreset = preset === "this-month";
  const cardData = isThisMonthPreset
    ? { spend: thisSpend, atm: thisATM, mqls: thisMQLs, sqls: thisSQLs, cpl: thisCPL, cpmql: thisCPMQL }
    : {
        spend: Math.round(rangeTotals.spend * 100) / 100,
        atm: rangeTotals.atm,
        mqls: rangeTotals.mqls,
        sqls: rangeTotals.sqls,
        cpl: rangeCPL,
        cpmql: rangeCPMQL,
      };
  const cardDeltas = isThisMonthPreset
    ? deltas
    : { spend: null, atm: null, mqls: null, sqls: null, cpl: null, cpmql: null };

  const rangeLabel =
    buckets.length === 1
      ? buckets[0].label
      : `${format(fromDate, "MMM d, yyyy")} \u2013 ${format(toDate, "MMM d, yyyy")}`;

  return (
    <div className="min-h-screen">
      <div className="px-8 pt-6">
        {!session.isPublic && <MetaTokenBanner accountIds={allAccountIds} />}
        {!session.isPublic && <SyncHealthBanner accountIds={allAccountIds} />}
        <FreshnessGuard lastSyncedAt={lastSyncedAt || null} isPublic={!!session.isPublic} />
      </div>
      <ExecutiveClient
        monthLabel={isThisMonthPreset ? format(now, "MMMM yyyy") : rangeLabel}
        rangeLabel={rangeLabel}
        rangeFrom={rangeFromStr}
        rangeTo={rangeToStr}
        preset={preset}
        presets={presets}
        thisMonth={cardData}
        lastMonthLabel={
          isThisMonthPreset
            ? (isPartialMonth
                ? `${format(lastMonthStart, "MMM")} 1-${cutoffDay}`
                : format(lastMonthStart, "MMMM"))
            : ""
        }
        comparisonLabel={
          isThisMonthPreset
            ? (isPartialMonth
                ? `vs ${format(lastMonthStart, "MMM")} 1-${cutoffDay}`
                : "vs last month")
            : undefined
        }
        deltas={cardDeltas}
        rangeTotals={{
          spend: Math.round(rangeTotals.spend * 100) / 100,
          atm: rangeTotals.atm,
          mqls: rangeTotals.mqls,
          sqls: rangeTotals.sqls,
          cpl: rangeCPL,
          cpmql: rangeCPMQL,
          costPerSQL: rangeCostPerSQL,
        }}
        trend={buckets.map(b => ({
          label: b.label,
          spend: b.spend,
          atm: b.atm,
          mqls: b.mqls,
          sqls: b.sqls,
          cpl: b.atm > 0 ? Math.round((b.spend / b.atm) * 100) / 100 : 0,
          cpmql: b.mqls > 0 ? Math.round((b.spend / b.mqls) * 100) / 100 : 0,
          costPerSQL: b.sqls > 0 ? Math.round((b.spend / b.sqls) * 100) / 100 : 0,
          sqlRate: b.atm > 0 ? Math.round((b.sqls / b.atm) * 1000) / 10 : 0,
        }))}
        dailyMTD={(() => {
          // Day-by-day MTD CPL + MTD spend. Totals reset at the 1st of every
          // month so Orly can compare March 21 vs April 21 at the same point.
          // Build a superset of dates from Meta spend + HubSpot ATM + HubSpot SQL.
          const spendByDate = new Map<string, number>();
          for (const m of metrics) {
            spendByDate.set(m.date, (spendByDate.get(m.date) || 0) + (m.spend ?? 0));
          }
          const atmByDate = new Map<string, number>();
          const mqlByDate = new Map<string, number>();
          const sqlByDate = new Map<string, number>();
          if (hubspotResult) {
            for (const d of hubspotResult.dailyATM) atmByDate.set(d.date, (atmByDate.get(d.date) || 0) + d.atm);
            for (const d of hubspotResult.dailyMQLs) mqlByDate.set(d.date, (mqlByDate.get(d.date) || 0) + d.mqls);
            for (const d of hubspotResult.dailySQLDeals) sqlByDate.set(d.date, (sqlByDate.get(d.date) || 0) + d.sqlDeals);
          }
          const allDates = Array.from(new Set<string>([
            ...spendByDate.keys(), ...atmByDate.keys(), ...mqlByDate.keys(), ...sqlByDate.keys(),
          ])).sort();
          // Walk each date, reset accumulators at month boundaries.
          let cumSpend = 0, cumAtm = 0, cumMqls = 0, cumSqls = 0;
          let lastCPL: number | null = null;
          let lastCPMQL: number | null = null;
          let lastCostPerSQL: number | null = null;
          let currentMonth = "";
          const out: Array<{ date: string; cumSpend: number; cumAtm: number; cumMqls: number; cumSqls: number; cpl: number | null; cpmql: number | null; costPerSql: number | null }> = [];
          for (const date of allDates) {
            const monthKey = date.slice(0, 7);
            if (monthKey !== currentMonth) {
              currentMonth = monthKey;
              cumSpend = 0; cumAtm = 0; cumMqls = 0; cumSqls = 0;
              lastCPL = null; lastCPMQL = null; lastCostPerSQL = null;
            }
            cumSpend += spendByDate.get(date) || 0;
            cumAtm += atmByDate.get(date) || 0;
            cumMqls += mqlByDate.get(date) || 0;
            cumSqls += sqlByDate.get(date) || 0;
            if (cumAtm > 0) lastCPL = Math.round((cumSpend / cumAtm) * 100) / 100;
            if (cumMqls > 0) lastCPMQL = Math.round((cumSpend / cumMqls) * 100) / 100;
            if (cumSqls > 0) lastCostPerSQL = Math.round((cumSpend / cumSqls) * 100) / 100;
            out.push({
              date,
              cumSpend: Math.round(cumSpend * 100) / 100,
              cumAtm,
              cumMqls,
              cumSqls,
              cpl: lastCPL,
              cpmql: lastCPMQL,
              costPerSql: lastCostPerSQL,
            });
          }
          return out;
        })()}
        monthlyTable={buckets.map(b => ({
          label: b.label,
          spend: b.spend,
          atm: b.atm,
          mqls: b.mqls,
          sqls: b.sqls,
          cpl: b.atm > 0 ? Math.round((b.spend / b.atm) * 100) / 100 : 0,
          cpmql: b.mqls > 0 ? Math.round((b.spend / b.mqls) * 100) / 100 : 0,
          costPerSQL: b.sqls > 0 ? Math.round((b.spend / b.sqls) * 100) / 100 : 0,
        }))}
        topCampaigns={topCampaigns}
        topAdByConversions={topAdByConversions}
        topAdBySpend={topAdBySpend}
        wow={wow}
      />
    </div>
  );
}
