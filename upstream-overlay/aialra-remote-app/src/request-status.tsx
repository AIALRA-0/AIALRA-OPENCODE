import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "@opencode-ai/ui/button";
import {
  REMOTE_REQUEST_EVENT,
  actionStateFromEvent,
  type ActionState,
  type RemoteFetchError,
  type RemoteRequestEventDetail,
} from "./action-state";
import { virtualOrigin } from "./remote-fetch";

function promptMount(): HTMLElement | null {
  const submit = document.querySelector<HTMLElement>(
    '[data-action="prompt-submit"]',
  );
  if (!submit) return null;
  const form = submit.closest("form");
  return form instanceof HTMLElement ? form : submit.parentElement;
}

function currentSessionId(): string | null {
  const match = location.pathname.match(/\/session\/([^/]+)$/u);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

function statusText(state: ActionState, note: string | null): string {
  if (note) return note;
  if (state.phase === "preparing") return "准备发送…";
  if (state.phase === "running") return "发送中…";
  if (state.phase === "success") return "已收到服务端响应";
  if (state.phase === "unknown") return "提交状态未知，请先检查会话";
  if (state.category === "channel_acquire_timeout")
    return "连接主机超时，未自动重发";
  if (state.category === "upstream_timeout")
    return "服务端响应超时，未自动重发";
  if (state.category === "authentication_failure") return "主机认证失败";
  if (state.category === "host_offline") return "主机已离线";
  if (state.category === "boundary_rejected") return "请求被工作区边界拒绝";
  if (state.category === "cancelled") return "发送已取消";
  return "发送失败，未自动重发";
}

function statusCheckError(category: string | undefined): string {
  switch (category) {
    case "channel_acquire_timeout":
      return "状态检查连接主机超时，请稍后重试";
    case "upstream_timeout":
      return "状态检查服务端响应超时，请稍后重试";
    case "authentication_failure":
      return "状态检查认证失败，请重新登录或检查主机授权";
    case "host_offline":
      return "状态检查失败：主机当前离线";
    case "boundary_rejected":
      return "状态检查被工作区边界拒绝";
    case "cancelled":
      return "状态检查已取消";
    case "unknown_write_state":
      return "提交状态未知，请先确认会话消息";
    default:
      return "状态检查失败，请稍后重试";
  }
}

export function RequestStatusSurface(props: { remoteFetch: typeof fetch }) {
  const [mount, setMount] = createSignal<HTMLElement | null>(null);
  const [state, setState] = createSignal<ActionState>({
    phase: "idle",
    updatedAt: Date.now(),
  });
  const [detail, setDetail] = createSignal<RemoteRequestEventDetail | null>(
    null,
  );
  const [note, setNote] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(false);
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  const syncMount = () => setMount(promptMount());
  const onRemoteRequest = (event: Event) => {
    const value = (event as CustomEvent<RemoteRequestEventDetail>).detail;
    if (!value || value.operation !== "prompt") return;
    setDetail(value);
    setNote(null);
    setState(actionStateFromEvent(value));
    if (clearTimer) clearTimeout(clearTimer);
    if (value.phase === "response") {
      clearTimer = setTimeout(() => {
        setState((current) =>
          current.requestId === value.requestId
            ? { phase: "idle", updatedAt: Date.now() }
            : current,
        );
      }, 2500);
    }
  };

  const check = async () => {
    const current = detail();
    const sessionID = currentSessionId();
    if (!current || !sessionID || checking()) return;
    setChecking(true);
    setNote("正在检查会话状态…");
    try {
      const response = await props.remoteFetch(
        `${virtualOrigin(current.hostId)}/api/session/${encodeURIComponent(sessionID)}`,
        { method: "GET" },
      );
      if (response.ok) {
        setNote("会话可访问，请查看消息列表确认是否已提交");
      } else {
        setNote(`会话状态检查返回 ${response.status}`);
      }
    } catch (error) {
      const category = (error as RemoteFetchError).category;
      setNote(statusCheckError(category));
    } finally {
      setChecking(false);
    }
  };

  onMount(() => {
    syncMount();
    const observer = new MutationObserver(syncMount);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener(REMOTE_REQUEST_EVENT, onRemoteRequest);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener(REMOTE_REQUEST_EVENT, onRemoteRequest);
      if (clearTimer) clearTimeout(clearTimer);
    });
  });

  return (
    <Show when={mount()}>
      {(target) => (
        <Show when={state().phase !== "idle"}>
          <Portal mount={target()}>
            <div
              data-aialra-prompt-status
              role="status"
              aria-live="polite"
              class="flex min-h-6 items-center gap-2 border-t border-border-weaker-base px-2 py-1 text-11-regular text-text-weak"
            >
              <span class="min-w-0 flex-1 truncate">
                {statusText(state(), note())}
              </span>
              <Show
                when={
                  state().phase === "unknown" ||
                  note()?.startsWith("状态检查") === true
                }
              >
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  disabled={checking()}
                  aria-busy={checking()}
                  onClick={() => void check()}
                >
                  检查会话
                </Button>
              </Show>
            </div>
          </Portal>
        </Show>
      )}
    </Show>
  );
}
