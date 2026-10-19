import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/server/guard";
import { AdminNav } from "@/components/admin/AdminNav";
import { Forbidden } from "@/components/admin/Forbidden";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const { admin, ipOk } = await currentAdmin();
  if (!ipOk) return <Forbidden />;
  if (!admin) redirect("/admin/login");
  return (
    <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <AdminNav username={admin.username} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
