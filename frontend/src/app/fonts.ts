import localFont from "next/font/local";

// Bundled variable fonts (docs/DESIGN.md section 8). No network font requests.
// Inter covers Latin text; Arabic glyphs fall through to Cairo via the font stack.
export const inter = localFont({
  src: "../../public/fonts/inter/InterVariable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const cairo = localFont({
  src: "../../public/fonts/cairo/CairoVariable.woff2",
  variable: "--font-cairo",
  weight: "200 1000",
  style: "normal",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});
