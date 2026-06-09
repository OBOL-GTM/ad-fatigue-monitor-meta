import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { ads, dailyMetrics } from "@/lib/db/schema";
import { inArray, gte } from "drizzle-orm";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { getATMLeadsByCampaign } from "@/lib/hubspot/client";
import { calculateFatigueScore } from "@/lib/fatigue/scoring";
import { DEFAULT_SETTINGS } from "@/lib/fatigue/types";
import { buildCampaignSnapshots, type PlanRecommendation } from "@/lib/strategy/plan";
import { format, startOfMonth, subDays } from "date-fns";

export const dynamic = "force-dynamic";
// Claude calls can take 20-40s for large prompts; avoid Railway gateway cut.
export const maxDuration = 120;

/**
 * Forecast & Plan: assembles per-campaign snapshots from Meta + HubSpot,
 * sends them to Claude, and returns structured recommendations designed to
 * lower CPL per campaign.
 *
 * POST /api/strategy/plan?range=mtd|30d|7d  (default mtd)
 */
export async function POST(req: Request) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const allAccountIds: string[] = session.allAccountIds;
  if (allAccountIds.length === 0) {
    return NextResponse.json({ error: "No accounts in session" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set on server" }, { status: 500 });
  }

  const url = new URL(req.url);
  const range = (url.searchParams.get("range") || "mtd").toLowerCase();
  const now = new Date();
  const rangeEnd = format(now, "yyyy-MM-dd");
  const rangeStart = range === "7d"
    ? format(subDays(now, 6), "yyyy-MM-dd")
    : range === "30d"
    ? format(subDays(now, 29), "yyyy-MM-dd")
    : format(startOfMonth(now), "yyyy-MM-dd");

  // Pull ads + range metrics + HS attribution in parallel.
  const [allAds, metricsRaw, leadsByCampaign] = await Promise.all([
    db.select().from(ads).where(inArray(ads.accountId, allAccountIds)).all(),
    db.select().from(dailyMetrics).where(gte(dailyMetrics.date, rangeStart)).all(),
    getATMLeadsByCampaign(rangeStart, rangeEnd).catch(() => [] as Array<{ campaign: string; count: number }>),
  ]);

  const adIds = new Set(allAds.map(a => a.id));
  const scopedMetrics = metricsRaw.filter(m => m.date <= rangeEnd && adIds.has(m.adId));

  // Fatigue per ad — calculated from full history so scores are meaningful
  const allMetricsFull = await db.select().from(dailyMetrics).where(inArray(dailyMetrics.adId, Array.from(adIds))).all();
  const metricsByAd = new Map<string, typeof allMetricsFull>();
  for (const m of allMetricsFull) {
    if (!metricsByAd.has(m.adId)) metricsByAd.set(m.adId, []);
    metricsByAd.get(m.adId)!.push(m);
  }
  const fatigueByAdId = new Map<string, number>();
  for (const ad of allAds) {
    const h = metricsByAd.get(ad.id) ?? [];
    if (h.length > 0) {
      const f = calculateFatigueScore(h.sort((a, b) => a.date.localeCompare(b.date)), DEFAULT_SETTINGS);
      fatigueByAdId.set(ad.id, f.fatigueScore);
    }
  }

  const snapshots = buildCampaignSnapshots({
    ads: allAds,
    metrics: scopedMetrics,
    fatigueByAdId,
    leadsByCampaign,
  });

  // Only include campaigns that actually ran this period, to keep prompt
  // focused. Archived-only campaigns with no spend don't help Claude.
  const relevant = snapshots.filter(s => s.spend > 0 || s.activeAdCount > 0).slice(0, 12);

  if (relevant.length === 0) {
    return NextResponse.json({
      range,
      rangeStart,
      rangeEnd,
      generatedAt: Date.now(),
      recommendations: [] as PlanRecommendation[],
      note: "No active or recently-spending campaigns in range.",
    });
  }

  // Call Claude with a tight structured prompt
  const client = new Anthropic({ apiKey });
  const prompt = [
    "You are a performance marketing strategist reviewing a Meta Ads account. Your job is to recommend specific, actionable changes per campaign that will lower cost-per-lead (CPL).",
    "",
    "ACCOUNT DATA:",
    JSON.stringify({ rangeStart, rangeEnd, campaigns: relevant }, null, 2),
    "",
    "RULES FOR RECOMMENDATIONS:",
    "- Return ONLY valid JSON matching the schema below. No prose, no markdown.",
    "- One object per campaign, up to 3 actions each, prioritized.",
    "- Be specific: reference the actual adName / campaignName in the recommendation text.",
    "- Actions should be concrete: 'duplicate top ad into new adset with Advantage+ audience' — not 'optimize further'.",
    "- If CPL is null (no leads tracked yet), focus on engagement-quality signals (CTR, frequency, fatigue).",
    "- If avgFatigueScore ≥ 50, include a creative-refresh or pause action.",
    "- If CPM is rising or high vs the account average, suggest audience tests or broader targeting.",
    "- If top and bottom ad CTR differ by 2x+, suggest pausing bottom and duplicating top.",
    "- If leads > 0 but CPL high, suggest testing a stricter optimization event (e.g. Purchase → Lead → SUBSCRIBE).",
    "- targetCpl: a concrete number representing a realistic 20-35% improvement on currentCpl; null if currentCpl is null.",
    "- headline: ONE sentence summarizing the campaign's current state.",
    "",
    "SCHEMA:",
    '{ "recommendations": [ { "campaignName": string, "currentCpl": number|null, "targetCpl": number|null, "headline": string, "actions": [ { "priority": "high"|"medium"|"low", "type": "pause"|"scale"|"new-adset"|"creative-test"|"optimization-event"|"budget-shift"|"audience"|"other", "text": string } ] } ] }',
  ].join("\n");

  let text = "";
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const first = resp.content[0];
    if (first && first.type === "text") text = first.text.trim();
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Common: user's Anthropic balance is empty. Surface a friendly,
    // actionable message instead of a raw 400 JSON dump.
    if (/credit balance is too low|insufficient.*credit|billing/i.test(msg)) {
      return NextResponse.json({
        error: "Anthropic credits are empty — add credits at https://console.anthropic.com/settings/billing and try again.",
        needsCredits: true,
      }, { status: 402 });
    }
    if (/rate.?limit/i.test(msg)) {
      return NextResponse.json({
        error: "Hit Anthropic rate limit — wait a minute and retry.",
      }, { status: 429 });
    }
    return NextResponse.json({ error: `Claude call failed: ${msg}` }, { status: 502 });
  }

  // Tolerate the model wrapping output in ```json fences
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return NextResponse.json({ error: "Could not parse Claude response", raw: text.slice(0, 2000) }, { status: 502 });
  }

  return NextResponse.json({
    range,
    rangeStart,
    rangeEnd,
    generatedAt: Date.now(),
    snapshotsUsed: relevant.length,
    recommendations: (parsed.recommendations ?? []) as PlanRecommendation[],
  });
}
