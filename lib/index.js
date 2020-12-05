/* jshint -W014, -W033, esversion: 9 */
/* eslint-disable new-cap */
'use strict'
const axios = require('axios')
const http = require('http')
const ip = require('ip')
const os = require('os')
const SSDPClient = require('node-ssdp').Client
const URL = require('url').URL
const xml2js = require('xml2js')

class WemoPlatform {
  constructor (log, config, api) {
    this.version = require('./../package.json').version
    if (!log || !api || !config) return
    this.config = config
    this.api = api
    this.log = log
    this.helpers = require('./utils/helpers')
    this.Characteristic = api.hap.Characteristic
    this.Service = api.hap.Service
    this.devicesInHB = new Map()
    this.devicesToDiscover = {}
    this.devicesWithError = {}
    this.refreshFlag = true
    this.errorLogFlag = 4
    this.debug = config.debug || false
    this.debugLoadDevice = config.debugLoadDevice || false
    this.ignoredDevices = []
    ;(Array.isArray(config.ignoredDevices) ? config.ignoredDevices : []).forEach(sn => {
      this.ignoredDevices.push(sn.replace(/\s+/g, '').toUpperCase())
    })
    this.manualDevices = Array.isArray(config.manualDevices) ? config.manualDevices : []
    this.makerTypes = {}
    if (this.config.makerTypes) {
      this.config.makerTypes.forEach(x => {
        this.makerTypes[x.serialNumber] = {
          type: x.makerType,
          timer: x.makerTimer
        }
      })
    }
    this.doorOpenTimer = parseInt(config.doorOpenTimer)
    this.doorOpenTimer = isNaN(this.doorOpenTimer)
      ? this.helpers.doorOpenTimer
      : this.doorOpenTimer < 0
        ? this.helpers.doorOpenTimer
        : this.doorOpenTimer
    this.noMotionTimer = parseInt(config.noMotionTimer)
    this.noMotionTimer = isNaN(this.noMotionTimer)
      ? this.helpers.noMotionTimer
      : this.noMotionTimer < 0
        ? this.helpers.noMotionTimer
        : this.noMotionTimer
    this.discoveryInterval = parseInt(config.discoveryInterval)
    this.discoveryInterval = isNaN(this.discoveryInterval)
      ? this.helpers.discoveryInterval
      : this.discoveryInterval <= 0
        ? this.helpers.discoveryInterval
        : this.discoveryInterval
    this.wemoClientOpts = config.wemoClient || {}
    this.api
      .on('didFinishLaunching', this.wemoSetup.bind(this))
      .on('shutdown', this.wemoShutdown.bind(this))
  }

  wemoSetup () {
    try {
      if (this.config.disablePlugin) {
        this.devicesInHB.forEach(a => this.removeAccessory(a))
        this.log.warn('*** Disabling plugin [v%s] ***', this.version)
        this.log.warn('*** To change this, set disablePlugin to false ***')
        return
      }
      this.log('Plugin [v%s] initialised. Searching for devices...', this.version)
      this.devicesInHB.forEach(accessory => {
        if (this.ignoredDevices.includes(accessory.context.serialNumber)) {
          this.removeAccessory(accessory)
        } else {
          this.devicesToDiscover[accessory.UUID] = accessory.displayName
          accessory.context.controllable = false
          this.api.updatePlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
          this.devicesInHB.set(accessory.UUID, accessory)
        }
      })
      this._port = this.wemoClientOpts.port || 0
      this._listenInterface = this.wemoClientOpts.listen_interface
      this._clients = {}
      this._server = http.createServer((req, res) => {
        let body = ''
        const udn = req.url.substring(1)
        if (req.method === 'NOTIFY' && this._clients[udn]) {
          req.on('data', chunk => (body += chunk.toString()))
          req.on('end', () => {
            if (this.debug) this.log('Incoming Request for %s:\n%s', udn, body)
            this._clients[udn].handleCallback(body)
            res.writeHead(204)
            res.end()
          })
        } else {
          if (this.debug) this.log('Received request for unknown device:\n%s', udn)
          res.writeHead(404)
          res.end()
        }
      })
      if (this._listenInterface) {
        this._server.listen(this._port, this.getLocalInterfaceAddress(), err => {
          if (err) this.log.warn('Server Listen Error:\n%s', err)
        })
      } else {
        this._server.listen(this._port, err => {
          if (err) this.log.warn('Server Listen Error:\n%s', err)
        })
      }
      if (!this.config.disableDiscovery) {
        this._ssdpClient = new SSDPClient(this.wemoClientOpts.discover_opts || {})
      }
      this.discoverDevices()
      setInterval(() => this.discoverDevices(), this.discoveryInterval * 1000)
    } catch (err) {
      this.log.warn('*** Disabling plugin [v%s] ***', this.version)
      this.log.warn(this.debug ? err : err.message)
    }
  }

