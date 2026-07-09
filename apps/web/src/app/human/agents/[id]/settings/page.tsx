import { redirect } from "next/navigation";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    saved?: string;
    created?: string;
    synced?: string;
    activated?: string;
  }>;
};

export default async function AdminAgentSettingsRedirect({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query: Awaited<NonNullable<PageProps["searchParams"]>> = searchParams ? await searchParams : {};
  const nextParams = new URLSearchParams({ tab: "settings" });
  for (const key of ["saved", "created", "synced", "activated"] as const) {
    if (query[key]) nextParams.set(key, query[key]);
  }
  redirect(`/human/agents/${id}?${nextParams.toString()}`);
}
