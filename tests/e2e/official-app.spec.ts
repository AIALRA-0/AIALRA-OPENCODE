import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const repo = resolve(import.meta.dirname, "../..");
const origin = "http://127.0.0.1:8787";

function tsx(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const cli = resolve(repo, "node_modules/tsx/dist/cli.mjs");
  return spawn(process.execPath, [cli, resolve(repo, script)], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function waitForHealth(
  child: ChildProcess,
  targetOrigin = origin,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("control plane exited before becoming healthy");
    try {
      const response = await fetch(`${targetOrigin}/health/ready`);
      if (response.ok) return;
    } catch {
      // The loopback listener is expected to refuse connections during startup
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("control plane did not become healthy");
}

test("creates a one-time enrollment code on a first boot", async ({ page }) => {
  const firstBootOrigin = "http://127.0.0.1:8788";
  const fixture = await mkdtemp(join(tmpdir(), "AIALRA-OPENCODE-first-boot-"));
  let control: ChildProcess | null = null;
  try {
    control = tsx("apps/control-plane/scripts/e2e-server.ts", {
      ...process.env,
      AIALRA_OPENCODE_E2E_ROOT: fixture,
      AIALRA_OPENCODE_E2E_PORT: "8788",
    });
    await waitForHealth(control, firstBootOrigin);
    await page.goto(firstBootOrigin);
    await expect(page.getByRole("button", { name: "登记 VPS" })).toBeVisible();
    await page.getByRole("button", { name: "登记 VPS" }).click();
    await expect(page.getByText("一次性登记码", { exact: true })).toBeVisible();
    await expect(page.locator("code")).toHaveText(
      /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u,
    );
  } finally {
    await stop(control);
    await removeTempTree(fixture);
  }
});

async function waitForLine(child: ChildProcess, marker: string): Promise<void> {
  let output = "";
  const collect = (value: Buffer) => {
    output += value.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (output.includes(marker)) return;
    if (child.exitCode !== null)
      throw new Error(`child exited before ${marker}: ${output.slice(-1_000)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`child did not report ${marker}: ${output.slice(-1_000)}`);
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
  if (child.exitCode === null && child.pid) {
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      await new Promise<void>((resolveExit) =>
        killer.once("exit", () => resolveExit()),
      );
    } else {
      child.kill("SIGKILL");
    }
  }
}

async function removeTempTree(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw lastError;
}

async function expectSingleSessionChrome(
  page: Page,
  options: { session?: boolean } = {},
): Promise<void> {
  const session = options.session ?? true;
  const readCounts = () =>
    page.evaluate(() => ({
      titlebar: document.querySelectorAll("header").length,
      center: document.querySelectorAll("#opencode-titlebar-center").length,
      centerPortals: document.querySelectorAll("#opencode-titlebar-center > *")
        .length,
      search: document.querySelectorAll(
        '#opencode-titlebar-center [aria-label="搜索文件"], #opencode-titlebar-center [aria-label="Search files"]',
      ).length,
      right: document.querySelectorAll("#opencode-titlebar-right").length,
      status: document.querySelectorAll(
        '#opencode-titlebar-right [aria-label="状态"], #opencode-titlebar-right [aria-label="Status"]',
      ).length,
      review: document.querySelectorAll(
        '#opencode-titlebar-right [aria-label="切换审查"], #opencode-titlebar-right [aria-label="Toggle review"]',
      ).length,
      toast: document.querySelectorAll('[data-component="toast-region"]')
        .length,
      sidebarSlot: document.querySelectorAll("[data-aialra-sidebar-slot]")
        .length,
      workspaceControl: document.querySelectorAll(
        "[data-aialra-workspace-control]",
      ).length,
      workspaceControlSlot: document.querySelectorAll(
        '[data-aialra-workspace-control-slot="true"]',
      ).length,
    }));
  try {
    await expect.poll(readCounts, { timeout: 10_000 }).toEqual({
      titlebar: 1,
      center: 1,
      centerPortals: session ? 1 : 0,
      search: session ? 1 : 0,
      right: 1,
      status: session ? 1 : 0,
      review: session ? 1 : 0,
      toast: 1,
      sidebarSlot: 0,
      workspaceControl: 1,
      workspaceControlSlot: 1,
    });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      centerChildren: [
        ...document.querySelectorAll("#opencode-titlebar-center > *"),
      ].map((element) => ({
        tag: element.tagName,
        text: element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 160),
        parent: element.parentElement?.id,
      })),
      rightChildren: [
        ...document.querySelectorAll("#opencode-titlebar-right > *"),
      ].map((element) => ({
        tag: element.tagName,
        text: element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 160),
        parent: element.parentElement?.id,
      })),
      toastRegions: [
        ...document.querySelectorAll('[data-component="toast-region"]'),
      ].map((element) => ({
        text: element.textContent?.replace(/\s+/gu, " ").trim().slice(0, 160),
        parent: element.parentElement?.tagName,
      })),
      route: location.pathname + location.search + location.hash,
    }));
    throw new Error(
      "session chrome cardinality failed: " + JSON.stringify(debug),
      { cause: error },
    );
  }
}

test("runs the zero-patch official App and recovers after a control-plane restart", async ({
  page,
}) => {
  const binary = process.env.AIALRA_OPENCODE_E2E_BINARY;
  if (!binary) test.skip(true, "AIALRA_OPENCODE_E2E_BINARY is required");
  const expectedProvider =
    process.env.AIALRA_OPENCODE_E2E_PROVIDER ?? "opencode";

  let control: ChildProcess | null = null;
  let agent: ChildProcess | null = null;
  const fixture = await mkdtemp(join(tmpdir(), "AIALRA-OPENCODE-app-"));
  try {
    const e2eEnv = {
      ...process.env,
      AIALRA_OPENCODE_E2E_ROOT: fixture,
    };
    control = tsx("apps/control-plane/scripts/e2e-server.ts", e2eEnv);
    await waitForHealth(control);
    agent = tsx("apps/agent/scripts/local-e2e.ts", {
      ...e2eEnv,
      AIALRA_OPENCODE_E2E_BINARY: binary,
      AIALRA_OPENCODE_E2E_HOLD: "1",
      AIALRA_OPENCODE_E2E_BROWSER_ONLY: "1",
    });
    await waitForLine(agent, '"browserReady":true');

    await page.addInitScript(() => {
      const state = window as unknown as {
        __aialraBrowserRelaySockets: number;
      };
      state.__aialraBrowserRelaySockets = 0;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          if (String(args[0]).includes("/ws/v1/browser"))
            state.__aialraBrowserRelaySockets += 1;
          return Reflect.construct(target, args) as WebSocket;
        },
      });
    });
    await page.goto(origin);
    const workspaceControl = page.locator("[data-aialra-workspace-control]");
    await expect(workspaceControl).toBeVisible();
    await expectSingleSessionChrome(page, { session: false });
    await expect(page.locator("#root")).toHaveAttribute(
      "data-aialra-app-state",
      "running",
    );
    await expect(page.locator("header")).toHaveCount(1);
    await expect(page.locator("#opencode-titlebar-center")).toHaveCount(1);
    await expect(page.locator('[data-component="toast-region"]')).toHaveCount(
      1,
    );
    await expect(page.locator("[data-aialra-sidebar-slot]")).toHaveCount(0);
    await expect(page.locator("[data-aialra-sidebar-hosts]")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __aialraBrowserRelaySockets: number })
              .__aialraBrowserRelaySockets,
        ),
      )
      .toBe(1);
    await expect(
      page.locator('nav[data-component="sidebar-nav-desktop"]'),
    ).toBeVisible();
    await expect(page.locator("[data-aialra-sidebar-fallback]")).toHaveCount(0);
    await workspaceControl.getByRole("button", { name: /工作区/u }).click();
    const management = page.locator(
      '[data-aialra-workspace-management] [data-component="dialog"]',
    );
    await expect(management).toBeVisible();
    const newSessionButton = management
      .locator("[data-aialra-host-management]")
      .first()
      .locator('[data-aialra-action="new-session"]');
    await expect(newSessionButton).toBeVisible();
    await expect.poll(async () => newSessionButton.isEnabled()).toBe(true);
    await newSessionButton.click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toMatch(/^\/[^/]+\/session$/u);
    await expect(page.locator("[data-aialra-workspace-control]")).toBeVisible();
    await expect(management).toHaveCount(0);
    await expectSingleSessionChrome(page);
    await page.goto(origin);
    await expect(page.locator("body")).not.toContainText(".opencode.invalid");
    await page.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    await page.getByRole("tab", { name: /^(服务器|Servers)$/u }).click();
    const host = await page.evaluate(async () => {
      const response = await fetch("/api/v1/hosts");
      const data = (await response.json()) as {
        hosts: Array<{ hostId: string }>;
      };
      const hostId = data.hosts[0]?.hostId;
      if (!hostId) return undefined;
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostId)),
      );
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      let bits = 0;
      let value = 0;
      let encoded = "";
      for (const byte of digest) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
          encoded += alphabet[(value >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) encoded += alphabet[(value << (5 - bits)) & 31];
      return `h-${encoded}.aialra.invalid`;
    });
    expect(host).toMatch(/^h-[a-z2-7]+\.aialra\.invalid$/u);
    const providerReadback = await page.evaluate(async (virtualHost) => {
      const health = await fetch(`https://${virtualHost}/global/health`);
      const providers = await fetch(`https://${virtualHost}/provider`);
      const healthBody = (await health.json()) as { healthy?: boolean };
      const providerBody = (await providers.json()) as { connected?: string[] };
      return {
        healthStatus: health.status,
        healthContentType: health.headers.get("content-type"),
        healthy: healthBody.healthy,
        providerStatus: providers.status,
        connected: providerBody.connected ?? [],
      };
    }, host);
    expect(providerReadback).toMatchObject({
      healthStatus: 200,
      healthy: true,
      providerStatus: 200,
    });
    expect(providerReadback.healthContentType).toContain("application/json");
    expect(providerReadback.connected).toContain(expectedProvider);
    const configurationReadback = await page.evaluate(async (virtualHost) => {
      const response = await fetch(`https://${virtualHost}/config/providers`);
      const value = (await response.json()) as unknown;
      const secretNames = new Set([
        "apikey",
        "authorization",
        "clientsecret",
        "headers",
        "key",
        "password",
        "refreshtoken",
        "secret",
        "token",
      ]);
      let sensitiveFieldFound = false;
      const visit = (input: unknown): void => {
        if (sensitiveFieldFound || !input || typeof input !== "object") return;
        if (Array.isArray(input)) {
          for (const child of input) visit(child);
          return;
        }
        for (const [name, child] of Object.entries(input)) {
          if (secretNames.has(name.toLowerCase())) {
            sensitiveFieldFound = true;
            return;
          }
          visit(child);
        }
      };
      visit(value);
      return { status: response.status, sensitiveFieldFound };
    }, host);
    expect(configurationReadback).toEqual({
      status: 200,
      sensitiveFieldFound: false,
    });
    await page.getByRole("tab", { name: /^(提供商|Providers)$/u }).click();
    const providersPanel = page.getByRole("tabpanel", {
      name: /^(提供商|Providers)$/u,
    });
    await expect(providersPanel).toBeVisible({ timeout: 15_000 });
    await expect(
      providersPanel.getByRole("heading", {
        name: /^(提供商|Providers)$/u,
        level: 2,
      }),
    ).toBeVisible();

    await stop(control);
    control = tsx("apps/control-plane/scripts/e2e-server.ts", e2eEnv);
    await waitForHealth(control);

    await expect
      .poll(
        async () => {
          return page.evaluate(async (virtualHost) => {
            const host = virtualHost;
            if (!host) return false;
            try {
              const response = await fetch(`https://${host}/global/health`);
              return response.ok;
            } catch {
              return false;
            }
          }, host);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await expectSingleSessionChrome(page);

    expect(agent.exitCode).toBeNull();
  } finally {
    await stop(agent);
    await stop(control);
    await removeTempTree(fixture);
  }
});

test("keeps VPS and remote workspaces isolated", async ({ page }) => {
  test.setTimeout(180_000);
  const binary = process.env.AIALRA_OPENCODE_E2E_BINARY;
  if (!binary) test.skip(true, "AIALRA_OPENCODE_E2E_BINARY is required");

  let control: ChildProcess | null = null;
  let vpsAgent: ChildProcess | null = null;
  let remoteAgent: ChildProcess | null = null;
  const fixture = await mkdtemp(join(tmpdir(), "AIALRA-OPENCODE-dual-"));
  const vpsWorkspace = await mkdtemp(join(tmpdir(), "AIALRA-OPENCODE-vps-"));
  const remoteWorkspace = await mkdtemp(
    join(tmpdir(), "AIALRA-OPENCODE-remote-"),
  );
  try {
    const e2eEnv = {
      ...process.env,
      AIALRA_OPENCODE_E2E_ROOT: fixture,
      AIALRA_OPENCODE_E2E_BINARY: binary,
      AIALRA_OPENCODE_E2E_HOLD: "1",
      AIALRA_OPENCODE_E2E_BROWSER_ONLY: "1",
    };
    control = tsx("apps/control-plane/scripts/e2e-server.ts", e2eEnv);
    await waitForHealth(control);
    vpsAgent = tsx("apps/agent/scripts/local-e2e.ts", {
      ...e2eEnv,
      AIALRA_OPENCODE_E2E_NAME: "AIALRA VPS",
      AIALRA_OPENCODE_E2E_MODE: "vps",
      AIALRA_OPENCODE_E2E_WORKSPACE: vpsWorkspace,
    });
    remoteAgent = tsx("apps/agent/scripts/local-e2e.ts", {
      ...e2eEnv,
      AIALRA_OPENCODE_E2E_NAME: "AIALRA Windows",
      AIALRA_OPENCODE_E2E_MODE: "remote",
      AIALRA_OPENCODE_E2E_WORKSPACE: remoteWorkspace,
    });
    await Promise.all([
      waitForLine(vpsAgent, '"browserReady":true'),
      waitForLine(remoteAgent, '"browserReady":true'),
    ]);

    await page.addInitScript(() => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true } }),
      );
      const state = window as unknown as {
        __aialraBrowserRelaySockets: number;
      };
      state.__aialraBrowserRelaySockets = 0;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          if (String(args[0]).includes("/ws/v1/browser"))
            state.__aialraBrowserRelaySockets += 1;
          return Reflect.construct(target, args) as WebSocket;
        },
      });
    });
    await page.goto(origin);
    const workspaceControl = page.locator("[data-aialra-workspace-control]");
    await expect(workspaceControl).toBeVisible();
    await expect(page.locator("[data-aialra-sidebar-hosts]")).toHaveCount(0);
    await expect(page.locator("[data-aialra-sidebar-slot]")).toHaveCount(0);
    await expect(
      page.locator("[data-aialra-classic-layout-preference]"),
    ).toHaveAttribute("data-new-layout", "false");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __aialraBrowserRelaySockets: number })
              .__aialraBrowserRelaySockets,
        ),
      )
      .toBe(1);
    const management = page.locator(
      '[data-aialra-workspace-management] [data-component="dialog"]',
    );
    const openManagement = async () => {
      if ((await management.count()) === 0)
        await workspaceControl.getByRole("button", { name: /工作区/u }).click();
      await expect(management).toBeVisible();
    };
    const chooseWorkspace = async (name: "AIALRA VPS" | "AIALRA Windows") => {
      await openManagement();
      const item = management
        .locator("[data-aialra-host-management]")
        .filter({ hasText: name })
        .first();
      const actualHostId = await item.getAttribute(
        "data-aialra-host-management",
      );
      expect(actualHostId).toBeTruthy();
      const target = item.getByRole("button", {
        name:
          (await workspaceControl.getAttribute("data-active-host")) ===
          actualHostId
            ? "当前工作区"
            : `切换到 ${name}`,
      });
      const started = await page.evaluate(() => performance.now());
      if (await target.isEnabled()) await target.click();
      await page.waitForFunction(
        (expectedHostId) =>
          document
            .querySelector("[data-aialra-workspace-control]")
            ?.getAttribute("data-active-host") === expectedHostId,
        actualHostId!,
        { polling: "raf" },
      );
      const finished = await page.evaluate(() => performance.now());
      return finished - started;
    };
    await expect(workspaceControl).toContainText("AIALRA VPS");
    await expect(management).toHaveCount(0);
    await openManagement();
    await expect(management).toContainText("AIALRA VPS");
    await expect(management).toContainText("AIALRA Windows");
    await expect(
      management.locator("[data-aialra-workspace-root]"),
    ).toHaveCount(2);
    await expect(
      management.locator('[data-aialra-action="select-workspace"]'),
    ).toHaveCount(2);
    await management.getByRole("button", { name: "关闭工作区管理" }).click();
    await expect(management).toHaveCount(0);

    await openManagement();
    const managementGeometry = await management.evaluate((element) => {
      const items = [
        ...element.querySelectorAll("[data-aialra-host-management]"),
      ]
        .filter((item): item is HTMLElement => item instanceof HTMLElement)
        .map((item) => item.getBoundingClientRect());
      return {
        overlaps: items.some(
          (item, index) =>
            index > 0 && items[index - 1]!.bottom > item.top + 0.5,
        ),
        overflow: [...element.querySelectorAll("[data-aialra-host-management]")]
          .filter((item): item is HTMLElement => item instanceof HTMLElement)
          .some((item) => item.scrollWidth > item.clientWidth + 1),
      };
    });
    expect(managementGeometry).toEqual({ overlaps: false, overflow: false });

    const roots = await page.evaluate(async () => {
      const response = await fetch("/api/v1/hosts");
      const data = (await response.json()) as {
        hosts: Array<{ hostId: string; mode: string; state: string }>;
      };
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      const virtualHost = async (hostId: string) => {
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(hostId),
          ),
        );
        let bits = 0;
        let value = 0;
        let encoded = "";
        for (const byte of digest) {
          value = (value << 8) | byte;
          bits += 8;
          while (bits >= 5) {
            encoded += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
          }
        }
        if (bits > 0) encoded += alphabet[(value << (5 - bits)) & 31];
        return `https://h-${encoded}.aialra.invalid`;
      };
      const result: Record<string, string> = {};
      for (const host of data.hosts.filter(
        (candidate) => candidate.state === "online",
      )) {
        const path = await fetch(`${await virtualHost(host.hostId)}/path`);
        result[host.mode] = String((await path.json()).directory ?? "");
      }
      return result;
    });
    expect(roots.vps).toContain("AIALRA-OPENCODE-vps-");
    expect(roots.remote).toContain("AIALRA-OPENCODE-remote-");
    expect(roots.vps).not.toBe(roots.remote);

    await chooseWorkspace("AIALRA Windows");
    const windowsManagement = page
      .locator("[data-aialra-host-management]")
      .filter({ hasText: "AIALRA Windows" })
      .first();
    await expect(
      windowsManagement.locator('[data-aialra-action="new-session"]'),
    ).toBeEnabled();
    await windowsManagement
      .locator('[data-aialra-action="new-session"]')
      .click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toMatch(/^\/[^/]+\/session$/u);
    await expectSingleSessionChrome(page);

    await expect(workspaceControl).toBeVisible();
    await expect(page.locator("[data-aialra-sidebar-fallback]")).toHaveCount(0);
    await expect(page.locator("[data-aialra-sidebar-hosts]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(".opencode.invalid");

    const switchDurations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? "AIALRA VPS" : "AIALRA Windows";
      switchDurations.push(await chooseWorkspace(target));
    }
    await expectSingleSessionChrome(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __aialraBrowserRelaySockets: number })
              .__aialraBrowserRelaySockets,
        ),
      )
      .toBe(1);
    switchDurations.sort((left, right) => left - right);
    const p95 = switchDurations[Math.ceil(switchDurations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(500);

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 1280) {
        const toggle = page.getByRole("button", {
          name: /Toggle (?:sidebar|menu)|侧边栏/u,
        });
        if (
          !(await page
            .locator('nav[data-component="sidebar-nav-mobile"]')
            .isVisible())
        )
          await toggle.click();
      }
      await expect(
        page.locator("[data-aialra-workspace-control]"),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
        )
        .toBe(true);
    }
    await expect(
      page.locator('[data-component="toast-region"]'),
    ).not.toContainText("Transport");
    await expect(page.locator("body")).not.toContainText("工作目录尚未确认");
  } finally {
    await stop(vpsAgent);
    await stop(remoteAgent);
    await stop(control);
    await Promise.all([
      removeTempTree(fixture),
      removeTempTree(vpsWorkspace),
      removeTempTree(remoteWorkspace),
    ]);
  }
});
