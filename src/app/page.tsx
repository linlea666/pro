import Link from "next/link";
import { getOverview } from "@/lib/overview";
import { allCoins } from "@/lib/server/coins";
import { TF_LABEL } from "@/lib/types";
import { LightPill } from "@/components/Light";
import { Sparkline } from "@/components/Sparkline";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fmtPct, fmtPrice, signColor } from "@/components/coin/format";

export const dynamic = "force-dynamic";

export default async function Home() {
  let data: Awaited<ReturnType<typeof getOverview>> | null = null;
  try {
    data = await getOverview();
  } catch (e) {
    console.error(e);
  }
  if (!data) {
    return (
      <div className="card mx-auto mt-10 max-w-lg p-8 text-center text-ink-2">
        行情数据暂时获取失败，请稍后刷新页面。
      </div>
    );
  }

  const count = (tf: string, light: string) => data!.coins.filter((c) => c.lights.find((l) => l.tf === tf)?.light === light).length;
  const total = data.coins.length;
  const g = count("1d", "green"), r = count("1d", "red");
  const mood =
    g >= total * 0.6 ? { text: "整体偏暖", desc: "多数主流币日线偏多，市场情绪较好。注意别在情绪最高时追涨。", color: "var(--up)" }
    : r >= total * 0.6 ? { text: "整体偏冷", desc: "多数主流币日线偏空，市场在走弱。这时候少操作、保住本金最重要。", color: "var(--down)" }
    : { text: "冷暖不一", desc: "各币走势分化，没有统一方向。适合观望，或只关注信号最清晰的几个币。", color: "var(--warn)" };
  const btc = data.coins.find((c) => c.coin === "BTC");

  return (
    <div className="space-y-8">
      <AutoRefresh seconds={60} />
      <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="card p-6">
          <p className="text-sm text-ink-3">今日看盘</p>
          <h1 className="mt-1 text-3xl font-semibold leading-tight">
            今天加密市场 <span style={{ color: mood.color }}>{mood.text}</span>
          </h1>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-2">{mood.desc}</p>
          <div className="mt-5 grid max-w-md grid-cols-3 gap-2 text-center">
            {(["green", "yellow", "red"] as const).map((l) => (
              <div key={l} className="rounded-xl border border-line p-3">
                <LightPill light={l} size="sm" />
                <div className="mt-1.5 text-2xl font-semibold num">{count("1d", l)}</div>
                <div className="text-[11px] text-ink-3">个币 · 日线</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card flex flex-col p-6">
          <p className="text-sm text-ink-3">新手三步看盘法</p>
          <ol className="mt-3 space-y-3 text-[14px] leading-relaxed">
            <li><b>① 先看大方向：</b>日线是绿灯再考虑买，红灯时别急着抄底。</li>
            <li><b>② 再看位置：</b>靠近支撑买、靠近阻力卖，不在半山腰追。</li>
            <li><b>③ 最后定止损：</b>买之前就想好“错了在哪认输”，用仓位计算器控制每次最多亏 2%。</li>
          </ol>
          <Link href={btc ? "/coin/BTC" : "/learn"} className="mt-auto inline-flex w-fit items-center gap-1 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-bg">
            从比特币开始 →
          </Link>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-lg font-semibold">主流币信号灯</h2>
          <span className="text-xs text-ink-3">↑ 偏多 · → 观望 · ↓ 偏空 · 每分钟更新</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.coins.map((c) => {
            const meta = allCoins().find((x) => x.id === c.coin);
            return (
              <Link key={c.coin} href={`/coin/${c.coin}`} className="card group p-4 transition hover:border-ink-3">
                <div className="flex items-start gap-2">
                  <div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-base font-semibold">{c.coin}</span>
                      <span className="text-xs text-ink-3">{meta?.name}</span>
                    </div>
                    <div className="num mt-0.5 text-lg font-medium">{fmtPrice(c.price)}</div>
                    <div className="num text-xs" style={{ color: signColor(c.change24h) }}>
                      {c.change24h >= 0 ? "↑" : "↓"} {fmtPct(c.change24h)} · 24h
                    </div>
                  </div>
                  <div className="ml-auto pt-1">
                    <Sparkline data={c.spark} width={96} height={40} />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-line pt-3">
                  {c.lights.map((l) => (
                    <div key={l.tf} className="text-center">
                      <div className="mb-1 text-[11px] text-ink-3">{TF_LABEL[l.tf]}</div>
                      <LightPill light={l.light} size="sm" />
                    </div>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
        {data.failed.length > 0 && <p className="mt-2 text-xs text-ink-3">暂时无法获取：{data.failed.join("、")}</p>}
      </section>
    </div>
  );
}
