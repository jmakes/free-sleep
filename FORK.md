# Fork logistics — `jmakes/free-sleep`

This repository is a fork of [throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep) customized for local control on an Eight Sleep Pod 4 (and compatible pods).

**Goals of this logistics baseline**

1. Install and update from **this fork**, not upstream.
2. Support two deploy paths: **installer-from-GitHub** and **rsync from a laptop**.
3. Keep a clear **rollback** path so a bad deploy does not strand the Pod.

No privileges beyond normal GitHub push access to `jmakes/free-sleep` and SSH to the Pod are required.

---

## What changed vs upstream

| Area | Behavior |
|------|----------|
| `scripts/repo_config.sh` | Single source of truth: owner / repo / branch / URLs |
| `scripts/install.sh` | Downloads zip from the configured fork (default `jmakes/free-sleep@main`) |
| `scripts/update.sh` | Re-runs install from the **same** fork config (no longer hardcodes upstream) |
| `server/src/serverInfo.json` | Version `2.1.5-jmakes.0` + `updateCheckUrl` pointing at this fork |
| `app/src/api/serverInfo.ts` | GUI “update available” checks this fork’s `serverInfo.json` |
| `scripts/build_release.sh` | Build `server/dist` + `server/public` on a dev machine |
| `scripts/deploy_rsync.sh` | Incremental deploy over SSH/rsync |
| `scripts/install_from_fork.sh` | One-shot migrate/reinstall onto this fork (run on Pod) |

User data lives under **`/persistent/free-sleep-data/`** and is **not** wiped by install/update.

---

## Product TODO (jmakes fork)

