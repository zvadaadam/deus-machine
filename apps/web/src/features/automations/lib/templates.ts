/**
 * Built-in automation templates (board 46a's suggestions, grown into the
 * Devin-style gallery). Each prefills the editor — nothing is created until
 * the user hits Create. User-authored templates are a later addition; the
 * shape here (category + prefill) is what they'd slot into.
 */

import {
  BookOpen,
  Bug,
  FileText,
  GitPullRequest,
  ListChecks,
  PackageSearch,
  ShieldCheck,
  Sparkles,
  TestTube2,
  type LucideIcon,
} from "lucide-react";
import type { EditorPrefill } from "../ui/AutomationEditor";

export interface AutomationTemplate {
  id: string;
  icon: LucideIcon;
  title: string;
  category: TemplateCategory;
  /** Humanized schedule shown on the card (the cron rides in the prefill). */
  schedule: string;
  description: string;
  prefill: EditorPrefill;
}

export const TEMPLATE_CATEGORIES = ["Review & release", "Code health", "Reporting"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "morning-pr-review",
    icon: GitPullRequest,
    title: "Morning PR review",
    category: "Review & release",
    schedule: "Weekdays at 9:00",
    description: "Summarize open PRs, review the new ones, flag anything stuck.",
    prefill: {
      name: "Morning PR review",
      prompt:
        "Review the repository's open pull requests. Summarize each new one, leave review comments on anything risky, and flag PRs that have been stuck for more than two days.",
      cron: "0 9 * * 1-5",
    },
  },
  {
    id: "changelog-draft",
    icon: FileText,
    title: "Changelog draft",
    category: "Review & release",
    schedule: "Fridays at 16:00",
    description: "Turns the week's merged work into release notes in your voice.",
    prefill: {
      name: "Changelog draft",
      prompt:
        "Collect everything merged since the last changelog entry and draft release notes: user-facing changes first, grouped by area, in the project's existing changelog voice.",
      cron: "0 16 * * 5",
    },
  },
  {
    id: "issue-triage",
    icon: ListChecks,
    title: "Issue triage sweep",
    category: "Review & release",
    schedule: "Weekdays at 8:00",
    description: "Labels new issues, asks for missing repro steps, closes stale ones.",
    prefill: {
      name: "Issue triage sweep",
      prompt:
        "Triage the repository's new and unlabeled issues: apply fitting labels, ask for reproduction steps where they're missing, link obvious duplicates, and list issues that have gone stale.",
      cron: "0 8 * * 1-5",
    },
  },
  {
    id: "nightly-audit",
    icon: ShieldCheck,
    title: "Nightly audit",
    category: "Code health",
    schedule: "Daily at 2:00",
    description: "Dependencies, types and dead code — opens a PR with safe fixes.",
    prefill: {
      name: "Nightly audit",
      prompt:
        "Audit dependencies, type errors and dead code. Open a PR with safe fixes only — no breaking upgrades. Summarize anything risky instead of touching it.",
      cron: "0 2 * * *",
    },
  },
  {
    id: "dependency-updates",
    icon: PackageSearch,
    title: "Dependency updates",
    category: "Code health",
    schedule: "Mondays at 6:00",
    description: "Patch and minor bumps with passing tests, one PR a week.",
    prefill: {
      name: "Dependency updates",
      prompt:
        "Update dependencies to their latest patch and minor versions, run the test suite, and open one PR with the passing bumps. List major-version updates separately without applying them.",
      cron: "0 6 * * 1",
    },
  },
  {
    id: "flaky-test-hunter",
    icon: TestTube2,
    title: "Flaky test hunter",
    category: "Code health",
    schedule: "Daily at 5:00",
    description: "Reruns the suite, catches flakes, files reproductions.",
    prefill: {
      name: "Flaky test hunter",
      prompt:
        "Run the test suite three times. For any test that doesn't fail consistently, investigate the flake, and write up a reproduction with the suspected cause. Fix only when the fix is obvious and safe.",
      cron: "0 5 * * *",
    },
  },
  {
    id: "bug-sweep",
    icon: Bug,
    title: "Recent-changes bug sweep",
    category: "Code health",
    schedule: "Daily at 3:00",
    description: "Reads the day's commits looking for real bugs, not style.",
    prefill: {
      name: "Recent-changes bug sweep",
      prompt:
        "Review the commits from the last 24 hours for real bugs — logic errors, races, missed edge cases. Ignore style. Report findings with file and line references; open a PR only for clear-cut fixes.",
      cron: "0 3 * * *",
    },
  },
  {
    id: "docs-sync",
    icon: BookOpen,
    title: "Docs drift check",
    category: "Reporting",
    schedule: "Wednesdays at 7:00",
    description: "Finds README/docs claims the code no longer backs.",
    prefill: {
      name: "Docs drift check",
      prompt:
        "Compare the README and docs against the current code. List every claim, example or instruction that no longer matches reality, and propose the corrected wording.",
      cron: "0 7 * * 3",
    },
  },
  {
    id: "weekly-summary",
    icon: Sparkles,
    title: "Weekly repo digest",
    category: "Reporting",
    schedule: "Fridays at 17:00",
    description: "What shipped, what's stuck, what needs a decision.",
    prefill: {
      name: "Weekly repo digest",
      prompt:
        "Write a short digest of the week: what shipped (merged PRs, grouped by theme), what's in flight, what's stuck and why, and any decisions the maintainers should make next week.",
      cron: "0 17 * * 5",
    },
  },
];

/** The list view's three-card teaser row. */
export const SUGGESTED_TEMPLATES = AUTOMATION_TEMPLATES.slice(0, 1).concat(
  AUTOMATION_TEMPLATES.filter((t) => t.id === "nightly-audit" || t.id === "changelog-draft")
);
