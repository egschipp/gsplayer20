export function encodeCursor(addedAt: number, id: string) {
  return Buffer.from(`${addedAt}|${id}`, "utf8").toString("base64");
}

export function decodeCursor(cursor: string) {
  const raw = Buffer.from(cursor, "base64").toString("utf8");
  const [addedAt, id] = raw.split("|");
  if (!addedAt || !id) {
    throw new Error("Invalid cursor");
  }
  return { addedAt: Number(addedAt), id };
}
