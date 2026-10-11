#!/usr/bin/env bash
# The e2e job's resource probe (#393): GitHub-hosted runners were shut down mid-suite with no
# test failure, and a runner shutdown skips every later step, `if: always()` ones included. So
# the probe prints one line per sample into the log of the step it runs in, which the runner
# keeps up to the shutdown, and keeps full snapshots in a directory for the artifact.
#
#   e2e-resource-probe.sh <directory> [seconds]   sample until stopped (default every 15 s)
#   e2e-resource-probe.sh --report <directory>    print the peaks and any kernel OOM kills
#
# It reads Linux's /proc (E2E_PROBE_PROC points a test at fixtures); elsewhere the memory fields
# print as "-" and the process totals still work. It never fails the job: a reading it can't
# take prints as "-".
set -u

proc="${E2E_PROBE_PROC:-/proc}"

mib() { echo $(($1 / 1024)); }

meminfo() {
  awk -v key="$1:" '$1 == key { print $2; found = 1 } END { if (!found) print 0 }' "$proc/meminfo" 2>/dev/null || echo 0
}

# The six process names holding the most memory, as "<name> <count>/<MiB>", from one
# `ps -o rss= -o comm=` listing. Names, not fixed groups: Node tools retitle their processes
# (pnpm, wrangler, playwright), and Linux prints the name where macOS prints the path.
top_processes() {
  awk '{ n = split($2, path, "/"); name = path[n]; count[name]++; rss[name] += $1 }
    END { for (name in rss) printf "%d %s %d/%dM\n", rss[name], name, count[name], rss[name] / 1024 }' <<<"$1" |
    sort -n -r | head -n 6 | awk '{ printf "%s%s %s", (NR > 1 ? " " : ""), $2, $3 }'
}

if [ "${1:-}" = "--report" ]; then
  directory="${2:?usage: e2e-resource-probe.sh --report <directory>}"
  summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
  if [ ! -s "$directory/peak.txt" ]; then
    echo "No resource probe samples in $directory."
    exit 0
  fi
  {
    echo "### E2E runner resources (#393)"
    echo
    echo '```'
    cat "$directory/peak.txt"
    echo '```'
  } | tee -a "$summary"
  # The kernel's OOM killer, if it fired: the process it chose and its memory then.
  if kills="$(sudo -n dmesg 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process')" && [ -n "$kills" ]; then
    echo "Kernel OOM events:"
    echo "$kills" | tee "$directory/oom.txt"
  fi
  exit 0
fi

directory="${1:?usage: e2e-resource-probe.sh <directory> [seconds]}"
interval="${2:-15}"
mkdir -p "$directory"
start=$(date +%s)
oom_start=$(awk '$1 == "oom_kill" { print $2 }' "$proc/vmstat" 2>/dev/null)
samples=0
peak_used=0
least_available=-1
peak_swap=0
peak_line=""

trap 'exit 0' TERM INT

while :; do
  samples=$((samples + 1))
  elapsed=$(($(date +%s) - start))
  stamp=$(printf '+%02d:%02d' $((elapsed / 60)) $((elapsed % 60)))
  total=$(meminfo MemTotal)
  available=$(meminfo MemAvailable)
  swap_total=$(meminfo SwapTotal)
  swap_free=$(meminfo SwapFree)
  used=$((total - available))
  swap=$((swap_total - swap_free))
  pressure=$(awk '{ split($2, ten, "="); printf "%s%s", (NR > 1 ? "/" : ""), ten[2] }' "$proc/pressure/memory" 2>/dev/null)
  oom=$(awk -v base="${oom_start:-0}" '$1 == "oom_kill" { print $2 - base }' "$proc/vmstat" 2>/dev/null)
  load=$(cut -d ' ' -f 1 "$proc/loadavg" 2>/dev/null)
  disk=$(df -P / 2>/dev/null | awk 'NR == 2 { print $5 }')
  listing=$(ps -A -o rss= -o comm= 2>/dev/null)
  if [ "$total" -gt 0 ]; then
    memory="mem $(mib "$used")/$(mib "$total")M avail $(mib "$available")M swap $(mib "$swap")/$(mib "$swap_total")M"
  else
    memory="mem -"
  fi
  line="[resource-probe] $stamp $memory psi10 ${pressure:--} oom_kill ${oom:--} load ${load:--} disk ${disk:--}"
  line="$line top $(top_processes "$listing")"
  {
    echo "== $(date -u +%FT%TZ) $stamp"
    echo "$line"
    free -m 2>/dev/null
    df -h / "${GITHUB_WORKSPACE:-.}" 2>/dev/null
    echo "PID PPID RSS(KiB) %CPU ELAPSED COMMAND"
    ps -A -o pid= -o ppid= -o rss= -o pcpu= -o etime= -o args= 2>/dev/null | sort -k3 -n -r | head -n 30 | cut -c 1-240
  } >>"$directory/samples.log"
  if [ "$total" -gt 0 ]; then
    [ "$used" -gt "$peak_used" ] && peak_used=$used && peak_line=$line
    { [ "$least_available" -lt 0 ] || [ "$available" -lt "$least_available" ]; } && least_available=$available
    [ "$swap" -gt "$peak_swap" ] && peak_swap=$swap
    {
      echo "Samples: $samples over ${stamp#+}, every ${interval}s"
      echo "Peak used: $(mib "$peak_used") MiB of $(mib "$total") MiB; least available: $(mib "$least_available") MiB"
      echo "Peak swap: $(mib "$peak_swap") MiB of $(mib "$swap_total") MiB; OOM kills: ${oom:--}"
      echo "At the peak: ${peak_line#\[resource-probe\] }"
    } >"$directory/peak.txt.tmp" && mv "$directory/peak.txt.tmp" "$directory/peak.txt"
  fi
  # Last, so a sample in the log has its snapshot in the artifact.
  echo "$line"
  sleep "$interval" &
  wait $!
done
