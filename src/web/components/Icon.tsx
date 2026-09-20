import type { CSSProperties } from "react";

export type IconName = "grid" | "book" | "bolt" | "clock" | "history" | "arrow" |
  "chevron-left" | "chevron-right" | "check" | "close" | "flag" | "search" |
  "image" | "message" | "shield" | "menu" | "expand" | "refresh" | "download";

const paths: Record<IconName, string> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  book: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2",
  bolt: "m13 2-9 12h7l-1 8 10-13h-7z",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  history: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l4 2",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  "chevron-left": "m15 5-7 7 7 7",
  "chevron-right": "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12 M18 6 6 18",
  flag: "M5 21V3 M5 3h13l-3 4 3 4H5",
  search: "M16.5 16.5 21 21 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  image: "M3 3h18v18H3z M3 16l6-6 5 5 3-3 4 4 M16 7h.01",
  message: "M21 3H3v14h5l4 4 4-4h5z M7 7h10 M7 11h6",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6z m-4 10 3 3 5-6",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  expand: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  refresh: "M20 7V2 M20 7h-5 M4 17v5 M4 17h5 M20 7a9 9 0 0 0-15-2 M4 17a9 9 0 0 0 15 2",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
};

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
