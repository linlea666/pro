"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { track } from "./track";

/** One "visit" per page shown (admin pages excluded). */
export function Tracker() {
  const path = usePathname();
  useEffect(() => {
    if (!path.startsWith("/admin")) track("visit");
  }, [path]);
  return null;
}
