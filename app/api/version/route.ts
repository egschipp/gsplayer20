import { jsonNoStore } from "@/lib/api/guards";
import { resolveAppVersion } from "@/lib/version/resolveAppVersion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await resolveAppVersion();
  return jsonNoStore(payload);
}
