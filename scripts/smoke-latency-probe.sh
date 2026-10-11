#!/usr/bin/env bash
# The staging smoke's latency probe (#417). The smoke stalled for minutes on page loads and API
# requests while Workers Observability showed the Worker answering in milliseconds, so the wait
# was before the Worker. Every few seconds this times two fresh requests from the runner with
# curl's phases (DNS, TCP connect, TLS, first byte, total) and the Cloudflare data center (colo)
# that answered:
# - `edge`: /cdn-cgi/trace, which Cloudflare answers without running the Worker, so it times the
#   runner's network path to Cloudflare;
# - `worker`: /robots.txt with the smoke-test header, which runs the Worker.
# A slow edge sample points at the path; a fast edge sample beside a slow worker first byte points
# at the Worker or its start-up. Compare the samples' times and colos with Observability.
#
#   smoke-latency-probe.sh <directory> <origin> [seconds]   sample until stopped (default every 5 s)
#   smoke-latency-probe.sh --report <directory>             print the summary and every slow sample
#
# It never fails the job: a request without an answer records curl's exit code.
set -u

# A sample at or over this many seconds, or without a 200, is slow.
slow=2

# The p50, p95 and maximum of the numbers on stdin, one per line (POSIX awk has no sort).
quantiles() {
  grep -E '^[0-9.]+$' | sort -n | awk '{ v[NR] = $1 } END {
    if (!NR) { print "- - -"; exit }
    p50 = int(NR * 0.5 + 0.999999); p95 = int(NR * 0.95 + 0.999999)
    printf "%.3f %.3f %.3f\n", v[p50], v[p95], v[NR]
  }'
}

if [ "${1:-}" = "--report" ]; then
  directory="${2:?usage: smoke-latency-probe.sh --report <directory>}"
  summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
  samples="$directory/samples.tsv"
  if [ ! -s "$samples" ]; then
    echo "No smoke latency samples in $directory."
    exit 0
  fi
  {
    echo "### Staging smoke latency (#417)"
    echo
    echo '```'
    for target in edge worker; do
      rows="$(awk -F '\t' -v target="$target" '$3 == target' "$samples")"
      if [ -z "$rows" ]; then
        printf '%-6s no samples\n' "$target"
        continue
      fi
      colos="$(cut -f 5 <<<"$rows" | sort -u | paste -s -d ' ' -)"
      bad="$(awk -F '\t' -v slow="$slow" '$4 != "200" || $11 + 0 >= slow { n++ } END { print n + 0 }' <<<"$rows")"
      read -r first50 first95 firstmax <<<"$(cut -f 10 <<<"$rows" | quantiles)"
      read -r total50 _ totalmax <<<"$(cut -f 11 <<<"$rows" | quantiles)"
      printf '%-6s %d samples, colo %s; first byte p50 %s s, p95 %s s, max %s s; total p50 %s s, max %s s; slow or failed %s\n' \
        "$target" "$(wc -l <<<"$rows" | tr -d ' ')" "$colos" "$first50" "$first95" "$firstmax" \
        "$total50" "$totalmax" "$bad"
    done
    echo
    echo "Slow (>= ${slow} s) or failed samples:"
    awk -F '\t' -v slow="$slow" '
      NR > 1 && ($4 != "200" || $11 + 0 >= slow) {
        printf "%s %s %-6s %s colo %s dns %s connect %s tls %s first byte %s total %s curl %s\n",
          $1, $2, $3, $4, $5, $7, $8, $9, $10, $11, $12; found = 1
      }
      END { if (!found) print "none" }' "$samples"
    echo '```'
  } | tee -a "$summary"
  exit 0
fi

directory="${1:?usage: smoke-latency-probe.sh <directory> <origin> [seconds]}"
origin="${2:?usage: smoke-latency-probe.sh <directory> <origin> [seconds]}"
origin="${origin%/}"
interval="${3:-5}"
mkdir -p "$directory"
samples="$directory/samples.tsv"
printf 'time\telapsed\ttarget\tcode\tcolo\tversion\tdns\tconnect\ttls\tfirst_byte\ttotal\tcurl_exit\n' >"$samples"
# Timings only: headers are read from a dump file, which works with any curl (%header needs 7.84).
format='%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}'
headers="$directory/headers.txt"
start=$(date +%s)

trap 'exit 0' TERM INT

# The value of one response header in the dump, or nothing.
header() {
  tr -d '\r' <"$headers" | awk -v name="$1" 'index(tolower($0), name ": ") == 1 { value = substr($0, length(name) + 3) } END { print value }'
}

# One request on a fresh connection: a TSV row from curl's timings and headers.
sample() {
  local target="$1" url="$2" stamp="$3" now="$4" result status code dns connect tls first total ray version
  shift 4
  : >"$headers"
  result="$(curl -sS -o /dev/null -D "$headers" --max-time 30 -w "$format" "$@" "$url" 2>/dev/null)"
  status=$?
  read -r code dns connect tls first total <<<"$result"
  # A Ray ID ends with the colo that answered: a490b8008d11eb92-ORD.
  ray="$(header cf-ray)"
  ray="${ray##*-}"
  version="$(header x-worker-version)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$stamp" "$target" \
    "${code:-000}" "${ray:--}" "${version:--}" "${dns:--}" "${connect:--}" "${tls:--}" \
    "${first:--}" "${total:--}" "$status" >>"$samples"
}

while :; do
  elapsed=$(($(date +%s) - start))
  stamp=$(printf '+%02d:%02d' $((elapsed / 60)) $((elapsed % 60)))
  now=$(date -u +%FT%TZ)
  sample edge "$origin/cdn-cgi/trace" "$stamp" "$now"
  sample worker "$origin/robots.txt" "$stamp" "$now" -H 'x-best-serp-co-smoke-test: 1'
  sleep "$interval" &
  wait $!
done
