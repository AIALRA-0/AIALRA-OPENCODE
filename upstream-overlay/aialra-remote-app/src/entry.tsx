import "@opencode-ai/app/index.css";
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useServer,
  useTabs,
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

const DEFAULT_SERVER_KEY = "aialra-opencode.default-host";
const HOST_ROUTE_KEY = "aialra-opencode.host-route";
const SETTINGS_KEY = "settings.v3";
const CLASSIC_LAYOUT_DEFAULT_APPLIED =
  "aialra-classic-layout-default-applied-v1";

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

function encodeRouteDirectory(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function defaultWorkspaceRoute(root: string | undefined): string {
  return root ? `/${encodeRouteDirectory(root)}/session` : "/";
}

function routeBelongsToHost(route: string, hostId: string): boolean {
  const match = route.match(/^\/server\/([^/]+)(?:\/|$)/u);
  if (!match) return route === "/" || route.startsWith("/new-session");
  return decodeRouteServerKey(match[1]!) === virtualOrigin(hostId);
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

function ensureClassicLayoutDefault(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ general: { newLayoutDesigns: false } }),
      );
      localStorage.setItem(CLASSIC_LAYOUT_DEFAULT_APPLIED, "1");
      return;
    }
    const value = JSON.parse(raw) as {
      general?: { newLayoutDesigns?: unknown };
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (!value.general || typeof value.general !== "object") value.general = {};
    if (typeof value.general.newLayoutDesigns === "boolean") return;
    value.general.newLayoutDesigns = false;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    localStorage.setItem(CLASSIC_LAYOUT_DEFAULT_APPLIED, "1");
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
}) {
  const server = useServer();
  const processed = new Map<string, string>();
  createEffect(() => {
    const roots = props.workspaceRoots();
    for (const host of props.hosts) {
      const root = roots[host.hostId];
      if (!root) continue;
      const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
      const projects = server.projects.forServer(key);
      const previous = processed.get(host.hostId);
      if (
        previous === root &&
        projects.list().some((project) => project.worktree === root)
      )
        continue;
      for (const project of projects.list()) {
        if (!withinWorkspace(root, project.worktree))
          projects.remove(project.worktree);
      }
      if (!projects.list().some((project) => project.worktree === root))
        projects.open(root);
      projects.touch(root);
      processed.set(host.hostId, root);
    }
  });
  return null;
}

function NewSessionFallback(props: {
  hosts: HostDescriptor[];
  selectedHostId: Accessor<string>;
  ensureWorkspaceRoot(host: HostDescriptor): Promise<string | undefined>;
}) {
  const server = useServer();
  const tabs = useTabs();
  const opening = new Set<string>();

  const openWorkspaceDraft = async (
    host: HostDescriptor,
    button: HTMLButtonElement,
  ) => {
    if (opening.has(host.hostId)) return;
    opening.add(host.hostId);
    const previousBusy = button.getAttribute("aria-busy");
    button.setAttribute("aria-busy", "true");
    try {
      const root = await props.ensureWorkspaceRoot(host);
      const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
      const projects = server.projects.forServer(key);
      if (!root) return;
      for (const project of projects.list()) {
        if (!withinWorkspace(root, project.worktree))
          projects.remove(project.worktree);
      }
      if (!projects.list().some((project) => project.worktree === root))
        projects.open(root);
      projects.touch(root);
      // The official tab store can accept a draft before its persisted
      // hydration flag flips. Calling it immediately keeps the button and
      // route responsive; hydration will reconcile the tab state afterwards.
      // A rejected draft is intentionally swallowed here because the normal
      // App error surface will expose a retryable state without blocking the
      // click task.
      try {
        const draft = (await tabs.newDraft(
          { server: key, directory: root },
          "",
        )) as { draftID?: unknown } | undefined;
        // The official tab store can finish its transition on a later frame
        // and another delegated home handler can briefly restore "/".  Keep
        // the newly created draft usable in both cases by retrying the route
        // handoff for a short, bounded window; no remote request is repeated
        // and an already changed route is never overwritten
        const routeDraft = () => {
          if (location.pathname !== "/") return;
          const fromResult =
            typeof draft?.draftID === "string" ? draft.draftID : undefined;
          const links = document.querySelectorAll<HTMLAnchorElement>(
            'a[href^="/new-session?draftId="]',
          );
          const latest = links.item(links.length - 1)?.href;
          const draftID =
            fromResult ??
            (latest
              ? new URL(latest, location.href).searchParams.get("draftId")
              : null);
          if (!draftID) return;
          history.pushState(
            null,
            "",
            `/new-session?draftId=${encodeURIComponent(draftID)}`,
          );
          window.dispatchEvent(new PopStateEvent("popstate"));
        };
        queueMicrotask(routeDraft);
        window.setTimeout(routeDraft, 80);
        window.setTimeout(routeDraft, 240);
      } catch {
        // The normal App error surface remains responsible for retryable
        // failures; the click handler must never leave an unhandled rejection
      }
    } finally {
      opening.delete(host.hostId);
      if (previousBusy === null) button.removeAttribute("aria-busy");
      else button.setAttribute("aria-busy", previousBusy);
    }
  };

  onMount(() => {
    const onClick = (event: MouseEvent) => {
      if (location.pathname !== "/") return;
      const target = event.target;
      const button =
        target instanceof Element ? target.closest("button") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      if (button.closest("[data-aialra-sidebar-hosts]")) return;
      const isNewSession =
        button.dataset.action === "home-new-session" ||
        button.dataset.action === "home-project-new-session" ||
        button.matches(
          'button[aria-label="新建会话"], button[aria-label="New session"]',
        );
      if (!isNewSession) return;

      const host = props.hosts.find(
        (candidate) => candidate.hostId === props.selectedHostId(),
      );
      if (!host || !isAvailable(host)) return;

      const key = ServerConnection.Key.make(virtualOrigin(host.hostId));
      // Let the official handler own the normal path once the workspace root
      // has been hydrated. The fallback is only for the transient empty-store
      // window during first load, and never intercepts a populated workspace.
      if (server.projects.forServer(key).list().length > 0) return;

      // The official titlebar intentionally does nothing when its project store
      // is still empty during the first metadata round trip. Intercept home
      // actions consistently so stale persisted project entries cannot make the
      // official handler silently return without a draft.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void openWorkspaceDraft(host, button);
    };

    // Window capture runs before the official App's delegated document
    // handler, so an empty project store cannot swallow this user action
    window.addEventListener("click", onClick, true);
    onCleanup(() => window.removeEventListener("click", onClick, true));
  });

  return null;
}

