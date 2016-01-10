var q = require('q')
var api = require('browserstack')
var BrowserStackTunnel = require('browserstacktunnel-wrapper')
var ngrok = require('ngrok')
var os = require('os')
var workerManager = require('./worker-manager')

var localUrlPattern = /^http:\/\/localhost:\d+/


var createBrowserStackTunnel = function (logger, config, emitter) {
  var log = logger.create('launcher.browserstack')
  var bsConfig = config.browserStack || {}
  var bsBinaryBasePath = process.env.BROWSER_STACK_BINARY_BASE_PATH || bsConfig.binaryBasePath || null
  var bsRunConfig = {
    key: process.env.BROWSER_STACK_ACCESS_KEY || bsConfig.accessKey,
    localIdentifier: bsConfig.localIdentifier || bsConfig.tunnelIdentifier,
    jarFile: process.env.BROWSER_STACK_TUNNEL_JAR || bsConfig.jarFile,
    hosts: [{
      name: config.hostname,
      port: config.port,
      sslFlag: 0
    }],
    proxyHost: bsConfig.proxyHost || null,
    proxyPort: bsConfig.proxyPort || null,
    proxyUser: bsConfig.proxyUser || null,
    proxyPass: bsConfig.proxyPass || null
  }

  if (bsConfig.startTunnel === false) {
    bsConfig.tunnelIdentifier = bsRunConfig.localIdentifier
    return q()
  }


  var deferred = q.defer()

  if (bsConfig.localtunnel !== true) {
    bsRunConfig.localIdentifier = bsRunConfig.localIdentifier || 'karma' + Math.random()
    bsConfig.tunnelIdentifier = bsRunConfig.localIdentifier

    if (bsBinaryBasePath) {
      switch (os.platform()) {
        case 'linux':
          switch (os.arch()) {
            case 'x64':
              bsRunConfig.linux64Bin = bsBinaryBasePath
              break
            case 'ia32':
              bsRunConfig.linux32Bin = bsBinaryBasePath
              break
          }
          break
        case 'darwin':
          bsRunConfig.osxBin = bsBinaryBasePath
          break
        default:
          bsRunConfig.win32Bin = bsBinaryBasePath
          break
      }
    }

    log.debug('Establishing the tunnel on %s:%s', config.hostname, config.port)
    var tunnel = new BrowserStackTunnel(bsRunConfig)

    tunnel.start(function (error) {
      if (error) {
        log.error('Can not establish the tunnel.\n%s', error.toString())
        deferred.reject(error)
      } else {
        log.debug('Tunnel established.')
        deferred.resolve(tunnel)
      }
    })

    emitter.on('exit', function (done) {
      log.debug('Shutting down the tunnel.')
      tunnel.stop(function (error) {
        if (error) {
          log.error(error)
        }

        if (workerManager.isPolling) {
          workerManager.stopPolling()
        }

        done()
      })
    })

  } else {

    ngrok.connect(config.port, function (error, publicUrl) {
      if (error) {
        log.error('Can not establish the LocalTunnel.\n%s', error.toString())
        deferred.reject(error)
      } else {
        log.debug('LocalTunnel established.')

	// hack: using http instead of https to avoid ssl errors on custom domain
        deferred.resolve(publicUrl && publicUrl.replace(/^https/, 'http'))
      }
    })

    emitter.on('exit', function (done) {
      log.debug('Shutting down the LocalTunnel.')

      if (workerManager.isPolling) {
        workerManager.stopPolling()
      }

      ngrok.disconnect()
      done()
    })
  }

  return deferred.promise
}

var createBrowserStackClient = function (/* config.browserStack */config) {
  var env = process.env

  config = config || {}

  // TODO(vojta): handle no username/pwd
  var client = api.createClient({
    username: env.BROWSER_STACK_USERNAME || config.username,
    password: env.BROWSER_STACK_ACCESS_KEY || config.accessKey
  })

  var pollingTimeout = config.pollingTimeout || 1000

  if (!workerManager.isPolling) {
    workerManager.startPolling(client, pollingTimeout, function (err) {
      if (err) {
        console.error(err)
      }
    })
  }

  return client
}

var formatError = function (error) {
  if (error.message === 'Validation Failed') {
    return '  Validation Failed: you probably misconfigured the browser ' +
      'or given browser is not available.'
  }

  return error.toString()
}

