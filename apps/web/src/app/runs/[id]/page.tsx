import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { selectPublicRunProject } from "@/lib/project-visibility";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetail({ params }: PageProps) {
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      projects: {
        orderBy: {
          publishedAt: "desc",
        },
      },
    },
  });

  if (!run) {
    notFound();
  }

  const project = selectPublicRunProject(run.projects);

  if (!project) {
    redirect("/runs");
  }

  redirect(`/projects/${project.id}?tab=production-memo`);
}