| Item | Status | Notes |
|------|--------|--------|
| Cover multi-tap controls | Done | double/triple/quad + haptics |
| Auto sleep analyze on power-off | Done | per-side setting + min duration |
| Schedule saves default to all days | Done | |
| Live **Sensors** view | In progress | Data → Sensors |
| **OEM-style occupied multi-pose calibration wizard** | TODO | Guided empty + on-back + roll; live confirm sensors; optional occupied envelope. Complements empty-bed cap baseline. |
| Person-first UI shell (Left / Right / House) | TODO | Parked until sleep path is solid |
| Off-box analysis APIs (#6) | TODO | Only if on-device resources are insufficient |

---

## Prerequisites

- Pod already running Free Sleep (root/jailbreak complete).
- SSH access (recommended):

  ```bash
  sh /home/dac/free-sleep/scripts/setup_ssh.sh
  # then from your laptop:
  ssh -p 8822 root@<POD_IP>
  ```

- Pod can reach GitHub during install/update (temporarily unblock if you use WAN blocking):

  ```bash
  sh /home/dac/free-sleep/scripts/unblock_internet_access.sh
  ```

---

## Path A — Installer from GitHub (full replace of app tree)

Use this when migrating from upstream for the first time, or when you want a clean tree matching the fork’s `main`.

### First-time migration from upstream

On the Pod (as root):

```bash
# 1) Optional known-good backup of the running tree
cp -a /home/dac/free-sleep /home/dac/free-sleep-known-good

# 2) Optional data backup
cp -a /persistent/free-sleep-data /persistent/free-sleep-data-backup-$(date +%F)

# 3) Allow GitHub if WAN is blocked
sh /home/dac/free-sleep/scripts/unblock_internet_access.sh

# 4) Install THIS fork (not upstream)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/jmakes/free-sleep/main/scripts/install.sh)"
```

Or use the wrapper (same defaults):

```bash
curl -fsSL https://raw.githubusercontent.com/jmakes/free-sleep/main/scripts/install_from_fork.sh | sh
```

### Later updates on the Pod

After the fork is installed, these stay on the fork:

```bash
fs-update
# or
sh /home/dac/free-sleep/scripts/update.sh
# or GUI: Settings → Update free-sleep
```

Override branch for a one-off:

```bash
FREE_SLEEP_GITHUB_BRANCH=my-feature fs-update
```

### Verify

```bash
systemctl status free-sleep --no-pager
journalctl -u free-sleep -n 50 --no-pager
cat /home/dac/free-sleep/server/src/serverInfo.json
# Open http://<POD_IP>:3000/ — set a temperature and confirm hardware responds
```

Re-block WAN if you use that:

```bash
sh /home/dac/free-sleep/scripts/block_internet_access.sh
```

---

## Path B — rsync from a laptop (fast iteration)

Use this while developing. Does not require pushing to GitHub first.

```bash
# On your laptop, from the repo root:

# Build committed-style artifacts (server/dist + server/public)
./scripts/build_release.sh

# Deploy (SSH port 8822 by default)
./scripts/deploy_rsync.sh root@<POD_IP>
# or combined:
./scripts/deploy_rsync.sh root@<POD_IP> --port 8822 --build
```

What it does:

1. Optionally builds release artifacts.
2. Copies `/home/dac/free-sleep` → `/home/dac/free-sleep-rsync-backup-<timestamp>` on the Pod.
3. Stops Free Sleep services.
4. rsyncs the local tree (excludes `node_modules`, `.git`, local data).
5. Runs `npm install` on the Pod only if `package-lock.json` changed.
6. Restarts services.

Useful flags:

| Flag | Meaning |
|------|---------|
| `--build` | Run `build_release.sh` first |
| `--port 8822` | SSH port (default 8822) |
| `--skip-backup` | Do not copy remote tree (faster; less safe) |
| `--no-restart` | Leave services stopped |

---

## Building release artifacts

The Pod does **not** compile TypeScript/React. Installable builds ship:

- `server/dist/` — compiled server
- `server/public/` — built web UI

On a dev machine:

```bash
./scripts/build_release.sh
```

Commit those outputs when you want **Path A** (installer) users to receive UI/server changes. Path B can deploy uncommitted builds.

Version / update metadata: edit `server/src/serverInfo.json` then rebuild.

Suggested version scheme for this fork: `2.1.5-jmakes.N` (semver prerelease tags compare correctly for the GUI update check).

---

## Rollback

### After a failed `fs-update` / installer run

`update.sh` already restores `/home/dac/free-sleep-backup` if install fails. If the service is still bad:

```bash
systemctl stop free-sleep free-sleep-stream 2>/dev/null || true
rm -rf /home/dac/free-sleep
mv /home/dac/free-sleep-backup /home/dac/free-sleep   # if still present
# or:
# mv /home/dac/free-sleep-known-good /home/dac/free-sleep
systemctl start free-sleep
```

### After a bad rsync

```bash
systemctl stop free-sleep free-sleep-stream 2>/dev/null || true
rm -rf /home/dac/free-sleep
mv /home/dac/free-sleep-rsync-backup-YYYYMMDD-HHMMSS /home/dac/free-sleep
systemctl start free-sleep
```

### Back to stock upstream Free Sleep

```bash
sh /home/dac/free-sleep/scripts/unblock_internet_access.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/throwaway31265/free-sleep/main/scripts/install.sh)"
```

### Nuclear: OEM firmware

Pod 4 hardware reset / firmware reset returns to official Eight Sleep software (loses Free Sleep). See upstream `INSTALLATION.md`.

---

## What is safe / what is not

**Safe for normal fork work**

- Anything under `/home/dac/free-sleep`
- Free Sleep systemd units
- Data under `/persistent/free-sleep-data/` (still: backup before risky DB experiments)

**Avoid unless you know why**

- U-Boot / bootargs / partition layout
- Unmasking OEM updaters (`swupdate`, `defibrillator`, …)
- Deleting `/persistent/free-sleep-data` unless you intend a factory free-sleep reset (`fs-reset`)

Pod 4 is effectively unbrickable for Free Sleep–only app changes; the realistic failure mode is “service won’t start until reinstall/rollback over SSH.”

---

## Syncing with upstream later

```bash
git remote add upstream https://github.com/throwaway31265/free-sleep.git  # once
git fetch upstream
git merge upstream/main   # or rebase; resolve conflicts carefully around scripts/*
./scripts/build_release.sh
# test, then push to origin
```

Re-test install/update after merging anything under `scripts/`.

---

## Cover tap controls (this fork)

Per-side mappings live under **Settings → Side settings** (with away mode / name).

| Gesture | Default action (Pod 4) |
|---------|-------------------------|
| Single | *Not available over dac* (OEM snooze is cover-local while alarm rings) |
| Double | −1°F |
| Triple | +1°F |
| Quad | Write current target temp into the active schedule slot for **all days** |

- Haptic ack: N short ticks on the same side for an N-tap gesture.
- Toasts: on-screen confirmation when a multi-tap is handled.
- Probe: `GET /api/gestures/probe` — multi-tap stamps are last-event Unix times.

## Resource management (this fork)

| Policy | Default | Env override |
|--------|---------|--------------|
| Vitals retention | 30 days | `FREE_SLEEP_VITALS_RETENTION_DAYS` |
| Movement retention | 30 days | `FREE_SLEEP_MOVEMENT_RETENTION_DAYS` |
| Sleep records retention | 180 days | `FREE_SLEEP_SLEEP_RETENTION_DAYS` |
| Default metrics query window | 7 days (if no start/end) | `FREE_SLEEP_DEFAULT_QUERY_DAYS` |
| Max metrics query window | 31 days | `FREE_SLEEP_MAX_QUERY_DAYS` |
| Low-disk threshold | 150 MB free → tighter prune | `FREE_SLEEP_LOW_DISK_MB` |

- Automatic prune: a few minutes after boot, then every 6 hours.
- Manual prune: `fs-prune-db` or `POST /api/metrics/prune`
- Disk/DB visibility: `GET /api/metrics/stats`
- Unbounded `/api/metrics/vitals` (no time range) no longer scans the whole table.
- Server + stream logs default to **info** (set `LOG_LEVEL=debug` if needed).

## Quick reference

| Action | Command |
|--------|---------|
| Install/migrate to this fork | `curl -fsSL https://raw.githubusercontent.com/jmakes/free-sleep/main/scripts/install.sh \| bash` |
| Update on Pod | `fs-update` |
| Build on laptop | `./scripts/build_release.sh` |
| Deploy from laptop | `./scripts/deploy_rsync.sh root@<POD_HOST> --build` |
| Debug | `fs-debug` |
| Restart | `fs-restart` |
| Reset biometrics DB only | `fs-reset-db` |
| Prune aged metrics | `fs-prune-db` |
| Metrics stats | `curl http://<POD_HOST>:3000/api/metrics/stats` |

Config knobs (env or `scripts/repo_config.sh`):

- `FREE_SLEEP_GITHUB_OWNER` (default `jmakes`)
- `FREE_SLEEP_GITHUB_REPO` (default `free-sleep`)
- `FREE_SLEEP_GITHUB_BRANCH` (default `main`)
