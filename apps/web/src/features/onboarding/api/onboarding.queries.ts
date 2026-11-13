import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { OnboardingService } from "./onboarding.service";
import { queryKeys } from "@/shared/api/queryKeys";

export function useStartGhAuthLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => OnboardingService.startGhAuthLogin(),
    onSuccess: (result) => {
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: queryKeys.github.ghStatus });
      }
    },
  });
}

export function useRecentProjects() {
  return useQuery({
    queryKey: ["onboarding", "recent-projects"],
    queryFn: () => call(api.recentProjects),
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