  wemoShutdown () {
    this.refreshFlag = false
  }

  discoverDevices () {
    if (!this.refreshFlag) return
    this.manualDevices.forEach(async device => await this.loadDevice(device))
    if (!this.config.disableDiscovery) {
      this._ssdpClient.removeAllListeners('response')
      this._ssdpClient.on('response', async (msg, statusCode, rinfo) => {
        if (msg.ST === 'urn:Belkin:service:basicevent:1' && !this.manualDevices.includes(msg.LOCATION)) {
          await this.loadDevice(msg.LOCATION)
        }
      })
      this._ssdpClient.search('urn:Belkin:service:basicevent:1')
    }
    if (this.errorLogFlag === 5) {
      this.errorLogFlag = 0
      for (const i in this.devicesToDiscover) {
        if (this.helpers.hasProperty(this.devicesToDiscover, i)) {
          this.log.warn('[%s] not found yet so cannot be controlled. Will retry connection.', this.devicesToDiscover[i])
        }
      }
      for (const i in this.devicesWithError) {
        if (this.helpers.hasProperty(this.devicesWithError, i)) {
          this.log.warn(
            '[%s] reported error [%s] so cannot be controlled. Will retry connection.',
            this.devicesWithError[i].device,
            this.devicesWithError[i].error
          )
        }
      }
    }
    this.errorLogFlag++
  }

  async loadDevice (setupUrl) {
    try {
      const location = new URL(setupUrl)
      const res = await axios.get(setupUrl)
      const json = await xml2js.parseStringPromise(res.data, { explicitArray: false })
      const device = json.root.device
      device.host = location.hostname
      device.port = location.port
      if (!this.cbURL) this.cbURL = 'http://' + this.getLocalInterfaceAddress(location.hostname) + ':' + this._server.address().port
      device.callbackURL = this.cbURL
      if (this._clients[device.UDN] && !this._clients[device.UDN].error) return
      this.initialiseDevice(device)
    } catch (err) {
      if (this.debug) this.log.warn('An error occurred loading a device - %s.', err)
    }
  }

