import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { LampSmartPlatform } from './lampsmart-platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Lampsmart {
  private service: Service;

  private readonly minColorTemp = 140;
  private readonly maxColorTemp = 500;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private state = {
    On: false,
    Brightness: 100,
    ColorTemperature: 140,
  };

  constructor(
    private readonly platform: LampSmartPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.state.ColorTemperature = this.minColorTemp;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'LampSmart')
      .setCharacteristic(this.platform.Characteristic.Model, 'Unknown')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Unknown');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this)); // SET - bind to the `setBrightness` method below

    this.service.addOptionalCharacteristic(this.platform.Characteristic.ColorTemperature);
    this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .updateValue(this.minColorTemp)
      .setProps({
        minValue: this.minColorTemp,
        maxValue: this.maxColorTemp,
      })
      .onSet(this.setColorTemperature.bind(this));
  }

  async setOn(value: CharacteristicValue) {
    this.state.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);
  }

  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.state.On;

    this.platform.log.debug('Get Characteristic On ->', isOn);
    return isOn;
  }

  async setBrightness(value: CharacteristicValue) {
    this.state.Brightness = value as number;

    this.platform.log.debug('Set Characteristic Brightness -> ', value);
    await this.setColdWarmColor(this.state.Brightness, this.state.ColorTemperature);
  }

  async setColorTemperature(value: CharacteristicValue) {
    this.state.ColorTemperature = value as number;

    this.platform.log.debug('Set Characteristic ColorTemperature -> ', value);
    await this.setColdWarmColor(this.state.Brightness, this.state.ColorTemperature);
  }

  async setColdWarmColor(brightness: number, minreds: number) {

    if (minreds < this.minColorTemp || minreds > this.maxColorTemp) {
      this.platform.log.error('Mired value out of range (140-500) ', minreds);
      return;
    }

    let wwLevel = (minreds - this.minColorTemp) / (this.maxColorTemp - this.minColorTemp);
    wwLevel = Math.min(1, Math.max(0, wwLevel));

    let cwLevel = 1 - wwLevel;
    cwLevel = Math.min(1, Math.max(0, cwLevel));

    brightness = brightness / 100; // range [0, 1]

    const whiteLevel = (this.state.On ? 1 : 0) * brightness;
    const coldColor = whiteLevel * cwLevel; // range [0, 1]
    const warmColor = whiteLevel * wwLevel; // range [0, 1]

    this.platform.log.debug('Set new Cold/Warm Color -> ', coldColor * 100, '/', warmColor * 100);
    this.platform.bleHandler.setColdWarmColor(coldColor * 255, warmColor * 255);
  }
}
