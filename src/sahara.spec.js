import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { Sahara } from "./sahara";


const PACKETS = [
  {
    name: "hello",
    hex: "010000003000000002000000010000000000100003000000010000000200000003000000040000000500000006000000",
    cmd: 1,
    data: { cmd: 1, len: 48, version: 2, version_supported: 1, cmd_packet_length: 0x100000, mode: 3,
      reserved1: 1, reserved2: 2, reserved3: 3, reserved4: 4, reserved5: 5, reserved6: 6 },
  },
  { name: "done", hex: "060000000c000000ffffffff", cmd: 6,
    data: { cmd: 6, len: 12, image_tx_status: 0xFFFFFFFF } },
  { name: "end transfer", hex: "04000000100000000c00000001000000", cmd: 4,
    data: { cmd: 4, len: 16, image_id: 12, image_tx_status: 1 } },
  { name: "64-bit read", hex: "12000000200000000c00000000000000ffffffffffff1f00ffffffffffffffff", cmd: 18,
    data: { cmd: 18, len: 32, image_id: 12, data_offset: Number.MAX_SAFE_INTEGER, data_len: 2 ** 64 } },
  { name: "execute response", hex: "0e0000001000000001000000ffff0000", cmd: 14,
    data: { cmd: 14, len: 16, client_cmd: 1, data_len: 65535 } },
  { name: "command ready", hex: "0b00000008000000", cmd: 11, data: null },
  { name: "reset response", hex: "0800000008000000", cmd: 8, data: null },
];

function packetBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function responseReader(bytes) {
  return new Sahara({ read: async () => bytes }, new ArrayBuffer(0));
}

afterEach(() => {
  mock.restore();
});

describe("Sahara responses", () => {
  for (const packet of PACKETS) {
    test(`decodes ${packet.name} from a nonzero byte offset`, async () => {
      const bytes = packetBytes(packet.hex);
      const storage = new Uint8Array(bytes.length + 16).fill(0xA5);
      storage.set(bytes, 7);
      const response = await responseReader(storage.subarray(7, 7 + bytes.length)).getResponse();
      expect(response).toEqual({ cmd: packet.cmd, data: packet.data });
    });

    test(`rejects truncated ${packet.name} packets`, async () => {
      spyOn(console, "error").mockImplementation(() => undefined);
      const bytes = packetBytes(packet.hex);
      for (let length = 0; length < bytes.length; length++) {
        // The full packet remains in the backing buffer, outside the visible view.
        expect(await responseReader(bytes.subarray(0, length)).getResponse()).toEqual({});
      }
    });
  }

  test("handles XML, empty data, and unknown commands", async () => {
    expect(await responseReader(new TextEncoder().encode("<?xml version=\"1.0\"?><data/>"))
      .getResponse()).toEqual({ firehose: "yes" });
    expect(await responseReader(new Uint8Array()).getResponse()).toEqual({});
    spyOn(console, "error").mockImplementation(() => undefined);
    expect(await responseReader(packetBytes("ff00000008000000")).getResponse()).toEqual({});
  });

  test("connect requires a complete command header", async () => {
    expect(await responseReader(packetBytes(PACKETS[0].hex)).connect()).toBe("sahara");
    await expect(responseReader(packetBytes("01000000")).connect()).rejects.toBeInstanceOf(RangeError);
  });
});
