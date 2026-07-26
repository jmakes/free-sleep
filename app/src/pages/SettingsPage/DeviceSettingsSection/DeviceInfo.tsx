import { Box, Chip, Typography } from '@mui/material';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { Version } from '@api/deviceStatusSchema';
import VersionStatus from '@components/VersionStatus.tsx';
import serverInfo from '../../../../../server/src/serverInfo.json';
import WifiStrength from './WifiStrength.tsx';
import RebootButton from './RebootButton.tsx';


function freeSleepBuildUrl(options: {
  owner?: string;
  repo?: string;
  branch?: string;
  commit?: string;
}): string {
  const owner = options.owner || serverInfo.githubOwner || 'jmakes';
  const repo = options.repo || serverInfo.githubRepo || 'free-sleep';
  const base = `https://github.com/${owner}/${repo}`;
  const commit = options.commit || serverInfo.commit;
  if (commit) {
    return `${base}/commit/${commit}`;
  }
  const branch = options.branch || serverInfo.branch || 'main';
  return `${base}/tree/${branch}`;
}


export default function DeviceInfo() {
  const { data: deviceStatus, isLoading } = useDeviceStatus();
  if (isLoading || !deviceStatus) return null;
  const hideCover = deviceStatus.coverVersion === Version.NotFound;
  const hideHub = deviceStatus.hubVersion === Version.NotFound;

  const freeSleep = deviceStatus.freeSleep;
  const commit = freeSleep.commit || serverInfo.commit || undefined;
  const buildUrl = freeSleepBuildUrl({
    owner: freeSleep.githubOwner,
    repo: freeSleep.githubRepo,
    branch: freeSleep.branch,
    commit,
  });
  const versionLabel = `v${freeSleep.version}`;
  const shortCommit = commit ? commit.slice(0, 7) : null;

  return (
    <>
      <Box sx={ { display: 'flex', gap: 1, mb: 1 } }>
        <Typography variant='body2'>Device</Typography>
        {
          !hideCover && <Chip label={ `${deviceStatus.coverVersion} Cover` } size='small'/>
        }
        {
          !hideHub && <Chip label={ `${deviceStatus.hubVersion} Hub` } size='small'/>
        }
      </Box>
      <Box sx={ { display: 'flex', gap: 1, align: 'center', alignItems: 'center', mb: 1, flexWrap: 'wrap' } }>
        <Typography variant='body2'>Free Sleep Build</Typography>
        <Chip
          label={ versionLabel }
          size='small'
          component='a'
          href={ buildUrl }
          target='_blank'
          rel='noopener noreferrer'
          clickable
          title={ `Open ${buildUrl}` }
          sx={ {
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
          } }
        />
        <Chip label={ freeSleep.branch } size='small'/>
        {
          shortCommit && (
            <Chip
              label={ shortCommit }
              size='small'
              component='a'
              href={ buildUrl }
              target='_blank'
              rel='noopener noreferrer'
              clickable
              title={ `Open commit ${commit}` }
              sx={ {
                fontFamily: 'monospace',
                textDecoration: 'none',
                '&:hover': { textDecoration: 'underline' },
              } }
            />
          )
        }
      </Box>
      <Box sx={ { display: 'flex', gap: 1, mt: 1 } }>
        <RebootButton />
        <WifiStrength />
      </Box>
      <VersionStatus />
    </>
  );
}
