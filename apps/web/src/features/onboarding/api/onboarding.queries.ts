import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { OnboardingService } from "./onboarding.service";
import { queryKeys } from "@/shared/api/queryKeys";

export function useCliCheck(toolName: string) {
  return useQuery({
    queryKey: ["onboarding", "cli-check", toolName],
    queryFn: () => OnboardingService.checkCliTool(toolName),
    staleTime: Infinity,
    retry: false,
  });
}

export function useGhAuth(enabled: boolean) {
  return useQuery({
    queryKey: ["onboarding", "gh-auth"],
    queryFn: () => OnboardingService.checkGhAuth(),
    staleTime: Infinity,
    retry: false,
    enabled,
  });
}

export function useRecentProjects() {
  return useQuery({
    queryKey: ["onboarding", "recent-projects"],
    queryFn: () => OnboardingService.fetchRecentProjects(),
    staleTime: Infinity,
    retry: false,
  });
}

export function useCompleteOnboarding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => OnboardingService.completeOnboarding(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
