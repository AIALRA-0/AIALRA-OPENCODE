export const RELAY_OPERATIONS = [
  "http.read",
  "http.write",
  "event.stream",
  "pty.connect",
] as const;

export type RelayOperation = (typeof RELAY_OPERATIONS)[number];

const OPERATION_SET = new Set<string>(RELAY_OPERATIONS);

export function isRelayOperation(value: string): value is RelayOperation {
  return OPERATION_SET.has(value);
}
