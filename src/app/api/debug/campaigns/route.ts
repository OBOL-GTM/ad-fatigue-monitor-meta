import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ads, accounts } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

/**
 * Diagnostic: lists every unique campaign currently in the DB for the
 * signed-in user, grouped by status. Lets us quickly see whether a
 * campaign (like "lead gen") is actually in the DB and what statuses
 * its ads are stuck on — vs. comparing to what Meta shows.
 *
 * Also fetches the LIVE campaign list from Meta via the stored token
 * so we can diff "in DB" vs "in Meta right now."
 */
export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const allAccountIds: string[] = session.allAccountIds;
  if (allAccountIds.length === 0) {
    return NextResponse.json({ error: "No accounts in session" }, { status: 400 });
  }

  const accountRows = await db.select().from(accounts).where(inArray(accounts.id, allAccountIds)).all();
  const dbAds = await db.select().from(ads).where(inArray(ads.accountId, allAccountIds)).all();

  // Group DB ads by campaignName + status
  type CampaignGroup = {
    campaignName: string;
    campaignId: string;
    total: number;
    byStatus: Record<string, number>;
  };
  const byCampaignId = new Map<string, CampaignGroup>();
  for (const a of dbAds) {
    if (a.id.startsWith("__unattributed_")) continue;
    const key = a.campaignId || a.campaignName || "(unknown)";
    if (!byCampaignId.has(key)) {
      byCampaignId.set(key, { campaignName: a.campaignName || "(unknown)", campaignId: a.campaignId || "", total: 0, byStatus: {} });
    }
    const g = byCampaignId.get(key)!;
    g.total++;
    g.byStatus[a.status] = (g.byStatus[a.status] || 0) + 1;
  }
  const dbCampaigns = Array.from(byCampaignId.values()).sort((a, b) => b.total - a.total);

  // Pull LIVE campaign list from Meta for comparison
  const metaCampaigns: Array<{ accountId: string; list?: any[]; error?: string }> = [];
  for (const acct of accountRows) {
    if (acct.tokenExpiresAt < Date.now()) {
      metaCampaigns.push({ accountId: acct.id, error: "token expired" });
      continue;
    }
    const actId = acct.id.startsWith("act_") ? acct.id : `act_${acct.id}`;
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${actId}/campaigns?fields=id,name,status,effective_status&limit=200&access_token=${acct.accessToken}`,
      );
      const data: any = await res.json();
      if (data.error) {
        metaCampaigns.push({ accountId: acct.id, error: data.error.message });
      } else {
        metaCampaigns.push({
          accountId: acct.id,
          list: (data.data || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            effective_status: c.effective_status,
          })),
        });
      }
    } catch (e: any) {
      metaCampaigns.push({ accountId: acct.id, error: e?.message || String(e) });
    }
  }

  return NextResponse.json({
    signedInAccountIds: allAccountIds,
    dbCampaigns,
    metaCampaigns,
  });
}
