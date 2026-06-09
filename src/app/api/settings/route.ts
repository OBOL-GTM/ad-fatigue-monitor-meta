import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let userSettings = await db.select().from(settings).where(eq(settings.id, 1)).get();

  // Create default settings if none exist
  if (!userSettings) {
    await db.insert(settings).values({ id: 1 }).run();
    userSettings = await db.select().from(settings).where(eq(settings.id, 1)).get();
  }

  return NextResponse.json(userSettings);
}

export async function PUT(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();

  // Ensure settings row exists
  const existing = await db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!existing) {
    await db.insert(settings).values({ id: 1 }).run();
  }

  await db.update(settings)
    .set({
      sensitivityPreset: body.sensitivityPreset,
      ctrWeight: body.ctrWeight,
      cpmWeight: body.cpmWeight,
      frequencyWeight: body.frequencyWeight,
      conversionWeight: body.conversionWeight,
      costPerResultWeight: body.costPerResultWeight,
      engagementWeight: body.engagementWeight,
      baselineWindowDays: body.baselineWindowDays,
      recentWindowDays: body.recentWindowDays,
      minDataDays: body.minDataDays,
    })
    .where(eq(settings.id, 1))
    .run();

  const updated = await db.select().from(settings).where(eq(settings.id, 1)).get();
  return NextResponse.json(updated);
}
