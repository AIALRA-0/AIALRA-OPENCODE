declare module "@solidjs/router" {
  export function useNavigate(): (
    to: string,
    options?: { replace?: boolean },
  ) => void;
}
