import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { syncAccount, syncTodayOnly } from "@/lib/meta/sync";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { clearHubSpotCache } from "@/lib/hubspot/client";
import { revalidatePath } from "next/cache";

// Sync pulls ads + metrics + insights for potentially 90 days, chunked. On
// large accounts that takes 60-90s. Railway's default request timeout is low,
// so we raise it here. Route Handlers respect this.
export const maxDuration = 300;

// Global lock: if a sync is already in progress for an account, new requests
// wait on the existing promise instead of kicking off a parallel sync. Prevents
// row-lock contention in Turso when user mashes Refresh + auto-sync fires.
const activeSyncs = new Map<string, Promise<any>>();

// Progress map, readable via /api/sync/status so the Sidebar can show live
// progress instead of a generic 60-second spinner.
type SyncProgress = {
  mode: "full" | "quick";
  accountIds: string[];
  startedAt: number;
  finishedAt: number | null;
  success: boolean | null;
  tokenExpired: boolean;
  adsFound: number;
  metricsUpserted: number;
  errors: string[];
};
const progressByKey = new Map<string, SyncProgress>();
export function getSyncProgress(accountIds: string[], mode: "full" | "quick") {
  const key = `${mode}:${accountIds.slice().sort().join(",")}`;
  return progressByKey.get(key) || null;
}

async function runSync(accountIds: string[], mode: "full" | "quick" = "full", resetStatuses = false) {
  const lockKey = `${mode}:${accountIds.slice().sort().join(",")}`;
  const existing = activeSyncs.get(lockKey);
  if (existing) {
    console.log(`[sync] Joining in-flight ${mode} sync for ${lockKey}`);
    return existing;
  }
  // Record progress so /api/sync/status can report while work is in flight.
  const progress: SyncProgress = {
    mode,
    accountIds,
    startedAt: Date.now(),
    finishedAt: null,
    success: null,
    tokenExpired: false,
    adsFound: 0,
    metricsUpserted: 0,
    errors: [],
  };
  progressByKey.set(lockKey, progress);
  const p = _runSyncInner(accountIds, mode, resetStatuses)
    .then((result: any) => {
      progress.finishedAt = Date.now();
      progress.success = result.success ?? (result.adsFound > 0 || (result.errors?.length ?? 0) === 0);
      progress.tokenExpired = Boolean(result.tokenExpired);
      progress.adsFound = result.adsFound ?? 0;
      progress.metricsUpserted = result.metricsUpserted ?? 0;
      progress.errors = result.errors ?? [];
      return result;
    })
    .catch((err: any) => {
      progress.finishedAt = Date.now();
      progress.success = false;
      progress.errors = [err?.message || String(err)];
      throw err;
    })
    .finally(() => activeSyncs.delete(lockKey));
  activeSyncs.set(lockKey, p);
  return p;
}

