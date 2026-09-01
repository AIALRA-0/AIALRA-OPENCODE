declare module "@opencode-ai/app" {
  import type { Component, JSX, ParentComponent } from "solid-js";

  export type ServerKey = string & { readonly __serverKey: unique symbol };

  export type Platform = {
    platform: "web";
    version?: string;
    openExternal(url: string): void;
    restart(): Promise<void>;
    notify(
      title: string,
      description?: string,
      onClick?: () => void,
    ): Promise<void>;
    fetch?: typeof fetch;
    getDefaultServer?(): Promise<ServerKey | null>;
    setDefaultServer?(url: ServerKey | null): Promise<void> | void;
  };

  export const AppBaseProviders: ParentComponent;
  export const AppInterface: Component<{
    children?: JSX.Element;
    defaultServer: ServerKey;
    servers: Array<{
      type: "http";
      displayName?: string;
      label?: string;
      http: { url: string };
    }>;
    disableHealthCheck?: boolean;
    serverScoped?: JSX.Element;
  }>;
  export const PlatformProvider: ParentComponent<{ value: Platform }>;
  export function useSettings(): {
    ready: () => boolean;
    current: {
      general?: { newLayoutDesigns?: boolean };
    };
    general: {
      newLayoutDesigns: () => boolean;
      setNewLayoutDesigns(value: boolean): void;
    };
  };
  export function useLayout(): {
    sidebar: {
      opened(): boolean;
      open(): void;
    };
  };
  export const ServerConnection: {
    Key: {
      make(value: string): ServerKey;
    };
  };
  export function useTabs(): {
    ready: (() => boolean) & { promise?: Promise<unknown> };
    newDraft(
      draft: { server: ServerKey; directory: string },
      prompt?: string,
    ): Promise<unknown>;
  };
  export function useServer(): {
    key: ServerKey;
    current:
      | {
          type: "http";
          displayName?: string;
          label?: string;
          http: { url: string };
        }
      | undefined;
    list: Array<{
      type: "http";
      displayName?: string;
      label?: string;
      http: { url: string };
    }>;
    setActive(key: ServerKey): void;
    projects: {
      open(directory: string): void;
      touch(directory: string): void;
      remove(directory: string): void;
      list(): Array<{ worktree: string; expanded?: boolean }>;
      forServer(key: ServerKey): {
        open(directory: string): void;
        touch(directory: string): void;
        remove(directory: string): void;
        list(): Array<{ worktree: string; expanded?: boolean }>;
      };
    };
  };
}
