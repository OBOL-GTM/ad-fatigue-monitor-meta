"use server";

import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { syncAccount } from "@/lib/meta/sync";
import { revalidatePath } from "next/cache";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { clearHubSpotCache } from "@/lib/hubspot/client";

export async function refreshData() {
  try {
    const session = await getSessionOrPublic();
    if (!session) {
      return { error: "Not authenticated. Go to /login first." };
    }
    const providerAccountId = session.accountId;
    if (!providerAccountId) {
      return { error: "No account connected. Go to /login first." };
    }

    // Get ALL accounts for this user (they may have multiple ad accounts)
    const allAccountIds: string[] = session.allAccountIds;
    const allAccounts = await db.select().from(accounts).all();
    // Filter to accounts that belong to this user's session
    const accountsToSync = allAccounts.filter(a => allAccountIds.includes(a.id));

    console.log(`[refreshData] Session has ${allAccountIds.length} account IDs: ${allAccountIds.join(", ")}`);
    console.log(`[refreshData] Found ${accountsToSync.length} accounts in DB to sync`);

    if (accountsToSync.length === 0) {
      return { error: "No account connected. Go to /login first." };
    }

    let totalAds = 0;
    let totalMetrics = 0;
    let totalAlerts = 0;
    const allErrors: string[] = [];

    // Sync ALL accounts, errors from empty accounts are suppressed when at least one has ads
    for (const account of accountsToSync) {
      if (account.tokenExpiresAt < Date.now()) {
        allErrors.push(`Account ${account.name}: token expired`);
        continue;
      }

      console.log(`[refreshData] Syncing account ${account.id} (${account.name})...`);
      const result = await syncAccount(account.id);
      totalAds += result.adsFound;
      totalMetrics += result.metricsUpserted;
      totalAlerts += result.alertsGenerated;
      if (result.errors.length > 0) {
        // Suppress "empty account" errors from secondary Meta accounts, they're noise, not failures
        const realErrors = result.errors.filter(e =>
          !/no campaigns|no ads found|make sure you have active campaigns/i.test(e)
        );
        if (realErrors.length > 0) {
          allErrors.push(...realErrors.map(e => `${account.name}: ${e}`));
        }
      }

      if (result.adsFound > 0) {
        console.log(`[refreshData] Account ${account.name} has ${result.adsFound} ads!`);
      }
    }

    // Clear the HubSpot in-memory cache so manual Refresh actually pulls fresh
    // HS data too. Without this, users see stale HubSpot numbers for up to 3
    // minutes after clicking Refresh (the cache TTL).
    clearHubSpotCache();

    // Invalidate every cached data-dependent page so both Meta metrics (re-synced
    // above) AND HubSpot data (re-fetched on next render via getLeadsFunnel) get
    // refreshed. revalidatePath clears the Next.js cache for that route.
    revalidatePath("/dashboard");
    revalidatePath("/alerts");
    revalidatePath("/leads");
    revalidatePath("/strategy");
    revalidatePath("/executive");
    revalidatePath("/ads");

    return {
      success: totalAds > 0 || allErrors.length === 0,
      adsFound: totalAds,
      metricsUpserted: totalMetrics,
      alertsGenerated: totalAlerts,
      errors: allErrors,
    };
  } catch (err: any) {
    console.error("[refreshData] Error:", err.message);
    return { error: `Sync failed: ${err.message}` };
  }
}
