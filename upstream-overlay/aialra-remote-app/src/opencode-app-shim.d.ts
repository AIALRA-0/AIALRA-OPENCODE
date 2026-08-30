declare module "@opencode-ai/app" {
  import type { Component, ParentComponent } from "solid-js";

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
    defaultServer: ServerKey;
    servers: Array<{ type: "http"; name: string; http: { url: string } }>;
  }>;
  export const PlatformProvider: ParentComponent<{ value: Platform }>;
  export const ServerConnection: {
    Key: {
      make(value: string): ServerKey;
    };
  };
}
