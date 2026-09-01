import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "@playwright/test";

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
    await rm(fixture, { recursive: true, force: true });
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

    await page.goto(origin);
    const workspaceNav = page.locator("[data-aialra-sidebar-hosts]");
    await expect(workspaceNav).toBeVisible();
    await expect(
      workspaceNav
        .getByRole("button", { name: /VPS 工作区|远程工作区/u })
        .first(),
    ).toBeVisible();
    const newSessionButton = workspaceNav.getByRole("button", {
      name: /新建会话/u,
    });
    await expect(newSessionButton).toBeVisible();
    await expect.poll(async () => newSessionButton.isEnabled()).toBe(true);
    await newSessionButton.click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe("/");
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

    expect(agent.exitCode).toBeNull();
  } finally {
    await stop(agent);
    await stop(control);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("keeps VPS and remote workspaces isolated", async ({ page }) => {
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

    await page.goto(origin);
    const workspaceNav = page.locator("[data-aialra-sidebar-hosts]");
    await expect(workspaceNav).toBeVisible();
    const vpsButton = workspaceNav.getByRole("button", { name: /VPS 工作区/u });
    const remoteButton = workspaceNav.getByRole("button", {
      name: /远程工作区/u,
    });
    await expect(vpsButton).toBeVisible();
    await expect(remoteButton).toBeVisible();
    await expect(vpsButton).toHaveAttribute("aria-pressed", "true");
    await expect(remoteButton).toHaveAttribute("aria-pressed", "false");

    await expect(workspaceNav).toContainText("AIALRA VPS");
    await expect(workspaceNav).toContainText("工作目录");

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

    await remoteButton.click();
    await expect(remoteButton).toHaveAttribute("aria-pressed", "true");
    await expect(vpsButton).toHaveAttribute("aria-pressed", "false");
    await expect(workspaceNav).toContainText("AIALRA Windows");
    await expect(
      workspaceNav.getByRole("button", { name: /新建会话/u }),
    ).toBeEnabled();

    await expect(workspaceNav).toBeVisible();
    await expect
      .poll(() =>
        workspaceNav.evaluate((element) => getComputedStyle(element).position),
      )
      .not.toBe("fixed");
    await expect(page.locator("body")).not.toContainText(".opencode.invalid");

    const switchDurations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? vpsButton : remoteButton;
      const start = await page.evaluate(() => performance.now());
      await target.click();
      await expect(target).toHaveAttribute("aria-pressed", "true");
      const end = await page.evaluate(() => performance.now());
      switchDurations.push(end - start);
    }
    switchDurations.sort((left, right) => left - right);
    const p95 = switchDurations[Math.ceil(switchDurations.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(500);
  } finally {
    await stop(vpsAgent);
    await stop(remoteAgent);
    await stop(control);
    await Promise.all([
      rm(fixture, { recursive: true, force: true }),
      rm(vpsWorkspace, { recursive: true, force: true }),
      rm(remoteWorkspace, { recursive: true, force: true }),
    ]);
  }
});
