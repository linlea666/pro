"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    const cur = document.documentElement.dataset.theme as "light" | "dark" | undefined;
    setTheme(cur ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("sl-theme", next);
    } catch {}
    setTheme(next);
    window.dispatchEvent(new Event("sl-theme"));
  };
  return (
    <button onClick={toggle} className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink-2 hover:text-ink" aria-label="切换明暗主题">
      {theme === "light" ? "☾" : "☀"}<span className="ml-1 hidden sm:inline">{theme === "light" ? "深色" : "浅色"}</span>
    </button>
  );
}
