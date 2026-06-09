import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export async function POST(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    const { apiKey } = await req.json();

    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { success: false, error: "API key is required." },
        { status: 400 }
      );
    }

    // Test the connection by fetching one contact
    const testRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!testRes.ok) {
      const body = await testRes.text();
      let errorMessage = "Connection failed.";

      if (testRes.status === 401) {
        errorMessage = "Invalid token. Check that your PAT is correct and has CRM read permissions.";
      } else if (testRes.status === 403) {
        errorMessage = "Token lacks permissions. Make sure your Private App has CRM > Contacts > Read scope.";
      } else {
        errorMessage = `HubSpot returned ${testRes.status}: ${body.slice(0, 200)}`;
      }

      return NextResponse.json({ success: false, error: errorMessage }, { status: 200 });
    }

    // Get total contact count via search endpoint
    let contactCount = 0;
    try {
      const searchRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filterGroups: [],
            limit: 1,
          }),
        }
      );

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        contactCount = searchData.total ?? 0;
      }
    } catch {
      // If search fails, fall back to the basic response
      const testData = await testRes.clone().json().catch(() => ({}));
      contactCount = testData.total ?? 0;
    }

    return NextResponse.json({ success: true, contactCount });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: `Server error: ${message}` },
      { status: 500 }
    );
  }
}
