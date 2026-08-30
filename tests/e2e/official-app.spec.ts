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
  try {
    control = tsx("apps/control-plane/scripts/e2e-server.ts");
    await waitForHealth(control);
    agent = tsx("apps/agent/scripts/local-e2e.ts", {
      ...process.env,
      AIALRA_OPENCODE_E2E_BINARY: binary,
      AIALRA_OPENCODE_E2E_HOLD: "1",
      AIALRA_OPENCODE_E2E_BROWSER_ONLY: "1",
    });
    await waitForLine(agent, '"browserReady":true');

    await page.goto(origin);
    await expect(
      page.getByRole("button", { name: /^(新建会话|New session)$/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^(设置|Settings)$/u }).click();
    await page.getByRole("tab", { name: /^(服务器|Servers)$/u }).click();
    const host = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .map((element) => element.textContent?.trim() ?? "")
        .find((text) => /^h-[a-z2-7]+\.opencode\.invalid$/u.test(text)),
    );
    expect(host).toMatch(/^h-[a-z2-7]+\.opencode\.invalid$/u);
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
    control = tsx("apps/control-plane/scripts/e2e-server.ts");
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
  }
});
