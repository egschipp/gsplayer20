import { jsonNoStore } from "@/lib/api/guards";
import { runVersionAction } from "@/src/features/system/actions/version.action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const payload = await runVersionAction();
  return jsonNoStore(payload);
}
