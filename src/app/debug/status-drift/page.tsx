import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import DriftClient from "./DriftClient";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export const dynamic = "force-dynamic";

/**
 * Status drift audit page. Compares every ad currently flagged ACTIVE in
 * our DB against Meta's live view, and shows mismatches sorted by how
 * stale they are. If anything's older than ~5 min, the auto-refresh path
 * isn't doing its job and we should investigate.
 *
 * "Fix it now" button calls the same endpoint with ?fix=1 to write Meta's
 * live status back to the DB immediately.
 */
export default async function StatusDriftPage() {
  // Logged-in users only. Public viewers should never see admin tooling.
  const session = await getSessionOrPublic();
  if (!session) redirect("/login");

  // Build the absolute URL for the API call from the request headers so it
  // works on Railway, locally, behind tunnels, etc.
  const h = await headers();
  const cookieJar = await cookies();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") || "http";
  const base = `${proto}://${host}`;
  const cookieHeader = cookieJar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");

  let initialData: any = null;
  let initialError: string | null = null;
  try {
    const res = await fetch(`${base}/api/debug/status-drift`, {
      cache: "no-store",
      headers: { cookie: cookieHeader },
    });
    if (res.ok) {
      initialData = await res.json();
    } else {
      initialError = `Audit fetch failed: HTTP ${res.status}`;
    }
  } catch (err: any) {
    initialError = err?.message || String(err);
  }

  return <DriftClient initialData={initialData} initialError={initialError} />;
}
