import { ServerConnection, useServer, useSettings } from "@opencode-ai/app";
import { Button } from "@opencode-ai/ui/button";
import { Dialog } from "@opencode-ai/ui/dialog";
import { Icon } from "@opencode-ai/ui/icon";
import { useDialog } from "@opencode-ai/ui/context/dialog";
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

function TitlebarRightMount(props: {
  children: import("solid-js").JSX.Element;
}) {
  const [mount, setMount] = createSignal<HTMLElement | null>(null);
  onMount(() => {
    const slot = document.createElement("div");
    slot.dataset.aialraWorkspaceControlSlot = "true";
    slot.className = "contents";

    const update = () => {
      const target = document.getElementById("opencode-titlebar-right");
      document
        .querySelectorAll<HTMLElement>(
          '[data-aialra-workspace-control-slot="true"]',
        )
        .forEach((candidate) => {
          if (candidate !== slot) candidate.remove();
        });
      if (!(target instanceof HTMLElement)) {
        if (slot.parentElement) slot.remove();
        if (mount() !== null) setMount(null);
        return;
      }
      if (slot.parentElement !== target) target.append(slot);
      if (mount() !== slot) setMount(slot);
    };

    update();
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
      window.removeEventListener("resize", scheduleUpdate);
      slot.remove();
    });
  });

  return (
    <Show when={mount()}>
      {(target) => <Portal mount={target()}>{props.children}</Portal>}
    </Show>
  );
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

