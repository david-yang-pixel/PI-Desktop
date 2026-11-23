import { useTranslation } from "react-i18next";
import type { GitHubBranchSummary, GitHubRepositoryRef, GitHubRepositorySummary } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { githubErrorText } from "../../settings/connectors/github-error-message";
import { unlistedBranchQuery, unlistedRepositoryQuery, useUnlistedLookup, type LookupState } from "./unlisted-target-lookup";

function LookupResult<T>({ name, result, notFound, label, onSelect }: {
  name: string;
  result: LookupState<T> | undefined;
  notFound: string;
  label(value: T): string;
  onSelect(value: T): void;
}) {
  const { t } = useTranslation();
  if (!result || result.status === "loading") {
    return <p role="status">{t("sessionTarget.lookup.searching", { name })}</p>;
  }
  if (result.status === "missing") return <p role="status">{notFound}</p>;
  if (result.status === "error") {
    return <p role="alert">{t("sessionTarget.loadFailed", { message: githubErrorText(t, result.cause) })}</p>;
  }
  return <>
    <span>{t("sessionTarget.lookup.foundOnGitHub")}</span>
    <Button variant="secondary" onClick={() => onSelect(result.value)}>{label(result.value)}</Button>
  </>;
}

/** Offers the repository the search names exactly when the listing left it out. */
export function UnlistedRepositoryOption({ query, listed, onSelect }: {
  query: string;
  listed: readonly GitHubRepositorySummary[] | undefined;
  onSelect(repository: GitHubRepositorySummary): void;
}) {
  const { t } = useTranslation();
  const wanted = unlistedRepositoryQuery(query, listed);
  const key = wanted && `${wanted.owner}/${wanted.name}`;
  const result = useUnlistedLookup(key, async () =>
    wanted ? (await api.getGithubRepository(wanted)).repository : null);
  if (!key) return null;
  return <LookupResult name={key} result={result} onSelect={onSelect}
    notFound={t("sessionTarget.lookup.repositoryNotFound", { name: key })} label={(value) => value.fullName} />;
}

/** Offers the branch the search names exactly when the listing left it out. */
export function UnlistedBranchOption({ query, repository, listed, onSelect }: {
  query: string;
  repository: GitHubRepositoryRef;
  listed: readonly GitHubBranchSummary[] | undefined;
  onSelect(branch: GitHubBranchSummary): void;
}) {
  const { t } = useTranslation();
  const wanted = unlistedBranchQuery(query, listed);
  const key = wanted && `${repository.owner}/${repository.name}#${wanted}`;
  const result = useUnlistedLookup(key, async () => wanted
    ? (await api.getGithubBranch({ owner: repository.owner, name: repository.name, branch: wanted })).branch
    : null);
  if (!wanted) return null;
  return <LookupResult name={wanted} result={result} onSelect={onSelect}
    notFound={t("sessionTarget.lookup.branchNotFound", { name: wanted })} label={(value) => value.name} />;
}
