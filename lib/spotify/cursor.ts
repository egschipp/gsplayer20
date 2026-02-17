export function encodeCursor(addedAt: number, id: string) {
  return Buffer.from(`${addedAt}|${id}`, "utf8").toString("base64");
}

export function decodeCursor(cursor: string) {
  const decoded = tryDecodeCursor(cursor);
  if (!decoded) throw new Error("Invalid cursor");
  return decoded;
}

export function tryDecodeCursor(cursor: string) {
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    const [addedAt, id] = raw.split("|");
    const parsedAddedAt = Number(addedAt);
    if (
      !addedAt ||
      !id ||
      !Number.isFinite(parsedAddedAt) ||
      !Number.isInteger(parsedAddedAt)
    ) {
      return null;
    }
    return { addedAt: parsedAddedAt, id };
  } catch {
    return null;
  }
}
