import {
  ServerConnection,
  useLayout,
  useServer,
  useSettings,
  useTabs,
} from "@opencode-ai/app";
import { Button } from "@opencode-ai/ui/button";
import { Icon } from "@opencode-ai/ui/icon";
import {
  Show,
  For,
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

const SIDEBAR_OPEN_EVENT = "aialra-open-sidebar";
const SIDEBAR_PREPARE_SWITCH_EVENT = "aialra-prepare-sidebar-switch";
const SIDEBAR_SWITCH_SETTLED_EVENT = "aialra-sidebar-switch-settled";

export function ClassicLayoutPreference() {
  const settings = useSettings();
  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!settings.ready() || !settings.general.newLayoutDesigns()) return;
    settings.general.setNewLayoutDesigns(false);
  });
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
  const root = rail?.parentElement;
  const panel = root?.children.item(1);
  return panel instanceof HTMLElement ? panel : nav;
}

function SidebarMount(props: { children: JSX.Element }) {
  const [mount, setMount] = createSignal<HTMLElement | null>(null);
  onMount(() => {
    const fallback = document.createElement("div");
    const slot = document.createElement("div");
    slot.dataset.aialraSidebarSlot = "true";
    fallback.dataset.aialraSidebarFallback = "true";
    fallback.style.cssText =
      "display:none;position:fixed;inset-block:2.5rem 0;inset-inline-start:4rem;width:280px;z-index:50;overflow:auto;background:var(--background-base);";
    document.body.append(fallback);

    let previousPanel: HTMLElement | null = null;
    let previousHidden = false;
    let prepared = false;
    let reconcileTimer: number | undefined;
    const setTarget = (target: HTMLElement) => {
      if (slot.parentElement !== target || target.firstElementChild !== slot)
        target.prepend(slot);
      if (slot !== mount()) setMount(slot);
      fallback.style.display =
        target === fallback && window.matchMedia("(min-width: 1280px)").matches
          ? "block"
          : "none";
    };
    const update = () => {
      const panel = sidebarPanel();
      const hidden =
        panel?.hasAttribute("inert") ||
        panel?.getAttribute("aria-hidden") === "true";
      if (prepared) {
        setTarget(fallback);
      } else {
        if (panel && !hidden) setTarget(panel);
        else setTarget(fallback);
      }
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
      setTarget(fallback);
    };
    const settle = () => {
      if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer);
      const deadline = performance.now() + 500;
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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", scheduleUpdate);
    onCleanup(() => {
      observer.disconnect();
      if (updateFrame !== undefined) window.cancelAnimationFrame(updateFrame);
      if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener(SIDEBAR_PREPARE_SWITCH_EVENT, prepare);
      window.removeEventListener(SIDEBAR_SWITCH_SETTLED_EVENT, settle);
      slot.remove();
      fallback.remove();
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

function hostWorkspaceLabel(host: HostDescriptor): string {
  return host.mode === "vps" ? "VPS 工作区" : "远程工作区";
}

function withinWorkspace(root: string, candidate: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/u, "");
  const left = normalize(root);
  const right = normalize(candidate);
  const windowsPath = /^[A-Za-z]:\//u.test(left);
  return (
    (windowsPath ? right.toLowerCase() : right) ===
      (windowsPath ? left.toLowerCase() : left) ||
    (windowsPath ? right.toLowerCase() : right).startsWith(
      `${windowsPath ? left.toLowerCase() : left}/`,
    )
  );
}

export function HostSidebar(props: {
  hosts: HostDescriptor[];
  selectedHostId: Accessor<string>;
  workspaceRoots: Accessor<Record<string, string>>;
  ensureWorkspaceRoot(host: HostDescriptor): Promise<string | undefined>;
  onSelect(host: HostDescriptor): void;
  onActivate(host: HostDescriptor): void;
  onRefresh(): void;
}) {
  const server = useServer();
  const tabs = useTabs();
  const [managementOpen, setManagementOpen] = createSignal(false);
  const [selectorOpen, setSelectorOpen] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [switching, setSwitching] = createSignal<string | null>(null);
  let switchSequence = 0;
  let selectorRoot: HTMLDivElement | undefined;
  let managementClose: HTMLButtonElement | undefined;

  onMount(() => {
    const dismissSelector = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || selectorRoot?.contains(target)) return;
      setSelectorOpen(false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (managementOpen()) setManagementOpen(false);
      else setSelectorOpen(false);
    };
    document.addEventListener("pointerdown", dismissSelector);
    document.addEventListener("keydown", dismissWithEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismissSelector);
      document.removeEventListener("keydown", dismissWithEscape);
    });
  });

  createEffect(() => {
    if (!managementOpen()) return;
    queueMicrotask(() => managementClose?.focus());
  });

  const selectedHost = () =>
    props.hosts.find((host) => host.hostId === props.selectedHostId());

  const selectHost = (host: HostDescriptor) => {
    if (host.state !== "online" && host.state !== "degraded") return;
    if (host.hostId === props.selectedHostId()) {
      setSelectorOpen(false);
      return;
    }
    const sequence = ++switchSequence;
    setSwitching(host.hostId);
    setSelectorOpen(false);
    window.dispatchEvent(new Event(SIDEBAR_PREPARE_SWITCH_EVENT));
    props.onSelect(host);
    queueMicrotask(() => {
      if (switchSequence !== sequence) return;
      props.onActivate(host);
      server.setActive(ServerConnection.Key.make(virtualOrigin(host.hostId)));
      window.dispatchEvent(new Event(SIDEBAR_SWITCH_SETTLED_EVENT));
      setSwitching(null);
    });
    void props.ensureWorkspaceRoot(host);
  };

  const openSession = async (host: HostDescriptor) => {
    if (busyAction()) return;
    setBusyAction(`new-${host.hostId}`);
    setError(null);
    try {
      const root = await props.ensureWorkspaceRoot(host);
      if (!root) throw new Error("工作目录尚未确认");
      const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
      const projects = server.projects.forServer(key);
      for (const project of projects.list()) {
        if (!withinWorkspace(root, project.worktree))
          projects.remove(project.worktree);
      }
      if (!projects.list().some((project) => project.worktree === root))
        projects.open(root);
      projects.touch(root);
      const draft = (await tabs.newDraft(
        { server: key, directory: root },
        "",
      )) as { draftID?: unknown } | undefined;
      if (typeof draft?.draftID === "string") {
        history.pushState(
          null,
          "",
          `/new-session?draftId=${encodeURIComponent(draft.draftID)}`,
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建会话");
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
        data-active-host={selectedHost()?.hostId}
        aria-label="AIALRA 工作区"
        class="order-first w-full shrink-0 border-b border-border-weaker-base bg-background-base"
      >
        <div class="flex flex-col gap-2 px-2 py-3">
          <Show when={selectedHost()}>
            {(host) => (
              <Button
                type="button"
                size="normal"
                variant="secondary"
                class="w-full justify-start"
                disabled={
                  busyAction() !== null ||
                  !props.workspaceRoots()[host().hostId] ||
                  switching() !== null
                }
                aria-busy={busyAction() === `new-${host().hostId}`}
                onClick={() => void openSession(host())}
              >
                <Icon name="edit" size="small" />
                新建会话
              </Button>
            )}
          </Show>

          <div
            ref={(element) => {
              selectorRoot = element;
            }}
            data-aialra-workspace-switcher
            class="relative"
          >
            <Show when={selectedHost()}>
              {(host) => {
                const active = () =>
                  host().state === "online" || host().state === "degraded";
                const root = () => props.workspaceRoots()[host().hostId];
                return (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      class="w-full min-w-0 justify-start gap-2 text-left"
                      aria-haspopup="listbox"
                      aria-expanded={selectorOpen()}
                      onClick={() => setSelectorOpen((value) => !value)}
                    >
                      <span
                        aria-hidden="true"
                        class={`size-1.5 shrink-0 rounded-full ${active() ? "bg-icon-success-base" : "bg-icon-critical-base"}`}
                      />
                      <span class="min-w-0 flex-1 truncate">
                        <span class="block truncate text-14-medium text-text-strong">
                          {host().displayName}
                        </span>
                        <span class="block truncate text-12-regular text-text-weak">
                          {hostWorkspaceLabel(host())} ·{" "}
                          {hostStateLabel(host())}
                        </span>
                      </span>
                      <Icon
                        name={selectorOpen() ? "chevron-up" : "chevron-down"}
                        size="small"
                        class="shrink-0 opacity-60"
                      />
                    </Button>
                    <div
                      data-aialra-workspace-root
                      class="mt-1 truncate px-2 font-mono text-11-regular text-text-weak"
                      title={root() ?? "正在读取工作目录"}
                    >
                      {root() ?? "正在读取工作目录"}
                    </div>
                  </>
                );
              }}
            </Show>

            <Show when={selectorOpen()}>
              <div
                data-aialra-workspace-menu
                role="listbox"
                aria-label="选择工作区"
                class="absolute inset-x-0 top-full z-50 mt-1 rounded-md border border-border-weak-base bg-background-base p-1 shadow-lg"
              >
                <For each={props.hosts}>
                  {(host) => {
                    const selected = () =>
                      host.hostId === props.selectedHostId();
                    const active = () =>
                      host.state === "online" || host.state === "degraded";
                    return (
                      <Button
                        type="button"
                        role="option"
                        variant={selected() ? "secondary" : "ghost"}
                        class="w-full min-w-0 justify-start gap-2 text-left"
                        aria-selected={selected()}
                        aria-busy={switching() === host.hostId}
                        disabled={!active() || switching() === host.hostId}
                        onClick={() => selectHost(host)}
                      >
                        <span
                          aria-hidden="true"
                          class={`size-1.5 shrink-0 rounded-full ${active() ? "bg-icon-success-base" : "bg-icon-critical-base"}`}
                        />
                        <span class="min-w-0 flex-1 truncate">
                          <span class="block truncate text-13-medium text-text-strong">
                            {host.displayName}
                          </span>
                          <span class="block truncate text-11-regular text-text-weak">
                            {hostWorkspaceLabel(host)} · {hostStateLabel(host)}
                          </span>
                        </span>
                        <Show when={selected()}>
                          <Icon name="check" size="small" />
                        </Show>
                      </Button>
                    );
                  }}
                </For>
                <div class="my-1 border-t border-border-weaker-base" />
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  class="w-full justify-start"
                  onClick={() => {
                    setSelectorOpen(false);
                    setManagementOpen(true);
                  }}
                >
                  <Icon name="server" size="small" />
                  管理工作区
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </section>

      <Show when={managementOpen()}>
        <Portal>
          <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
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
                    const root = () => props.workspaceRoots()[host.hostId];
                    return (
                      <div class="rounded-lg border border-border-weaker-base bg-surface-base p-3">
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-14-medium text-text-strong">
                              {host.displayName}
                            </div>
                            <div class="mt-0.5 text-12-regular text-text-weak">
                              {host.platform} · {hostWorkspaceLabel(host)} ·{" "}
                              {hostStateLabel(host)}
                            </div>
                          </div>
                          <span class="shrink-0 text-11-medium text-text-weak">
                            {host.capabilities.includes("workspace-boundary")
                              ? "边界已隔离"
                              : "边界待验证"}
                          </span>
                        </div>
                        <div class="mt-3 select-text break-all font-mono text-11-regular text-text-strong">
                          {root() ?? "正在读取工作目录"}
                        </div>
                        <div class="mt-2 text-11-regular text-text-weak">
                          Agent {host.agentVersion} · OpenCode{" "}
                          {host.opencodeVersion ?? "未知"}
                        </div>
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
                    window.setTimeout(() => setBusyAction(null), 180);
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
