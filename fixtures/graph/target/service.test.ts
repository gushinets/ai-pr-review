import { serve } from "./service";
export function affectedTest(): boolean {
  return serve(2) === 4;
}