var BrowserStackBrowser = function (id, emitter, args, logger,
  /* config */ config,
  /* browserStackTunnel */ tunnel, /* browserStackClient */ client,
  baseLauncherDecorator) {
  var self = this

  baseLauncherDecorator(self)

  var workerId = null
  var captured = false
  var alreadyKilling = null
  var log = logger.create('launcher.browserstack')
  var browserName = (args.browser || args.device) + (args.browser_version ? ' ' + args.browser_version : '') +
    ' (' + args.os + ' ' + args.os_version + ')'

  this.id = id
  this.name = browserName + ' on BrowserStack'

  var bsConfig = config.browserStack || {}
  var captureTimeout = config.captureTimeout || 0
  var captureTimeoutId
  var retryLimit = bsConfig.retryLimit || 3

  this.start = function (url) {
    // TODO(vojta): handle non os/browser/version
    var settings = {
      os: args.os,
      os_version: args.os_version,
      device: args.device,
      browser: args.browser,
      tunnelIdentifier: !bsConfig.localtunnel ? bsConfig.tunnelIdentifier : null,
      // TODO(vojta): remove "version" (only for B-C)
      browser_version: args.browser_version || args.version || 'latest',
      url: url + '?id=' + id,
      'browserstack.tunnel': !(bsConfig.localtunnel),
      timeout: bsConfig.timeout || 300,
      project: bsConfig.project,
      name: bsConfig.name || 'Karma test',
      build: bsConfig.build || process.env.TRAVIS_BUILD_NUMBER || process.env.BUILD_NUMBER ||
        process.env.BUILD_TAG || process.env.CIRCLE_BUILD_NUM || null
    }

    if (typeof args.real_mobile !== 'undefined') {
      settings.real_mobile = args.real_mobile
    }

    this.url = url
    tunnel.then(function (publicUrl) {
      if (publicUrl) {
        settings.url = settings.url.replace(localUrlPattern, publicUrl)
        self.url = self.url.replace(localUrlPattern, publicUrl)
      }

      client.createWorker(settings, function (error, worker) {
        var sessionUrlShowed = false

        if (error) {
          log.error('Can not start %s\n  %s', browserName, formatError(error))
          return emitter.emit('browser_process_failure', self)
        }

        workerId = worker.id
        alreadyKilling = null

        worker = workerManager.registerWorker(worker)
        worker.on('status', function (status) {
          // TODO(vojta): show immediately in createClient callback once this gets fixed:
          // https://github.com/browserstack/api/issues/10
          if (!sessionUrlShowed) {
            log.info('%s session at %s', browserName, worker.browser_url)
            sessionUrlShowed = true
          }

          switch (status) {
            case 'running':
              log.debug('%s job started with id %s', browserName, workerId)

              if (captureTimeout) {
                captureTimeoutId = setTimeout(self._onTimeout, captureTimeout)
              }
              break

            case 'queue':
              log.debug('%s job with id %s in queue.', browserName, workerId)
              break

            case 'delete':
              log.debug('%s job with id %s has been deleted.', browserName, workerId)
              break
          }
        })
      })
    }, function () {
      emitter.emit('browser_process_failure', self)
    })
  }

  this.kill = function (done) {
    if (!alreadyKilling) {
      alreadyKilling = q.defer()

      if (workerId) {
        log.debug('Killing %s (worker %s).', browserName, workerId)
        client.terminateWorker(workerId, function () {
          log.debug('%s (worker %s) successfully killed.', browserName, workerId)
          workerId = null
          captured = false
          alreadyKilling.resolve()
        })
      } else {
        alreadyKilling.resolve()
      }
    }

    if (done) {
      alreadyKilling.promise.then(done)
    }
  }

  this.forceKill = function () {
    var self = this

    return q.promise(function (resolve) {
      self.kill(resolve)
    })
  }

  this.markCaptured = function () {
    captured = true

    if (captureTimeoutId) {
      clearTimeout(captureTimeoutId)
      captureTimeoutId = null
    }
  }

  this.isCaptured = function () {
    return captured
  }

  this.toString = function () {
    return this.name
  }

  this._onTimeout = function () {
    if (captured) {
      return
    }

    log.warn('%s has not captured in %d ms, killing.', browserName, captureTimeout)
    self.kill(function () {
      if (retryLimit--) {
        self.start(self.url)
      } else {
        emitter.emit('browser_process_failure', self)
      }
    })
  }
}

// PUBLISH DI MODULE
module.exports = {
  'browserStackTunnel': ['factory', createBrowserStackTunnel],
  'browserStackClient': ['factory', createBrowserStackClient],
  'launcher:BrowserStack': ['type', BrowserStackBrowser]
}
