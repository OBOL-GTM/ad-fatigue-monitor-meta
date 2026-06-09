import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import SettingsClient from "./SettingsClient";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSessionOrPublic();
  if (!session) redirect("/login");
  // Get or create default settings
  let userSettings = await db.select().from(settings).where(eq(settings.id, 1)).get();

  if (!userSettings) {
    await db.insert(settings).values({ id: 1 }).run();
    userSettings = (await db.select().from(settings).where(eq(settings.id, 1)).get())!;
  }

  const data = {
    sensitivityPreset: userSettings.sensitivityPreset,
    ctrWeight: userSettings.ctrWeight,
    cpmWeight: userSettings.cpmWeight,
    frequencyWeight: userSettings.frequencyWeight,
    conversionWeight: userSettings.conversionWeight,
    costPerResultWeight: userSettings.costPerResultWeight,
    engagementWeight: userSettings.engagementWeight,
    baselineWindowDays: userSettings.baselineWindowDays,
    recentWindowDays: userSettings.recentWindowDays,
    minDataDays: userSettings.minDataDays,
  };

  return (
    <div className="min-h-screen">
      <SettingsClient initialSettings={data} />
    </div>
  );
}
