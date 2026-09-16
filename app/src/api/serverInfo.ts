import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import serverInfo from '../../../server/src/serverInfo.json';
import semver from 'semver';

export type ServerInfo = {
  version: string;
  branch: string;
  commit?: string;
  updateAvailable: boolean;
  githubOwner?: string;
  githubRepo?: string;
  updateCheckUrl?: string;
}

type LatestVersion = {
  version: string;
  branch: string;
  commit?: string;
  githubOwner?: string;
  githubRepo?: string;
  updateCheckUrl?: string;
}

const defaultUpdateCheckUrl =
  'https://raw.githubusercontent.com/jmakes/free-sleep/main/server/src/serverInfo.json';

export const getLatestVersion = async () => {
  const url = serverInfo.updateCheckUrl || defaultUpdateCheckUrl;
  return axios.get<LatestVersion>(url);
};

/** True when remote is newer by semver, or same/newer semver with a different stamped commit. */
export function isRemoteNewer(remote: LatestVersion, local: { version: string; commit?: string }): boolean {
  const remoteVer = remote.version;
  const localVer = local.version;

  if (semver.valid(remoteVer) && semver.valid(localVer)) {
    if (semver.gt(remoteVer, localVer)) return true;
    if (semver.lt(remoteVer, localVer)) return false;
    // Same version — fall through to commit compare
  } else if (remoteVer !== localVer) {
    // Non-semver fallback: any string difference means "maybe update"
    return true;
  }

  const remoteCommit = remote.commit?.trim();
  const localCommit = local.commit?.trim();
  if (remoteCommit && localCommit && remoteCommit !== localCommit) {
    return true;
  }
  return false;
}


export const useServerInfo = () => useQuery<ServerInfo>({
  queryKey: ['useServerInfo'],
  queryFn: async () => {
    const response = await getLatestVersion();
    let updateAvailable = isRemoteNewer(response.data, serverInfo);
    if (import.meta.env.VITE_ENV === 'demo') {
      updateAvailable = true;
    }
    return {
      ...response.data,
      updateAvailable
    };
  },
  staleTime: 60_000,
  retry: 1,
});
