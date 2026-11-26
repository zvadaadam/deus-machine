import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";

export function useRecentProjects() {
  return useQuery({
    queryKey: ["onboarding", "recent-projects"],
    queryFn: () => call(api.recentProjects),
    staleTime: Infinity,
    retry: false,
  });
}
