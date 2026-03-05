import { resolveAppVersion } from "@/lib/version/resolveAppVersion";

export async function runVersionAction() {
  return resolveAppVersion();
}
