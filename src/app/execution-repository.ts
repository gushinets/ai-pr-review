import type { Octokit } from "@octokit/rest";

/** Artifact and log access follow the execution repository, not the target App. */
export async function requirePrivateExecutionRepository(github: Octokit, repository: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("EXECUTION_REPOSITORY_REJECTED");
  const [owner, repo] = repository.split("/") as [string, string];
  const { data } = await github.rest.repos.get({ owner, repo });
  if (
    data.full_name?.toLowerCase() !== repository.toLowerCase() ||
    data.private !== true ||
    data.visibility !== "private"
  )
    throw new Error("EXECUTION_REPOSITORY_REJECTED");
  return data;
}
