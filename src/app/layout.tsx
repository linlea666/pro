import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ErrorReporter } from "@/components/ErrorReporter";
import { Tracker } from "@/components/Tracker";

export const metadata: Metadata = {
  title: "信号灯 SignalLight — 看得懂的加密行情分析",
  description: "把专业技术分析翻译成一句人话：红绿灯结论、历史胜率、关键价位和止损参考，专为新手设计。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
  ],
};

// Applies the saved theme before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("sl-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">
        <ErrorReporter />
        <Tracker />
        <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-6">
            <Link href="/" className="flex shrink-0 items-center gap-2">
              <Logo />
              <span className="hidden whitespace-nowrap text-[17px] font-semibold tracking-tight min-[400px]:inline">信号灯</span>
              <span className="hidden text-xs text-ink-3 sm:inline">SignalLight</span>
            </Link>
            <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[13px] [scrollbar-width:none] sm:gap-1 sm:text-sm">
              <Link href="/" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink"><span className="hidden sm:inline">今日</span>看盘</Link>
              <Link href="/coin/BTC" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink">分析<span className="hidden sm:inline">工作台</span></Link>
              <Link href="/watch" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink"><span className="hidden sm:inline">实时</span>盯盘</Link>
              <Link href="/moves" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink">涨跌<span className="hidden sm:inline">统计</span></Link>
              <Link href="/spot" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink">囤币</Link>
              <Link href="/flows" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink">ETF<span className="hidden sm:inline"> 买盘</span></Link>
              <Link href="/learn" className="rounded-lg px-1.5 py-1.5 text-ink-2 sm:px-3 hover:bg-panel-2 hover:text-ink"><span className="hidden sm:inline">新手</span>学堂</Link>
            </nav>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pb-16 pt-6">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto max-w-7xl px-4 py-6 text-xs leading-relaxed text-ink-3">
            信号灯提供的所有内容仅用于学习技术分析，不构成任何投资建议。加密资产价格波动剧烈，可能损失全部本金，请只用亏得起的钱。行情数据来自交易所公开接口，可能存在延迟。
          </div>
        </footer>
      </body>
    </html>
  );
}
