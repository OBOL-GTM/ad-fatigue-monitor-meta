import { NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * One-shot cleanup: remove duplicate rows in daily_metrics where the unique
 * index on (ad_id, date) exists but there are still duplicate rows from a
 * previous era (pre-index). Keeps the row with the highest spend for each
 * (ad_id, date) pair.
 *
 * Safe to run repeatedly. Use only when Orly reports doubled totals.
 *
 * Usage (logged in): /api/debug/dedupe-metrics
 *                    /api/debug/dedupe-metrics?apply=1   (actually delete)
 */
export async function GET(req: Request) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const apply = new URL(req.url).searchParams.get("apply") === "1";

  // Count how many dupe rows exist.
  const countRes = await db.run(sql`
    SELECT COUNT(*) AS n FROM daily_metrics WHERE id NOT IN (
      SELECT MAX(id) FROM daily_metrics GROUP BY ad_id, date
    )
  `);
  const dupeCount = (countRes.rows?.[0] as any)?.n ?? 0;

  if (!apply) {
    return NextResponse.json({
      dupeCount,
      willDelete: dupeCount,
      note: "Dry run. Add ?apply=1 to actually delete the duplicate rows.",
    });
  }

  // Delete every row whose id is not the MAX(id) for its (ad_id, date) pair.
  // We pick MAX(id) because that's the most recently inserted, which is most
  // likely to reflect the freshest Meta insight for that day.
  const delRes = await db.run(sql`
    DELETE FROM daily_metrics WHERE id NOT IN (
      SELECT MAX(id) FROM daily_metrics GROUP BY ad_id, date
    )
  `);
  const deleted = (delRes as any).rowsAffected ?? dupeCount;

  return NextResponse.json({
    applied: true,
    deletedRows: deleted,
    note: "Duplicate daily_metrics rows removed. All spend totals should now be correct.",
  });
}
