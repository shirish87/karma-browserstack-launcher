var EventEmitter = require('events').EventEmitter
var util = require('util')

function Worker (data) {
  EventEmitter.call(this)

  if (typeof data === 'object' && !Array.isArray(data)) {
    var self = this

    Object.keys(data).forEach(function (k) {
      self[k] = data[k]
    })
  }
}

util.inherits(Worker, EventEmitter)

/**
 * Tracks worker state across runs.
 */
function WorkerManager () {
  this._pollHandle = null
  this.workers = {}
  this.isPolling = false
}

WorkerManager.prototype.registerWorker = function registerWorker (workerData) {
  if (this.workers[workerData.id]) {
    this.unregisterWorker(this.workers[workerData.id])
  }

  var worker = new Worker(workerData)
  worker.emit('status', worker.status)

  this.workers[workerData.id] = worker
  return worker
}

WorkerManager.prototype.unregisterWorker = function unregisterWorker (worker) {
  worker.emit('delete', worker)
  worker.removeAllListeners()

  delete this.workers[worker.id]
  return worker
}

WorkerManager.prototype.updateWorker = function updateWorker (workerData) {
  var workers = this.workers

  if (workers[workerData.id]) {
    var worker = workers[workerData.id]
    var prevStatus = worker.status

    Object.keys(workerData).forEach(function (k) {
      worker[k] = workerData[k]
    })

    if (worker.status !== prevStatus) {
      worker.emit('status', worker.status)
    }
  }
}

WorkerManager.prototype.startPolling = function startPolling (client, pollingTimeout, callback) {
  if (this.isPolling) {
    return
  }

  var self = this
  this.isPolling = true

  client.getWorkers(function (err, updatedWorkers) {
    if (err) {
      self.isPolling = false
      return (callback ? callback(err) : null)
    }

    updatedWorkers = updatedWorkers || []
    var activeWorkerIds = updatedWorkers.map(function (worker) {
      return worker.id
    })

    // process deletions
    for (var i = 0, l = self.workers.length; i < l; i++) {
      var worker = self.workers[i]
      if (activeWorkerIds.indexOf(worker.id) === -1) {
        self.unregisterWorker(worker)
      }
    }

    // process updates
    updatedWorkers.forEach(function (workerData) {
      self.updateWorker(workerData)
    })

    self._pollHandle = setTimeout(function () {
      self.isPolling = false
      self.startPolling(client, pollingTimeout, callback)
    }, pollingTimeout)
  })
}

WorkerManager.prototype.stopPolling = function stopPolling () {
  if (this._pollHandle) {
    clearTimeout(this._pollHandle)
    this._pollHandle = null
  }

  this.isPolling = false
}

// expose a single, shared instance of WorkerManager
var workerManager = new WorkerManager()

module.exports = {
  Worker: Worker,

  WorkerManager: {
    getInstance: function () {
      return workerManager
    }
  }
}
