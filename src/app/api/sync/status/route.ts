import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { getSyncProgress } from "../route";

export const dynamic = "force-dynamic";

/**
 * Live progress of the user's latest full-mode sync, so the Sidebar can
 * poll instead of blocking on the initial POST (which Railway's gateway
 * would kill at ~60s). Returns null if no sync has ever been kicked off
 * for this user's accounts in this process, meaning nothing to report.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allAccountIds: string[] = session.allAccountIds;
  if (allAccountIds.length === 0) {
    return NextResponse.json({ progress: null });
  }

  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode");
  const mode: "full" | "quick" = modeParam === "quick" ? "quick" : "full";

  const progress = getSyncProgress(allAccountIds, mode);
  if (!progress) return NextResponse.json({ progress: null });

  const now = Date.now();
  return NextResponse.json({
    progress: {
      mode: progress.mode,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      running: progress.finishedAt === null,
      elapsedMs: (progress.finishedAt ?? now) - progress.startedAt,
      success: progress.success,
      tokenExpired: progress.tokenExpired,
      adsFound: progress.adsFound,
      metricsUpserted: progress.metricsUpserted,
      errors: progress.errors,
    },
  });
}
