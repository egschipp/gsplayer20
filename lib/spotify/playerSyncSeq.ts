const seqByUser = new Map<string, number>();

export function nextPlayerSyncSeq(userKey: string): number {
  const key = String(userKey || "");
  if (!key) return 1;
  const prev = seqByUser.get(key) ?? 0;
  const next = prev + 1;
  seqByUser.set(key, next);
  return next;
}
