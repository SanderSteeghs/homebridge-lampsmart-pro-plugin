import { createCipheriv } from 'crypto';
import crc from 'crc';

import type { LampCommand, BleContext } from './ble-advertiser.js';

const HEADER = [0xF0, 0x08];

const PREFIX = [0x20, 0x80, 0x00];
const DEVICE_TYPE = 0x0100;

const PACKET_LEN = 21;

export class LampSmartBleV2Packet {
  tx_count: number;
  type: number;
  identifier: number;
  group_index: number;
  command: number;
  args: Uint8Array;
  sign: number;
  spare: number;
  seed: number;
  crc16: number;

  constructor(buffer?: Uint8Array ) {
    buffer ??= new Uint8Array(PACKET_LEN).fill(0);

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;

    this.tx_count = view.getUint8(offset); offset++;
    this.type = view.getUint16(offset, true); offset += 2;
    this.identifier = view.getUint32(offset, true); offset += 4;
    this.group_index = view.getUint8(offset); offset++;
    this.command = view.getUint16(offset, true); offset += 2;
    this.args = buffer.slice(offset, offset + 4); offset += 4;
    this.sign = view.getUint16(offset, true); offset += 2;
    this.spare = view.getUint8(offset); offset++;
    this.seed = view.getUint16(offset, true); offset += 2;
    this.crc16 = view.getUint16(offset, true);
  }

  toUint8Array(): Uint8Array {
    const buffer = new Uint8Array(PACKET_LEN).fill(0);
    const view = new DataView(buffer.buffer);

    let offset = 0;
    view.setUint8(offset, this.tx_count); offset++;
    view.setUint16(offset, this.type, true); offset += 2;
    view.setUint32(offset, this.identifier, true); offset += 4;
    view.setUint8(offset, this.group_index); offset++;
    view.setUint16(offset, this.command, true); offset += 2;
    buffer.set(this.args, offset); offset += 4;
    view.setUint16(offset, this.sign, true); offset += 2;
    view.setUint8(offset, this.spare); offset++;
    view.setUint16(offset, this.seed, true); offset += 2;
    view.setUint16(offset, this.crc16, true);

    return buffer;
  }

  public static tryEncode(command: LampCommand, args: number[], context: BleContext): Uint8Array | undefined {
    if (args.length !== 4) {
      return undefined;
    }

    const packet = new LampSmartBleV2Packet();
    packet.tx_count = context.txCount;
    packet.type = DEVICE_TYPE;
    packet.identifier = context.deviceId;
    packet.command = command as number;
    packet.args = new Uint8Array(args);
    packet.group_index = context.groupIndex;
    packet.seed = Math.floor(Math.random() * 0xFFF5);

    const bytes = new Uint8Array(PREFIX.length + PACKET_LEN);
    bytes.set(PREFIX);
    bytes.set(packet.toUint8Array(), PREFIX.length);

    packet.sign = this.compute_sign(bytes.subarray(1), packet.tx_count, packet.seed);
    bytes.set(packet.toUint8Array(), PREFIX.length);

    const whitened = this.whiten(bytes.subarray(2).subarray(0, bytes.length - 6), packet.seed & 0xFF, 0);
    bytes.set(whitened, 2);

    // ...don't use toUint8Array since that would overwrite the whitened data ...
    packet.crc16 = this.compute_crc16(bytes.subarray(0, bytes.length - 2), ~(packet.seed));
    const view = new DataView(bytes.buffer);
    view.setUint16(22, packet.crc16, true);

    // add header
    const result = new Uint8Array(HEADER.length + bytes.length);
    result.set(HEADER);
    result.set(bytes, HEADER.length);

    return result;
  }

