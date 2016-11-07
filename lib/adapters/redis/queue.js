'use strict';

const Redis = require('redis');
const Log = require('../../logger.js');
/**
 * An interface to the Audit queue
 * @constructor
 * @param {Object} config - Redis client configuration
 */

AuditQueue.sharedKeys = {
  backlog : 'storj:audit:full:backlog',               /* sorted set */
  ready   : 'storj:audit:full:ready',                 /* list */
  pass    : 'storj:audit:full:pass',                  /* set */
  fail    : 'storj:audit:full:fail'                   /* set */
};

function AuditQueue(uuid, config) {
  this._config = config;
  this._uuid = uuid || 'undefined';
  this._workerKeys = {
    pending : 'storj:audit:full:pending:' + this._uuid, /* list */
  };

  if(!this._config.password) {
    delete this._config.password;
  }

  this.blockingClient = Redis.createClient(this._config);
  this.client = Redis.createClient(this._config);
  this.client.on('error', handleError);

  function handleError(err) {
    if(err) { Log.error(err.message); }
  }
}

/**
 * Adds a series of Audits to the backlog queue
 * @param {Object[]} audits
 * @param {Number} audits[].ts - The Audit's scheduled time
 * @param {Object} audits[].data - Data required to fulfill the audit
 * @param {Object} audits[].data.id - Renter's shard contract primary key
 * @param {Object} audits[].data.root - Merkle root
 * @param {Object} audits[].data.depth - Merkle depth
 * @param {Object} audits[].data.challenge - Audit Challenge
 * @param {Object} audits[].data.hash - Hash of the consigned data
 * @param {AuditQueue~add} callback
 */

/**
 * Callback used by add.
 * @callback AuditQueue~add
 * @param {Error} err - Error
 * @param {Number} count - An integer of audits added to the backlog.
 */

AuditQueue.prototype.add = function(audits, callback) {
  var command = [AuditQueue.sharedKeys.backlog];
  audits.forEach(function(elem) {
    command.push(elem.ts, JSON.stringify(elem.data));
  });

  this.client.ZADD(command, function(err, resp) {
    if(err) { return callback(err); }
    this.client.publish(
      AuditQueue.sharedKeys.backlog,
      JSON.stringify(audits) || 0
    );
    return callback(null, resp);
  }.bind(this));
};

/**
 * Populates the ready queue from the backlog queue
 * @param {Number} start - Begining timestamp range to populate ready queue
 * @param {Number} stop - Ending timestamp range to populate ready queue
 * @param {AuditQueue~populateReadyQueue} callback
 */

/**
 * Callback used by populateReadyQueue.
 * @callback AuditQueue~populateReadyQueue
 * @param {Error} err - Error
 * @param {Boolean} hasReadyAudits - has Audits ready
 */


AuditQueue.prototype.populateReadyQueue = function(start, stop, callback) {
  start = start || 0;
  stop = stop || Date.now();
  var command = [['ZREMRANGEBYSCORE', AuditQueue.sharedKeys.backlog, start, stop]];

  this.client.watch(AuditQueue.sharedKeys.backlog);
  this._get(start, stop, function(err, resp) {
    if(resp.length === 0) {
      this.client.unwatch();
      Log.info('Audit:' + this._uuid
        + ':AuditQueue.populateReadyQueue'
        + ': ' + AuditQueue.sharedKeys.backlog + ' no available ready'
      );

      return callback(null, false);
    } else {
      var pushCommand = ['RPUSH', AuditQueue.sharedKeys.ready];
      resp.forEach(function(elem) {
        pushCommand.push(JSON.stringify(elem));
      });

      command.push(pushCommand);
      this.client.multi(command).exec(function(err, arrResp) {
        if(err) { return callback(err); }
        if(arrResp === null) {
          Log.info('Audit:' + this._uuid
            + ':AuditQueue.populateReadyQueue'
            + ': key modified, transaction canceled'
          );

          return this.populateReadyQueue(start, undefined, callback);
        }

        this.client.publish(
          AuditQueue.sharedKeys.ready,
          JSON.stringify(resp)
        );

        return callback(null, arrResp[arrResp.length -1] > 0);
      }.bind(this));
    }
  }.bind(this));
};

/**
 * Awaits a single audit, blocking the connection indefinitely, from the ready
 * queue and commits it to the pending queue
 * @param {AuditQueue~awaitReadyQueue} callback
 */

