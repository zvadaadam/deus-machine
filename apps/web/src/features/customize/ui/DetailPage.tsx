/**
 * DetailPage — the in-page view of one app, plugin or skill (design boards
 * 48b–48e). It replaces the catalog inside Customize instead of floating over
 * it: a breadcrumb back, the item's header and primary action, a strip of
 * facts (status, where it runs, what it brings), then the content beside a
 * details column — the shape of Sentry's and Vercel's integration pages.
 */

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { openExternal } from "@/platform/native/window";
import { TONE_CLASS, type StatusLabel } from "../lib/status";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export interface Fact {
  label: string;
  value: ReactNode;
}

export function DetailPage({
  trail,
  onBack,
  icon,
  title,
  byline,
  actions,
  facts,
  aside,
  children,
}: {
  trail: Crumb[];
  onBack: () => void;
  icon: ReactNode;
  title: string;
  byline: ReactNode;
  actions?: ReactNode;
  facts: Fact[];
  aside: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="control-interaction text-text-tertiary hover:text-text-primary hover:bg-control-hover -ml-1.5 flex h-6 w-6 items-center justify-center rounded-md"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {trail.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="text-text-disabled h-3 w-3 shrink-0" />}
            {crumb.onClick ? (
              <button
                type="button"
                onClick={crumb.onClick}
                className="text-text-tertiary hover:text-text-primary truncate"
              >
                {crumb.label}
              </button>
            ) : (
              <span className="text-text-secondary truncate">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {icon}
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-text-primary truncate text-xl font-semibold">{title}</h1>
            <div className="text-text-tertiary flex flex-wrap items-center gap-x-1.5 text-xs">
              {byline}
            </div>
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      <dl className="border-border-subtle grid grid-cols-2 gap-x-6 gap-y-3 border-y py-3.5 sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-text-muted text-2xs font-medium tracking-wide uppercase">
              {fact.label}
            </dt>
            <dd className="text-text-primary truncate text-sm">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-w-0 flex-col gap-8">{children}</div>
        <aside className="flex min-w-0 flex-col gap-5">{aside}</aside>
      </div>
    </div>
  );
}

/** A titled block in the main column. */
export function DetailSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-text-secondary flex items-baseline gap-1.5 text-sm font-medium">
          {title}
          {count !== undefined && <span className="text-text-muted text-xs">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A labelled group in the details column. */
export function AsideGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-text-muted text-2xs font-medium tracking-wide uppercase">{title}</span>
      <div className="flex flex-col gap-1.5 text-xs">{children}</div>
    </div>
  );
}

export function AsideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(href)}
      className="text-text-secondary hover:text-text-primary inline-flex w-fit max-w-full min-w-0 items-center gap-1 text-left"
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0" />
    </button>
  );
}

export function StatusText({ status }: { status: StatusLabel | null }) {
  return status ? (
    <span className={cn(TONE_CLASS[status.tone])}>{status.text}</span>
  ) : (
    <span className="text-text-muted">Not added</span>
  );
}

/** A form field: a small label over its control. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-text-muted text-2xs font-medium tracking-wide uppercase">{label}</span>
      {children}
    </div>
  );
}

/** A clickable row for an app or skill inside another item's page. */
export function PartRow({
  icon,
  title,
  detail,
  status,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  status: StatusLabel | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-foreground/[0.03] -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150"
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-text-primary truncate text-sm font-medium">{title}</span>
        <span className="text-text-tertiary truncate text-xs">{detail}</span>
      </div>
      <span className="shrink-0 text-xs">
        <StatusText status={status} />
      </span>
      <ChevronRight className="text-text-disabled h-3.5 w-3.5 shrink-0" />
    </button>
  );
}
