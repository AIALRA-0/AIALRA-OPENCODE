declare module "@opencode-ai/ui/button" {
  import type { JSX } from "solid-js";

  export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: "small" | "normal" | "large";
    variant?: "primary" | "secondary" | "ghost";
    icon?: string;
  };

  export function Button(props: ButtonProps): JSX.Element;
}

declare module "@opencode-ai/ui/icon" {
  import type { JSX } from "solid-js";

  export type IconProps = {
    name: string;
    size?: "small" | "normal" | "large";
    class?: string;
  };

  export function Icon(props: IconProps): JSX.Element;
}

declare module "@opencode-ai/ui/dialog" {
  import type { ComponentProps, JSX, ParentProps } from "solid-js";

  export interface DialogProps extends ParentProps {
    title?: JSX.Element;
    description?: JSX.Element;
    action?: JSX.Element;
    size?: "normal" | "large" | "x-large";
    class?: ComponentProps<"div">["class"];
    classList?: ComponentProps<"div">["classList"];
    fit?: boolean;
    transition?: boolean;
  }

  export function Dialog(props: DialogProps): JSX.Element;
}

declare module "@opencode-ai/ui/context/dialog" {
  import type { JSX } from "solid-js";

  export function useDialog(): {
    readonly active: unknown;
    show(element: () => JSX.Element, onClose?: () => void): void;
    push(element: () => JSX.Element, onClose?: () => void): void;
    close(): void;
  };
}
