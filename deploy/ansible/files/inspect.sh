#!/bin/sh
set -eu
. /etc/os-release
printf 'UBUNTU=%s\n' "${ID:-unknown}:${VERSION_ID:-unknown}"
printf 'ARCH=%s\n' "$(uname -m)"
printf 'MEMORY=%s\n' "$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
printf 'DISK=%s\n' "$(df -Pk /opt 2>/dev/null | awk 'NR==2 {printf "%.0f", $4*1024}')"
if [ -c /dev/kvm ]; then echo KVM=1; else echo KVM=0; fi
if sudo -n true 2>/dev/null; then echo SUDO=1; else echo SUDO=0; fi
if [ -f /var/lib/apk-platform/install.lock ] || [ -d /var/lib/apk-platform/install.lock.d ]; then echo MARKER=1; else echo MARKER=0; fi
if [ -r /var/lib/apk-platform/node-id ]; then printf 'NODE_ID=%s\n' "$(cat /var/lib/apk-platform/node-id)"; fi
