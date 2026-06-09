import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { db } from "@/lib/db";
import { accounts, ads, dailyMetrics } from "@/lib/db/schema";
import { gte, lte, and, sql, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Debug spend, hit /api/debug/spend?from=2026-04-01&to=2026-04-20 (logged in).
 * Breaks down daily_metrics totals by account + unattributed vs real so we can
 * see exactly where the $27k-vs-$13.9k gap is coming from.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || "2026-04-01";
  const to = searchParams.get("to") || "2026-04-20";

  // All accounts in DB
  const allAccounts = await db.select().from(accounts).all();

  // Session's scoped account IDs
  const sessAccountIds: string[] = session.allAccountIds;

  // For each account, sum spend by joining ads -> dailyMetrics
  const perAccount: Array<{ accountId: string; name: string; ads: number; realSpend: number; unattributedSpend: number; total: number }> = [];

  for (const acct of allAccounts) {
    const adsInAcct = await db.select({ id: ads.id }).from(ads).where(sql`${ads.accountId} = ${acct.id}`).all();
    const adIds = adsInAcct.map((a) => a.id);
    const realAdIds = adIds.filter((id) => !id.startsWith("__unattributed_"));
    const unAdIds = adIds.filter((id) => id.startsWith("__unattributed_"));

    const realSpend = realAdIds.length
      ? (
          await db
            .select({ s: sql<number>`COALESCE(SUM(${dailyMetrics.spend}), 0)` })
            .from(dailyMetrics)
            .where(and(gte(dailyMetrics.date, from), lte(dailyMetrics.date, to), inArray(dailyMetrics.adId, realAdIds)))
            .get()
        )?.s || 0
      : 0;

    const unSpend = unAdIds.length
      ? (
          await db
            .select({ s: sql<number>`COALESCE(SUM(${dailyMetrics.spend}), 0)` })
            .from(dailyMetrics)
            .where(and(gte(dailyMetrics.date, from), lte(dailyMetrics.date, to), inArray(dailyMetrics.adId, unAdIds)))
            .get()
        )?.s || 0
      : 0;

    perAccount.push({
      accountId: acct.id,
      name: acct.name,
      ads: adIds.length,
      realSpend: Math.round(realSpend * 100) / 100,
      unattributedSpend: Math.round(unSpend * 100) / 100,
      total: Math.round((realSpend + unSpend) * 100) / 100,
    });
  }

  // Orphan rows: dailyMetrics rows whose ad_id is NOT in the ads table at all.
  const orphan =
    (
      await db
        .select({ s: sql<number>`COALESCE(SUM(${dailyMetrics.spend}), 0)` })
        .from(dailyMetrics)
        .where(
          and(
            gte(dailyMetrics.date, from),
            lte(dailyMetrics.date, to),
            sql`${dailyMetrics.adId} NOT IN (SELECT id FROM ads)`,
          ),
        )
        .get()
    )?.s || 0;

  // Grand total
  const grand =
    (
      await db
        .select({ s: sql<number>`COALESCE(SUM(${dailyMetrics.spend}), 0)` })
        .from(dailyMetrics)
        .where(and(gte(dailyMetrics.date, from), lte(dailyMetrics.date, to)))
        .get()
    )?.s || 0;

  // ── Live Meta reconciliation ──
  // For each session account, call Meta's account-level insights endpoint and
  // compare its spend number vs what we have in the DB. Any gap means we're
  // missing data (recent sync hasn't captured it yet, or there's a real bug).
  const liveReconciliation: Array<{
    accountId: string;
    name: string;
    metaSpend: number | null;
    dbSpend: number;
    gap: number;
    gapPct: number | null;
    error?: string;
  }> = [];

  for (const acct of allAccounts.filter((a) => sessAccountIds.includes(a.id))) {
    const dbEntry = perAccount.find((p) => p.accountId === acct.id);
    const dbSpend = dbEntry?.total || 0;
    if (acct.tokenExpiresAt < Date.now()) {
      liveReconciliation.push({
        accountId: acct.id,
        name: acct.name,
        metaSpend: null,
        dbSpend,
        gap: 0,
        gapPct: null,
        error: "token expired",
      });
      continue;
    }
    try {
      const actId = acct.id.startsWith("act_") ? acct.id : `act_${acct.id}`;
      const url = `https://graph.facebook.com/v21.0/${actId}/insights?fields=spend&level=account&time_range=${encodeURIComponent(
        JSON.stringify({ since: from, until: to }),
      )}&access_token=${acct.accessToken}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const metaSpend = parseFloat(body?.data?.[0]?.spend || "0") || 0;
      const gap = Math.round((metaSpend - dbSpend) * 100) / 100;
      const gapPct = metaSpend > 0 ? Math.round((gap / metaSpend) * 10000) / 100 : null;
      liveReconciliation.push({
        accountId: acct.id,
        name: acct.name,
        metaSpend: Math.round(metaSpend * 100) / 100,
        dbSpend,
        gap,
        gapPct,
      });
    } catch (e: any) {
      liveReconciliation.push({
        accountId: acct.id,
        name: acct.name,
        metaSpend: null,
        dbSpend,
        gap: 0,
        gapPct: null,
        error: e?.message || String(e),
      });
    }
  }

  const liveMetaTotal = liveReconciliation.reduce(
    (s, r) => s + (r.metaSpend || 0),
    0,
  );

  // Per-day breakdown for the last 7 days of the range, makes same-day lag
  // obvious (today's spend hasn't landed yet because Meta's insights API has
  // 6-12h delay).
  const dailyBreakdown = await db
    .select({
      date: dailyMetrics.date,
      totalSpend: sql<number>`COALESCE(SUM(${dailyMetrics.spend}), 0)`,
    })
    .from(dailyMetrics)
    .where(
      and(
        gte(dailyMetrics.date, from),
        lte(dailyMetrics.date, to),
        sessAccountIds.length > 0
          ? inArray(
              dailyMetrics.adId,
              (
                await db
                  .select({ id: ads.id })
                  .from(ads)
                  .where(inArray(ads.accountId, sessAccountIds))
                  .all()
              ).map((a) => a.id),
            )
          : undefined,
      ),
    )
    .groupBy(dailyMetrics.date)
    .orderBy(dailyMetrics.date)
    .all();

  return NextResponse.json({
    range: { from, to },
    session: {
      accountId: session.accountId,
      allAccountIds: sessAccountIds,
    },
    accountsInDb: allAccounts.length,
    perAccount,
    orphanSpend: Math.round(orphan * 100) / 100,
    grandTotalDailyMetrics: Math.round(grand * 100) / 100,
    liveReconciliation,
    liveMetaTotal: Math.round(liveMetaTotal * 100) / 100,
    diagnosis: liveReconciliation.length === 0
      ? "No session accounts to reconcile."
      : liveReconciliation.some((r) => Math.abs(r.gapPct || 0) > 5)
        ? `Significant drift: some accounts >5% off Meta. Click Refresh in sidebar to resync, or verify Meta Ads Manager number (it may be rounded).`
        : liveReconciliation.some((r) => Math.abs(r.gap) > 10)
          ? `Small gap ($${liveReconciliation.reduce((s, r) => s + Math.abs(r.gap), 0).toFixed(2)} total) likely due to same-day Meta insights lag. Tomorrow's sync will close it.`
          : "DB spend matches live Meta within rounding.",
    dailyBreakdown: dailyBreakdown.map((d) => ({
      date: d.date,
      spend: Math.round(d.totalSpend * 100) / 100,
    })),
    note: "liveReconciliation calls Meta's /insights endpoint directly and compares vs DB. gap = metaSpend - dbSpend. If gap is positive, DB is behind Meta (sync needs to run). If negative, DB has stale data Meta no longer reports.",
  });
}
