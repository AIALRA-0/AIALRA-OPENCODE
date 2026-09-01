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
