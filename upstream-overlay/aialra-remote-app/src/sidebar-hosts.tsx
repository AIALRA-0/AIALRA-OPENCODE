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

const CLASSIC_LAYOUT_MARKER = "aialra-classic-layout-default-v1";
const CLASSIC_LAYOUT_DEFAULT_APPLIED =
  "aialra-classic-layout-default-applied-v1";
const SIDEBAR_OPEN_EVENT = "aialra-open-sidebar";
const SIDEBAR_PREPARE_SWITCH_EVENT = "aialra-prepare-sidebar-switch";
const SIDEBAR_SWITCH_SETTLED_EVENT = "aialra-sidebar-switch-settled";

export function ClassicLayoutPreference() {
  const settings = useSettings();
  createEffect(() => {
    if (typeof window === "undefined") return;
    if (
      window.localStorage.getItem(CLASSIC_LAYOUT_MARKER) === "1" ||
      window.localStorage.getItem(CLASSIC_LAYOUT_DEFAULT_APPLIED) !== "1"
    )
      return;

    // The default is applied before AppInterface mounts, but the upstream
    // settings store intentionally uses a temporary new-layout fallback while
    // its async storage is loading. Flip that fallback once, then let the
    // official setting own all later explicit choices.
    window.localStorage.setItem(CLASSIC_LAYOUT_MARKER, "1");
    if (settings.general.newLayoutDesigns())
      settings.general.setNewLayoutDesigns(false);
  });
  return (
    <span
      data-aialra-classic-layout-preference
      data-new-layout={String(settings.general.newLayoutDesigns())}
      data-settings-ready={String(settings.ready())}
      hidden
    />
  );
}

function sidebarPanel(): HTMLElement | null {
  const nav = document.querySelector<HTMLElement>(
    'nav[data-component="sidebar-nav-desktop"]',
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
    fallback.dataset.aialraSidebarFallback = "true";
    fallback.style.cssText =
      "display:none;position:fixed;inset-block:2.5rem 0;inset-inline-start:4rem;width:280px;z-index:50;overflow:auto;background:var(--background-base);";
    document.body.append(fallback);

    let previousPanel: HTMLElement | null = null;
    let previousHidden = false;
    let prepared = false;
    let reconcileTimer: number | undefined;
    const setTarget = (target: HTMLElement) => {
      if (target !== mount()) setMount(target);
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
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = undefined;
        const panel = sidebarPanel();
        const hidden =
          panel?.hasAttribute("inert") ||
          panel?.getAttribute("aria-hidden") === "true";
        if (!panel || hidden) return;
        prepared = false;
        setTarget(panel);
      }, 240);
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
    onCleanup(() => {
      observer.disconnect();
      if (updateFrame !== undefined) window.cancelAnimationFrame(updateFrame);
      if (reconcileTimer !== undefined) window.clearTimeout(reconcileTimer);
      window.removeEventListener(SIDEBAR_PREPARE_SWITCH_EVENT, prepare);
      window.removeEventListener(SIDEBAR_SWITCH_SETTLED_EVENT, settle);
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
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [switching, setSwitching] = createSignal<string | null>(null);
  let switchSequence = 0;

  const selectedHost = () =>
    props.hosts.find((host) => host.hostId === props.selectedHostId());

  const selectHost = (host: HostDescriptor) => {
    if (host.state !== "online" && host.state !== "degraded") return;
    if (host.hostId === props.selectedHostId()) return;
    const sequence = ++switchSequence;
    setSwitching(host.hostId);
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
        aria-label="AIALRA 工作区"
        class="order-first w-full shrink-0 border-b border-border-weaker-base bg-background-base"
      >
        <div class="px-3 pt-3 pb-2 text-12-medium text-text-weak">工作区</div>
        <div class="flex flex-col gap-1 px-2 pb-2">
          <For each={props.hosts}>
            {(host) => {
              const selected = () => host.hostId === props.selectedHostId();
              const active = () =>
                host.state === "online" || host.state === "degraded";
              const root = () => props.workspaceRoots()[host.hostId];
              return (
                <div class="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant={selected() ? "secondary" : "ghost"}
                    class="w-full min-w-0 justify-start gap-2 text-left"
                    aria-pressed={selected()}
                    aria-busy={switching() === host.hostId}
                    disabled={!active() || switching() === host.hostId}
                    onClick={() => selectHost(host)}
                  >
                    <span
                      aria-hidden="true"
                      class={`size-1.5 shrink-0 rounded-full ${active() ? "bg-icon-success-base" : "bg-icon-critical-base"}`}
                    />
                    <span class="min-w-0 flex-1 truncate">
                      <span class="block truncate text-14-medium text-text-strong">
                        {host.displayName}
                      </span>
                      <span class="block truncate text-12-regular text-text-weak">
                        {hostWorkspaceLabel(host)} · {hostStateLabel(host)}
                      </span>
                    </span>
                    <Icon
                      name="chevron-down"
                      size="small"
                      class="shrink-0 opacity-60"
                    />
                  </Button>
                  <Show when={selected()}>
                    <div class="mx-2 mb-1 rounded-md bg-surface-base px-2 py-2 text-11-regular text-text-weak">
                      <div class="mb-1 text-12-medium text-text-base">
                        工作目录
                      </div>
                      <div
                        data-aialra-workspace-root
                        class="select-text break-all font-mono text-11-regular text-text-strong"
                      >
                        {root() ?? "正在读取工作目录"}
                      </div>
                      <div class="mt-1 break-words">
                        Agent {host.agentVersion} · OpenCode{" "}
                        {host.opencodeVersion ?? "未知"}
                      </div>
                      <Button
                        type="button"
                        size="small"
                        variant="ghost"
                        class="mt-2 w-full justify-start"
                        disabled={
                          busyAction() !== null ||
                          !root() ||
                          switching() !== null
                        }
                        aria-busy={busyAction() === `new-${host.hostId}`}
                        onClick={() => void openSession(host)}
                      >
                        <Icon name="edit" size="small" />
                        新建会话
                      </Button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        <div class="flex flex-col gap-1 px-2 pb-3">
          <Button
            type="button"
            size="small"
            variant="ghost"
            class="w-full justify-start"
            aria-expanded={managementOpen()}
            aria-controls="aialra-host-management"
            onClick={() => setManagementOpen((value) => !value)}
          >
            <Icon name="server" size="small" />
            主机管理
          </Button>
          <Show when={managementOpen()}>
            <section
              id="aialra-host-management"
              role="region"
              aria-label="主机管理"
              class="mt-1 rounded-md bg-surface-base p-2"
            >
              <div class="mb-2 flex items-center justify-between gap-2">
                <span class="text-12-medium text-text-strong">登记与状态</span>
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
                  刷新
                </Button>
              </div>
              <For each={props.hosts}>
                {(host) => (
                  <div class="mb-2 last:mb-0 text-11-regular text-text-weak">
                    <div class="text-12-medium text-text-base">
                      {host.displayName}
                    </div>
                    <div>
                      {host.platform} · {hostStateLabel(host)}
                    </div>
                    <div>
                      工作区边界：
                      {host.capabilities.includes("workspace-boundary")
                        ? "已隔离"
                        : "待验证"}
                    </div>
                  </div>
                )}
              </For>
              <div class="mt-2 flex flex-wrap gap-1">
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
                    class="mt-2 rounded-md border border-border-weaker-base p-2"
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
          </Show>
        </div>
      </section>
    </SidebarMount>
  );
}
