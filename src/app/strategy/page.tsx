import { db } from "@/lib/db";
import { ads, dailyMetrics, settings } from "@/lib/db/schema";
import { eq, inArray, gte, lte, and } from "drizzle-orm";
import { calculateFatigueScore } from "@/lib/fatigue/scoring";
import type { ScoringSettings } from "@/lib/fatigue/types";
import { DEFAULT_SETTINGS } from "@/lib/fatigue/types";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { redirect } from "next/navigation";
import { format, startOfMonth, endOfMonth, subDays } from "date-fns";
import { getLeadsFunnelLite, getATMLeadsByCampaign, getClosedWonRevenue } from "@/lib/hubspot/client";
import { computeWoW } from "@/lib/wow";
import StrategyClient from "./StrategyClient";
import LeadsClient from "../leads/LeadsClient";
import FreshnessGuard from "@/components/FreshnessGuard";
import {
  generateCampaignRecommendations,
  type CampaignInput,
} from "@/lib/strategy/recommendations";

export const dynamic = "force-dynamic";
// Full getLeadsFunnel + ATM-by-campaign + closed-won fan out to multiple HS
// searches + association reads. Raise the timeout so 6-month ranges don't abort.
export const maxDuration = 300;

export default async function StrategyPage({
  searchParams,
}: {
  searchParams?: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSessionOrPublic();
  if (!session) redirect("/login");
  const accountId = session.accountId;
  if (!accountId) redirect("/login");
  const allAccountIds: string[] = session.allAccountIds;

  // Read the user-selected date range (used by the Leads date picker that
  // lives inside LeadsClient, pushes ?from=&to= to this page).
  const params = (await searchParams) || {};

  // Get settings
  const userSettings = await db.select().from(settings).where(eq(settings.id, 1)).get();
  const scoringSettings: ScoringSettings = userSettings
    ? {
        ctrWeight: userSettings.ctrWeight,
        cpmWeight: userSettings.cpmWeight,
        frequencyWeight: userSettings.frequencyWeight,
        conversionWeight: userSettings.conversionWeight,
        costPerResultWeight: userSettings.costPerResultWeight,
        engagementWeight: userSettings.engagementWeight,
        baselineWindowDays: userSettings.baselineWindowDays,
        recentWindowDays: userSettings.recentWindowDays,
        minDataDays: userSettings.minDataDays,
      }
    : DEFAULT_SETTINGS;

  // Refresh any stale ad statuses from Meta before reading the DB, so paused
  // ads don't show as ACTIVE (limited to 1 hit per account per minute, and
  // only when the freshest lastSyncedAt is > 5 min old).
  const { verifyActiveAdStatuses, refreshAdStatusesForAccounts } = await import("@/lib/meta/statusRefresh");
  await verifyActiveAdStatuses(allAccountIds);
  await refreshAdStatusesForAccounts(allAccountIds);
  // Fetch ALL ads (needed for range-scoped spend totals that include paused /
  // archived / unattributed rows, matches Dashboard accuracy).
  const allAdsRaw = await db.select().from(ads).where(inArray(ads.accountId, allAccountIds)).all();
  // ACTIVE-only ad summaries for the per-ad detail cards.
  const allAds = allAdsRaw.filter(a => a.status === "ACTIVE" && !a.id.startsWith("__unattributed_"));

  // This month is the default range, matches the Executive + Dashboard defaults.
  // Allow ?from=&to= override from the Leads date picker.
  const now = new Date();
  const rangeStart = params.from || format(startOfMonth(now), "yyyy-MM-dd");
  const rangeEnd = params.to || format(endOfMonth(now), "yyyy-MM-dd");

  // Process each ACTIVE ad, summaries use ALL-TIME metrics for fatigue scoring
  // (fatigue needs history) but display numbers are range-scoped to this month.
  //
  // Batch-fetch all metrics in one query + group in memory. Previous N+1
  // fired one query per ad which made Strategy take 10s+ on large accounts.
  const allAdIdsStr = allAds.map(a => a.id);
  const allMetricsForAds = allAdIdsStr.length === 0
    ? []
    : await db.select().from(dailyMetrics).where(inArray(dailyMetrics.adId, allAdIdsStr)).all();
  const metricsByAdId = new Map<string, typeof allMetricsForAds>();
  for (const m of allMetricsForAds) {
    const arr = metricsByAdId.get(m.adId);
    if (arr) arr.push(m);
    else metricsByAdId.set(m.adId, [m]);
  }
  for (const arr of metricsByAdId.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  const adSummaries = allAds.map((ad) => {
    const allMetrics = metricsByAdId.get(ad.id) ?? [];
    const fatigue = calculateFatigueScore(allMetrics, scoringSettings);
    const rangeMetrics = allMetrics.filter(m => m.date >= rangeStart && m.date <= rangeEnd);
    const totalSpend = rangeMetrics.reduce((s, m) => s + (m.spend ?? 0), 0);
    const totalReach = rangeMetrics.reduce((s, m) => s + (m.reach ?? 0), 0);
    const totalImpressions = rangeMetrics.reduce((s, m) => s + (m.impressions ?? 0), 0);
    const totalClicks = rangeMetrics.reduce((s, m) => s + (m.clicks ?? 0), 0);
    const avgCTR = rangeMetrics.length > 0 ? rangeMetrics.reduce((s, m) => s + m.ctr, 0) / rangeMetrics.length : 0;
    const avgCPM = rangeMetrics.length > 0 ? rangeMetrics.reduce((s, m) => s + m.cpm, 0) / rangeMetrics.length : 0;
    const avgFrequency = rangeMetrics.length > 0 ? rangeMetrics.reduce((s, m) => s + m.frequency, 0) / rangeMetrics.length : 0;
    const avgCPC = rangeMetrics.length > 0 ? rangeMetrics.reduce((s, m) => s + m.cpc, 0) / rangeMetrics.length : 0;
    const costPerResult = rangeMetrics.length > 0 ? rangeMetrics.reduce((s, m) => s + m.costPerAction, 0) / rangeMetrics.length : 0;
    return {
      id: ad.id,
      adName: ad.adName,
      campaignName: ad.campaignName,
      status: ad.status,
      fatigueScore: fatigue.fatigueScore,
      stage: fatigue.stage,
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalReach,
      totalImpressions,
      totalClicks,
      avgCTR: Math.round(avgCTR * 100) / 100,
      avgCPM: Math.round(avgCPM * 100) / 100,
      avgFrequency: Math.round(avgFrequency * 100) / 100,
      avgCPC: Math.round(avgCPC * 100) / 100,
      costPerResult: Math.round(costPerResult * 100) / 100,
    };
  });

  // Build daily spend by ad (top 6 by total spend, last 30 days)
  const topAds = [...adSummaries].sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 6);
  const topAdIds = new Set(topAds.map(a => a.id));

  const recentMetrics = await db
    .select()
    .from(dailyMetrics)
    .where(and(gte(dailyMetrics.date, rangeStart), lte(dailyMetrics.date, rangeEnd)))
    .all();

  // Build date -> { adName: spend } map across the SELECTED range (not hard-
  // coded to current month). Use T12:00:00 to dodge timezone off-by-ones.
  const dailyMap = new Map<string, Record<string, number>>();
  const dailyMapStart = new Date(rangeStart + "T12:00:00");
  const dailyMapEnd = new Date(rangeEnd + "T12:00:00");
  for (let d = new Date(dailyMapStart); d <= dailyMapEnd; d.setDate(d.getDate() + 1)) {
    dailyMap.set(format(d, "yyyy-MM-dd"), {});
  }

  const adIdToName = new Map(topAds.map(a => [a.id, a.adName]));
  for (const m of recentMetrics) {
    if (!topAdIds.has(m.adId)) continue;
    const name = adIdToName.get(m.adId);
    if (!name) continue;
    const dayData = dailyMap.get(m.date);
    if (dayData) {
      dayData[name] = (dayData[name] ?? 0) + (m.spend ?? 0);
    }
  }

  const dailySpendByAd = Array.from(dailyMap.entries()).map(([date, spends]) => ({
    date,
    ...Object.fromEntries(
      topAds.map(a => [a.adName, Math.round((spends[a.adName] ?? 0) * 100) / 100])
    ),
  }));

  // TOP-LINE TOTALS: sum from ALL ads in range (including paused/archived/
  // unattributed) so the numbers match Dashboard's Performance card exactly.
  // DEDUPE: Turso prod had accumulated duplicate (ad_id, date) rows from a
  // pre-unique-index sync, which doubled spend. Collapse to one row per
  // (ad_id, date) picking the max spend, to survive that legacy state.
  const allAdIdsFull = new Set(allAdsRaw.map(a => a.id));
  const rangeMetricsAll = await db
    .select()
    .from(dailyMetrics)
    .where(and(gte(dailyMetrics.date, rangeStart), lte(dailyMetrics.date, rangeEnd)))
    .all();
  const dedupeMap = new Map<string, typeof rangeMetricsAll[number]>();
  for (const m of rangeMetricsAll) {
    if (m.date > rangeEnd) continue;
    if (!allAdIdsFull.has(m.adId)) continue;
    const key = `${m.adId}:${m.date}`;
    const existing = dedupeMap.get(key);
    if (!existing || (m.spend ?? 0) > (existing.spend ?? 0)) {
      dedupeMap.set(key, m);
    }
  }
  const rangeScopedAll = Array.from(dedupeMap.values());
  const totalSpend = rangeScopedAll.reduce((s, m) => s + (m.spend ?? 0), 0);
  const totalReach = rangeScopedAll.reduce((s, m) => s + (m.reach ?? 0), 0);
  const totalClicks = rangeScopedAll.reduce((s, m) => s + (m.clicks ?? 0), 0);
  const totalImpressionsAll = rangeScopedAll.reduce((s, m) => s + (m.impressions ?? 0), 0);

  // Campaign-level aggregates, spend/reach/clicks MUST include paused/archived/
  // unattributed rows so totals match Dashboard + top-line. Previous version summed
  // adSummaries (ACTIVE-only) which silently dropped historical spend.
  const campaignNameById = new Map(allAdsRaw.map(a => [a.id, a.campaignName]));
  const activeAdCountByCampaign = new Map<string, number>();
  const fatigueSumByCampaign = new Map<string, number>();
  for (const ad of adSummaries) {
    activeAdCountByCampaign.set(ad.campaignName, (activeAdCountByCampaign.get(ad.campaignName) ?? 0) + 1);
    fatigueSumByCampaign.set(ad.campaignName, (fatigueSumByCampaign.get(ad.campaignName) ?? 0) + ad.fatigueScore);
  }

  const campaignMap = new Map<string, { spend: number; reach: number; clicks: number }>();
  for (const m of rangeScopedAll) {
    const name = campaignNameById.get(m.adId);
    if (!name) continue;
    const c = campaignMap.get(name) ?? { spend: 0, reach: 0, clicks: 0 };
    c.spend += m.spend ?? 0;
    c.reach += m.reach ?? 0;
    c.clicks += m.clicks ?? 0;
    campaignMap.set(name, c);
  }

  const campaignSpend = Array.from(campaignMap.entries()).map(([campaignName, c]) => {
    const activeAds = activeAdCountByCampaign.get(campaignName) ?? 0;
    const fatigueSum = fatigueSumByCampaign.get(campaignName) ?? 0;
    return {
      campaignName,
      spend: Math.round(c.spend * 100) / 100,
      reach: c.reach,
      clicks: c.clicks,
      ads: activeAds,
      avgFatigue: activeAds > 0 ? Math.round(fatigueSum / activeAds) : 0,
    };
  });

  // Account health
  const accountHealth = adSummaries.length > 0
    ? Math.round(100 - adSummaries.reduce((s, a) => s + a.fatigueScore, 0) / adSummaries.length)
    : 100;

  // HUBSPOT: use the LITE variant for the main funnel so date preset clicks
  // are fast. getLeadsFunnel (full) fans out a contact-association fetch per
  // company which makes every preset click take 5-10s on Strategy page.
  // Lite returns daily ATM + daily deal-based SQLs, enough for all the
  // numbers + charts on this page. Contact drilldown on LeadsClient is a
  // secondary feature that's rarely used; we pass an empty contacts array
  // rather than blocking the page render on it.
  const [hs, utmLeads, won] = await Promise.all([
    getLeadsFunnelLite(rangeStart, rangeEnd).catch((err) => {
      console.error("[strategy] HubSpot fetch failed:", err);
      return null;
    }),
    getATMLeadsByCampaign(rangeStart, rangeEnd).catch((err) => {
      console.error("[strategy] HubSpot utm-campaign fetch failed:", err);
      return [] as Array<{ campaign: string; count: number }>;
    }),
    getClosedWonRevenue(rangeStart, rangeEnd).catch((err) => {
      console.error("[strategy] HubSpot closed-won fetch failed:", err);
      return { totalRevenue: 0, wonCount: 0, revenueByUtm: [] as Array<{ campaign: string; revenue: number; deals: number }> };
    }),
  ]);
  const totalATM = hs?.totalATM ?? 0;
  const totalSQLs = hs?.totalSQLs ?? 0;
  const totalMQLs = 0;
  // Daily ATM from lite (no per-day sqls — that's derived from dailySQLDeals
  // below, matching the headline deal-based total).
  const hubspotATM = hs?.dailyATM.map(d => ({ date: d.date, atm: d.atm, sqls: 0 })) ?? [];
  const hubspotMQLs: Array<{ date: string; mqls: number }> = [];
  const allLeadContacts: Array<any> = [];
  const costPerDemo = totalATM > 0 ? totalSpend / totalATM : null;
  const costPerSQL = totalSQLs > 0 ? totalSpend / totalSQLs : null;
  const demoToSQLRate = totalATM > 0 ? (totalSQLs / totalATM) * 100 : null;
  const clickToLeadRate = totalClicks > 0 ? (totalATM / totalClicks) * 100 : null;

  // PER-CAMPAIGN CPL: join Meta campaign spend to HS ATM counts via utm_campaign.
  // Match is best-effort (normalize: lowercase, strip non-alphanumerics, substring
  // both ways) because Meta campaign names rarely match UTMs verbatim.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const utmNormMap = new Map(utmLeads.map(u => [normalize(u.campaign), u] as const));
  const utmClaimed = new Set<string>();
  const campaignCPL = campaignSpend.map(c => {
    const nameNorm = normalize(c.campaignName);
    let matchedLeads = 0;
    let matchedUtm: string | null = null;
    // Exact normalized match first
    const exact = utmNormMap.get(nameNorm);
    if (exact && !utmClaimed.has(exact.campaign)) {
      matchedLeads = exact.count;
      matchedUtm = exact.campaign;
      utmClaimed.add(exact.campaign);
    } else {
      // Fall back to substring match (longest first, unclaimed only)
      const candidates = [...utmNormMap.entries()]
        .filter(([k, v]) => !utmClaimed.has(v.campaign) && (k.includes(nameNorm) || nameNorm.includes(k)) && k.length > 2)
        .sort((a, b) => b[0].length - a[0].length);
      if (candidates.length > 0) {
        matchedLeads = candidates[0][1].count;
        matchedUtm = candidates[0][1].campaign;
        utmClaimed.add(matchedUtm);
      }
    }
    const cpl = matchedLeads > 0 ? Math.round((c.spend / matchedLeads) * 100) / 100 : null;
    return {
      campaignName: c.campaignName,
      spend: c.spend,
      leads: matchedLeads,
      cpl,
      matchedUtm,
    };
  });
  const unmatchedUtm = utmLeads
    .filter(u => !utmClaimed.has(u.campaign))
    .map(u => ({ campaign: u.campaign, count: u.count }));

  // ROAS: attribute closed-won revenue back to Meta campaigns using the same
  // normalized utm match. Revenue matches once per utm (longest-normalized
  // campaign name wins), the rest is surfaced as "unmatched revenue."
  const revNormMap = new Map(won.revenueByUtm.map(r => [normalize(r.campaign), r] as const));
  const revClaimed = new Set<string>();
  const campaignROAS = campaignCPL.map(c => {
    const nameNorm = normalize(c.campaignName);
    let revenue = 0;
    let deals = 0;
    const exact = revNormMap.get(nameNorm);
    if (exact && !revClaimed.has(exact.campaign)) {
      revenue = exact.revenue;
      deals = exact.deals;
      revClaimed.add(exact.campaign);
    } else {
      const cands = [...revNormMap.entries()]
        .filter(([k, v]) => !revClaimed.has(v.campaign) && (k.includes(nameNorm) || nameNorm.includes(k)) && k.length > 2)
        .sort((a, b) => b[0].length - a[0].length);
      if (cands.length > 0) {
        revenue = cands[0][1].revenue;
        deals = cands[0][1].deals;
        revClaimed.add(cands[0][1].campaign);
      }
    }
    const roas = c.spend > 0 ? Math.round((revenue / c.spend) * 100) / 100 : null;
    return { ...c, revenue, dealsWon: deals, roas };
  });
  const unmatchedRevenue = won.revenueByUtm
    .filter(r => !revClaimed.has(r.campaign))
    .map(r => ({ campaign: r.campaign, revenue: r.revenue, deals: r.deals }));
  const unmatchedRevenueTotal = unmatchedRevenue.reduce((s, r) => s + r.revenue, 0);

  const totalROAS = totalSpend > 0 ? Math.round((won.totalRevenue / totalSpend) * 100) / 100 : null;

  // DAY-OF-WEEK PERFORMANCE: aggregate spend + clicks + CTR by weekday to
  // expose when campaigns are most efficient.
  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowBuckets: Array<{ day: string; spend: number; clicks: number; impressions: number }> =
    DAY_LABELS.map((day) => ({ day, spend: 0, clicks: 0, impressions: 0 }));
  for (const m of rangeScopedAll) {
    const d = new Date(m.date + "T00:00:00");
    const b = dowBuckets[d.getDay()];
    b.spend += m.spend ?? 0;
    b.clicks += m.clicks ?? 0;
    b.impressions += m.impressions ?? 0;
  }
  const dayOfWeek = dowBuckets.map((b) => ({
    day: b.day,
    spend: Math.round(b.spend * 100) / 100,
    clicks: b.clicks,
    ctr: b.impressions > 0 ? Math.round((b.clicks / b.impressions) * 10000) / 100 : 0,
  }));

  // ============================================================
  // LEADS-page derivations (formerly lived in /leads/page.tsx)
  // Merged here so /strategy shows the full picture in one page.
  // ============================================================

  // Daily totals across the range (for top-line stacked-area chart).
  const leadDailyMap = new Map<string, { spend: number; clicks: number; conversions: number; impressions: number }>();
  const dStart = new Date(rangeStart + "T00:00:00");
  const dEnd = new Date(rangeEnd + "T00:00:00");
  for (let d = new Date(dStart); d <= dEnd; d.setDate(d.getDate() + 1)) {
    leadDailyMap.set(format(d, "yyyy-MM-dd"), { spend: 0, clicks: 0, conversions: 0, impressions: 0 });
  }
  for (const m of rangeScopedAll) {
    const day = leadDailyMap.get(m.date);
    if (day) {
      day.spend += m.spend ?? 0;
      day.clicks += m.clicks ?? 0;
      day.conversions += m.actions ?? 0;
      day.impressions += m.impressions ?? 0;
    }
  }
  const dailyData = Array.from(leadDailyMap.entries()).map(([date, d]) => ({
    date,
    spend: Math.round(d.spend * 100) / 100,
    clicks: d.clicks,
    conversions: d.conversions,
    impressions: d.impressions,
  }));

  // Per-campaign breakdown (Leads-style, with CPC + conversionRate).
  const leadCampaignMap = new Map<string, { spend: number; clicks: number; conversions: number; impressions: number; reach: number }>();
  for (const m of rangeScopedAll) {
    const name = campaignNameById.get(m.adId) || "Deleted / archived ads";
    const c = leadCampaignMap.get(name) ?? { spend: 0, clicks: 0, conversions: 0, impressions: 0, reach: 0 };
    c.spend += m.spend ?? 0;
    c.clicks += m.clicks ?? 0;
    c.conversions += m.actions ?? 0;
    c.impressions += m.impressions ?? 0;
    c.reach += m.reach ?? 0;
    leadCampaignMap.set(name, c);
  }
  const campaignBreakdown = Array.from(leadCampaignMap.entries())
    .map(([name, c]) => ({
      campaignName: name,
      spend: Math.round(c.spend * 100) / 100,
      clicks: c.clicks,
      conversions: c.conversions,
      impressions: c.impressions,
      reach: c.reach,
      cpc: c.clicks > 0 ? Math.round((c.spend / c.clicks) * 100) / 100 : 0,
      conversionRate: c.clicks > 0 ? Math.round((c.conversions / c.clicks) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Daily spend by campaign (for stacked chart inside LeadsClient).
  const dailyCampaignMap = new Map<string, Map<string, { spend: number; clicks: number; reach: number; impressions: number }>>();
  for (const m of rangeScopedAll) {
    const name = campaignNameById.get(m.adId);
    if (!name) continue;
    if (!dailyCampaignMap.has(m.date)) dailyCampaignMap.set(m.date, new Map());
    const dayMap = dailyCampaignMap.get(m.date)!;
    const c = dayMap.get(name) ?? { spend: 0, clicks: 0, reach: 0, impressions: 0 };
    c.spend += m.spend ?? 0;
    c.clicks += m.clicks ?? 0;
    c.reach += m.reach ?? 0;
    c.impressions += m.impressions ?? 0;
    dayMap.set(name, c);
  }
  const leadCampaignNames = campaignBreakdown.map((c) => c.campaignName);
  const dailyByCampaign = Array.from(leadDailyMap.keys()).map((date) => {
    const dayMap = dailyCampaignMap.get(date);
    const row: Record<string, any> = { date };
    for (const name of leadCampaignNames) {
      const d = dayMap?.get(name);
      row[`${name}_spend`] = d ? Math.round(d.spend * 100) / 100 : 0;
      row[`${name}_clicks`] = d ? d.clicks : 0;
      row[`${name}_reach`] = d ? d.reach : 0;
    }
    return row;
  });

  // Daily CPL + Cost-per-SQL, merges daily spend with daily ATM & deal-based
  // SQL counts. SQLs come from hs.dailySQLDeals (deal-based, matches the
  // native 'SQLs Monthly' HS report exactly) — NOT from contact-level
  // lifecycle classification, which was drifting away from the headline
  // totalSQLs number in the top card.
  const atmByDate = new Map(hubspotATM.map((d) => [d.date, d.atm]));
  const sqlsByDate = new Map<string, number>();
  for (const d of hs?.dailySQLDeals ?? []) {
    sqlsByDate.set(d.date, (sqlsByDate.get(d.date) || 0) + d.sqlDeals);
  }
  const dailyCPL = dailyData.map((day) => {
    const atm = atmByDate.get(day.date) || 0;
    const sqls = sqlsByDate.get(day.date) || 0;
    return {
      date: day.date,
      spend: day.spend,
      atm,
      sqls,
      cpl: atm > 0 ? Math.round((day.spend / atm) * 100) / 100 : null,
      costPerSql: sqls > 0 ? Math.round((day.spend / sqls) * 100) / 100 : null,
    };
  });

  const leadPageTotals = {
    totalConversions: rangeScopedAll.reduce((s, m) => s + (m.actions ?? 0), 0),
  };

  // ─────────────────────────────────────────────────────────────
  // STRATEGY ENGINE: generate campaign-level recommendations.
  // Campaign-level is where HubSpot attribution is reliable (ATM leads are
  // joined via hs_analytics_source_data_2 which contains the Meta campaign
  // name). Each rec has a number + action + confidence.
  // ─────────────────────────────────────────────────────────────
  const fatigueByCampaign = new Map<string, { sum: number; n: number }>();
  for (const a of adSummaries) {
    const agg = fatigueByCampaign.get(a.campaignName) ?? { sum: 0, n: 0 };
    agg.sum += a.fatigueScore;
    agg.n += 1;
    fatigueByCampaign.set(a.campaignName, agg);
  }
  const activeCountByCampaign = new Map<string, number>();
  for (const a of adSummaries) {
    activeCountByCampaign.set(a.campaignName, (activeCountByCampaign.get(a.campaignName) ?? 0) + 1);
  }
  const campaignInputs: CampaignInput[] = campaignROAS.map((c) => {
    const fatigueAgg = fatigueByCampaign.get(c.campaignName);
    return {
      campaignName: c.campaignName,
      spend: c.spend,
      leads: c.leads,
      revenue: c.revenue,
      roas: c.roas,
      cpl: c.cpl,
      activeAdCount: activeCountByCampaign.get(c.campaignName) ?? 0,
      avgFatigue: fatigueAgg && fatigueAgg.n > 0 ? Math.round(fatigueAgg.sum / fatigueAgg.n) : 0,
    };
  });
  const accountCPL = totalATM > 0 ? totalSpend / totalATM : null;
  const recommendations = generateCampaignRecommendations(campaignInputs, accountCPL, totalSpend);

  const lastSyncedAt = allAdsRaw.reduce((max, ad) => Math.max(max, ad.lastSyncedAt ?? 0), 0);

  // ─────────────────────────────────────────────────────────────
  // WoW: build daily maps over the last ~8 weeks (always anchored on today,
  // independent of the user-selected range) so the WoW cards are stable
  // even when Orly is looking at e.g. "last month" in the range picker.
  // ─────────────────────────────────────────────────────────────
  const weeklyTrendFromDate = subDays(now, 8 * 7);
  const weeklyFromStr = format(weeklyTrendFromDate, "yyyy-MM-dd");
  const todayStr = format(now, "yyyy-MM-dd");
  const [wowMetricsRaw, hubspotWoW] = await Promise.all([
    db.select().from(dailyMetrics).where(and(gte(dailyMetrics.date, weeklyFromStr), lte(dailyMetrics.date, todayStr))).all(),
    getLeadsFunnelLite(weeklyFromStr, todayStr).catch(err => {
      console.error("[strategy] HubSpot WoW fetch failed:", err);
      return null;
    }),
  ]);
  const wowAdIdSet = new Set(allAdsRaw.map(a => a.id));
  const wowDedupe = new Map<string, typeof wowMetricsRaw[number]>();
  for (const m of wowMetricsRaw) {
    if (!wowAdIdSet.has(m.adId)) continue;
    const key = `${m.adId}:${m.date}`;
    const existing = wowDedupe.get(key);
    if (!existing || (m.spend ?? 0) > (existing.spend ?? 0)) wowDedupe.set(key, m);
  }
  const wowSpendByDate = new Map<string, number>();
  for (const m of wowDedupe.values()) {
    wowSpendByDate.set(m.date, (wowSpendByDate.get(m.date) || 0) + (m.spend ?? 0));
  }
  const wowAtmByDate = new Map<string, number>();
  const wowSqlsByDate = new Map<string, number>();
  if (hubspotWoW) {
    for (const d of hubspotWoW.dailyATM) {
      wowAtmByDate.set(d.date, (wowAtmByDate.get(d.date) || 0) + d.atm);
    }
    for (const d of hubspotWoW.dailySQLDeals) {
      wowSqlsByDate.set(d.date, (wowSqlsByDate.get(d.date) || 0) + d.sqlDeals);
    }
  }
  const wow = computeWoW({
    dailySpend: wowSpendByDate,
    dailyAtm: wowAtmByDate,
    dailySqls: wowSqlsByDate,
    now,
    weeksBack: 8,
  });

  return (
    <div className="min-h-screen">
      <div className="px-8 pt-6">
        <FreshnessGuard lastSyncedAt={lastSyncedAt || null} isPublic={!!session.isPublic} />
      </div>

      {/* Leads section (formerly /leads) */}
      <LeadsClient
        totalSpend={Math.round(totalSpend * 100) / 100}
        totalClicks={totalClicks}
        totalImpressions={totalImpressionsAll}
        totalConversions={leadPageTotals.totalConversions}
        totalReach={totalReach}
        dailyData={dailyData}
        campaignBreakdown={campaignBreakdown}
        rangeFrom={rangeStart}
        rangeTo={rangeEnd}
        activeAdCount={allAds.length}
        hubspotATM={hubspotATM.length > 0 ? hubspotATM : undefined}
        hubspotMQLs={hubspotMQLs.length > 0 ? hubspotMQLs : undefined}
        totalATM={totalATM > 0 ? totalATM : undefined}
        totalSQLs={totalSQLs > 0 ? totalSQLs : undefined}
        totalMQLs={totalMQLs > 0 ? totalMQLs : undefined}
        campaignNames={leadCampaignNames}
        dailyByCampaign={dailyByCampaign}
        leadContacts={allLeadContacts.length > 0 ? allLeadContacts : undefined}
        dailyCPL={dailyCPL}
        wow={wow}
      />

      {/* Analytics section */}
      <StrategyClient
        ads={adSummaries}
        dailySpendByAd={dailySpendByAd}
        campaignSpend={campaignSpend}
        accountHealth={accountHealth}
        recommendations={recommendations}
        totalSpend={Math.round(totalSpend * 100) / 100}
        totalReach={totalReach}
        totalClicks={totalClicks}
        totalImpressions={totalImpressionsAll}
        totalATM={totalATM}
        totalSQLs={totalSQLs}
        costPerDemo={costPerDemo !== null ? Math.round(costPerDemo * 100) / 100 : null}
        costPerSQL={costPerSQL !== null ? Math.round(costPerSQL * 100) / 100 : null}
        demoToSQLRate={demoToSQLRate !== null ? Math.round(demoToSQLRate * 10) / 10 : null}
        clickToLeadRate={clickToLeadRate !== null ? Math.round(clickToLeadRate * 100) / 100 : null}
        dayOfWeek={dayOfWeek}
        campaignCPL={campaignROAS}
        unmatchedUtm={unmatchedUtm}
        totalRevenue={won.totalRevenue}
        wonCount={won.wonCount}
        totalROAS={totalROAS}
        unmatchedRevenue={unmatchedRevenue}
        unmatchedRevenueTotal={Math.round(unmatchedRevenueTotal * 100) / 100}
        rangeLabel={`${format(new Date(rangeStart + "T12:00:00"), "MMM d")} – ${format(new Date(rangeEnd + "T12:00:00"), "MMM d, yyyy")}`}
        wow={wow}
      />
    </div>
  );
}
