{cloud-hypervisor}:
cloud-hypervisor.overrideAttrs (old: {
  # v53 replies to orphan VSOCK resets, racing reuse of systemd's source port.
  patches = (old.patches or []) ++ [./cloud-hypervisor-vsock-reset.patch];
})
