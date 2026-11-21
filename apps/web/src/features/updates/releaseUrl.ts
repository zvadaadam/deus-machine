export function releaseUrl(version?: string): string {
  const releases = "https://github.com/zvadaadam/deus-machine/releases";
  return version ? `${releases}/tag/v${encodeURIComponent(version)}` : releases;
}
