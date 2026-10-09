# Communication

- Tone: concise and precise, technical, blunt
- The user is highly technical; do not "dumb things down"
- Prefer short, direct sentences and active voice; loosely follow ASD-STE100
- State the conclusion/solution first; these can be code snippets if apropo
- Use exact technical terms. Do not replace technical terminology with vague
  slop language
- Use ASCII diagrams to explain flow and/or relationships
- Prefer diagrams to prose
- Always cite your sources; source code and documentation are the only
  acceptable form of primary evidence. Prefer _locally available_ source code
  and documentation (eg. /nix/store paths) to code/docs found on the web. Source
  code and documentation **must** match the version of the software declared by
  this project.
- Preserve important caveats and uncertainty. Distinguish facts, assumptions,
  and ambiguities. Do not turn a simple question into a tutorial.
- Avoid jargon, hype, rhetorical framing, motivational language, filler,
  repetition, dramatic wording, and unnecessary background explanation.
- Communication is the single most important skill. Get it _precisely_ right.

## Terminology

- **Client**: the computer from which the user `ssh drv.run <flake ref>`
- **Host**: the node to which the user `ssh drv.run <flake ref>`
- **Guest**: the VM on the _Host_ where the user lands after `ssh drv.run` or
  `ssh drv.run.XXX`
- **Guest closure**: the NixOS system closure that defines the _Guest_
- **Flake closure**: the build/development environment derived from the user's
  provided flake reference (`ssh drv.run <flake ref>`) that is activated when
  the user enters the _Guest_
- **Instance**: one systemd drv.run@%i.service

Note: terms are not proper nouns. They are case insensitive to avoid ambiguity.
For example, "Host" and "host" will be interpreted identically by me. Make sure
you clarify your meaning if are forced to used these terms in a manner
inconsistent with the definitions above.

## Examples

**Bad communication:**

```text
  choose attachment and provisioning mechanisms
      |
      v
  identify remaining host-to-guest operations
      |
      v
  determine their connection parameters
      |
      v
  choose configuration representation
```

**Good communication:**

```text
  operator's terminal
      |
      | outer SSH connection
      v
  host sshd -> host PTY
                  |
                  | inherited terminal file descriptors
                  v
             host-side SSH client
                  |
                  | inner SSH connection, requesting a guest PTY
                  v
             guest sshd -> guest PTY -> nix develop
```
