/**
 * TemplatesView — the Devin-style template gallery: category chips, sections
 * per category, cards that prefill the editor. Built-ins only for now;
 * user-authored templates slot into the same shape later.
 */

import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { ScrollArea } from "@/components/ui";
import {
  AUTOMATION_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type AutomationTemplate,
  type TemplateCategory,
} from "../lib/templates";
import type { EditorPrefill } from "./AutomationEditor";

type Filter = "all" | TemplateCategory;

export function TemplatesView({
  onBack,
  onUse,
}: {
  onBack: () => void;
  onUse: (prefill: EditorPrefill) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const sections = useMemo(() => {
    const categories = filter === "all" ? TEMPLATE_CATEGORIES : [filter];
    return categories
      .map((category) => ({
        category,
        templates: AUTOMATION_TEMPLATES.filter((t) => t.category === category),
      }))
      .filter((s) => s.templates.length > 0);
  }, [filter]);

  const countFor = (category: TemplateCategory) =>
    AUTOMATION_TEMPLATES.filter((t) => t.category === category).length;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-8 py-12">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label="Back to automations"
            onClick={onBack}
            className="text-text-secondary hover:bg-foreground/[0.04] flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex flex-col gap-1">
            <h1 className="text-text-primary text-xl font-semibold">Templates</h1>
            <p className="text-text-tertiary text-sm">
              Preset automations — pick one and shape it to your repo.
            </p>
          </div>
        </div>

        {/* Category chips */}
        <div className="flex flex-wrap gap-1">
          <CategoryChip
            label="All"
            count={AUTOMATION_TEMPLATES.length}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {TEMPLATE_CATEGORIES.map((category) => (
            <CategoryChip
              key={category}
              label={category}
              count={countFor(category)}
              active={filter === category}
              onClick={() => setFilter(category)}
            />
          ))}
        </div>

        {sections.map(({ category, templates }) => (
          <div key={category} className="flex flex-col gap-3">
            <span className="text-text-secondary text-sm font-medium">{category}</span>
            <div className="grid grid-cols-3 gap-3">
              {templates.map((template) => (
                <TemplateCard key={template.id} template={template} onUse={onUse} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function CategoryChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors duration-150",
        active
          ? "bg-bg-selection text-text-primary font-medium"
          : "text-text-tertiary hover:text-text-secondary"
      )}
    >
      {label}
      <span className={cn("text-2xs", active ? "text-text-tertiary" : "text-text-disabled")}>
        {count}
      </span>
    </button>
  );
}

function TemplateCard({
  template,
  onUse,
}: {
  template: AutomationTemplate;
  onUse: (prefill: EditorPrefill) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onUse(template.prefill)}
      className="border-border-subtle bg-bg-elevated hover:border-border-default flex flex-col gap-1.5 rounded-lg border p-3.5 text-left transition-colors duration-150"
    >
      <div className="flex items-center gap-2">
        <template.icon className="text-text-secondary h-[15px] w-[15px] shrink-0" />
        <span className="text-text-primary text-sm font-medium">{template.title}</span>
      </div>
      <span className="text-text-muted text-2xs">{template.schedule}</span>
      <span className="text-text-tertiary text-xs leading-relaxed">{template.description}</span>
    </button>
  );
}
