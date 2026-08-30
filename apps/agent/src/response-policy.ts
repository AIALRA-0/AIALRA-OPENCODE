const CONFIGURATION_RESPONSE_PATHS = new Set([
  "/config",
  "/config/providers",
  "/global/config",
]);

const SECRET_FIELD_NAMES = new Set([
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

const MAX_CONFIGURATION_RESPONSE_BYTES = 16 * 1024 * 1024;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !SECRET_FIELD_NAMES.has(name.toLowerCase()))
      .map(([name, child]) => [name, redact(child)]),
  );
}

export function requestContainsSecretConfiguration(
  path: string,
  body: Uint8Array | null,
): boolean {
  if (path !== "/config" && path !== "/global/config") return false;
  if (!body?.byteLength) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return true;
  }
  let found = false;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    for (const [name, child] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.has(name.toLowerCase())) {
        found = true;
        return;
      }
      visit(child);
    }
  };
  visit(parsed);
  return found;
}

export async function sanitizedConfigurationResponse(
  path: string,
  response: Response,
): Promise<Uint8Array | null> {
  if (!CONFIGURATION_RESPONSE_PATHS.has(path)) return null;
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("configuration response is not JSON");
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.byteLength > MAX_CONFIGURATION_RESPONSE_BYTES)
    throw new Error("configuration response exceeds sanitization limit");
  const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
  return Buffer.from(JSON.stringify(redact(parsed)), "utf8");
}
