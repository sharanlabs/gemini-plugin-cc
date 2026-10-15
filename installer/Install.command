#!/bin/sh
installer_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/bin/sh "$installer_root/installer/bootstrap.sh" "$@"
result=$?
printf '\nPress Enter to close this window.\n'
read -r unused
exit "$result"
