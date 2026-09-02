import "@opencode-ai/app/index.css";
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useServer,
  type Platform,
} from "@opencode-ai/app";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import { Button } from "@opencode-ai/ui/button";
import { render } from "solid-js/web";
import {
  bootstrap,
  createPairingCode,
  type HostDescriptor,
  type PairingCode,
} from "./api";
import { BrowserRelay } from "./relay";
import { createRemoteFetch, virtualOrigin } from "./remote-fetch";
import { installRemoteWebSocket } from "./remote-websocket";
import {
  ClassicLayoutPreference,
  HostSidebar,
  SidebarLayoutBridge,
} from "./sidebar-hosts";
import { RequestStatusSurface } from "./request-status";
import {
  workspaceSessionRoute,
  type WorkspaceRootResult,
  type WorkspaceRootState,
  type WorkspaceStateByHost,
} from "./workspace-state";
import { claimApplicationRoot, markApplicationRoot } from "./app-lifecycle";
import { RemoteFetchError, type RemoteErrorCategory } from "./action-state";

const DEFAULT_SERVER_KEY = "aialra-opencode.default-host";
const HOST_ROUTE_KEY = "aialra-opencode.host-route";
const SETTINGS_KEY = "settings.v3";
const CLASSIC_LAYOUT_ENFORCED = "aialra-classic-layout-enforced-v1";
// A successful /path response is the host's stable workspace boundary. Keep
// it warm for normal navigation and rapid host switching; explicit retry
// actions bypass this TTL and force a fresh verification.
const ROOT_VERIFICATION_TTL_MS = 120_000;

function isAvailable(host: HostDescriptor): boolean {
  return host.state === "online" || host.state === "degraded";
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // Performance marks are best-effort and never block a user action
  }
}

function safeRoute(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return "/";
  try {
    const url = new URL(value, location.origin);
    if (
      url.origin !== location.origin ||
      url.hostname.endsWith(".aialra.invalid")
    )
      return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function decodeRouteServerKey(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (value) => value.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function decodeRouteDirectory(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (value) => value.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

function defaultWorkspaceRoute(root: string | undefined): string {
  return root ? workspaceSessionRoute(root) : "/";
}

function routeBelongsToHost(
  route: string,
  hostId: string,
  workspaceRoot?: string,
): boolean {
  const match = route.match(/^\/server\/([^/]+)(?:\/|$)/u);
  if (match) return decodeRouteServerKey(match[1]!) === virtualOrigin(hostId);
  if (route === "/" || route.startsWith("/new-session")) return true;
  if (!workspaceRoot) return false;
  const segment = route.split("/", 3)[1];
  const directory = segment ? decodeRouteDirectory(segment) : null;
  return directory ? withinWorkspace(workspaceRoot, directory) : false;
}

function withinWorkspace(root: string, candidate: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/u, "");
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const windowsPath = /^[A-Za-z]:\//u.test(normalizedRoot);
  const left = windowsPath ? normalizedRoot.toLowerCase() : normalizedRoot;
  const right = windowsPath
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  return right === left || right.startsWith(`${left}/`);
}

function enforceClassicLayout(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ general: { newLayoutDesigns: false } }),
      );
      localStorage.setItem(CLASSIC_LAYOUT_ENFORCED, "1");
      return;
    }
    const value = JSON.parse(raw) as {
      general?: { newLayoutDesigns?: unknown };
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (!value.general || typeof value.general !== "object") value.general = {};
    value.general.newLayoutDesigns = false;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    localStorage.setItem(CLASSIC_LAYOUT_ENFORCED, "1");
  } catch {
    // Storage is optional in private browsing and should never block startup
  }
}

