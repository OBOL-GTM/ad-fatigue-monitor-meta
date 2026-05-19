import { db } from "@/lib/db";
import { accounts, ads, dailyMetrics, publicLinks } from "@/lib/db/schema";
import { eq, gte, sql } from "drizzle-orm";
import {
  format, startOfMonth, endOfMonth, subMonths, addMonths, isBefore,
  isAfter, startOfYear,
} from "date-fns";
import { getLeadsFunnelLite } from "@/lib/hubspot/client";
import ExecutiveClient from "@/app/executive/ExecutiveClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

/**
 * Public view-only executive dashboard. No login required.
 * Anyone with a valid, non-revoked token can view the live data.
 * URL: /public/executive/<token>
 */
export default async function PublicExecutivePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ from?: string; to?: string; preset?: string }>;
}) {
  const { token } = await params;

  // Validate token
  const link = await db
    .select()
    .from(publicLinks)
    .where(eq(publicLinks.token, token))
    .get();

  if (!link || link.revokedAt) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold text-foreground mb-2">Link unavailable</h1>
          <p className="text-[14px] text-muted-foreground">
            This view-only link has been revoked or doesn't exist. Ask the person who shared it for a new one.
          </p>
        </div>
      </main>
    );
  }

  // Bump view counter (best-effort, non-blocking)
  db.update(publicLinks)
    .set({ viewsCount: sql`${publicLinks.viewsCount} + 1` })
    .where(eq(publicLinks.token, token))
    .run();

  // Scope to the accounts belonging to the user who CREATED the link.
  // Without this, if a second user connects a Meta account, public viewers
  // get a mashup. Deterministic order so the primary account never flips.
  const ownerId = link.createdBy;
  const allAccountRows = await db
    .select({ id: accounts.id, userId: accounts.userId })
    .from(accounts)
    .orderBy(accounts.id)
    .all();
  const scopedRows = ownerId
    ? allAccountRows.filter(r => r.userId === ownerId)
    : allAccountRows;
  const allAccountIds = scopedRows.map(r => r.id);

  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const defaultFrom = thisMonthStart;

  const sp = await searchParams;
  const preset = sp.preset || "this-month";
  const fromDate = sp.from ? new Date(sp.from + "T00:00:00") : defaultFrom;
  const toDate = sp.to ? new Date(sp.to + "T23:59:59") : now;
  const rangeFromStr = format(fromDate, "yyyy-MM-dd");
  const rangeToStr = format(toDate, "yyyy-MM-dd");

  // Refresh any stale ad statuses from Meta so paused ads don't show as
  // ACTIVE to public viewers. Runs at most once per account per minute.
  const { verifyActiveAdStatuses, refreshAdStatusesForAccounts } = await import("@/lib/meta/statusRefresh");
  await verifyActiveAdStatuses(allAccountIds);
  await refreshAdStatusesForAccounts(allAccountIds);

  const [allAds, metricsRaw, hubspotResult] = await Promise.all([
    db.select().from(ads).all(),
    db.select().from(dailyMetrics).where(gte(dailyMetrics.date, rangeFromStr)).all(),
    getLeadsFunnelLite(rangeFromStr, rangeToStr).catch(err => {
      console.error("[public-executive] HubSpot fetch failed:", err);
      return null;
    }),
  ]);
  const adAccountSet = new Set(allAccountIds);
  const allAdsForAccount = allAds.filter(a => adAccountSet.has(a.accountId));
  const allAdIds = new Set(allAdsForAccount.map(a => a.id));
  // Dedupe (adId, date) picking max spend per pair. Matches the exact logic
  // used on the authenticated Executive page so public viewers never see a
  // different spend total than the owner does (legacy Turso duplicate rows).
  const pubExecDedupe = new Map<string, typeof metricsRaw[number]>();
  for (const m of metricsRaw) {
    if (m.date > rangeToStr) continue;
    if (!allAdIds.has(m.adId)) continue;
    const key = `${m.adId}:${m.date}`;
    const existing = pubExecDedupe.get(key);
    if (!existing || (m.spend ?? 0) > (existing.spend ?? 0)) pubExecDedupe.set(key, m);
  }
  const metrics = Array.from(pubExecDedupe.values());

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

  for (const m of metrics) {
    const d = new Date(m.date + "T00:00:00");
    const bucket = buckets.find(b => d >= b.monthStart && d <= b.monthEnd);
    if (bucket) bucket.spend += m.spend ?? 0;
  }

  if (hubspotResult) {
    for (const day of hubspotResult.dailyATM) {
      const d = new Date(day.date + "T00:00:00");
      const bucket = buckets.find(b => d >= b.monthStart && d <= b.monthEnd);
      if (bucket) bucket.atm += day.atm;
    }
    for (const day of hubspotResult.dailyMQLs) {
      const d = new Date(day.date + "T00:00:00");
      const bucket = buckets.find(b => d >= b.monthStart && d <= b.monthEnd);
      if (bucket) bucket.mqls += day.mqls;
    }
    for (const day of hubspotResult.dailySQLDeals) {
      const d = new Date(day.date + "T00:00:00");
      const bucket = buckets.find(b => d >= b.monthStart && d <= b.monthEnd);
      if (bucket) bucket.sqls += day.sqlDeals;
    }
  }
  for (const b of buckets) b.spend = Math.round(b.spend * 100) / 100;

  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const thisMonthKey = format(thisMonthStart, "yyyy-MM");
  const lastMonthKey = format(lastMonthStart, "yyyy-MM");
  const thisMonth = buckets.find(b => b.key === thisMonthKey);
  const lastMonth = buckets.find(b => b.key === lastMonthKey);

  const pctDelta = (curr: number, prev: number): number | null => {
    if (!prev) return null;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  };

  const thisSpendVal = thisMonth?.spend ?? 0;
  const thisATMVal = thisMonth?.atm ?? 0;
  const thisMQLsVal = thisMonth?.mqls ?? 0;
  const thisSQLsVal = thisMonth?.sqls ?? 0;
  const thisCPLVal = thisATMVal > 0 ? Math.round((thisSpendVal / thisATMVal) * 100) / 100 : null;
  const thisCPMQLVal = thisMQLsVal > 0 ? Math.round((thisSpendVal / thisMQLsVal) * 100) / 100 : null;
  const lastSpend = lastMonth?.spend ?? 0;
  const lastATM = lastMonth?.atm ?? 0;
  const lastMQLs = lastMonth?.mqls ?? 0;
  const lastSQLs = lastMonth?.sqls ?? 0;
  const lastCPL = lastATM > 0 ? Math.round((lastSpend / lastATM) * 100) / 100 : null;
  const lastCPMQL = lastMQLs > 0 ? Math.round((lastSpend / lastMQLs) * 100) / 100 : null;
  const momDeltas = {
    spend: pctDelta(thisSpendVal, lastSpend),
    atm: pctDelta(thisATMVal, lastATM),
    mqls: pctDelta(thisMQLsVal, lastMQLs),
    sqls: pctDelta(thisSQLsVal, lastSQLs),
    cpl: lastCPL && thisCPLVal ? pctDelta(thisCPLVal, lastCPL) : null,
    cpmql: lastCPMQL && thisCPMQLVal ? pctDelta(thisCPMQLVal, lastCPMQL) : null,
  };

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

  // When the user selects a range other than "this-month", stat cards should
  // reflect the selected range, not the hardcoded current month.
  const isThisMonthPreset = preset === "this-month";
  const cardData = isThisMonthPreset
    ? { spend: thisSpendVal, atm: thisATMVal, mqls: thisMQLsVal, sqls: thisSQLsVal, cpl: thisCPLVal, cpmql: thisCPMQLVal }
    : {
        spend: Math.round(rangeTotals.spend * 100) / 100,
        atm: rangeTotals.atm,
        mqls: rangeTotals.mqls,
        sqls: rangeTotals.sqls,
        cpl: rangeCPL,
        cpmql: rangeCPMQL,
      };
  const cardDeltas = isThisMonthPreset
    ? momDeltas
    : { spend: null, atm: null, mqls: null, sqls: null, cpl: null, cpmql: null };

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
    const ad = allAdsForAccount.find(a => a.id === adId);
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

  const campaignMap = new Map<string, { spend: number; conversions: number }>();
  for (const m of metrics) {
    const ad = allAdsForAccount.find(a => a.id === m.adId);
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

  const presets = {
    "this-month": { from: format(thisMonthStart, "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "last-month": { from: format(lastMonthStart, "yyyy-MM-dd"), to: format(endOfMonth(lastMonthStart), "yyyy-MM-dd") },
    "3m": { from: format(startOfMonth(subMonths(now, 2)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "6m": { from: format(startOfMonth(subMonths(now, 5)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "ytd": { from: format(startOfYear(now), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
    "12m": { from: format(startOfMonth(subMonths(now, 11)), "yyyy-MM-dd"), to: format(now, "yyyy-MM-dd") },
  };

  return (
    <div className="min-h-screen">
      {/* Tiny banner so viewer knows this is a shared view */}
      <div className="bg-gradient-to-r from-[#6B93D8]/10 via-[#9B7ED0]/10 to-[#D06AB8]/10 border-b border-border exec-no-print">
        <div className="max-w-6xl mx-auto px-6 py-2 text-[12px] text-muted-foreground flex items-center justify-between">
          <span>
            {link.label ? <>Shared view, <span className="font-medium text-foreground">{link.label}</span></> : "Shared view"}
          </span>
          <span className="text-[11px]">View-only · live data</span>
        </div>
      </div>
      <ExecutiveClient
        basePath={`/public/executive/${token}`}
        monthLabel={isThisMonthPreset ? format(now, "MMMM yyyy") : (
          buckets.length === 1
            ? buckets[0].label
            : `${format(fromDate, "MMM d, yyyy")} \u2013 ${format(toDate, "MMM d, yyyy")}`
        )}
        rangeLabel={
          buckets.length === 1
            ? buckets[0].label
            : `${format(fromDate, "MMM d, yyyy")} \u2013 ${format(toDate, "MMM d, yyyy")}`
        }
        rangeFrom={rangeFromStr}
        rangeTo={rangeToStr}
        preset={preset}
        presets={presets}
        thisMonth={cardData}
        lastMonthLabel={isThisMonthPreset ? format(lastMonthStart, "MMMM") : ""}
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
      />
    </div>
  );
}