  async initialiseDevice (device) {
    try {
      let accessory
      let uuid = this.api.hap.uuid.generate(device.UDN)
      delete this.devicesToDiscover[uuid]
      delete this.devicesWithError[uuid]
      if (this.ignoredDevices.includes(device.serialNumber)) return
      if (!this._clients[device.UDN] || this._clients[device.UDN].error) {
        this._clients[device.UDN] = new (require('./connection/upnp'))(this.debug, this.log, this.helpers, device)
      }
      const deviceClient = this._clients[device.UDN]
      if (device.deviceType === this.helpers.deviceTypes.Bridge) {
        /**************************
        WEMO LINK SUBDEVICE [BULBS]
        **************************/
        try {
          const subdevices = await deviceClient.getEndDevices()
          subdevices.forEach(subdevice => {
            uuid = this.api.hap.uuid.generate(subdevice.deviceId)
            delete this.devicesToDiscover[uuid]
            delete this.devicesWithError[uuid]
            if (this.ignoredDevices.includes(subdevice.deviceId)) return
            accessory = this.devicesInHB.has(uuid)
              ? this.devicesInHB.get(uuid)
              : this.addAccessory(subdevice, false)
            if (!accessory) return
            accessory.client = deviceClient
            accessory.control = new (require('./device/link'))(this, accessory, device, subdevice)
            accessory.context.serialNumber = subdevice.deviceId
            accessory.context.ipAddress = device.host
            accessory.context.port = device.port
            accessory.context.macAddress = device.macAddress.replace(/..\B/g, '$&:')
            accessory.context.icon = device.iconList && device.iconList.icon && device.iconList.icon.url
              ? device.iconList.icon.url
              : false
            accessory.context.controllable = true
            this.api.updatePlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
            this.devicesInHB.set(uuid, accessory)
            this.log(
              '[%s] found with serial number [%s] and mac address [%s].',
              accessory.displayName,
              device.serialNumber,
              accessory.context.macAddress
            )
            deviceClient.on('error', err => {
              this.devicesWithError[uuid] = {
                device: accessory.displayName,
                error: err.code
              }
              accessory.context.controllable = false
              this.api.updatePlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
              this.devicesInHB.set(uuid, accessory)
            })
          })
        } catch (err) {
          this.log.warn('[%s] an error occurred requesting subdevices - %s', device.friendlyName, err)
          return
        }
      } else {
        accessory = this.devicesInHB.has(uuid)
          ? this.devicesInHB.get(uuid)
          : this.addAccessory(device, true)
        if (!accessory) return
        accessory.client = deviceClient
        if (device.deviceType === this.helpers.deviceTypes.Insight) {
          /***********
          WEMO INSIGHT
          ***********/
          accessory.control = new (require('./device/insight'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.Dimmer) {
          /****************
          WEMO LIGHT DIMMER
          ****************/
          accessory.control = new (require('./device/light-dimmer'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.LightSwitch) {
          /****************
          WEMO LIGHT SWITCH
          ****************/
          accessory.control = new (require('./device/light-switch'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.Maker) {
          /*********
          WEMO MAKER
          *********/
          const usage = this.helpers.hasProperty(this.makerTypes, device.serialNumber)
            ? ['garageDoor', 'switch'].includes(this.makerTypes[device.serialNumber].type)
              ? this.makerTypes[device.serialNumber].type
              : 'switch'
            : 'switch'
          accessory.control = usage === 'switch'
            ? new (require('./device/maker-switch'))(this, accessory, device)
            : new (require('./device/maker-garage'))(this, accessory, device)
        } else if ([this.helpers.deviceTypes.Motion, this.helpers.deviceTypes.NetCamSensor].includes(device.deviceType)) {
          /*****************
          WEMO MOTION SENSOR
          *****************/
          accessory.control = new (require('./device/motion'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.Switch) {
          /**********
          WEMO OUTLET
          **********/
          accessory.control = new (require('./device/outlet'))(this, accessory, device)
        } else if ([this.helpers.deviceTypes.HeaterA, this.helpers.deviceTypes.HeaterB].includes(device.deviceType)) {
          /**********
          WEMO HEATER
          **********/
          accessory.control = new (require('./device/heater'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.Humidifier) {
          /**************
          WEMO HUMIDIFIER
          **************/
          accessory.control = new (require('./device/humidifier'))(this, accessory, device)
        } else if (device.deviceType === this.helpers.deviceTypes.Crockpot) {
          /************
          WEMO CROCKPOT
          ************/
          accessory.control = new (require('./device/crockpot'))(this, accessory, device)
        }
        accessory.context.serialNumber = device.serialNumber
        accessory.context.ipAddress = device.host
        accessory.context.port = device.port
        accessory.context.macAddress = device.macAddress.replace(/..\B/g, '$&:')
        accessory.context.icon = device.iconList && device.iconList.icon && device.iconList.icon.url
          ? device.iconList.icon.url
          : false
        accessory.context.controllable = true
        this.api.updatePlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
        this.devicesInHB.set(uuid, accessory)
        this.log(
          '[%s] found with serial number [%s] and mac address [%s].',
          accessory.displayName, device.serialNumber, accessory.context.macAddress
        )
        deviceClient.on('error', err => {
          this._clients[device.UDN] = undefined
          this.devicesWithError[uuid] = {
            device: accessory.displayName,
            error: err.code
          }
          accessory.context.controllable = false
          this.api.updatePlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
          this.devicesInHB.set(uuid, accessory)
        })
      }
    } catch (err) {
      this.log.warn('[%s] could not be initialised as %s.', device.friendlyName, err)
    }
  }

  addAccessory (device, isPrimary) {
    try {
      if (this.ignoredDevices.includes(isPrimary ? device.serialNumber : device.deviceId)) return
      const accessory = new this.api.platformAccessory(
        device.friendlyName,
        this.api.hap.uuid.generate(isPrimary ? device.UDN : device.deviceId))
      accessory
        .getService(this.Service.AccessoryInformation)
        .setCharacteristic(this.Characteristic.Manufacturer, 'Belkin Wemo')
        .setCharacteristic(this.Characteristic.Model, isPrimary ? device.modelName : 'LED Bulb (Via Link)')
        .setCharacteristic(this.Characteristic.SerialNumber, isPrimary ? device.serialNumber : device.deviceId)
        .setCharacteristic(this.Characteristic.FirmwareRevision, isPrimary ? device.firmwareVersion : null)
        .setCharacteristic(this.Characteristic.Identify, true)
      accessory.on('identify', (paired, callback) => {
        this.log('[%s] - identify button pressed.', accessory.displayName)
        callback()
      })
      accessory.context.serialNumber = isPrimary ? device.serialNumber : device.deviceId
      this.api.registerPlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
      this.log('[%s] added to Homebridge with serial number [%s] and mac address [%s].', device.friendlyName, device.serialNumber, device.macAddress)
      return accessory
    } catch (err) {
      this.log.warn('[%s] was not added to Homebridge as %s.', device.friendlyName, this.debug ? err : err.message)
    }
  }

  configureAccessory (accessory) {
    if (!this.log) return
    this.devicesInHB.set(accessory.UUID, accessory)
  }

  removeAccessory (accessory) {
    try {
      this.devicesInHB.delete(accessory.UUID)
      this.api.unregisterPlatformAccessories('homebridge-platform-wemo', 'BelkinWeMo', [accessory])
      this.log('[%s] has been removed from Homebridge.', accessory.displayName)
    } catch (err) {
      this.log.warn('[%s] could not be removed from Homebridge as %s.', accessory.displayName, this.debug ? err : err.message)
    }
  }

  getLocalInterfaceAddress (targetNetwork) {
    let interfaces = os.networkInterfaces()
    if (this._listenInterface) {
      if (interfaces[this._listenInterface]) {
        interfaces = [interfaces[this._listenInterface]]
      } else {
        return new Error('Unable to find interface ' + this._listenInterface)
      }
    }
    const addresses = []
    for (const k in interfaces) {
      if (this.helpers.hasProperty(interfaces, k)) {
        for (const k2 in interfaces[k]) {
          if (this.helpers.hasProperty(interfaces[k], k2)) {
            const address = interfaces[k][k2]
            if (address.family === 'IPv4' && !address.internal) {
              if (targetNetwork && ip.subnet(address.address, address.netmask).contains(targetNetwork)) {
                addresses.unshift(address.address)
              } else {
                addresses.push(address.address)
              }
            }
          }
        }
      }
    }
    return addresses.shift()
  }
}

module.exports = hb => hb.registerPlatform('homebridge-platform-wemo', 'BelkinWeMo', WemoPlatform)