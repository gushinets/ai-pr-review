export function f0(): number {
  return 0;
}
export function f1(): number {
  return 1;
}
export function f2(): number {
  return 2;
}
export function f3(): number {
  return 3;
}
export function f4(): number {
  return 4;
}
export function f5(): number {
  return 5;
}
export function f6(): number {
  return 6;
}
export function f7(): number {
  return 7;
}
export function lateDispatch(handlers: Record<string, () => void>, key: string): void {
  handlers[key]();
}
