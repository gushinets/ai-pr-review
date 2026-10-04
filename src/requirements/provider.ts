import type {
  LinearRequirementsContextV1,
  LinearRequirementsLoader,
} from "../linear/requirements-loader.js";
import type { LinearOAuthCredentials } from "../linear/oauth.js";

export type NormalizedRequirementsContext = Omit<LinearRequirementsContextV1, "identifier"> & {
  identifier: string | null;
};
export interface RequirementsProvider {
  load(identifier: string | null): Promise<NormalizedRequirementsContext>;
}
export const noRequirements: RequirementsProvider = {
  async load(identifier) {
    if (identifier !== null) throw new Error("Requirements provider identity mismatch");
    return {
      schema_version: 1,
      identifier: null,
      title: "No requirements provider configured",
      description:
        "Review code, CI and trusted policy. No external behavioral requirements were supplied.",
      comments: [],
    };
  },
};
export function linearRequirements(
  loader: LinearRequirementsLoader,
  credentials: LinearOAuthCredentials,
): RequirementsProvider {
  return {
    load(identifier) {
      if (identifier === null) throw new Error("Requirements provider identity mismatch");
      return loader.load(identifier, credentials);
    },
  };
}
