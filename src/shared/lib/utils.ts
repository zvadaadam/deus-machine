import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely extracts an error message from any error type.
 * Handles Error instances, objects with message property, and unknown types.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Extracts the repository name from a GitHub URL.
 * Supports both HTTPS and SSH formats:
 * - https://github.com/user/repo.git -> repo
 * - git@github.com:user/repo.git -> repo
 */
export function extractRepoNameFromUrl(url: string): string | null {
  // SSH format: git@github.com:user/repo.git
  if (url.startsWith("git@")) {
    const name = url.split(":")[1]?.split("/").pop()?.replace(/\.git$/, "");
    return name || null;
  }

  // HTTPS format: https://github.com/user/repo.git
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "");
    return name || null;
  } catch {
    return null;
  }
}
