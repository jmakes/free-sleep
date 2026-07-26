#!/bin/bash
# -----------------------------------------------------------------------------
# Free Sleep fork source configuration
#
# Install and update scripts source this file when present on the Pod.
# Defaults target the jmakes fork. Override any value with an environment
# variable before running install/update, e.g.:
#
#   FREE_SLEEP_GITHUB_BRANCH=my-feature sh scripts/update.sh
#
# Upstream install (if you intentionally want stock Free Sleep again):
#   FREE_SLEEP_GITHUB_OWNER=throwaway31265 FREE_SLEEP_GITHUB_BRANCH=main \
#     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/throwaway31265/free-sleep/main/scripts/install.sh)"
# -----------------------------------------------------------------------------

FREE_SLEEP_GITHUB_OWNER="${FREE_SLEEP_GITHUB_OWNER:-jmakes}"
FREE_SLEEP_GITHUB_REPO="${FREE_SLEEP_GITHUB_REPO:-free-sleep}"
FREE_SLEEP_GITHUB_BRANCH="${FREE_SLEEP_GITHUB_BRANCH:-main}"

FREE_SLEEP_REPO_ZIP_URL="${FREE_SLEEP_REPO_ZIP_URL:-https://github.com/${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}/archive/refs/heads/${FREE_SLEEP_GITHUB_BRANCH}.zip}"
FREE_SLEEP_INSTALL_SCRIPT_URL="${FREE_SLEEP_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}/${FREE_SLEEP_GITHUB_BRANCH}/scripts/install.sh}"
FREE_SLEEP_UPDATE_CHECK_URL="${FREE_SLEEP_UPDATE_CHECK_URL:-https://raw.githubusercontent.com/${FREE_SLEEP_GITHUB_OWNER}/${FREE_SLEEP_GITHUB_REPO}/${FREE_SLEEP_GITHUB_BRANCH}/server/src/serverInfo.json}"

# GitHub archive extracts to "<repo>-<branch>" (slashes in branch names become dashes)
FREE_SLEEP_EXTRACTED_DIR="${FREE_SLEEP_EXTRACTED_DIR:-${FREE_SLEEP_GITHUB_REPO}-${FREE_SLEEP_GITHUB_BRANCH//\//-}}"

export FREE_SLEEP_GITHUB_OWNER
export FREE_SLEEP_GITHUB_REPO
export FREE_SLEEP_GITHUB_BRANCH
export FREE_SLEEP_REPO_ZIP_URL
export FREE_SLEEP_INSTALL_SCRIPT_URL
export FREE_SLEEP_UPDATE_CHECK_URL
export FREE_SLEEP_EXTRACTED_DIR
