import {
  ServerConnection,
  useLayout,
  useServer,
  useSettings,
} from "@opencode-ai/app";
import { Button } from "@opencode-ai/ui/button";
import { Icon } from "@opencode-ai/ui/icon";
import { useNavigate } from "@solidjs/router";
import {
  batch,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  createPairingCode,
  type HostDescriptor,
  type PairingCode,
} from "./api";
import { virtualOrigin } from "./remote-fetch";
import {
  hostWorkspaceLabel,
  workspaceSessionRoute,
  workspaceRootErrorMessage,
  type HostViewModel,
  type WorkspaceRootResult,
  type WorkspaceStateByHost,
} from "./workspace-state";

const SIDEBAR_OPEN_EVENT = "aialra-open-sidebar";
const SIDEBAR_PREPARE_SWITCH_EVENT = "aialra-prepare-sidebar-switch";
const SIDEBAR_SWITCH_SETTLED_EVENT = "aialra-sidebar-switch-settled";

export function ClassicLayoutPreference() {
  const settings = useSettings();
  return (
    <>
      <style>{`
        div:has(> div > [data-action="settings-new-layout-designs"]),
        [data-component="settings-v2-row"]:has([data-action="settings-new-layout-designs"]) {
          display: none !important;
        }
      `}</style>
      <span
        data-aialra-classic-layout-preference
        data-new-layout={String(settings.general.newLayoutDesigns())}
        data-settings-ready={String(settings.ready())}
        hidden
      />
    </>
  );
}

function sidebarPanel(): HTMLElement | null {
  const mobile = window.matchMedia("(max-width: 1279px)").matches;
  const nav = document.querySelector<HTMLElement>(
    mobile
      ? 'nav[data-component="sidebar-nav-mobile"]'
      : 'nav[data-component="sidebar-nav-desktop"]',
  );
  const rail = nav?.querySelector<HTMLElement>(
    '[data-component="sidebar-rail"]',
  );
  const panel = rail?.nextElementSibling;
  return panel instanceof HTMLElement ? panel : null;
}

function SidebarMount(props: { children: JSX.Element }) {
  const [mount, setMount] = createSignal<HTMLElement | null>(null);
  onMount(() => {
    const slot = document.createElement("div");
    slot.dataset.aialraSidebarSlot = "true";
    slot.className = "contents";

    let previousPanel: HTMLElement | null = null;
    let previousHidden = false;
    let prepared = false;
    let reconcileTimer: number | undefined;

    const clearTarget = () => {
      if (slot.parentElement) slot.remove();
      if (mount() !== null) setMount(null);
    };

    const setTarget = (target: HTMLElement | null) => {
      if (!target) {
        clearTarget();
        return;
      }
      if (slot.parentElement !== target || target.firstElementChild !== slot)
        target.prepend(slot);
      if (slot !== mount()) setMount(slot);
    };

    const update = () => {
      const panel = sidebarPanel();
      const hidden =
        panel?.hasAttribute("inert") ||
        panel?.getAttribute("aria-hidden") === "true";
      if (prepared || !panel || hidden) clearTarget();
      else setTarget(panel);

      if (panel !== previousPanel) {
        previousPanel = panel;
        previousHidden = false;
      }
      if (panel && hidden && !previousHidden)
        window.dispatchEvent(new Event(SIDEBAR_OPEN_EVENT));
      previousHidden = !!hidden;
    };

    const prepare = () => {
      prepared = true;
      if (reconcileTimer !== undefined) {
        window.clearTimeout(reconcileTimer);
        reconcileTimer = undefined;
      }
      clearTarget();
    };

    const settle = () => {
      if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer);
      const deadline = performance.now() + 750;
      const reconcile = () => {
        reconcileTimer = undefined;
        const panel = sidebarPanel();
        const hidden =
          panel?.hasAttribute("inert") ||
          panel?.getAttribute("aria-hidden") === "true";
        if (!panel || hidden) {
          if (performance.now() < deadline) {
            reconcileTimer = window.setTimeout(reconcile, 16);
            return;
          }
          prepared = false;
          update();
          return;
        }
        prepared = false;
        setTarget(panel);
      };
      reconcileTimer = window.setTimeout(reconcile, 0);
    };

    update();
    window.addEventListener(SIDEBAR_PREPARE_SWITCH_EVENT, prepare);
    window.addEventListener(SIDEBAR_SWITCH_SETTLED_EVENT, settle);
    let updateFrame: number | undefined;
    const scheduleUpdate = () => {
      if (updateFrame !== undefined) return;
      updateFrame = window.requestAnimationFrame(() => {
        updateFrame = undefined;
        update();
      });
    };
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleUpdate);

    onCleanup(() => {
      observer.disconnect();
      if (updateFrame !== undefined) window.cancelAnimationFrame(updateFrame);
      if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener(SIDEBAR_PREPARE_SWITCH_EVENT, prepare);
      window.removeEventListener(SIDEBAR_SWITCH_SETTLED_EVENT, settle);
      slot.remove();
    });
  });

  return (
    <Show when={mount()}>
      {(target) => <Portal mount={target()}>{props.children}</Portal>}
    </Show>
  );
}

