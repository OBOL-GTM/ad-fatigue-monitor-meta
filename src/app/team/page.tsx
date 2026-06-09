import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { teamInvites, shareTokens, publicLinks } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { headers } from "next/headers";
import TeamClient from "./TeamClient";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await getSessionOrPublic();
  if (!session) redirect("/login");

  const invites = await db
    .select()
    .from(teamInvites)
    .orderBy(desc(teamInvites.invitedAt))
    .all();

  const tokens = await db
    .select()
    .from(shareTokens)
    .orderBy(desc(shareTokens.createdAt))
    .all();

  const publicTokens = await db
    .select()
    .from(publicLinks)
    .orderBy(desc(publicLinks.createdAt))
    .all();

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || "https";
  const origin = host ? `${proto}://${host}` : "";

  return (
    <div className="min-h-screen">
      <TeamClient
        initialInvites={invites}
        initialTokens={tokens}
        initialPublicLinks={publicTokens}
        origin={origin}
      />
    </div>
  );
}
