export interface RelayRetryState {
  attempts: number;
  retryAt: number;
}

export const RELAY_RETRY_INITIAL_MS = 500;
export const RELAY_RETRY_MAX_MS = 15_000;

export function relayRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  return Math.min(RELAY_RETRY_INITIAL_MS * 2 ** exponent, RELAY_RETRY_MAX_MS);
}

export function nextRelayRetryState(
  previous: RelayRetryState | undefined,
  now: number,
): RelayRetryState {
  const attempts = (previous?.attempts ?? 0) + 1;
  return {
    attempts,
    retryAt: now + relayRetryDelay(attempts),
  };
}
