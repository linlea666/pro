export function Forbidden() {
  return (
    <div className="card mx-auto mt-16 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">无权访问</h1>
      <p className="mt-2 text-sm text-ink-2">当前 IP 不在后台白名单内。如需调整，请修改服务器上 /etc/signallight/signallight.env 的 ADMIN_IP_ALLOWLIST。</p>
    </div>
  );
}
