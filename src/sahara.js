import { cmd_t, sahara_mode_t, status_t, exec_cmd_t } from "./saharaDefs"
import { containsBytes, packGenerator, runWithTimeout } from "./utils";
import { createLogger } from "./logger";
import { toXml } from "./xml";

/** @param {DataView} view */
function readCommandHeader(view) {
  return { cmd: view.getUint32(0, true), len: view.getUint32(4, true) };
}

const logger = createLogger("sahara");


export class Sahara {
  /**
   * @param {usbClass} cdc
   * @param {ArrayBuffer} programmer
   */
  constructor(cdc, programmer) {
    this.cdc = cdc;
    this.programmer = programmer;
    this.id = null;
    this.serial = "";
    this.mode = "";
  }

  /**
   * @returns {Promise<string>}
   */
  async connect() {
    let respPromise = this.cdc.read(0xC * 0x4);
    let resp = await runWithTimeout(respPromise, 500).catch(() => new Uint8Array());
    if (resp.length > 1) {
      if (resp[0] === 0x01) {
        const pkt = readCommandHeader(new DataView(resp.buffer, resp.byteOffset, resp.byteLength));
        if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
          return "sahara";
        }
        if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
          return "sahara";
        }
        throw "Sahara - Connect failed: unknown command";
      }
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
    } else {
      try {
        await runWithTimeout(this.cdc.write(new TextEncoder().encode(toXml("nop"))), 1000);
        if (!resp) respPromise = this.cdc.read();
        resp = await runWithTimeout(respPromise, 2000).catch(() => new Uint8Array());
      } catch {
        resp = new Uint8Array();
      }
      if (containsBytes("<?xml", resp)) {
        return "firehose";
      }
      if (resp[0] === cmd_t.SAHARA_END_TRANSFER) {
        return "sahara";
      }
    }
    logger.error("Device is in Sahara error state, please reboot the device.");
    return "error";
  }

  async cmdHello(mode, version=2, version_min=1, max_cmd_len=0) {
    const cmd = cmd_t.SAHARA_HELLO_RSP;
    const len = 0x30;
    const elements = [cmd, len, version, version_min, max_cmd_len, mode, 1, 2, 3, 4, 5, 6];
    const responseData = packGenerator(elements);
    await this.cdc.write(responseData);
    return true;
  }

  async cmdModeSwitch(mode) {
    const elements = [cmd_t.SAHARA_SWITCH_MODE, 0xC, mode];
    const data = packGenerator(elements);
    await this.cdc.write(data);
    return true;
  }

  /**
   * @returns {Promise<{}|{firehose: string}|{cmd: *, data: null}|{cmd: *, data: *}>}
   */
  async getResponse() {
    try {
      const data = await this.cdc.read();
      if (data.length === 0) {
        return {};
      }
      const dataText = new TextDecoder("utf-8").decode(data);
      if (dataText.includes("<?xml")) {
        return { "firehose": "yes" };
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const pkt = readCommandHeader(view);
      if (pkt.cmd === cmd_t.SAHARA_HELLO_REQ) {
        return { "cmd": pkt.cmd, "data": {
          ...pkt,
          version: view.getUint32(8, true),
          version_supported: view.getUint32(12, true),
          cmd_packet_length: view.getUint32(16, true),
          mode: view.getUint32(20, true),
          reserved1: view.getUint32(24, true),
          reserved2: view.getUint32(28, true),
          reserved3: view.getUint32(32, true),
          reserved4: view.getUint32(36, true),
          reserved5: view.getUint32(40, true),
          reserved6: view.getUint32(44, true),
        } };
      }
      if (pkt.cmd === cmd_t.SAHARA_DONE_RSP) {
        return { "cmd": pkt.cmd, "data": { ...pkt, image_tx_status: view.getUint32(8, true) } };
      }
      if (pkt.cmd === cmd_t.SAHARA_END_TRANSFER) {
        return { "cmd": pkt.cmd, "data": {
          ...pkt, image_id: view.getUint32(8, true), image_tx_status: view.getUint32(12, true),
        } };
      }
      if (pkt.cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        return { "cmd": pkt.cmd, "data": {
          ...pkt,
          image_id: Number(view.getBigUint64(8, true)),
          data_offset: Number(view.getBigUint64(16, true)),
          data_len: Number(view.getBigUint64(24, true)),
        } };
      }
      if (pkt.cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        return { "cmd": pkt.cmd, "data": {
          ...pkt, client_cmd: view.getUint32(8, true), data_len: view.getUint32(12, true),
        } };
      }
      if (pkt.cmd === cmd_t.SAHARA_CMD_READY || pkt.cmd === cmd_t.SAHARA_RESET_RSP) {
        return { "cmd": pkt.cmd, "data": null };
      }
      logger.error("Didn't match any cmd_t");
      return {};
    } catch (error) {
      logger.error(error);
      return {};
    }
  }

  async cmdExec(mcmd) {
    const dataToSend = packGenerator([cmd_t.SAHARA_EXECUTE_REQ, 0xC, mcmd]);
    await this.cdc.write(dataToSend);
    const res = await this.getResponse();
    if ("cmd" in res) {
      const cmd = res.cmd;
      if (cmd === cmd_t.SAHARA_EXECUTE_RSP) {
        const pkt = res.data;
        const data = packGenerator([cmd_t.SAHARA_EXECUTE_DATA, 0xC, mcmd]);
        await this.cdc.write(data);
        return await this.cdc.read(pkt.data_len);
      }
      if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        throw "Sahara - error while executing command";
      }
      return null;
    }
    return res;
  }

  async cmdGetSerialNum() {
    const res = await this.cmdExec(exec_cmd_t.SAHARA_EXEC_CMD_SERIAL_NUM_READ);
    if (res === null) {
      throw "Sahara - Unable to get serial number of device";
    }
    const data = new DataView(res.buffer, 0).getUint32(0, true);
    return `0x${data.toString(16).padStart(8,'0')}`
  }

  async enterCommandMode() {
    if (!await this.cmdHello(sahara_mode_t.SAHARA_MODE_COMMAND)) {
      return false;
    }
    const res = await this.getResponse();
    if ("cmd" in res) {
      if (res.cmd === cmd_t.SAHARA_END_TRANSFER) {
        if ("data" in res) {
          return false;
        }
      } else if (res.cmd === cmd_t.SAHARA_CMD_READY) {
        return true;
      }
    }
    return false;
  }

  async uploadLoader() {
    if (!(await this.enterCommandMode())) {
      throw "Sahara - Failed to enter command mode in Sahara";
    }
    this.serial = await this.cmdGetSerialNum();
    await this.cmdModeSwitch(sahara_mode_t.SAHARA_MODE_COMMAND);

    await this.connect();
    logger.debug("Uploading loader...");
    if (!(await this.cmdHello(sahara_mode_t.SAHARA_MODE_IMAGE_TX_PENDING))) {
      throw "Sahara - Error while uploading loader";
    }

    const start = performance.now();
    let remainingBytes = this.programmer.byteLength;
    while (remainingBytes >= 0) {
      const resp = await this.getResponse();
      if (!resp || !("cmd" in resp)) {
        throw "Sahara - Timeout while uploading loader. Wrong loader?";
      }
      const { cmd, data: pkt } = resp;
      if (cmd === cmd_t.SAHARA_64BIT_MEMORY_READ_DATA) {
        const { image_id, data_offset, data_len } = pkt;
        this.id = image_id;
        if (this.id < 0xC) {
          throw "Sahara - Unknown sahara id";
        }
        if (this.mode !== "firehose") {
          logger.debug("Firehose mode detected, uploading...");
          this.mode = "firehose";
        }

        let dataToWrite;
        if (data_offset + data_len > this.programmer.byteLength) {
          dataToWrite = new Uint8Array(data_len);
          if (data_offset < this.programmer.byteLength) {
            dataToWrite.set(new Uint8Array(this.programmer, data_offset, this.programmer.byteLength - data_offset));
          }
        } else {
          dataToWrite = new Uint8Array(this.programmer, data_offset, data_len);
        }

        await this.cdc.write(dataToWrite);
        remainingBytes -= data_len;
      } else if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        if (pkt.image_tx_status === status_t.SAHARA_STATUS_SUCCESS) {
          if (!await this.cmdDone()) {
            throw "Sahara - Failed to upload loader";
          }
          logger.debug(`Loader successfully uploaded in ${(performance.now() - start).toFixed(3)}ms`);
          return this.mode;
        }
      }
    }
    return this.mode;
  }

  async cmdDone() {
    const toSendData = packGenerator([cmd_t.SAHARA_DONE_REQ, 0x8]);
    await this.cdc.write(toSendData);
    const res = await this.getResponse();
    if ("cmd" in res) {
      const cmd = res.cmd;
      if (cmd === cmd_t.SAHARA_DONE_RSP) {
        return true;
      }
      if (cmd === cmd_t.SAHARA_END_TRANSFER) {
        if ("data" in res) {
          const pkt = res.data;
          if (pkt.image_tx_status === status_t.SAHARA_NAK_INVALID_CMD) {
            logger.error("Invalid transfer command received");
            return false;
          }
        }
      } else {
        throw "Sahara - Received invalid response";
      }
    }
    return false;
  }
}