function BootstrapPanel(props: { hosts: HostDescriptor[] }) {
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const issue = async (displayName: string, mode: "vps" | "remote") => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    setPairing(null);
    try {
      setPairing(await createPairingCode(displayName, mode));
    } catch {
      setError("Unable to create a one-time enrollment code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      style={{
        "max-width": "42rem",
        margin: "10vh auto",
        padding: "2rem",
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        color: "CanvasText",
      }}
    >
      <h1 style={{ "font-size": "1.5rem", "margin-bottom": "0.5rem" }}>
        连接 OpenCode 主机
      </h1>
      <p style={{ color: "GrayText", "margin-bottom": "1.5rem" }}>
        当前没有兼容的在线主机，请生成一次性登记码并在目标 Agent 上使用
      </p>
      <div style={{ display: "flex", gap: "0.75rem", "flex-wrap": "wrap" }}>
        <Button
          type="button"
          variant="secondary"
          size="large"
          disabled={busy()}
          aria-busy={busy()}
          onClick={() => void issue("AIALRA VPS", "vps")}
        >
          登记 VPS
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="large"
          disabled={busy()}
          aria-busy={busy()}
          onClick={() => void issue("AIALRA Windows", "remote")}
        >
          登记 Windows
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="large"
          disabled={busy()}
          aria-busy={busy()}
          onClick={() => location.reload()}
        >
          刷新主机
        </Button>
      </div>
      <Show when={pairing()}>
        {(value) => (
          <section
            aria-live="polite"
            style={{
              margin: "1.5rem 0",
              padding: "1rem",
              border: "1px solid GrayText",
              "border-radius": "0.5rem",
            }}
          >
            <p style={{ margin: "0 0 0.5rem" }}>一次性登记码</p>
            <code style={{ "font-size": "1.4rem", "letter-spacing": "0.08em" }}>
              {value().code}
            </code>
            <p style={{ color: "GrayText", "font-size": "0.875rem" }}>
              10 分钟内有效，使用后立即失效
            </p>
          </section>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={props.hosts.length > 0}>
        <h2 style={{ "font-size": "1rem", "margin-top": "2rem" }}>
          已登记主机
        </h2>
        <ul>
          <For each={props.hosts}>
            {(host) => (
              <li>
                {host.displayName} · {host.platform} · {host.state}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </main>
  );
}

function HostWorkspaceBootstrap(props: {
  hosts: HostDescriptor[];
  workspaceRoots: Accessor<Record<string, string>>;
  selectedHostId: Accessor<string>;
}) {
  const server = useServer();
  const processed = new Map<string, string>();
  createEffect(() => {
    const roots = props.workspaceRoots();
    const host = props.hosts.find(
      (candidate) => candidate.hostId === props.selectedHostId(),
    );
    if (!host) return;
    const root = roots[host.hostId];
    if (!root) return;
    const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
    const projects = server.projects.forServer(key);
    const previous = processed.get(host.hostId);
    if (
      previous === root &&
      projects.list().some((project) => project.worktree === root)
    )
      return;
    for (const project of projects.list()) {
      if (!withinWorkspace(root, project.worktree))
        projects.remove(project.worktree);
    }
    if (!projects.list().some((project) => project.worktree === root))
      projects.open(root);
    projects.touch(root);
    processed.set(host.hostId, root);
  });
  return null;
}

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement))
    throw new Error("application root is missing");
  if (!claimApplicationRoot(root)) return;

  // Apply the wrapper policy before any asynchronous bootstrap work. This
  // prevents a persisted V2 preference from winning the first render race.
  enforceClassicLayout();
  const hosts = await bootstrap();
  const available = hosts.filter(isAvailable);
  if (!available.length) {
    render(() => <BootstrapPanel hosts={hosts} />, root);
    markApplicationRoot(root, "running");
    return;
  }

  const relay = new BrowserRelay();
  const hostIds = available.map((host) => host.hostId);
  const restoreRemoteWebSocket = installRemoteWebSocket(relay, hostIds);
  const remoteFetch = createRemoteFetch(relay, hostIds);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const candidate = input instanceof Request ? input.url : String(input);
    const url = new URL(candidate, location.href);
    if (url.hostname.endsWith(".aialra.invalid"))
      return remoteFetch(input, init);
    if (url.origin === location.origin) return nativeFetch(input, init);
    return Promise.reject(new TypeError("unregistered network destination"));
  }) as typeof fetch;
  globalThis.fetch = wrappedFetch;

  const serverFor = (host: HostDescriptor) => ({
    type: "http" as const,
    displayName: host.displayName,
    label: host.mode === "vps" ? "VPS 工作区" : "远程工作区",
    http: { url: virtualOrigin(host.hostId) },
  });
  const serverConfigs = available.map(serverFor);
  const stored = localStorage.getItem(DEFAULT_SERVER_KEY);
  const initial =
    available.find((host) => host.hostId === stored) ??
    available.find((host) => virtualOrigin(host.hostId) === stored) ??
    available.find((host) => host.mode === "vps") ??
    available[0]!;
  const [selected, setSelected] = createSignal(initial);
  const [workspaceRoots, setWorkspaceRoots] = createSignal<
    Record<string, string>
  >({});
  const [workspaceStates, setWorkspaceStates] =
    createSignal<WorkspaceStateByHost>(
      Object.fromEntries(
        available.map((host) => [
          host.hostId,
          {
            rootStatus: "idle" as const,
            rootState: {
              phase: "idle" as const,
              generation: 0,
            } satisfies WorkspaceRootState,
            expanded: host.hostId === initial.hostId,
          },
        ]),
      ),
    );
  const updateWorkspaceState = (
    hostId: string,
    patch: Partial<WorkspaceStateByHost[string]>,
  ) => {
    setWorkspaceStates((current) => ({
      ...current,
      [hostId]: {
        rootStatus: current[hostId]?.rootStatus ?? "idle",
        expanded: current[hostId]?.expanded ?? false,
        ...current[hostId],
        ...patch,
      },
    }));
  };
  const routes = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(HOST_ROUTE_KEY) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(
            ([hostId, route]) =>
              hostIds.includes(hostId) && typeof route === "string",
          )
          .map(([hostId, route]) => [hostId, safeRoute(route)]),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const selectHost = (host: HostDescriptor) => {
    if (!isAvailable(host) || host.hostId === selected().hostId) return;
    const current = selected();
    const currentRoute = safeRoute(
      `${location.pathname}${location.search}${location.hash}`,
    );
    routes[current.hostId] = routeBelongsToHost(
      currentRoute,
      current.hostId,
      workspaceRoots()[current.hostId],
    )
      ? currentRoute
      : "/";
    updateWorkspaceState(current.hostId, {
      lastRoute: routes[current.hostId],
    });
    localStorage.setItem(HOST_ROUTE_KEY, JSON.stringify(routes));
    localStorage.setItem(DEFAULT_SERVER_KEY, host.hostId);
    setSelected(host);
  };

  const activateHost = (host: HostDescriptor): string => {
    const root = workspaceRoots()[host.hostId];
    const saved = routes[host.hostId];
    const next =
      saved && saved !== "/" && routeBelongsToHost(saved, host.hostId, root)
        ? saved
        : defaultWorkspaceRoute(root);
    updateWorkspaceState(host.hostId, {
      expanded: true,
      lastRoute: next,
    });
    mark("aialra-host-switch-state");
    return next;
  };

  const workspaceRootLoads = new Map<string, Promise<WorkspaceRootResult>>();
  const rootGeneration = new Map<string, number>();
  const categoryForRootFailure = (
    cause: unknown,
    response?: Response,
  ): RemoteErrorCategory => {
    if (cause instanceof RemoteFetchError) return cause.category;
    if (response?.status === 401) return "authentication_failure";
    if (response?.status === 403) return "boundary_rejected";
    return "upstream_timeout";
  };
  const loadWorkspaceRoot = (
    host: HostDescriptor,
    options: { force?: boolean } = {},
  ): Promise<WorkspaceRootResult> => {
    const known = workspaceStates()[host.hostId]?.rootState;
    const knownRoot = known?.root ?? workspaceRoots()[host.hostId];
    if (
      !options.force &&
      known?.phase === "ready" &&
      knownRoot &&
      known.verifiedAt !== undefined &&
      Date.now() - known.verifiedAt <= ROOT_VERIFICATION_TTL_MS
    ) {
      return Promise.resolve({
        ok: true as const,
        hostId: host.hostId,
        directory: knownRoot,
        verifiedAt: known.verifiedAt,
      });
    }
    const existing = workspaceRootLoads.get(host.hostId);
    if (existing) return existing;
    const generation = (rootGeneration.get(host.hostId) ?? 0) + 1;
    rootGeneration.set(host.hostId, generation);
    const previous = workspaceStates()[host.hostId]?.rootState;
    updateWorkspaceState(host.hostId, {
      rootStatus: "loading",
      rootState: {
        phase: "loading",
        root: previous?.root ?? workspaceRoots()[host.hostId],
        generation,
      },
    });
    const pending = (async () => {
      let lastFailure: Extract<WorkspaceRootResult, { ok: false }> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let response: Response | undefined;
        try {
          response = await remoteFetch(
            new URL("/path", virtualOrigin(host.hostId)),
          );
          if (!response.ok) {
            const category = categoryForRootFailure(undefined, response);
            lastFailure = {
              ok: false,
              hostId: host.hostId,
              category,
              retryable: response.status >= 500,
            };
          } else {
            const value = (await response.json()) as { directory?: unknown };
            const directory = value.directory;
            if (typeof directory !== "string" || !directory) {
              lastFailure = {
                ok: false,
                hostId: host.hostId,
                category: "upstream_timeout",
                retryable: true,
              };
            } else {
              const verifiedAt = Date.now();
              if (rootGeneration.get(host.hostId) !== generation)
                return {
                  ok: false as const,
                  hostId: host.hostId,
                  category: "cancelled" as const,
                  retryable: false,
                };
              setWorkspaceRoots((current) => ({
                ...current,
                [host.hostId]: directory,
              }));
              updateWorkspaceState(host.hostId, {
                root: directory,
                rootStatus: "ready",
                rootState: {
                  phase: "ready",
                  root: directory,
                  verifiedAt,
                  generation,
                },
              });
              return {
                ok: true as const,
                hostId: host.hostId,
                directory,
                verifiedAt,
              };
            }
          }
        } catch (cause) {
          const category = categoryForRootFailure(cause, response);
          const retryable =
            category === "channel_acquire_timeout" ||
            category === "upstream_timeout";
          lastFailure = {
            ok: false,
            hostId: host.hostId,
            category,
            retryable,
            requestId:
              cause instanceof RemoteFetchError ? cause.requestId : undefined,
          };
        }
        if (!lastFailure || !lastFailure.retryable || attempt === 2) break;
        if (rootGeneration.get(host.hostId) === generation)
          updateWorkspaceState(host.hostId, {
            rootStatus: "retrying",
            rootState: {
              phase: "retrying",
              root: previous?.root ?? workspaceRoots()[host.hostId],
              generation,
              errorCategory: lastFailure.category,
              retryable: true,
            },
          });
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, attempt === 0 ? 150 : 400),
        );
      }
      const failure: Extract<WorkspaceRootResult, { ok: false }> =
        lastFailure ?? {
          ok: false as const,
          hostId: host.hostId,
          category: "upstream_timeout" as const,
          retryable: true,
        };
      if (rootGeneration.get(host.hostId) === generation)
        updateWorkspaceState(host.hostId, {
          rootStatus: "failed",
          rootState: {
            phase: "failed",
            root: previous?.root ?? workspaceRoots()[host.hostId],
            generation,
            errorCategory: failure.category,
            retryable: failure.retryable,
          },
        });
      return failure;
    })();
    workspaceRootLoads.set(host.hostId, pending);
    void pending.then(
      () => {
        if (workspaceRootLoads.get(host.hostId) === pending)
          workspaceRootLoads.delete(host.hostId);
      },
      () => {
        if (workspaceRootLoads.get(host.hostId) === pending)
          workspaceRootLoads.delete(host.hostId);
      },
    );
    return pending;
  };

  let disposeRender: (() => void) | undefined;
  const disposeRuntime = () => {
    disposeRender?.();
    disposeRender = undefined;
    remoteFetch.dispose();
    restoreRemoteWebSocket();
    relay.dispose();
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = nativeFetch;
  };
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) disposeRuntime();
  };
  window.addEventListener("pagehide", onPageHide, { once: true });

  try {
    disposeRender = render(
      () => (
        <PlatformProvider
          value={
            {
              platform: "web",
              version: "remote-0.1.0",
              openExternal(value) {
                if (!URL.canParse(value)) return;
                const url = new URL(value);
                if (!["http:", "https:", "mailto:"].includes(url.protocol))
                  return;
                if (url.hostname.endsWith(".aialra.invalid")) return;
                window.open(url.href, "_blank", "noopener,noreferrer");
              },
              async restart() {
                location.reload();
              },
              async notify(title, description, onClick) {
                if (
                  !("Notification" in window) ||
                  Notification.permission !== "granted"
                )
                  return;
                const notification = new Notification(title, {
                  body: description,
                });
                notification.onclick = () => {
                  window.focus();
                  onClick?.();
                  notification.close();
                };
              },
              fetch: remoteFetch,
              getDefaultServer: async () =>
                ServerConnection.Key.make(virtualOrigin(selected().hostId)),
              setDefaultServer(value) {
                if (value === null) {
                  localStorage.removeItem(DEFAULT_SERVER_KEY);
                  return;
                }
                const host = available.find(
                  (candidate) => virtualOrigin(candidate.hostId) === value,
                );
                if (host) localStorage.setItem(DEFAULT_SERVER_KEY, host.hostId);
              },
            } satisfies Platform
          }
        >
          <AppBaseProviders>
            <AppInterface
              defaultServer={ServerConnection.Key.make(
                virtualOrigin(initial.hostId),
              )}
              servers={serverConfigs}
              // The relay can briefly report a host as online before its local
              // agent channel is ready; the official blocking health gate would
              // hide the sidebar and make the whole page look inert. Let the
              // application render immediately and let request-level status
              // surfaces report host readiness instead.
              disableHealthCheck
              serverScoped={<SidebarLayoutBridge />}
            >
              <ClassicLayoutPreference />
              <HostSidebar
                hosts={hosts}
                selectedHostId={() => selected().hostId}
                workspaceRoots={workspaceRoots}
                workspaceStates={workspaceStates}
                ensureWorkspaceRoot={loadWorkspaceRoot}
                onSelect={selectHost}
                onActivate={activateHost}
                onRefresh={() => location.reload()}
              />
              <HostWorkspaceBootstrap
                hosts={available}
                workspaceRoots={workspaceRoots}
                selectedHostId={() => selected().hostId}
              />
              <RequestStatusSurface remoteFetch={remoteFetch} />
            </AppInterface>
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    );
  } catch (error) {
    window.removeEventListener("pagehide", onPageHide);
    disposeRuntime();
    throw error;
  }

  markApplicationRoot(root, "running");

  mark("aialra-app-first-render");
  // Keep first paint and the selected host independent from inactive-host
  // metadata. Warm the active channels immediately, then hydrate other hosts
  // one at a time after the official sidebar has rendered.
  void remoteFetch.prewarm([initial.hostId]);
  void loadWorkspaceRoot(initial);
  const inactive = available.filter((host) => host.hostId !== initial.hostId);
  window.setTimeout(() => {
    void (async () => {
      for (const host of inactive) await remoteFetch.prewarm([host.hostId]);
    })();
  }, 1_000);
}

void start().catch((error) => {
  const root = document.getElementById("root");
  if (root) {
    markApplicationRoot(root, "failed");
    root.textContent =
      error instanceof Error
        ? error.message
        : "AIALRA OpenCode failed to start";
  }
});
