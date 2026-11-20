# packages/pds

PDS owns the HTML/Datastar coding frontend and its retained pi-durable harness.
The product contract is [[packages/pds/SPEC.md]].

SSH suggestions use `PDS_KNOWN_HOSTS_DIR`, defaulting to `~/.ssh/known_hosts.d`;
an empty value disables suggestions. This selects only what PDS lists, not
OpenSSH's trust configuration. See [[tasks/050-infrastructure-contract.md]] for
the publication contract and [src/index.ts](src/index.ts) for startup
configuration.

Do not share application code with the retiring app. Keep the harness, patches,
and relevant tests in PDS rather than a standalone local harness package.

When contributing browser behavior, read
[Datastar's Tao](https://data-star.dev/guide/the_tao_of_datastar).
