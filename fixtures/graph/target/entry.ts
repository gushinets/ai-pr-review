import { serve } from "./service";
export function entry(value: number): number {
  return serve(value);
}
