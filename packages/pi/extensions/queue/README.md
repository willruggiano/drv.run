# Queued compact extension

This `pi` extension enables you to queue `/compact` commands as
steering/follow-up messages. Without this extension, `/compact` commands are
sent as plain text messages (ie. literal "/compact").

See also: <https://github.com/earendil-works/pi/issues/1282>

## Usage

```pi
Implement JWT-based authentication<enter>
/compact<alt+enter>
Use a pi subprocess to independently review the new code<enter>
/compact<alt+enter>
Commit and publish a github pr<enter>
```

The result:

```pi
Ok I will implement JWT-based authentication.

.. Working...

Follow-up: /compact
Steering: Use a pi subprocess to independently review the new code
Follow-up: /compact
Commit and publish a github pr
↳ Alt+Up to edit all queued messages
```
