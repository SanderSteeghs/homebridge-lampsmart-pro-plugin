import bleno from '@abandonware/bleno';
import noble from '@abandonware/noble';

import { Mutex } from 'async-mutex';

import { LampSmartBleV2Packet } from './lampsmart-ble-v2.js';

import type { Logging } from 'homebridge';

const DEVICE_NAME = 'HomebridgeHub';

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

function parseUint8ArrayToHexString(byteArray: Uint8Array): string[] {
  if (byteArray.length % 2 !== 0) {
    throw new Error('Uint8Array length must be even to convert into 16-bit hex pairs.');
  }

  const hexPairs: string[] = [];
  for (let i = 0; i < byteArray.length; i += 2) {
    const hexPair = (
      byteArray[i + 1].toString(16).padStart(2, '0') +
      byteArray[i].toString(16).padStart(2, '0')
    ).toLowerCase();

    hexPairs.push(hexPair);
  }

  return hexPairs;
}

export function parseHexStringToUint8Array(hexPairs: string[]): Uint8Array {

  // Convert each 16-bit hex pair into two bytes (little-endian order)
  const byteArray: number[] = [];
  for (const hex of hexPairs) {
    if (hex.length !== 4) {
      throw new Error('Invalid hex pair: ${hex} (expected length 4)');
    }

    // Convert the 16-bit hex pair to two 8-bit bytes
    const highByte = parseInt(hex.slice(0, 2), 16);
    const lowByte = parseInt(hex.slice(2, 4), 16);

    byteArray.push(lowByte, highByte);
  }

  return new Uint8Array(byteArray);
}

function startAdv(name: string, advData: string[]) {
  return new Promise<void>((resolve, reject) => {
    const onAdvertisingStart = (error?: Error | null) => {
      bleno.removeListener('advertisingStart', onAdvertisingStart);
      if (error) {
        return reject(error);
      }
      resolve();
    };

    bleno.on('advertisingStart', onAdvertisingStart);
    bleno.startAdvertising(name, advData, (err) => {
      if (err) {
        // If an error occurs immediately, clean up the listener.
        bleno.removeListener('advertisingStart', onAdvertisingStart);
        return reject(err);
      }
      // Otherwise, wait for the event to trigger.
    });
  });
}

function stopAdv(timeoutMs = 500): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;

    // Fallback timeout in case callback is never called.
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, timeoutMs);

    bleno.stopAdvertising(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

export enum LampCommand {
  On = 0x10,
  Off = 0x11,
  WarmColdColor = 0x21,
}

export class BleContext {

  public constructor(
    public readonly deviceId: number,
    public readonly groupIndex: number,
    public txCount: number,
  ) {};

}

export class BleAdvertiser {

  private queue: [LampCommand, Uint8Array][] = [];
  private readonly context: BleContext;
  private readonly mutex = new Mutex();

  constructor(
      public readonly log: Logging,
      deviceId: number) {
    this.context = new BleContext(deviceId, 0, 138);
  }

  public async start() {

    bleno.on('stateChange', (state: string) => {
      this.log.info(`[Bleno] State changed to: ${state}`);
    });

    // Wait until bleno is powered on.
    while (bleno.state !== 'poweredOn') {
      this.log.debug('Waiting for bleno to be powered on...');
      await delay(100);
    }
    this.log.debug('bleno powered on...');

    return this.loop();
  }

  public async turnOn() {
    await this.enqueuePacket(LampCommand.On, [0x00, 0x00, 0x00, 0x00]);
  }

  public async turnOff() {
    await this.enqueuePacket(LampCommand.Off, [0x00, 0x00, 0x00, 0x00]);
  }

  public async setColdWarmColor(cold: number, warm: number) {
    if (cold > 255) {
      this.log.warn('invalid cold temperature ', cold, '. Value exceeds maximum 255');
    }
    if (warm > 255) {
      this.log.warn('invalid cold temperature ', warm, '. Value exceeds maximum 255');
    }

    await this.enqueuePacket(LampCommand.WarmColdColor, [0x00, 0x00, cold, warm]);
  }

  async enqueuePacket(cmd: LampCommand, args: number[]) {
    const encoded =  LampSmartBleV2Packet.tryEncode(cmd, args, this.context);
    if (!encoded) {
      throw new Error('Failed to encode command');
    }

    await this.mutex.runExclusive(async () => {
      // replace all packets with the same command since the newest is the desired state
      this.queue = this.queue.filter(x => x[0] !== cmd);
      this.queue.push([cmd, encoded]);
      this.context.txCount += 1;
      this.context.txCount %= 140;
    });
  }

  async loop() {
    while (true) {
      let packet: [LampCommand, Uint8Array] | undefined;
      // Use the mutex to safely extract an item from the queue.
      await this.mutex.runExclusive(async () => {
        if (this.queue.length > 0) {
          packet = this.queue.shift();
        }
      });

      if (!packet) {
        await delay(100);
        continue;
      }

      const [cmd, encoded] = packet;
      this.log.debug(LampSmartBleV2Packet.tryDecode(encoded)?.toString() ?? 'could not decode adv data');

      const advData = parseUint8ArrayToHexString(encoded);

      try {
        // await stopAdv();
        await startAdv(DEVICE_NAME, advData);

        this.log.debug(`Advertising packet for command ${LampCommand[cmd]} started.`);
      } catch (err) {
        this.log.warn(`Failed to advertise packet for command ${LampCommand[cmd]}: ${err}`);
      }

      // Advertise this packet for 500ms
      await delay(500);

      try {
        await stopAdv();
        this.log.debug(`Advertising packet for command ${LampCommand[cmd]} stopped.`);
      } catch (err) {
        this.log.warn(`Failed to stop advertising for command ${LampCommand[cmd]}: ${err}`);
      }

      await delay(200);
    }
  }
}

// Useful when debugging existing app/remote
// not used in homebridge plugin
const SCANNING = false;
if (SCANNING) {
  noble.on('stateChange', (state: string) => {
    console.log(`[Noble] State changed to: ${state}`);
    if (state === 'poweredOn') {
    // The empty array [] means scan for all services.
    // The second parameter true means allow duplicate advertisements.
      noble.startScanning([], true, (error) => {
        if (error) {
          console.error(`[Noble] Scanning failed to start: ${error}`);
        } else {
          console.log('[Noble] Scanning started.');
        }
      });
    } else {
      noble.stopScanning();
      console.log('[Noble] Scanning stopped.');
    }
  });

  /**
 * Handle discovered peripherals (i.e., devices sending BLE advertisements).
 * The advertisement object is parsed by Noble and contains fields like localName,
 * manufacturerData, and serviceData.
 */
  noble.on('discover', (peripheral) => {
    const advertisement = peripheral.advertisement;

    if (!advertisement.serviceUuids) {
      return;
    }

    const packet = LampSmartBleV2Packet.tryDecode(parseHexStringToUint8Array(advertisement.serviceUuids));
    if (!packet) {
      return;
    }

    console.log('decoded lamp smart packet');
    console.log(packet);
  });
}