import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function AdminAgentListRedirect() {
  redirect("/human?view=agents");
}
