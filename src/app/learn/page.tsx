import { GLOSSARY, type Term } from "@/lib/glossary";

export const metadata = { title: "新手学堂 — 信号灯" };

const GROUPS: Term["group"][] = ["基础", "风控", "指标", "TD 序列", "缠论"];
const GROUP_INTRO: Record<Term["group"], string> = {
  基础: "看懂 K 线图的最低门槛，先从这里开始。",
  风控: "比找到好买点更重要：活下来，才有机会赚钱。",
  指标: "常见技术指标，知道它们在说什么就够了。",
  "TD 序列": "判断涨跌是否“累了”的计数方法。",
  缠论: "把走势拆成笔和中枢的结构分析方法。",
};

export default function Learn() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">新手学堂</h1>
        <p className="mt-1 text-ink-2">每个术语都用大白话解释：是什么、怎么看、常见误区。在分析页里点击带虚线的词，也能随时查看。</p>
      </div>
      <nav className="flex flex-wrap gap-2">
        {GROUPS.map((g) => (
          <a key={g} href={`#${g}`} className="chip">{g}</a>
        ))}
      </nav>
      {GROUPS.map((g) => (
        <section key={g} id={g} className="scroll-mt-20">
          <h2 className="text-lg font-semibold">{g}</h2>
          <p className="mb-3 text-sm text-ink-3">{GROUP_INTRO[g]}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {GLOSSARY.filter((t) => t.group === g).map((t) => (
              <article key={t.key} className="card p-4 text-[14px] leading-relaxed">
                <h3 className="font-semibold">{t.title}</h3>
                <p className="mt-1 text-ink-2">{t.what}</p>
                <p className="mt-2 text-ink-2"><b className="text-ink">怎么看：</b>{t.how}</p>
                {t.trap && <p className="mt-2 text-ink-2"><b className="text-warn">常见误区：</b>{t.trap}</p>}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
