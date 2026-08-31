import "@opencode-ai/app/index.css";
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useServer,
  type Platform,
} from "@opencode-ai/app";
import { For, Show, createSignal } from "solid-js";
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

const DEFAULT_SERVER_KEY = "aialra-opencode.default-host";
const HOST_ROUTE_KEY = "aialra-opencode.host-route";

function BootstrapPanel(props: { hosts: HostDescriptor[] }) {
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const issue = async (displayName: string, mode: "vps" | "remote") => {
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
        <button
          disabled={busy()}
          onClick={() => void issue("AIALRA VPS", "vps")}
        >
          登记 VPS
        </button>
        <button
          disabled={busy()}
          onClick={() => void issue("AIALRA Windows", "remote")}
        >
          登记 Windows
        </button>
        <button disabled={busy()} onClick={() => location.reload()}>
          刷新主机
        </button>
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

function HostManager(props: {
  hosts: HostDescriptor[];
  selected: HostDescriptor;
  onSelect(host: HostDescriptor): void;
}) {
  const [open, setOpen] = createSignal(false);
  const [pairing, setPairing] = createSignal<PairingCode | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const issue = async (displayName: string, mode: "vps" | "remote") => {
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

  const workspaceName = (host: HostDescriptor) =>
    host.mode === "vps" ? "VPS 工作区" : "远程工作区";
  const modeName = (host: HostDescriptor) =>
    host.mode === "vps" ? "VPS" : "远程";

  return (
    <header
      style={{
        position: "fixed",
        top: "0.45rem",
        left: "50%",
        transform: "translateX(-50%)",
        "z-index": 2147483000,
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        display: "flex",
        gap: "0.45rem",
        "align-items": "center",
      }}
    >
      <nav
        aria-label="执行工作区"
        style={{
          display: "flex",
          gap: "0.25rem",
          padding: "0.2rem",
          background: "Canvas",
          border: "1px solid GrayText",
          "border-radius": "0.55rem",
          "box-shadow": "0 0.25rem 0.8rem rgb(0 0 0 / 0.2)",
        }}
      >
        <For each={props.hosts}>
          {(host) => (
            <button
              type="button"
              aria-pressed={host.hostId === props.selected.hostId}
              disabled={host.state !== "online" && host.state !== "degraded"}
              onClick={() => props.onSelect(host)}
              style={{
                padding: "0.38rem 0.65rem",
                border: "0",
                "border-radius": "0.38rem",
                background:
                  host.hostId === props.selected.hostId
                    ? "Highlight"
                    : "transparent",
                color:
                  host.hostId === props.selected.hostId
                    ? "HighlightText"
                    : "CanvasText",
                cursor: "pointer",
              }}
            >
              {workspaceName(host)} ·{" "}
              {host.state === "online" ? "在线" : host.state}
            </button>
          )}
        </For>
      </nav>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        主机管理
      </button>
      <Show when={open()}>
        <section
          role="dialog"
          aria-label="主机管理"
          style={{
            width: "min(24rem, calc(100vw - 2rem))",
            position: "absolute",
            top: "2.65rem",
            right: "0",
            padding: "1rem",
            background: "Canvas",
            color: "CanvasText",
            border: "1px solid GrayText",
            "border-radius": "0.5rem",
            "box-shadow": "0 0.75rem 2rem rgb(0 0 0 / 0.25)",
          }}
        >
          <h2 style={{ "font-size": "1rem", margin: "0 0 0.75rem" }}>
            OpenCode 主机
          </h2>
          <ul style={{ margin: "0 0 1rem", padding: "0 0 0 1.25rem" }}>
            <For each={props.hosts}>
              {(host) => (
                <li style={{ "margin-bottom": "0.65rem" }}>
                  <strong>{host.displayName}</strong>
                  <div>
                    {modeName(host)} · {host.platform} · {host.state}
                  </div>
                  <div>
                    Agent {host.agentVersion} · OpenCode{" "}
                    {host.opencodeVersion ?? "未知"}
                  </div>
                  <div>
                    工作区：
                    {host.capabilities.includes("workspace-boundary")
                      ? "已隔离"
                      : "待升级"}
                  </div>
                </li>
              )}
            </For>
          </ul>
          <div style={{ display: "flex", gap: "0.5rem", "flex-wrap": "wrap" }}>
            <button
              disabled={busy()}
              onClick={() => void issue("AIALRA VPS", "vps")}
            >
              登记 VPS
            </button>
            <button
              disabled={busy()}
              onClick={() => void issue("AIALRA Windows", "remote")}
            >
              登记 Windows
            </button>
            <button disabled={busy()} onClick={() => location.reload()}>
              刷新
            </button>
          </div>
          <Show when={pairing()}>
            {(value) => (
              <div aria-live="polite" style={{ margin: "1rem 0 0" }}>
                <div>一次性登记码</div>
                <code
                  style={{ "font-size": "1.25rem", "letter-spacing": "0.08em" }}
                >
                  {value().code}
                </code>
                <div style={{ color: "GrayText", "font-size": "0.8rem" }}>
                  10 分钟内有效，使用后立即失效
                </div>
              </div>
            )}
          </Show>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </section>
      </Show>
    </header>
  );
}

function HostWorkspaceBootstrap(props: {
  host: HostDescriptor;
  workspaceRoot: string;
}) {
  const server = useServer();
  if (
    !server.projects
      .list()
      .some((project) => project.worktree === props.workspaceRoot)
  )
    server.projects.open(props.workspaceRoot);
  server.projects.touch(props.workspaceRoot);
  return null;
}

async function start(): Promise<void> {
  const hosts = await bootstrap();
  const available = hosts.filter(
    (host) => host.state === "online" || host.state === "degraded",
  );
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
    if (url.hostname.endsWith(".opencode.invalid"))
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
  const stored = localStorage.getItem(DEFAULT_SERVER_KEY);
  const initial =
    available.find((host) => host.hostId === stored) ??
    available.find((host) => virtualOrigin(host.hostId) === stored) ??
    available.find((host) => host.mode === "vps") ??
    available[0]!;
  const [selected, setSelected] = createSignal(initial);
  const workspaceRoots = new Map<string, string>();
  const routes = (() => {
    try {
      return JSON.parse(localStorage.getItem(HOST_ROUTE_KEY) ?? "{}") as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  })();
  const selectHost = (host: HostDescriptor) => {
    if (host.state !== "online" && host.state !== "degraded") return;
    const current = selected();
    routes[current.hostId] =
      location.pathname + location.search + location.hash;
    localStorage.setItem(HOST_ROUTE_KEY, JSON.stringify(routes));
    localStorage.setItem(DEFAULT_SERVER_KEY, host.hostId);
    setSelected(host);
    history.replaceState(null, "", routes[host.hostId] ?? "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  for (const host of available) {
    const response = await remoteFetch(
      new URL("/path", virtualOrigin(host.hostId)),
    );
    if (!response.ok)
      throw new Error(
        `${host.displayName} workspace path returned ${response.status}`,
      );
    const value = (await response.json()) as { directory?: string };
    if (!value.directory)
      throw new Error(`${host.displayName} workspace path is unavailable`);
    workspaceRoots.set(host.hostId, value.directory);
  }
  const platform: Platform = {
    platform: "web",
    version: "remote-0.1.0",
    openExternal(value) {
      if (!URL.canParse(value)) return;
      const url = new URL(value);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
      if (url.hostname.endsWith(".opencode.invalid")) return;
      window.open(url.href, "_blank", "noopener,noreferrer");
    },
    async restart() {
      location.reload();
    },
    async notify(title, description, onClick) {
      if (!("Notification" in window) || Notification.permission !== "granted")
        return;
      const notification = new Notification(title, { body: description });
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
  };
  const root = document.getElementById("root");
  if (!(root instanceof HTMLElement))
    throw new Error("application root is missing");
  render(
    () => (
      <>
        <HostManager
          hosts={hosts}
          selected={selected()}
          onSelect={selectHost}
        />
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <Show when={selected()} keyed>
              {(host) => {
                const server = serverFor(host);
                return (
                  <AppInterface
                    defaultServer={ServerConnection.Key.make(server.http.url)}
                    servers={[server]}
                    serverScoped={
                      <HostWorkspaceBootstrap
                        host={host}
                        workspaceRoot={workspaceRoots.get(host.hostId)!}
                      />
                    }
                  />
                );
              }}
            </Show>
          </AppBaseProviders>
        </PlatformProvider>
      </>
    ),
    root,
  );
}

void start().catch((error) => {
  const root = document.getElementById("root");
  if (root)
    root.textContent =
      error instanceof Error
        ? error.message
        : "AIALRA OpenCode failed to start";
});
