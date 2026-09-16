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

/**
 * Update offer is version-based only.
 * Build/deploy stamps HEAD into serverInfo.commit, which often differs from the
 * commit field last pushed to GitHub — that must not look like an available update.
 */
export function isRemoteNewer(remote: LatestVersion, local: { version: string; commit?: string }): boolean {
  const remoteVer = remote.version;
  const localVer = local.version;

  if (semver.valid(remoteVer) && semver.valid(localVer)) {
    return semver.gt(remoteVer, localVer);
  }
  return remoteVer !== localVer;
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
