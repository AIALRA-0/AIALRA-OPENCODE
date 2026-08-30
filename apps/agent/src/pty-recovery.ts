const PTY_CONNECT_PATH = /^(?:\/api)?\/pty\/(pty_[0-9A-Za-z]{26})\/connect$/;
const PTY_RESOURCE_PATH = /^(?:\/api)?\/pty\/(pty_[0-9A-Za-z]{26})$/;

export function stalePtyIdFromSocket(path: string): string | null {
  return PTY_CONNECT_PATH.exec(path)?.[1] ?? null;
}

export function stalePtyIdFromResource(path: string): string | null {
  return PTY_RESOURCE_PATH.exec(path)?.[1] ?? null;
}
