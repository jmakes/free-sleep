import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import serverInfo from '../../../server/src/serverInfo.json';
import semver from 'semver';

export type ServerInfo = {
  version: string;
  branch: string;
  updateAvailable: boolean;
  githubOwner?: string;
  githubRepo?: string;
  updateCheckUrl?: string;
}

type LatestVersion = {
  version: string;
  branch: string;
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


export const useServerInfo = () => useQuery<ServerInfo>({
  queryKey: ['useServerInfo'],
  queryFn: async () => {
    const response = await getLatestVersion();
    let updateAvailable = false;
    // Prefer semver so 2.1.5-jmakes.1 > 2.1.5-jmakes.0 works as expected.
    if (semver.valid(response.data.version) && semver.valid(serverInfo.version)) {
      updateAvailable = semver.gt(response.data.version, serverInfo.version);
    } else {
      updateAvailable = response.data.version !== serverInfo.version;
    }
    if (import.meta.env.VITE_ENV === 'demo') {
      updateAvailable = true;
    }
    return {
      ...response.data,
      updateAvailable
    };
  },
  staleTime: 60_000,
});