export function WorkspaceControl(props: {
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
  const dialog = useDialog();
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

  createEffect(() => {
    const selected = props.selectedHostId();
    if (switching() === null) setRenderedHostId(selected);
  });

  onCleanup(() => {
    disposed = true;
    switchSequence += 1;
  });

  createEffect(() => {
    if (!managementOpen()) return;
    queueMicrotask(() => {
      document
        .querySelector<HTMLElement>(
          '[data-aialra-workspace-management] [aria-label="关闭工作区管理"]',
        )
        ?.focus();
    });
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
    if (transitionPromise) {
      try {
        await transitionPromise;
      } catch {
        if (!disposed && switchSequence === sequence) {
          setSwitchErrors((current) => ({
            ...current,
            [host.hostId]: "工作区切换失败，请重试",
          }));
          setSwitching(null);
        }
        return false;
      }
    }
    if (disposed || switchSequence !== sequence) return false;

    // Keep the old host mounted while /path is validated. Once validation
    // succeeds, move the official route to a neutral home boundary before
    // changing the server scope. Solid's keyed ServerKey provider and the
    // route tree then have a complete render turn to dispose the old session
    // chrome before the target host is mounted. This is the important part of
    // the single-instance guarantee: changing the scope and the session route
    // in the same batch can leave two legacy route branches alive briefly.
    const next = props.onActivate(host);
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
    let completed = false;
    try {
      completed = await transition;
    } catch {
      if (!disposed && switchSequence === sequence) {
        setSwitchErrors((current) => ({
          ...current,
          [host.hostId]: "工作区切换失败，请重试",
        }));
        setSwitching(null);
      }
      return false;
    } finally {
      if (transitionPromise === transition) transitionPromise = null;
    }
    if (!completed || disposed || switchSequence !== sequence) return false;
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
      dialog.close();
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

  const currentHost = () =>
    props.hosts.find((host) => host.hostId === renderedHostId()) ??
    props.hosts[0];
  const currentView = () => {
    const host = currentHost();
    return host ? modelFor(host) : undefined;
  };
  const currentStatusTone = () => {
    const host = currentHost();
    const view = currentView();
    if (!host || !hostIsAvailable(host) || view?.rootStatus === "failed")
      return "bg-icon-critical-base";
    if (view?.rootStatus === "loading" || view?.rootStatus === "retrying")
      return "bg-icon-warning-base";
    return "bg-icon-success-base";
  };
  const openManagement = () => {
    if (managementOpen() || disposed) return;
    setError(null);
    setManagementOpen(true);
    dialog.show(
      () => (
        <WorkspaceManagementDialog
          hosts={props.hosts}
          selectedHostId={() => renderedHostId()}
          modelFor={modelFor}
          busyAction={busyAction}
          switching={switching}
          switchErrors={switchErrors}
          pairing={pairing}
          error={error}
          onClose={() => setManagementOpen(false)}
          onSwitch={(host) => void switchHost(host)}
          onOpenSession={openSession}
          onRetryWorkspaceRoot={retryWorkspaceRoot}
          onRefresh={props.onRefresh}
          onIssue={issue}
        />
      ),
      () => setManagementOpen(false),
    );
  };

  return (
    <TitlebarRightMount>
      <Show when={currentHost()}>
        {(host) => (
          <div
            data-aialra-workspace-control
            data-active-host={host().hostId}
            class="flex min-w-0 items-center"
          >
            <Button
              type="button"
              size="small"
              variant="ghost"
              data-aialra-action="manage-workspaces"
              aria-haspopup="dialog"
              aria-expanded={managementOpen()}
              aria-label={`工作区 ${host().displayName}，${hostStateLabel(host())}`}
              title={`${host().displayName} · ${hostStateLabel(host())} · ${rootStatusLabel(currentView()?.rootStatus ?? "idle")}`}
              class="max-w-[min(30vw,13rem)] min-w-0 gap-1.5 px-1.5"
              onClick={openManagement}
            >
              <span
                data-aialra-workspace-status
                data-aialra-workspace-status-state={currentView()?.rootStatus}
                aria-hidden="true"
                class={`size-1.5 shrink-0 rounded-full ${currentStatusTone()}`}
              />
              <span class="hidden min-w-0 truncate text-12-regular sm:inline">
                {host().displayName}
              </span>
              <Icon name="chevron-down" size="small" />
            </Button>
          </div>
        )}
      </Show>
    </TitlebarRightMount>
  );
}

interface WorkspaceManagementDialogProps {
  hosts: HostDescriptor[];
  selectedHostId: Accessor<string>;
  modelFor(host: HostDescriptor): HostViewModel;
  busyAction: Accessor<string | null>;
  switching: Accessor<string | null>;
  switchErrors: Accessor<Record<string, string | undefined>>;
  pairing: Accessor<PairingCode | null>;
  error: Accessor<string | null>;
  onClose(): void;
  onSwitch(host: HostDescriptor): void;
  onOpenSession(host: HostDescriptor): void;
  onRetryWorkspaceRoot(host: HostDescriptor): void;
  onRefresh(): void;
  onIssue(mode: "vps" | "remote"): void;
}

function WorkspaceManagementDialog(props: WorkspaceManagementDialogProps) {
  const dialog = useDialog();
  const close = () => {
    dialog.close();
    props.onClose();
  };

  return (
    <div data-aialra-workspace-management>
      <Dialog
        title="管理工作区"
        description="查看主机状态、版本和工作区边界，或登记新的 Agent"
        size="large"
        class="w-full max-w-lg"
        action={
          <Button
            type="button"
            size="small"
            variant="ghost"
            aria-label="关闭工作区管理"
            onClick={close}
          >
            <Icon name="close" size="small" />
          </Button>
        }
      >
        <div class="max-h-[min(620px,calc(100vh-10rem))] overflow-y-auto">
          <div class="flex flex-col gap-2">
            <For each={props.hosts}>
              {(host) => {
                const view = () => props.modelFor(host);
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
                    <div class="mt-3 flex items-center gap-2">
                      <Button
                        type="button"
                        size="small"
                        variant={
                          props.selectedHostId() === host.hostId
                            ? "ghost"
                            : "secondary"
                        }
                        data-aialra-action="select-workspace"
                        data-host-id={host.hostId}
                        disabled={
                          props.selectedHostId() === host.hostId ||
                          !hostIsAvailable(host) ||
                          props.switching() === host.hostId
                        }
                        aria-busy={props.switching() === host.hostId}
                        onClick={() => props.onSwitch(host)}
                      >
                        {props.selectedHostId() === host.hostId
                          ? "当前工作区"
                          : `切换到 ${host.displayName}`}
                      </Button>
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
                          props.busyAction() !== null ||
                          props.switching() !== null
                        }
                        aria-busy={props.busyAction() === `new-${host.hostId}`}
                        onClick={() => props.onOpenSession(host)}
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
                            props.busyAction() !== null
                          }
                          aria-busy={
                            props.busyAction() === `root-${host.hostId}`
                          }
                          onClick={() => props.onRetryWorkspaceRoot(host)}
                        >
                          重试工作目录
                        </Button>
                      </Show>
                    </div>
                    <Show when={props.switchErrors()[host.hostId]}>
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
              disabled={props.busyAction() !== null}
              aria-busy={props.busyAction() === "refresh"}
              onClick={() => props.onRefresh()}
            >
              刷新状态
            </Button>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={props.busyAction() !== null}
              aria-busy={props.busyAction() === "pair-vps"}
              onClick={() => props.onIssue("vps")}
            >
              登记 VPS
            </Button>
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={props.busyAction() !== null}
              aria-busy={props.busyAction() === "pair-remote"}
              onClick={() => props.onIssue("remote")}
            >
              登记 Windows
            </Button>
          </div>
          <Show when={props.pairing()}>
            {(value) => (
              <div
                aria-live="polite"
                class="mt-3 rounded-md border border-border-weaker-base p-3"
              >
                <div class="text-11-regular text-text-weak">一次性登记码</div>
                <code class="text-14-medium tracking-widest text-text-strong">
                  {value().code}
                </code>
                <div class="mt-1 text-11-regular text-text-weak">
                  10 分钟内有效，使用后立即失效
                </div>
              </div>
            )}
          </Show>
          <Show when={props.error()}>
            <p
              role="alert"
              class="mt-2 text-11-regular text-icon-critical-base"
            >
              {props.error()}
            </p>
          </Show>
        </div>
      </Dialog>
    </div>
  );
}
