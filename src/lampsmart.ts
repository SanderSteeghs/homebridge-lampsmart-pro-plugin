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
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

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
      .onSet(this.setColorTemperature.bind(this)); // SET - bind to the `setColorTemperature` method below
  }

  async setOn(value: CharacteristicValue) {
    this.state.On = value as boolean;

    this.platform.log.debug('Set Characteristic On ->', value);

    if (value) {
      this.platform.bleHandler.turnOn();
    } else {
      this.platform.bleHandler.turnOff();
    }
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

    const midPoint = this.minColorTemp + (this.maxColorTemp - this.minColorTemp) / 2;
    const midRange = midPoint - this.minColorTemp;

    let warmColor = undefined;
    let coldColor = undefined;
    if (minreds < midPoint) {
      coldColor = (2.55 * brightness);
      warmColor = ((2.55 * brightness) / midRange) * (minreds - this.minColorTemp);
    } else {
      coldColor = ((2.55 * brightness) / midRange) * (this.maxColorTemp - minreds);
      warmColor = (2.55 * brightness);
    }

    warmColor = Math.round(warmColor);
    coldColor = Math.round(coldColor);

    this.platform.log.debug('Set new brightness and minreds', brightness, minreds);
    this.platform.log.debug('Set new Cold/Warm Color -> ', coldColor, '/', warmColor);
    await this.platform.bleHandler.setColdWarmColor(coldColor, warmColor);
  }
}