export function SidebarLayoutBridge() {
  const layout = useLayout();
  onMount(() => {
    const open = () => layout.sidebar.open();
    open();
    window.addEventListener(SIDEBAR_OPEN_EVENT, open);
    onCleanup(() => window.removeEventListener(SIDEBAR_OPEN_EVENT, open));
  });
  return null;
}

function hostStateLabel(host: HostDescriptor): string {
  if (host.state === "online") return "在线";
  if (host.state === "degraded") return "降级";
  if (host.state === "offline") return "离线";
  return "不兼容";
}

function hostIsAvailable(host: HostDescriptor): boolean {
  return host.state === "online" || host.state === "degraded";
}

function rootStatusLabel(status: HostViewModel["rootStatus"]): string {
  if (status === "loading") return "正在验证工作目录…";
  if (status === "retrying") return "正在重试工作目录…";
  if (status === "failed") return "工作目录验证失败，点击重试";
  if (status === "ready") return "工作目录已验证";
  return "等待验证工作目录";
}

function withinWorkspace(root: string, candidate: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/u, "");
  const left = normalize(root);
  const right = normalize(candidate);
  const windowsPath = /^[A-Za-z]:\//u.test(left);
  const normalizedLeft = windowsPath ? left.toLowerCase() : left;
  const normalizedRight = windowsPath ? right.toLowerCase() : right;
  return (
    normalizedRight === normalizedLeft ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

export function HostSidebar(props: {
  hosts: HostDescriptor[];
  selectedHostId: Accessor<string>;
  workspaceRoots: Accessor<Record<string, string>>;
  workspaceStates: Accessor<WorkspaceStateByHost>;
  ensureWorkspaceRoot(
    host: HostDescriptor,
    options?: { force?: boolean },
  ): Promise<WorkspaceRootResult>;
  onSelect(host: HostDescriptor): void;
  onActivate(host: HostDescriptor): string;
  onRefresh(): void;
}) {
  const server = useServer();
  const navigate = useNavigate();
  const [managementOpen, setManagementOpen] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [switching, setSwitching] = createSignal<string | null>(null);
  const [switchErrors, setSwitchErrors] = createSignal<
    Record<string, string | undefined>
  >({});
  const [renderedHostId, setRenderedHostId] = createSignal(
    props.selectedHostId(),
  );
  let switchSequence = 0;
  let disposed = false;
  let transitionPromise: Promise<boolean> | null = null;
  let managementClose: HTMLButtonElement | undefined;

  createEffect(() => {
    const selected = props.selectedHostId();
    if (switching() === null) setRenderedHostId(selected);
  });

  onMount(() => {
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && managementOpen()) setManagementOpen(false);
    };
    document.addEventListener("keydown", dismissWithEscape);
    onCleanup(() => document.removeEventListener("keydown", dismissWithEscape));
  });

  onCleanup(() => {
    disposed = true;
    switchSequence += 1;
  });

  createEffect(() => {
    if (!managementOpen()) return;
    queueMicrotask(() => managementClose?.focus());
  });

  const modelFor = (host: HostDescriptor): HostViewModel => {
    const state = props.workspaceStates()[host.hostId];
    const rootState = state?.rootState;
    return {
      ...host,
      workspaceLabel: hostWorkspaceLabel(host),
      workspaceRoot: props.workspaceRoots()[host.hostId] ?? state?.root,
      rootStatus: state?.rootStatus ?? "idle",
      rootErrorCategory: rootState?.errorCategory,
      rootRetryable: rootState?.retryable,
      expanded: false,
    };
  };

  const switchHost = async (host: HostDescriptor): Promise<boolean> => {
    if (!hostIsAvailable(host) || disposed) return false;
    if (host.hostId === renderedHostId()) {
      if (transitionPromise) await transitionPromise;
      return !disposed;
    }
    const sequence = ++switchSequence;
    setSwitching(host.hostId);
    setError(null);
    setSwitchErrors((current) => ({ ...current, [host.hostId]: undefined }));
    let result: WorkspaceRootResult;
    try {
      result = await props.ensureWorkspaceRoot(host);
    } catch {
      if (disposed || switchSequence !== sequence) return false;
      setSwitchErrors((current) => ({
        ...current,
        [host.hostId]: "无法验证工作区，请稍后重试",
      }));
      setSwitching(null);
      return false;
    }
    if (disposed || switchSequence !== sequence) return false;
    if (!result.ok) {
      setSwitchErrors((current) => ({
        ...current,
        [host.hostId]: workspaceRootErrorMessage(result.category),
      }));
      setSwitching(null);
      return false;
    }
    const verified = props.workspaceStates()[host.hostId]?.rootState;
    if (
      !verified ||
      verified.phase !== "ready" ||
      verified.root !== result.directory ||
      verified.verifiedAt !== result.verifiedAt
    ) {
      setSwitchErrors((current) => ({
        ...current,
        [host.hostId]: "工作目录验证已过期，请在管理工作区重试",
      }));
      setSwitching(null);
      return false;
    }
    if (transitionPromise) await transitionPromise;
    if (disposed || switchSequence !== sequence) return false;

    // Keep the old host mounted while /path is validated. Once validation
    // succeeds, move the official route to a neutral home boundary before
    // changing the server scope. Solid's keyed ServerKey provider and the
    // route tree then have a complete render turn to dispose the old session
    // chrome before the target host is mounted. This is the important part of
    // the single-instance guarantee: changing the scope and the session route
    // in the same batch can leave two legacy route branches alive briefly.
    const next = props.onActivate(host);
    window.dispatchEvent(new Event(SIDEBAR_PREPARE_SWITCH_EVENT));
    const transition = (async () => {
      const settle = (count: number) =>
        count <= 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              let frames = 0;
              const nextFrame = () => {
                if (disposed || frames >= count) {
                  resolve();
                  return;
                }
                frames += 1;
                window.requestAnimationFrame(nextFrame);
              };
              window.requestAnimationFrame(nextFrame);
            });

      if (location.pathname !== "/") {
        navigate("/", { replace: true });
        await settle(1);
      }
      if (disposed || switchSequence !== sequence) return false;

      batch(() => {
        props.onSelect(host);
        server.setActive(ServerConnection.Key.make(virtualOrigin(host.hostId)));
        setRenderedHostId(host.hostId);
      });
      navigate(next, { replace: true });
      await settle(0);
      return !disposed && switchSequence === sequence;
    })();
    transitionPromise = transition;
    const completed = await transition;
    if (transitionPromise === transition) transitionPromise = null;
    if (!completed || disposed || switchSequence !== sequence) return false;
    window.dispatchEvent(new Event(SIDEBAR_SWITCH_SETTLED_EVENT));
    setSwitching(null);
    return true;
  };

  const openSession = async (host: HostDescriptor) => {
    if (busyAction() !== null || !hostIsAvailable(host)) return;
    setBusyAction(`new-${host.hostId}`);
    setError(null);
    try {
      if (host.hostId !== renderedHostId()) {
        const switched = await switchHost(host);
        if (!switched) return;
      }
      const result = await props.ensureWorkspaceRoot(host);
      if (!result.ok) {
        setSwitchErrors((current) => ({
          ...current,
          [host.hostId]: workspaceRootErrorMessage(result.category),
        }));
        return;
      }
      const root = result.directory;
      const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
      const projects = server.projects.forServer(key);
      for (const project of projects.list()) {
        if (!withinWorkspace(root, project.worktree))
          projects.remove(project.worktree);
      }
      if (!projects.list().some((project) => project.worktree === root))
        projects.open(root);
      projects.touch(root);
      setManagementOpen(false);
      navigate(workspaceSessionRoute(root));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建会话");
    } finally {
      setBusyAction(null);
    }
  };

  const retryWorkspaceRoot = async (host: HostDescriptor) => {
    if (busyAction() !== null) return;
    setBusyAction(`root-${host.hostId}`);
    setError(null);
    try {
      const result = await props.ensureWorkspaceRoot(host, { force: true });
      if (!result.ok)
        setSwitchErrors((current) => ({
          ...current,
          [host.hostId]: workspaceRootErrorMessage(result.category),
        }));
      else
        setSwitchErrors((current) => ({
          ...current,
          [host.hostId]: undefined,
        }));
    } catch {
      setSwitchErrors((current) => ({
        ...current,
        [host.hostId]: "无法验证工作区，请稍后重试",
      }));
    } finally {
      setBusyAction(null);
    }
  };

  const issue = async (mode: "vps" | "remote") => {
    if (busyAction()) return;
    setBusyAction(`pair-${mode}`);
    setPairing(null);
    setError(null);
    try {
      setPairing(
        await createPairingCode(
          mode === "vps" ? "AIALRA VPS" : "AIALRA Windows",
          mode,
        ),
      );
    } catch {
      setError("无法生成一次性登记码");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <SidebarMount>
      <section
        data-aialra-sidebar-hosts
        data-active-host={renderedHostId()}
        aria-label="AIALRA 工作区"
        class="order-first w-full shrink-0 border-b border-border-weaker-base bg-background-base"
      >
        <div class="flex min-w-0 flex-col gap-1 px-2 py-2">
          <div class="px-2 pb-1 text-11-medium uppercase tracking-wide text-text-weak">
            工作区
          </div>
          <For each={props.hosts}>
            {(host) => {
              const view = () => modelFor(host);
              const active = () => hostIsAvailable(host);
              const statusTone = () => {
                if (!active() || view().rootStatus === "failed")
                  return "bg-icon-critical-base";
                if (
                  view().rootStatus === "loading" ||
                  view().rootStatus === "retrying"
                )
                  return "bg-icon-warning-base";
                return "bg-icon-success-base";
              };
              return (
                <div
                  data-aialra-host-item={host.hostId}
                  class="flex min-w-0 flex-col gap-1 rounded-md"
                >
                  <Button
                    type="button"
                    variant={
                      host.hostId === renderedHostId() ? "secondary" : "ghost"
                    }
                    class="w-full min-w-0 justify-start gap-2 text-left"
                    aria-label={`${host.displayName}，${hostStateLabel(host)}，${rootStatusLabel(view().rootStatus)}`}
                    title={`${host.displayName} · ${hostStateLabel(host)} · ${rootStatusLabel(view().rootStatus)}`}
                    aria-busy={switching() === host.hostId}
                    disabled={!active() || switching() === host.hostId}
                    onClick={() => void switchHost(host)}
                  >
                    <span
                      data-aialra-host-status={host.hostId}
                      data-aialra-host-status-state={view().rootStatus}
                      aria-hidden="true"
                      class={`size-1.5 shrink-0 rounded-full ${statusTone()} ${switching() === host.hostId ? "animate-pulse" : ""}`}
                    />
                    <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
                      {host.displayName}
                    </span>
                  </Button>

                  <Show when={switchErrors()[host.hostId]}>
                    {(message) => (
                      <span
                        data-aialra-host-error={host.hostId}
                        role="status"
                        aria-live="polite"
                        class="m-0 px-2 text-11-regular leading-4 text-icon-critical-base"
                      >
                        {message()}
                      </span>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>

          <Button
            type="button"
            size="small"
            variant="ghost"
            class="mt-1 w-full justify-start"
            data-aialra-action="manage-workspaces"
            onClick={() => {
              setError(null);
              setManagementOpen(true);
            }}
          >
            <Icon name="server" size="small" />
            管理工作区
          </Button>
          <Show when={error()}>
            <p
              role="alert"
              class="px-2 pb-1 text-11-regular text-icon-critical-base"
            >
              {error()}
            </p>
          </Show>
        </div>
      </section>

      <Show when={managementOpen()}>
        <Portal>
          <div
            data-aialra-workspace-overlay
            class="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
            inert={false}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget)
                setManagementOpen(false);
            }}
          >
            <section
              data-aialra-workspace-management
              role="dialog"
              aria-modal="true"
              aria-labelledby="aialra-workspace-management-title"
              class="max-h-[min(720px,calc(100vh-2rem))] w-full max-w-lg overflow-y-auto rounded-xl border border-border-weak-base bg-background-base p-4 shadow-xl"
            >
              <div class="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2
                    id="aialra-workspace-management-title"
                    class="text-16-medium text-text-strong"
                  >
                    管理工作区
                  </h2>
                  <p class="mt-1 text-12-regular text-text-weak">
                    查看主机状态、版本和工作区边界，或登记新的 Agent
                  </p>
                </div>
                <Button
                  ref={(element) => {
                    managementClose = element;
                  }}
                  type="button"
                  size="small"
                  variant="ghost"
                  aria-label="关闭工作区管理"
                  onClick={() => setManagementOpen(false)}
                >
                  <Icon name="close" size="small" />
                </Button>
              </div>

              <div class="flex flex-col gap-2">
                <For each={props.hosts}>
                  {(host) => {
                    const view = () => modelFor(host);
                    const rootReady = () =>
                      view().rootStatus === "ready" &&
                      Boolean(view().workspaceRoot);
                    return (
                      <div
                        data-aialra-host-management={host.hostId}
                        class="rounded-lg border border-border-weaker-base bg-surface-base p-3"
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-14-medium text-text-strong">
                              {host.displayName}
                            </div>
                            <div class="mt-0.5 text-12-regular text-text-weak">
                              {host.platform} · {view().workspaceLabel} ·{" "}
                              {hostStateLabel(host)}
                            </div>
                          </div>
                          <span class="shrink-0 text-11-medium text-text-weak">
                            {host.capabilities.includes("workspace-boundary")
                              ? "边界已隔离"
                              : "边界待验证"}
                          </span>
                        </div>
                        <div
                          data-aialra-workspace-root
                          class="mt-3 select-text break-all font-mono text-11-regular text-text-strong"
                        >
                          {rootReady()
                            ? view().workspaceRoot
                            : rootStatusLabel(view().rootStatus)}
                        </div>
                        <div class="mt-2 text-11-regular text-text-weak">
                          Agent {host.agentVersion} · OpenCode{" "}
                          {host.opencodeVersion ?? "未知"}
                        </div>
                        <div class="mt-3 flex flex-wrap items-center gap-1">
                          <Button
                            type="button"
                            size="small"
                            variant="secondary"
                            data-aialra-action="new-session"
                            data-host-id={host.hostId}
                            disabled={
                              !rootReady() ||
                              !hostIsAvailable(host) ||
                              busyAction() !== null ||
                              switching() !== null
                            }
                            aria-busy={busyAction() === `new-${host.hostId}`}
                            onClick={() => void openSession(host)}
                          >
                            <Icon name="edit" size="small" />
                            新建会话
                          </Button>
                          <Show
                            when={
                              view().rootStatus === "failed" ||
                              view().rootStatus === "loading" ||
                              view().rootStatus === "retrying"
                            }
                          >
                            <Button
                              type="button"
                              size="small"
                              variant="ghost"
                              data-aialra-action="retry-workspace-root"
                              disabled={
                                view().rootStatus === "loading" ||
                                view().rootStatus === "retrying" ||
                                busyAction() !== null
                              }
                              aria-busy={busyAction() === `root-${host.hostId}`}
                              onClick={() => void retryWorkspaceRoot(host)}
                            >
                              重试工作目录
                            </Button>
                          </Show>
                        </div>
                        <Show when={switchErrors()[host.hostId]}>
                          {(message) => (
                            <div
                              data-aialra-host-error={host.hostId}
                              role="status"
                              aria-live="polite"
                              class="mt-2 text-11-regular text-icon-critical-base"
                            >
                              {message()}
                            </div>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>

              <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border-weaker-base pt-4">
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={busyAction() !== null}
                  aria-busy={busyAction() === "refresh"}
                  onClick={() => {
                    if (busyAction()) return;
                    setBusyAction("refresh");
                    props.onRefresh();
                  }}
                >
                  刷新状态
                </Button>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={busyAction() !== null}
                  aria-busy={busyAction() === "pair-vps"}
                  onClick={() => void issue("vps")}
                >
                  登记 VPS
                </Button>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={busyAction() !== null}
                  aria-busy={busyAction() === "pair-remote"}
                  onClick={() => void issue("remote")}
                >
                  登记 Windows
                </Button>
              </div>
              <Show when={pairing()}>
                {(value) => (
                  <div
                    aria-live="polite"
                    class="mt-3 rounded-md border border-border-weaker-base p-3"
                  >
                    <div class="text-11-regular text-text-weak">
                      一次性登记码
                    </div>
                    <code class="text-14-medium tracking-widest text-text-strong">
                      {value().code}
                    </code>
                    <div class="mt-1 text-11-regular text-text-weak">
                      10 分钟内有效，使用后立即失效
                    </div>
                  </div>
                )}
              </Show>
              <Show when={error()}>
                <p
                  role="alert"
                  class="mt-2 text-11-regular text-icon-critical-base"
                >
                  {error()}
                </p>
              </Show>
            </section>
          </div>
        </Portal>
      </Show>
    </SidebarMount>
  );
}
