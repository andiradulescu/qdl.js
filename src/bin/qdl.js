#!/usr/bin/env bun
import arg from "arg";

import { createProgress, createQdl } from "../cli";

const args = arg({
  "--help": Boolean,
  "-h": "--help",
  "--programmer": String,
  "--log-level": String,
  "-l": "--log-level",
});

const { _: commands } = args;

const help = `Usage: qdl.js <command> [...flags] [...args]

Commands:
  reset                                Reboot the device
  getactiveslot                        Get the active slot
  setactiveslot <slot>                 Set the active slot (a or b)
  getstorageinfo                       Print UFS information
  printgpt                             Print GPT luns and partitions
  repairgpt <lun> <image>              Repair GPT by flashing primary table and creating backup table
  erase <partition>                    Erase a partition
  flash <partition> <image>            Flash an image to a partition
  testroundtrip                        Test GPT entry parse/serialize round-trip on all LUNs

Slot suffixes (_a/_b) are auto-detected from the active slot when omitted.

Flags:
  --programmer <url>                   Use a different loader [default is comma 3/3X]
  --log-level, -l <level>              Set log level (silent, error, warn, info, debug) [default is info]
  -h, --help                           Display this menu and exit`;

if (args["--help"] || commands.length === 0) {
  console.info(help);
  process.exit(0);
}

if (args["--log-level"]) {
  // Set environment variable so it's passed to the QDL instance
  process.env.QDL_LOG_LEVEL = args["--log-level"].toLowerCase();
}

const qdl = await createQdl(args["--programmer"]);

const [command, ...commandArgs] = args._;
if (command === "reset") {
  await qdl.reset();
} else if (command === "getactiveslot") {
  const activeSlot = await qdl.getActiveSlot();
  console.info(activeSlot);
} else if (command === "setactiveslot") {
  if (commandArgs.length !== 1) {
    console.error("Expected slot name (a or b)");
    process.exit(1);
  }
  const [slot] = commandArgs;
  if (slot !== "a" && slot !== "b") {
    console.error("Slot must be 'a' or 'b'");
    process.exit(1);
  }
  await qdl.setActiveSlot(slot);
} else if (command === "getstorageinfo") {
  const storageInfo = await qdl.getStorageInfo();
  storageInfo.serial_num = storageInfo.serial_num.toString(16).padStart(8, "0");
  console.info(storageInfo);
} else if (command === "printgpt") {
  for (const lun of qdl.firehose.luns) {
    console.info(`LUN ${lun}`);

    console.info("\nPrimary GPT:");
    const primaryGpt = await qdl.getGpt(lun, 1n);
    console.table(primaryGpt.getPartitions());

    console.info("\nBackup GPT:");
    const backupGpt = await qdl.getGpt(lun, primaryGpt.alternateLba);
    console.table(backupGpt.getPartitions());

    const consistentPartEntries = primaryGpt.partEntriesCrc32 === backupGpt.partEntriesCrc32;
    if (!consistentPartEntries) {
      console.warn("\nPrimary and backup GPT partition entries are inconsistent");
    }

    console.info("\n\n");
  }
} else if (command === "repairgpt") {
  if (commandArgs.length !== 2) throw "Usage: qdl.js repairgpt <lun> <image>";
  const lun = Number.parseInt(commandArgs[0], 10);
  if (Number.isNaN(lun)) throw "Expected physical partition number";
  const image = Bun.file(commandArgs[1]);
  await qdl.repairGpt(lun, image);
} else if (command === "erase") {
  if (commandArgs.length !== 1) {
    console.error("Expected partition name");
    process.exit(1);
  }
  let [partitionName] = commandArgs;
  // Auto-detect active slot if partition name doesn't have a slot suffix
  if (!partitionName.endsWith("_a") && !partitionName.endsWith("_b")) {
    const [found] = await qdl.detectPartition(partitionName);
    if (!found) {
      const activeSlot = await qdl.getActiveSlot();
      partitionName = `${partitionName}_${activeSlot}`;
      console.info(`[qdl] Detected active slot ${activeSlot}, using ${partitionName}`);
    }
  }
  await qdl.erase(partitionName);
} else if (command === "flash") {
  if (commandArgs.length !== 2) {
    console.error("Expected partition name and image path");
    process.exit(1);
  }
  let [partitionName, imageName] = commandArgs;
  // Auto-detect active slot if partition name doesn't have a slot suffix
  if (!partitionName.endsWith("_a") && !partitionName.endsWith("_b")) {
    const [found] = await qdl.detectPartition(partitionName);
    if (!found) {
      const activeSlot = await qdl.getActiveSlot();
      partitionName = `${partitionName}_${activeSlot}`;
      console.info(`[qdl] Detected active slot ${activeSlot}, using ${partitionName}`);
    }
  }
  const image = Bun.file(imageName);
  await qdl.flashBlob(partitionName, image, createProgress(image.size));
} else if (command === "testroundtrip") {
  const { buf: crc32 } = await import("crc-32");
  const { GPT } = await import("../gpt.js");
  const sectorSize = qdl.firehose.cfg.SECTOR_SIZE_IN_BYTES;
  let allMatch = true;

  for (const lun of qdl.firehose.luns) {
    const gpt = new GPT(sectorSize);
    const headerData = await qdl.firehose.cmdReadBuffer(lun, 1n, 1);
    if (!gpt.parseHeader(headerData, 1n)) {
      console.info(`LUN ${lun}: no valid GPT`);
      continue;
    }

    const rawEntries = await qdl.firehose.cmdReadBuffer(lun, gpt.partEntriesStartLba, gpt.partEntriesSectors);
    gpt.parsePartEntries(rawEntries);
    const roundTripped = gpt.buildPartEntries();

    const crcLen = gpt.numPartEntries * gpt.partEntrySize;
    const rawCrc = crc32(rawEntries.subarray(0, crcLen));
    const rtCrc = crc32(roundTripped);

    if (rawCrc === rtCrc) {
      console.info(`LUN ${lun}: OK (${gpt.numPartEntries} entries)`);
      continue;
    }

    allMatch = false;
    console.error(`LUN ${lun}: MISMATCH — raw CRC ${rawCrc} vs round-trip CRC ${rtCrc}`);
    for (let i = 0; i < crcLen; i++) {
      if (rawEntries[i] !== roundTripped[i]) {
        const entryIdx = Math.floor(i / gpt.partEntrySize);
        const byteOff = i % gpt.partEntrySize;
        let field = "unknown";
        if (byteOff < 16) field = "type GUID";
        else if (byteOff < 32) field = "unique GUID";
        else if (byteOff < 40) field = "firstLba";
        else if (byteOff < 48) field = "lastLba";
        else if (byteOff < 56) field = "attributes";
        else field = "name";
        console.error(`  entry[${entryIdx}] byte ${byteOff} (${field}): raw=0x${rawEntries[i].toString(16).padStart(2, "0")} rt=0x${roundTripped[i].toString(16).padStart(2, "0")}`);
      }
    }
  }

  if (allMatch) console.info("All LUNs OK");
} else {
  console.error(`Unrecognized command: ${commands[0]}`);
  console.info(`\n${help}`);
  process.exit(1);
}

qdl.firehose.flushDeviceMessages();
process.exit(0);