  public static tryDecode(fullBuffer: Uint8Array): LampSmartBleV2Packet | undefined {
    if (fullBuffer.length < HEADER.length + PREFIX.length + PACKET_LEN) {
      return undefined;
    }

    if (fullBuffer[0] !== HEADER[0] || fullBuffer[1] !== HEADER[1]) {
      return undefined;
    }

    const rawBuffer = fullBuffer.subarray(2);
    if (rawBuffer.length < PACKET_LEN + PREFIX.length) {
      return undefined;
    }

    if (rawBuffer[0] !== PREFIX[0] || rawBuffer[1] !== PREFIX[1]) {
      return undefined;
    }

    const seedView = new DataView(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
    const seed = seedView.getUint16(PREFIX.length + 17, true);

    const crc = this.compute_crc16(rawBuffer.subarray(0, rawBuffer.length - 2), ~(seed));
    const whitenData = this.whiten(rawBuffer.subarray(2).subarray(0, rawBuffer.length - 6), seed & 0xFF, 0);
    if (whitenData[0] !== PREFIX[2]) {
      // this does not matter for some reason
      return undefined;
    }

    // reconstruct the buffer with the whitened slice
    const buffer = new Uint8Array(PACKET_LEN + PREFIX.length);
    buffer.set(rawBuffer.subarray(0, 2));
    buffer.set(whitenData, 2);
    buffer.set(rawBuffer.subarray(2 + whitenData.length), 2 + whitenData.length);

    if (buffer.length < PACKET_LEN) {
      return undefined;
    }

    const packet = new LampSmartBleV2Packet(buffer.subarray(PREFIX.length));

    if (packet.crc16 !== crc) {
      return undefined;
    }

    if (packet.type !== DEVICE_TYPE) {
      return undefined;
    }

    if (packet.sign !== this.compute_sign(buffer.subarray(1), packet.tx_count, packet.seed)) {
      return undefined;
    }

    return packet;
  }

  toString(): string {
    return `
      tx_count: 0x${this.tx_count.toString(16).padStart(2, '0')}
      type: 0x${this.type.toString(16).padStart(4, '0')}
      identifier: 0x${this.identifier.toString(16).padStart(8, '0')}
      group_index: 0x${this.group_index.toString(16).padStart(2, '0')}
      command: 0x${this.command.toString(16).padStart(4, '0')}
      args: [${Array.from(this.args).map(x => `0x${x.toString(16).padStart(2, '0')}`).join(', ')}]
      sign: 0x${this.sign.toString(16).padStart(4, '0')}
      spare: 0x${this.spare.toString(16).padStart(2, '0')}
      seed: 0x${this.seed.toString(16).padStart(4, '0')}
      crc16: 0x${this.crc16.toString(16).padStart(4, '0')}
    `;
  }

  static whiten(data: Uint8Array, seed: number, salt: number): Uint8Array {
    const XBOXES = new Uint8Array([
      0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC,
      0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
      0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A,
      0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
      0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85,
      0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
      0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5,
      0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
      0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C,
      0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
      0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9,
      0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
      0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94,
      0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
      0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68,
      0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
    ]);

    const res = new Uint8Array(data);
    for (let i = 0; i < data.length; i++) {
      const index = (((seed + i + 9) & 0x1F) + ((salt & 0x3) * 0x20)) & 0x7F;
      res[i] ^= XBOXES[index];
      res[i] ^= seed;
    }

    return res;
  }

  static compute_sign(buf: Uint8Array, tx_count: number, seed: number): number {
    // Make sure seed is 16-bit
    seed = seed & 0xffff;

    const sigkey = Buffer.from([
      seed & 0xff,
      (seed >> 8) & 0xff,
      tx_count & 0xff,
      0x0D, 0xBF, 0xE6, 0x42, 0x68,
      0x41, 0x99, 0x2D, 0x0F, 0xB0,
      0x54, 0xBB, 0x16,
    ]);

    if (sigkey.length !== 16) {
      throw new Error('Key must be 16 bytes');
    }

    const iv = Buffer.alloc(0);

    const cipher = createCipheriv('aes-128-ecb', sigkey, iv);
    cipher.setAutoPadding(false); // no padding (we work on exactly 16 bytes)

    const plaintext = Buffer.from(buf.subarray(0, 16));
    const aes_out = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const sign = aes_out.readUInt16LE(0);

    return sign === 0 ? 0xffff : sign;
  }

  static compute_crc16(buf: Uint8Array, seed: number): number {
    return crc.crc16ccitt(buf, seed);
  }
}
