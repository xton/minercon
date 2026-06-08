// src/test/fixtures/rcon/script.ts
//
// The single ordered sequence of `RconProtocol` calls that both the recorder
// (recordRconFixtures.ts, run by hand against a real server) and the replay
// suite (rconProtocol.test.ts, run as part of `npm test`) execute.
//
// Why this has to be shared and exact: `RconProtocol` assigns request IDs by
// a simple incrementing counter, so the bytes it produces for "the 2nd
// command sent on this connection" are only byte-identical to what was
// recorded if the replay genuinely *is* the 2nd command sent. Driving both
// modes from the same script is what keeps that alignment automatic — no
// fixture ever needs its IDs rewritten, and the `FakeSocket` can verify
// outgoing bytes match byte-for-byte (see fakeSocket.ts) as a regression
// guard on packet framing itself.
//
// The three commands were chosen to walk `RconProtocol` through its three
// distinct response shapes:
export const RCON_CONVERSATION_SCRIPT: readonly string[] = [
  'list',                                  // short — resolves from a single packet
  'minecraft:help',                        // long — reliably exceeds the 4096-byte
                                           // packet ceiling, exercising the
                                           // double-packet fragmentation reassembly.
                                           // (plain "help" gets paginated by some
                                           // servers — e.g. RconTabComplete — into
                                           // short single-page responses, which
                                           // defeats the point of this entry; the
                                           // namespaced form bypasses that)
  'this-command-does-not-exist-zzz12345',  // unknown command — server's error-response shape
];
