export type ApplicationState = "starting" | "running" | "failed";

interface ApplicationRoot {
  dataset: Record<string, string | undefined>;
}

export function claimApplicationRoot(root: ApplicationRoot): boolean {
  if (
    root.dataset.aialraAppState === "starting" ||
    root.dataset.aialraAppState === "running"
  )
    return false;
  root.dataset.aialraAppState = "starting";
  return true;
}

export function markApplicationRoot(
  root: ApplicationRoot,
  state: ApplicationState,
): void {
  root.dataset.aialraAppState = state;
}
