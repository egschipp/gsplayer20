import { NextResponse } from "next/server";
import { resolveAppVersion } from "@/lib/version/resolveAppVersion";

export const runtime = "nodejs";

export async function GET() {
  const payload = await resolveAppVersion();
  return NextResponse.json(payload);
}
