import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateProjectInput, ProjectDetail, ProjectSummary } from "@shared/projects";
import { apiClient } from "@/shared/api/client";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { sendRequest } from "@/platform/ws";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

export const projectKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (id: string) => ["projects", "detail", id] as const,
  file: (id: string, path: string, revision: number) =>
    ["projects", "file", id, path, revision] as const,
};

export function useProjects() {
  const enabled = !isCloudDirectWebMode();
  useQuerySubscription("projects", { queryKey: projectKeys.list, enabled });
  return useQuery({
    queryKey: projectKeys.list,
    queryFn: () => sendRequest<ProjectSummary[]>("projects"),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export function useProject(projectId: string | null) {
  const enabled = !!projectId && !isCloudDirectWebMode();
  useQuerySubscription("project", {
    queryKey: projectKeys.detail(projectId ?? ""),
    params: { projectId },
    enabled,
  });
  return useQuery({
    queryKey: projectKeys.detail(projectId ?? ""),
    queryFn: () => sendRequest<ProjectDetail | null>("project", { projectId }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => apiClient.post<ProjectDetail>("/projects", input),
    onSuccess: (project) => {
      client.setQueryData(projectKeys.detail(project.id), project);
      void client.invalidateQueries({ queryKey: projectKeys.list });
    },
  });
}

type ProjectAction =
  | { action: "pause" | "resume" | "archive" }
  | { action: "limits"; dispatchLimit: number }
  | { action: "stop" | "retry" | "resume-agent"; agentId: string }
  | { action: "accept"; reportId: string }
  | { action: "cancel-input"; inputId: string }
  | { action: "content"; path: string; content: string; expectedRevision: number };

export function useProjectAction(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectAction & { requestId: string }) => {
      const { action, ...body } = input;
      const route =
        action === "stop" || action === "retry" || action === "resume-agent"
          ? `agents/${encodeURIComponent(input.agentId)}/${action === "resume-agent" ? "resume" : action}`
          : action === "accept"
            ? `reports/${encodeURIComponent(input.reportId)}/accept`
            : action === "cancel-input"
              ? `inputs/${encodeURIComponent(input.inputId)}/cancel`
              : action;
      return apiClient.post(`/projects/${encodeURIComponent(projectId)}/${route}`, body);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      void client.invalidateQueries({ queryKey: projectKeys.list });
    },
  });
}

export function useProjectFile(projectId: string, path: string | null, revision: number) {
  return useQuery({
    queryKey: projectKeys.file(projectId, path ?? "", revision),
    queryFn: () =>
      apiClient.get<{ path: string; content: string; revision: number }>(
        `/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path: path!, revision: String(revision) })}`
      ),
    enabled: !!path,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
