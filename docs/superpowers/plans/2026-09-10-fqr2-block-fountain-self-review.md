# FQR2 Implementation Plan Self-Review Amendments

This companion note records two corrections found during the mandatory plan self-review before implementation. It is part of the execution contract for `2026-09-10-fqr2-block-fountain.md`.

## 1. Deterministic vector values are fixed independently

For the fixed block hash

`00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff`

and `SEQ_NUM = 5`, seed material is the eight bytes:

`00 00 00 05 00 11 22 33`

SHA-256(seed material) must be:

`8dd21af39630ff5042c387a01e76136c6bcd202586e8f1f65a798a7879cd0fdf`

The initial xoshiro256** state words, read as four unsigned 64-bit big-endian integers, are:

- `0x8dd21af39630ff50`
- `0x42c387a01e76136c`
- `0x6bcd202586e8f1f6`
- `0x5a798a7879cd0fdf`

The first five xoshiro256** outputs must be:

- `0x2f6b92ad60b4ff56`
- `0x66a6e04a4d9e41fc`
- `0xb6a71f2dd5a4928e`
- `0x9e42fc45ff03454e`
- `0xd507e460c144c74d`

For `K = 4` and the same block hash, deterministic index selections are:

- `SEQ_NUM=1` -> `[0]`
- `SEQ_NUM=4` -> `[3]`
- `SEQ_NUM=5` -> `[0]`
- `SEQ_NUM=6` -> `[0]`
- `SEQ_NUM=7` -> `[3,0,1]`
- `SEQ_NUM=8` -> `[0]`
- `SEQ_NUM=9` -> `[0]`
- `SEQ_NUM=10` -> `[3]`
- `SEQ_NUM=11` -> `[1,3]`
- `SEQ_NUM=12` -> `[1]`
- `SEQ_NUM=13` -> `[1,0]`

With four 4-byte source symbols `00010203`, `10111213`, `20212223`, `30313233`, the mixed payload for `SEQ_NUM=7` (`[3,0,1]`) must equal `20212223`.

These values were computed independently from the written algorithm and must be hard-coded into tests. Production functions must never generate their own expected vectors.

## 2. Native camera ingestion is single-flight and non-queuing

The existing camera `frameLoop()` callback is synchronous, while FQR2 acceptance may perform asynchronous SHA-256 and persistent storage operations. FQR2 must therefore not permit concurrent `receiver.accept()` calls and must not build an unbounded promise/frame queue.

Native routing uses exactly one in-flight FQR2 accept operation:

```js
let fqr2AcceptBusy = false;

function routeFqr2Frame(decoded) {
  if (fqr2AcceptBusy) return;
  fqr2AcceptBusy = true;
  Promise.resolve(fqr2Receiver.accept(decoded))
    .catch(error => {
      status.textContent = error?.message || 'Could not decode this FQR2 frame.';
    })
    .finally(() => {
      fqr2AcceptBusy = false;
    });
}
```

A frame arriving while busy is intentionally dropped. Fountain repetition/repair tolerates loss, and dropping is preferable to violating the bounded-memory contract. Stop/mode change must invalidate the active receiver generation so completion from an older async operation cannot update a newer UI session.

Structural/native tests must assert this single-flight/no-queue behavior.
