/**
 * @see {@link https://uefi.org/specs/UEFI/2.10/Apx_A_GUID_and_Time_Formats.html#efi-guid-format-apxa-guid-and-time-formats}
 */
function readGuid(buffer, offset) {
  const timeLow = buffer.getUint32(offset, true);
  const timeMid = buffer.getUint16(offset + 4, true);
  const timeHighAndVersion = buffer.getUint16(offset + 6, true);
  const clockSeqHighAndReserved = buffer.getUint8(offset + 8);
  const clockSeqLow = buffer.getUint8(offset + 9);
  // Node is always stored in big-endian format regardless of the integer field endianness
  const node = Array.from({ length: 6 }, (_, i) => buffer.getUint8(offset + 10 + i).toString(16).padStart(2, "0")).join("");

  return [
    timeLow.toString(16).padStart(8, "0"),
    timeMid.toString(16).padStart(4, "0"),
    timeHighAndVersion.toString(16).padStart(4, "0"),
    clockSeqHighAndReserved.toString(16).padStart(2, "0") + clockSeqLow.toString(16).padStart(2, "0"),
    node,
  ].join("-");
}

function writeGuid(buffer, offset, value) {
  const parts = value.split("-");
  if (parts.length !== 5) throw new Error("Invalid GUID format");

  const timeLow = Number.parseInt(parts[0], 16);
  const timeMid = Number.parseInt(parts[1], 16);
  const timeHighAndVersion = Number.parseInt(parts[2], 16);
  const clockSeq = Number.parseInt(parts[3], 16);
  const clockSeqHighAndReserved = (clockSeq >> 8) & 0xFF;
  const clockSeqLow = clockSeq & 0xFF;

  buffer.setUint32(offset, timeLow, true);
  buffer.setUint16(offset + 4, timeMid, true);
  buffer.setUint16(offset + 6, timeHighAndVersion, true);
  buffer.setUint8(offset + 8, clockSeqHighAndReserved);
  buffer.setUint8(offset + 9, clockSeqLow);

  const nodeHex = parts[4];
  for (let i = 0; i < 6; i++) {
    buffer.setUint8(offset + 10 + i, Number.parseInt(nodeHex.substring(i * 2, i * 2 + 2), 16));
  }
}


function readPartitionName(buffer) {
  const charCodes = [];
  for (let i = 0; i < 36; i++) {
    const charCode = buffer.getUint16(56 + i * 2, true);
    if (charCode === 0) break;
    charCodes.push(charCode);
  }
  return String.fromCharCode(...charCodes);
}

function writePartitionName(buffer, value) {
  const length = Math.min(value.length, 35);
  for (let i = 0; i < length; i++) {
    buffer.setUint16(56 + i * 2, value.charCodeAt(i), true);
  }
  buffer.setUint16(56 + length * 2, 0, true);
}


/**
 * @param {Uint8Array} data
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-header}
 */
export function readHeader(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    signature: new TextDecoder().decode(data.subarray(0, 8)),
    revision: view.getUint32(8, true),
    headerSize: view.getUint32(12, true),
    headerCrc32: view.getInt32(16, true),
    reserved: view.getUint32(20, true),
    currentLba: view.getBigUint64(24, true),
    alternateLba: view.getBigUint64(32, true),
    firstUsableLba: view.getBigUint64(40, true),
    lastUsableLba: view.getBigUint64(48, true),
    diskGuid: new Uint8Array(data.subarray(56, 72)),
    partEntriesStartLba: view.getBigUint64(72, true),
    numPartEntries: view.getUint32(80, true),
    partEntrySize: view.getUint32(84, true),
    partEntriesCrc32: view.getInt32(88, true),
  };
}

/** @param {ReturnType<typeof readHeader>} header */
export function writeHeader(header) {
  const data = new Uint8Array(92);
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode(header.signature).subarray(0, 8));
  view.setUint32(8, header.revision, true);
  view.setUint32(12, header.headerSize, true);
  view.setInt32(16, header.headerCrc32, true);
  view.setUint32(20, header.reserved, true);
  view.setBigUint64(24, header.currentLba, true);
  view.setBigUint64(32, header.alternateLba, true);
  view.setBigUint64(40, header.firstUsableLba, true);
  view.setBigUint64(48, header.lastUsableLba, true);
  data.set(header.diskGuid, 56);
  view.setBigUint64(72, header.partEntriesStartLba, true);
  view.setUint32(80, header.numPartEntries, true);
  view.setUint32(84, header.partEntrySize, true);
  view.setInt32(88, header.partEntriesCrc32, true);
  return data;
}

/**
 * @param {Uint8Array} data
 * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#gpt-partition-entry-array}
 */
export function readPartitionEntry(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: readGuid(view, 0),
    unique: readGuid(view, 16),
    startingLba: view.getBigUint64(32, true),
    endingLba: view.getBigUint64(40, true),
    /**
     * @see {@link https://uefi.org/specs/UEFI/2.10/05_GUID_Partition_Table_Format.html#defined-gpt-partition-entry-attributes}
     */
    attributes: view.getBigUint64(48, true),
    name: readPartitionName(view),
  };
}

/** @param {ReturnType<typeof readPartitionEntry>} entry */
export function writePartitionEntry(entry) {
  const data = new Uint8Array(128);
  const view = new DataView(data.buffer);
  writeGuid(view, 0, entry.type);
  writeGuid(view, 16, entry.unique);
  view.setBigUint64(32, entry.startingLba, true);
  view.setBigUint64(40, entry.endingLba, true);
  view.setBigUint64(48, entry.attributes, true);
  writePartitionName(view, entry.name);
  return data;
}