/**
 * Callback used by awaitReadyQueue.
 * @callback AuditQueue~awaitReadyQueue
 * @param {Error} err - Error
 * @param {Audit} audit - an audit from top of the ready queue
 */

AuditQueue.prototype.awaitReadyQueue = function(callback) {
  this.blockingClient.BRPOPLPUSH(
    AuditQueue.sharedKeys.ready,
    this._workerKeys.pending,
    0, /* timeout parameter, 0 = indefinitely */
    function(err, result) {
      if(err) { return callback(err); }
      this.client.publish(
        this._workerKeys.pending,
        result
      );

      return callback(null, JSON.parse(result));
  }.bind(this));
};

/**
 * Pops a single audit (non-blocking) from the ready queue and commits it to the
 * pending queue
 * @param {AuditQueue~popReadyQueue} callback
 */

/**
 * Callback used by popReadyQueue.
 * @callback AuditQueue~popReadyQueue
 * @param {Error} err - Error
 * @param {Audit} audit - an audit from top of the ready queue
 */

AuditQueue.prototype.popReadyQueue = function(callback) {
  this.client.RPOPLPUSH(
    AuditQueue.sharedKeys.ready,
    this._workerKeys.pending,
    function(err, result) {
      if(err) { return callback(err); }
      if(result === null) { return callback(null, null); }
      this.client.publish(
        this._workerKeys.pending,
        result
      );

      return callback(null, JSON.parse(result));
  }.bind(this));
};

/**
 * Returns all audits from the pending queue
 * @param {AuditQueue~getPendingQueue} callback
 */

/**
 * Callback used by getPendingQueue.
 * @callback AuditQueue~getPendingQueue
 * @param {Error} err - Error
 * @param {Audit[]} audits - audits from the pending queue
 */

AuditQueue.prototype.getPendingQueue = function(callback) {
  this.client.LRANGE(
    this._workerKeys.pending,
    0,
    -1,
    function(err, result) {
      if(err) { return callback(err); }
      result.forEach(function(elem, ind, arr) {
        arr[ind] = JSON.parse(elem);
      });

      return callback(null, result);
  });
};

/**
 * Pops a single audit in the pending queue to the fail or pass queue
 * @param {Audit} audit - the audit object to move from pending
 * @param {Boolean} hasPassed - has the audit passed or failed
 * @param {AuditQueue~pushResultQueue} callbackcount
 */

/**
 * Callback used by pushResultQueue.
 * @callback AuditQueue~pushResultQueue
 * @param {Error} err - Errorcount
 * @param {Boolean} isSuccess - has result been successfully persisted
 */

AuditQueue.prototype.pushResultQueue = function(audit, hasPassed, callback) {
  audit = JSON.stringify(audit);
  var finalQueue = hasPassed ? 'pass' : 'fail';
  var multi = this.client.multi();

  this.client.watch(this._workerKeys.pending);
  multi.lrem(this._workerKeys.pending, 1, audit);
  multi.sadd(AuditQueue.sharedKeys[finalQueue], audit);
  multi.exec(function(err, arrResp) {
      if(err) { return callback(err); }
      if(arrResp === null) {
        this.client.unwatch();
        Log.info('Audit:' + this._uuid
          + ':AuditQueue.pushResultQueue'
          + ': key modified, transaction canceled'
        );

        return this.pushResultQueue(audit, hasPassed, callback);
      }

      this.client.publish(
        AuditQueue.sharedKeys[finalQueue],
        audit
      );

      return callback(null, arrResp[arrResp.length] > 0);
    }.bind(this));

};

/**
 * Returns all elements in the backlog queue for a given time range
 * @param {Number} start - Time, in seconds, to begin search
 * @param {Number} stop - Time, in seconds, to end search
 * @param {AuditQueue~_get} callback
 */

/**
 * Callback used by _get.
 * @callback AuditQueue~_get
 * @param {Error} err - Error
 * @param {Audit[]} audits - An array of audits
 */

AuditQueue.prototype._get = function(start, stop, callback) {
  let command = [AuditQueue.sharedKeys.backlog, start, stop];
  this.client.ZRANGEBYSCORE(command, function(err, resp) {
    if(err) { return callback(err); }
    resp.forEach(function(elem, ind, arr) {
      arr[ind] = JSON.parse(elem);
    });
    return callback(null, resp);
  });
};

module.exports = AuditQueue;
