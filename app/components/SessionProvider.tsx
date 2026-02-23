"use client";

import { SessionProvider } from "next-auth/react";
import TokenAutoRefresh from "./TokenAutoRefresh";

export default function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider refetchInterval={60} refetchOnWindowFocus>
      <TokenAutoRefresh />
      {children}
    </SessionProvider>
  );
}
