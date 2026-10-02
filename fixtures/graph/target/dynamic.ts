export function dispatch(handlers: Record<string, () => void>, key: string): void {
  handlers[key]();
}
