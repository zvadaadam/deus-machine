# Components

## Shadcn — You Own the Code

Files in `src/components/ui/` are starter code you're meant to customize. Editing them directly is the intended workflow.

### Edit `components/ui/*` directly when:
- Changing default styles, adding project-wide variants, fixing a11y, adjusting animations

### Create feature components when:
- Adding app-specific behavior, combining shadcn primitives into domain patterns, adding business logic

### Shadcn Rules

1. **Theme first** — try CSS variables in `global.css` before editing components. If you're overriding the same className everywhere, edit the component once.
2. **Keep standard props** — preserve `className`, `variant`, `size`, `asChild`. Don't embed domain logic in `ui/*`.
3. **Refresh from upstream** with `bunx shadcn@canary add <component> --overwrite`, then reapply customizations.

## Component Architecture

### Encapsulate Self-Contained Concerns

If a piece of UI involves data derivation + rendering + state, make it a component. Don't scatter utilities across the parent.

```tsx
// Bad — parent wires up avatar logic manually
function Item({ repo }) {
  const owner = getRepoOwner(repo.name);
  const url = getGitHubAvatarUrl(owner);
  return <Avatar><AvatarImage src={url} />...</Avatar>;
}

// Good — component owns its concern
function Item({ repo }) {
  return <RepoAvatar repoName={repo.name} />;
}
```

### Extract vs Keep Inline

**Extract when:** combines data + rendering, has own state/hooks, reusable, 10+ lines distracting from parent.

**Keep inline when:** pure layout div, one-liner, only makes sense in this parent.

### Where Components Live

| Location | What goes here |
|---|---|
| `src/features/{feature}/ui/` | Default. Feature-scoped components. |
| `src/shared/components/` | Cross-feature reusable compositions (only when 2+ features need it) |
| `src/components/ui/` | Shadcn base primitives only |
