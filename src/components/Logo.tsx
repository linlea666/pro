export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="6" y="1" width="14" height="24" rx="7" fill="var(--panel-2)" stroke="var(--border)" />
      <circle cx="13" cy="7" r="3.2" fill="var(--down)" />
      <circle cx="13" cy="13" r="3.2" fill="var(--warn)" />
      <circle cx="13" cy="19" r="3.2" fill="var(--up)" />
    </svg>
  );
}
