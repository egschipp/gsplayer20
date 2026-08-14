import { requireAppUser, requireSameOrigin } from "@/lib/api/guards";
import { getSqlite } from "@/lib/db/client";
import { deleteAccountData } from "@/src/features/account/data/delete-account-data";

export const runtime = "nodejs";

export async function DELETE(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const { session, response } = await requireAppUser();
  if (response) return response;
  if (!session?.appUserId) {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const changes = deleteAccountData(getSqlite(), session.appUserId);
  return Response.json(
    { status: changes === 1 ? "DELETED" : "NOT_FOUND" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
