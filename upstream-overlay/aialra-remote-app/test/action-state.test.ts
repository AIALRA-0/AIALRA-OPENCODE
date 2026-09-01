import { expect, test } from "bun:test";
import {
  actionStateFromEvent,
  operationFor,
  type RemoteRequestEventDetail,
} from "../src/action-state";

const detail = (
  overrides: Partial<RemoteRequestEventDetail>,
): RemoteRequestEventDetail => ({
  requestId: "request-1",
  hostId: "host-test-1234",
  operation: "metadata",
  phase: "preparing",
  sent: false,
  ...overrides,
});

test("classifies request operations by route and method", () => {
  expect(operationFor("/session/s-1/prompt", "POST")).toBe("prompt");
  expect(operationFor("/event", "GET")).toBe("event");
  expect(operationFor("/pty/s-1", "GET")).toBe("pty");
  expect(operationFor("/project", "GET")).toBe("metadata");
  expect(operationFor("/project", "PATCH")).toBe("write");
});

test("keeps unknown write state non-retryable", () => {
  expect(
    actionStateFromEvent(
      detail({
        operation: "prompt",
        phase: "failed",
        category: "unknown_write_state",
        sent: true,
      }),
    ),
  ).toMatchObject({ phase: "unknown", retryable: false, sent: true });
});

test("allows retry for a host that is temporarily offline", () => {
  expect(
    actionStateFromEvent(
      detail({
        phase: "failed",
        category: "host_offline",
      }),
    ),
  ).toMatchObject({ phase: "failed", retryable: true });
});

test("does not retry authentication or boundary failures", () => {
  for (const category of [
    "authentication_failure",
    "boundary_rejected",
  ] as const) {
    expect(
      actionStateFromEvent(detail({ phase: "failed", category })),
    ).toMatchObject({ phase: "failed", retryable: false });
  }
});
