# PR: fix A/B partition flags to match ABL

## Summary

`setActiveSlot()` and `getActiveSlot()` wrote and read A/B partition flags at wrong bit positions, 6 bits too high. This rewrites both to match [ABL's `SetActiveSlot()`](https://git.codelinaro.org/clo/qcomlt/abl/-/blob/LE.UM.2.3.7/QcomModulePkg/Library/BootLib/PartitionTableUpdate.c#L1233-1320) exactly.

## The bug

PR #92 ("rewrite GPT parsing") misinterpreted edl's `AB_FLAG_OFFSET = 6`. In edl, that's a **byte** offset into the 8-byte GPT attributes field (byte 6 = bits 48-55). The rewrite treated it as a **bit** offset to add to 48:

```js
// #92 introduced:
const ATTRIBUTE_FLAG_OFFSET = 48n;
const AB_FLAG_OFFSET = ATTRIBUTE_FLAG_OFFSET + 6n;  // = 54  (should be 48)
```

Every flag constant was then defined relative to this shifted base, landing 6 bits too high:

| Flag | Should be | Was | Written to |
|------|:---------:|:---:|:----------:|
| ACTIVE | bit 50 | `0x1<<2 << 54` | **bit 56** |
| SUCCESSFUL | bit 54 | `0x1<<6 << 54` | **bit 60** |
| UNBOOTABLE | bit 55 | `0x1<<7 << 54` | **bit 61** |
| RETRY | bits 51-53 | `0xF<<8 << 54` | **bits 62-65** |

ABL reads bits 48-55. Everything above 55 is ignored.

The original code (PR #54, "Fastboot → QDL") was correct — it used edl's magic bytes `0x6f`/`0x3a` shifted by `PART_ATT_PRIORITY_BIT = BigInt(48)`.

## Why it appeared to work

Within flash.comma.ai (the primary consumer of this library), `repairPartitionTables` always writes GPT images that contain **pre-set boot_a attributes**:

```
boot_a in GPT image: 0x003f000000000000
  → priority=3, active=1, retry=7, successful=0, unbootable=0
```

After the operator precedence fix in 6ff8067, the broken `setActiveSlot()` preserved bits 48-55 untouched (since its mask and writes only targeted bits 56+). So ABL booted using the GPT image's pre-set flags — not anything `setActiveSlot()` wrote.

The timeline:

1. **PR #54** — correct. Used `0x006f << 48n` / `0x003a << 48n` for boot partitions, toggled only ACTIVE for non-boot.
2. **PR #92** — broke it. `AB_FLAG_OFFSET = 48n + 6n = 54n`. Also had an operator precedence bug in `updateABFlags`: `~mask << offset` (destroys bits 0-53 due to `~` binding tighter than `<<`).
3. **6ff8067** — fixed precedence to `~(mask << offset)`. Now bits 48-55 are preserved, but writes still land at 56+. This is the version that "worked" — by accident of not touching the bits ABL reads.

## Why it matters now

With `retry=7` and `successful=0` from the GPT image, ABL gives the device 7 boot attempts to call `mark_boot_successful`. If the on-device tool that sets `SUCCESSFUL=1` also writes to the wrong bit (as happened with a rewritten `abctl`), ABL never sees it. After 7 boots, `retry=0, successful=0` → ABL marks the slot unbootable → brick.

This was confirmed on a live device: the ~7-reboot brick cycle matched `MAX_RETRY_COUNT=7` exactly.

## What changed

**Constants**: Replaced shifted-offset constants with absolute bit positions matching [ABL's `PartitionTableUpdate.h`](https://git.codelinaro.org/clo/qcomlt/abl/-/blob/LE.UM.2.3.7/QcomModulePkg/Include/Library/PartitionTableUpdate.h#L89-102):

```js
const PART_ATT_PRIORITY_BIT    = 48n;   // 2-bit field (0-3)
const PART_ATT_ACTIVE_BIT      = 50n;   // 1-bit
const PART_ATT_RETRY_CNT_BIT   = 51n;   // 3-bit field (0-7)
const PART_ATT_SUCCESS_BIT     = 54n;   // 1-bit
const PART_ATT_UNBOOTABLE_BIT  = 55n;   // 1-bit
```

**`setActiveSlot(slot)`**: Rewritten to match ABL's `SetActiveSlot()` + `MarkPtnActive()`:

| | Active boot | Inactive boot | Active non-boot | Inactive non-boot |
|---|---|---|---|---|
| **ABL** | pri=3, active=1, retry=7, succ=0, unboot=0 | pri=2, active=0, others unchanged | set ACTIVE only | clear ACTIVE only |
| **This PR** | same | same | same | same |
| **Before** | all flags at wrong bits | all flags at wrong bits | set active+unbootable at wrong bits | set unbootable at wrong bits |

**`getActiveSlot()`**: Now checks only `boot_*` partitions (matching ABL's `GetActiveSlot`), uses priority for tie-breaking, returns `null` instead of defaulting to `"a"` when no active slot is found.

**Removed**: `updateABFlags()` — the generic flag-setting function that encoded the wrong offset. Flag manipulation is now inline in `setActiveSlot()` with explicit bitmask operations matching ABL.

## Test plan

- [ ] `bun test` passes
- [ ] `bun lint` passes
- [ ] Flash a device via flash.comma.ai, verify it boots
- [ ] `printgpt` after flash shows correct boot_a attributes: `0x003f000000000000` (pri=3, active=1, retry=7, succ=0, unboot=0)
- [ ] After device boots and calls `mark_boot_successful`, boot_a shows `successful=1` at bit 54