async function _runSyncInner(accountIds: string[], mode: "full" | "quick" = "full", resetStatuses = false) {
  const allAccounts = await db
    .select()
    .from(accounts)
    .where(inArray(accounts.id, accountIds))
    .all();

  if (allAccounts.length === 0) {
    return {
      success: false,
      error: "No account connected. Please click 'Connect with Facebook' on the login page first.",
    } as const;
  }

  // Optional one-shot heal: zero out every ad's status for these accounts
  // before syncing, so the upsert below rewrites each one from Meta's current
  // truth. Use when the DB is suspected to have stale ARCHIVED flags from a
  // prior buggy reconciliation pass. Metrics rows are NOT touched — spend,
  // CTR etc. are preserved.
  if (resetStatuses && mode === "full") {
    try {
      const { sql } = await import("drizzle-orm");
      const { ads } = await import("@/lib/db/schema");
      for (const acctId of accountIds) {
        await db.run(sql`UPDATE ads SET status = 'UNKNOWN' WHERE account_id = ${acctId}`);
      }
      console.log(`[sync] Reset statuses for ${accountIds.length} account(s) before resync`);
    } catch (e: any) {
      console.warn(`[sync] reset-statuses failed (non-fatal):`, e?.message || e);
    }
  }

  let totalAds = 0;
  let totalMetrics = 0;
  let totalAlerts = 0;
  const perAccount: Array<{
    accountId: string;
    accountName: string;
    adsFound: number;
    metricsUpserted: number;
    errors: string[];
    tokenExpired?: boolean;
  }> = [];
  const allErrors: string[] = [];

  // Process accounts in parallel, isolated try/catch per account so a single
  // broken account doesn't kill the whole refresh.
  const recordRun = async (
    accountId: string,
    startedAt: number,
    success: boolean,
    adsFound: number,
    metricsUpserted: number,
    errors: string[],
  ) => {
    try {
      const { createRawDbClient } = await import("@/lib/db");
      const c = createRawDbClient();
      await c.execute({
        sql: `INSERT INTO sync_runs (mode, source, account_id, started_at, finished_at, success, ads_found, metrics_upserted, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [mode, "manual", accountId, startedAt, Date.now(), success ? 1 : 0, adsFound, metricsUpserted, errors.length ? JSON.stringify(errors) : null],
      });
    } catch (e) {
      console.error("[sync_runs] insert failed (manual):", e);
    }
  };

  await Promise.all(
    allAccounts.map(async (account) => {
      const accStart = Date.now();
      const entry = {
        accountId: account.id,
        accountName: account.name,
        adsFound: 0,
        metricsUpserted: 0,
        errors: [] as string[],
      };
      perAccount.push(entry);

      if (account.tokenExpiresAt < Date.now()) {
        entry.errors.push("Meta token expired, reconnect on login page.");
        Object.assign(entry, { tokenExpired: true });
        await recordRun(account.id, accStart, false, 0, 0, entry.errors);
        return;
      }

      try {
        // "quick" mode: only pull today's insights + refresh ad statuses.
        // Takes ~3-5s vs 30-60s for the full 180-day sync. The 10-min
        // auto-sync in instrumentation.ts keeps the historical window fresh.
        if (mode === "quick") {
          const result = await syncTodayOnly(account.id);
          entry.metricsUpserted = result.rowsUpdated;
          totalMetrics += result.rowsUpdated;
          const realErrors = (result.errors || []).filter(
            (e) => !/no campaigns|no ads found|make sure you have active campaigns/i.test(e),
          );
          entry.errors.push(...realErrors);
          allErrors.push(...realErrors.map((e) => `${account.name}: ${e}`));
          await recordRun(account.id, accStart, realErrors.length === 0, 0, result.rowsUpdated, realErrors);
          return;
        }
        const result = await syncAccount(account.id);
        entry.adsFound = result.adsFound;
        entry.metricsUpserted = result.metricsUpserted;
        totalAds += result.adsFound;
        totalMetrics += result.metricsUpserted;
        totalAlerts += result.alertsGenerated;
        const realErrors = (result.errors || []).filter(
          (e) => !/no campaigns|no ads found|make sure you have active campaigns/i.test(e),
        );
        entry.errors.push(...realErrors);
        allErrors.push(...realErrors.map((e) => `${account.name}: ${e}`));
        await recordRun(account.id, accStart, realErrors.length === 0, result.adsFound, result.metricsUpserted, realErrors);
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.error(`[sync] Account ${account.id} threw:`, msg);
        entry.errors.push(`Sync crashed: ${msg}`);
        allErrors.push(`${account.name}: ${msg}`);
        await recordRun(account.id, accStart, false, 0, 0, [msg]);
      }
    }),
  );

  // Always clear HS cache + revalidate pages so subsequent page loads are fresh.
  clearHubSpotCache();
  revalidatePath("/dashboard");
  revalidatePath("/alerts");
  revalidatePath("/leads");
  revalidatePath("/strategy");
  revalidatePath("/executive");
  revalidatePath("/ads");

  const tokenExpired = perAccount.some((a: any) => a.tokenExpired);
  // Quick mode doesn't count ads (it only refreshes today's metrics on
  // existing ads) so success is judged on errors + token validity only.
  // Full mode requires at least one ad fetched to count as success.
  const success = mode === "quick"
    ? allErrors.length === 0 && !tokenExpired
    : totalAds > 0 && allErrors.length === 0 && !tokenExpired;
  return {
    success,
    tokenExpired,
    adsFound: totalAds,
    metricsUpserted: totalMetrics,
    alertsGenerated: totalAlerts,
    errors: allErrors,
    perAccount,
    finishedAt: new Date().toISOString(),
  } as const;
}

// Cron entrypoint (GET with CRON_SECRET), syncs ALL connected accounts.
// Can also be hit by Railway cron / GitHub Actions / cron-job.org.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    const allAccounts = await db.select().from(accounts).all();
    const accountIds = allAccounts.map((a) => a.id);
    const result = await runSync(accountIds, "full");
    return NextResponse.json({ ...result, source: "cron" });
  }

  // Otherwise require a user session, sync all THEIR accounts.
  const session = await getSessionOrPublic();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allAccountIds: string[] = session.allAccountIds;
  if (allAccountIds.length === 0) {
    return NextResponse.json(
      { error: "No account connected. Please click 'Connect with Facebook' on the login page first." },
      { status: 400 },
    );
  }

  // Default = "full" (the original thorough 180-day sync).
  // Opt in to ?mode=quick for the 5-second today-only version.
  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode");
  const mode: "full" | "quick" = modeParam === "quick" ? "quick" : "full";
  // ?reset=1 — one-shot heal: wipe every ad's status to UNKNOWN before
  // the sync writes Meta's current truth back. Use when the DB is stale
  // from a prior buggy archival pass. Metrics are untouched.
  const resetStatuses = url.searchParams.get("reset") === "1";

  // QUICK mode: run synchronously and return the result (it's fast, ~5s).
  if (mode === "quick") {
    const result = await runSync(allAccountIds, mode);
    return NextResponse.json({ ...result, mode, started: false });
  }

  // FULL mode: 30-120s. Don't block the HTTP response or Railway's gateway
  // kills the connection at ~60s, stranding the client forever. Fire the
  // sync into the background and return immediately. Client polls
  // /api/sync/status to detect completion.
  const lockKey = `${mode}:${allAccountIds.slice().sort().join(",")}`;
  const already = activeSyncs.get(lockKey);
  if (!already) {
    // Swallow errors, they're recorded in the progress map anyway
    runSync(allAccountIds, mode, resetStatuses).catch(() => {});
  }
  return NextResponse.json({
    mode,
    started: true,
    startedAt: Date.now(),
    joinedExisting: Boolean(already),
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
