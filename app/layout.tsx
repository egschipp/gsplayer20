import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GSPlayer20",
  description: "Next.js app for GSPlayer20",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
