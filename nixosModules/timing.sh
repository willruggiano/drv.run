# shellcheck shell=bash
# /proc/uptime is CLOCK_BOOTTIME (monotonic, includes suspend), at centisecond
# resolution. Do not mix it with systemd's CLOCK_MONOTONIC or another VM's clock.
phase() {
  local uptime _ io_pressure=/dev/null cpu_pressure=/dev/null
  read -r uptime _ </proc/uptime
  if [[ -r /proc/pressure/io ]]; then io_pressure=/proc/pressure/io; fi
  if [[ -r /proc/pressure/cpu ]]; then cpu_pressure=/proc/pressure/cpu; fi
  jq --null-input --compact-output \
    --arg phase "$1" --argjson monotonic_s "${2:-$uptime}" \
    --rawfile cpu /proc/stat --rawfile disks /proc/diskstats \
    --rawfile io_pressure "$io_pressure" --rawfile cpu_pressure "$cpu_pressure" \
    '{phase: $phase, clock: "boottime", monotonic_s: $monotonic_s, resolution_s: 0.01,
      cpu: $cpu, disks: $disks, io_pressure: $io_pressure, cpu_pressure: $cpu_pressure}' \
    >>"$timing_directory/timings.jsonl"
}
