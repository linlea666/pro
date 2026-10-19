import type { Light as L } from "@/lib/ta/verdict";

const META: Record<L, { color: string; soft: string; icon: string; text: string }> = {
  green: { color: "var(--up)", soft: "var(--up-soft)", icon: "↑", text: "偏多" },
  yellow: { color: "var(--warn)", soft: "var(--warn-soft)", icon: "→", text: "观望" },
  red: { color: "var(--down)", soft: "var(--down-soft)", icon: "↓", text: "偏空" },
};

export const lightMeta = (l: L) => META[l];

/** Compact pill: icon + text, never color alone. */
export function LightPill({ light, label, size = "md" }: { light: L; label?: string; size?: "sm" | "md" }) {
  const m = META[light];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm"}`}
      style={{ background: m.soft, color: m.color }}
    >
      <span aria-hidden="true">{m.icon}</span>
      {label ?? m.text}
    </span>
  );
}

/** The vertical three-lamp traffic light. */
export function TrafficLight({ light, size = 18 }: { light: L; size?: number }) {
  const lamps: L[] = ["red", "yellow", "green"];
  return (
    <div className="inline-flex flex-col gap-1.5 rounded-full border border-line bg-panel-2 p-1.5" role="img" aria-label={`信号灯：${META[light].text}`}>
      {lamps.map((l) => (
        <span
          key={l}
          className="block rounded-full transition"
          style={{
            width: size,
            height: size,
            background: l === light ? META[l].color : "var(--border)",
            boxShadow: l === light ? `0 0 ${size}px ${META[l].color}` : "none",
            opacity: l === light ? 1 : 0.5,
          }}
        />
      ))}
    </div>
  );
}
