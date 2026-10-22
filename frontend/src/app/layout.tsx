import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";

import { cairo, inter } from "./fonts";
import "./globals.css";

// The logo (docs/DESIGN.md section 9) as an inline favicon: no extra request.
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><g fill="none" stroke="#B08A4E" stroke-width="6" stroke-linejoin="round"><rect x="22" y="22" width="52" height="52"/><rect x="22" y="22" width="52" height="52" transform="rotate(45 48 48)"/></g></svg>',
  );

export const metadata: Metadata = {
  title: "Dar al Ilm · دار العلم",
  description: "A private 3D library for your PDF books.",
  icons: { icon: ICON },
};

export const viewport: Viewport = {
  themeColor: "#f6f5f2",
  colorScheme: "light",
};

// Applies the remembered UI language before the first paint, so Arabic never flashes LTR.
const LANGUAGE_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  LANGUAGE_STORAGE_KEY,
)})==="ar"){var d=document.documentElement;d.lang="ar";d.dir="rtl"}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr" className={`${inter.variable} ${cairo.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LANGUAGE_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
