# Nix's JSON interface supplies the hashes; never hash the mounted closure.
# Only compare content identity, not signatures, timestamps or derivers.
def identity:
  {narHash, narSize, references: (.references | sort)};
. as $image |
all(to_entries[];
  . as $entry |
  ($registered[0][$entry.key] // null) as $existing |
  ($entry.value.narHash | type == "string") and
  ($entry.value.narSize | type == "number" and . > 0) and
  ($entry.value.references | type == "array") and
  all($entry.value.references[]; . as $reference | $image | has($reference)) and
  ($existing == null or ($existing | identity) == ($entry.value | identity))
)