async function start(): Promise<void> {
  const hosts = await bootstrap();
  const available = hosts.filter(isAvailable);
  if (!available.length) {
    const root = document.getElementById("root");
    if (!(root instanceof HTMLElement))
      throw new Error("application root is missing");
    render(() => <BootstrapPanel hosts={hosts} />, root);
    return;
  }

  const relay = new BrowserRelay();
  const hostIds = available.map((host) => host.hostId);
  installRemoteWebSocket(relay, hostIds);
  const remoteFetch = createRemoteFetch(relay, hostIds);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const candidate = input instanceof Request ? input.url : String(input);
    const url = new URL(candidate, location.href);
    if (url.hostname.endsWith(".aialra.invalid"))
      return remoteFetch(input, init);
    if (url.origin === location.origin) return nativeFetch(input, init);
    return Promise.reject(new TypeError("unregistered network destination"));
  }) as typeof fetch;

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
  let routeSyncScheduled = false;

  const selectHost = (host: HostDescriptor) => {
    if (!isAvailable(host) || host.hostId === selected().hostId) return;
    const current = selected();
    routes[current.hostId] = routeBelongsToHost(
      safeRoute(`${location.pathname}${location.search}${location.hash}`),
      current.hostId,
    )
      ? safeRoute(`${location.pathname}${location.search}${location.hash}`)
      : "/";
    localStorage.setItem(HOST_ROUTE_KEY, JSON.stringify(routes));
    localStorage.setItem(DEFAULT_SERVER_KEY, host.hostId);
    setSelected(host);
  };

  const activateHost = (host: HostDescriptor) => {
    const saved = routes[host.hostId];
    const next =
      saved && saved !== "/" && routeBelongsToHost(saved, host.hostId)
        ? saved
        : defaultWorkspaceRoute(workspaceRoots()[host.hostId]);
    history.replaceState(null, "", next);
    if (!routeSyncScheduled) {
      routeSyncScheduled = true;
      setTimeout(() => {
        routeSyncScheduled = false;
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, 0);
    }
    mark("aialra-host-switch-state");
  };

  const workspaceRootLoads = new Map<string, Promise<string | undefined>>();
  const loadWorkspaceRoot = (host: HostDescriptor) => {
    const existing = workspaceRootLoads.get(host.hostId);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const response = await remoteFetch(
          new URL("/path", virtualOrigin(host.hostId)),
        );
        if (!response.ok) return undefined;
        const value = (await response.json()) as { directory?: unknown };
        const directory = value.directory;
        if (typeof directory !== "string" || !directory) return undefined;
        setWorkspaceRoots((current) => ({
          ...current,
          [host.hostId]: directory,
        }));
        return directory;
      } catch {
        // The official App will expose the host state and retry its own metadata
        return undefined;
      }
    })();
    workspaceRootLoads.set(host.hostId, pending);
    void pending.then((directory) => {
      if (
        directory === undefined &&
        workspaceRootLoads.get(host.hostId) === pending
      )
        workspaceRootLoads.delete(host.hostId);
    });
    return pending;
  };

  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement))
    throw new Error("application root is missing");
  // The classic shell is the wrapper default only when the user has not
  // already saved an explicit layout choice. This runs before AppInterface so
  // the first paint does not briefly mount the new shell and then remount it.
  ensureClassicLayoutDefault();
  render(
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
              ensureWorkspaceRoot={loadWorkspaceRoot}
              onSelect={selectHost}
              onActivate={activateHost}
              onRefresh={() => location.reload()}
            />
            <HostWorkspaceBootstrap
              hosts={available}
              workspaceRoots={workspaceRoots}
            />
            <NewSessionFallback
              hosts={available}
              selectedHostId={() => selected().hostId}
              ensureWorkspaceRoot={loadWorkspaceRoot}
            />
            <RequestStatusSurface remoteFetch={remoteFetch} />
          </AppInterface>
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  );

  mark("aialra-app-first-render");
  void remoteFetch.prewarm(hostIds);
  void Promise.allSettled(available.map(loadWorkspaceRoot));
}

void start().catch((error) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent =
      error instanceof Error
        ? error.message
        : "AIALRA OpenCode failed to start";
});
