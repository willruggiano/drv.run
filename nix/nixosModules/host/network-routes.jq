# Inspect every routing table, including local and policy-routing tables.
# Default routes are expected. More-specific overlapping routes are not.
def ip_number:
  split(".") | map(tonumber) | reduce .[] as $octet (0; . * 256 + $octet);
def range:
  split("/") as $parts |
  ($parts[0] | ip_number) as $start |
  [ $start, $start + pow(2; 32 - (($parts[1] // "32") | tonumber)) ];
. as $routes |
all($config[0].slots[];
  . as $slot | ($slot.subnet | range) as $pool |
  all($routes[];
    . as $route |
    if (.dst // "default") == "default" then true
    # Only after network.sh has verified this existing TAP's identity/address.
    elif .dev == $slot.tap and .protocol == "kernel" then true
    else (.dst | range) as $route_range |
      $route_range[1] <= $pool[0] or $route_range[0] >= $pool[1]
    end
  )
)
