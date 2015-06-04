var zmq = require('zmq');
var ClientRequest = require('./ClientRequest');
var debug = require('debug')('pigato:Client');
var uuid = require('node-uuid');
var util = require('util');
var events = require('events');
var _ = require('lodash');
var MDP = require('./mdp');
var putils = require('./utils');

var HEARTBEAT_LIVENESS = 3;

function Client(broker, conf) {

  this.broker = broker;

  this.conf = {
    autostart: false,
    reconnect: 1000,
    heartbeat: 2500,
    timeout: 60000,
    retry: 0,
    name: 'C' + uuid.v4()
  };

  this.reqs = {};

  _.extend(this.conf, conf);

  events.EventEmitter.call(this);

  if (this.conf.autostart) {
    this.start();
  }
};
util.inherits(Client, events.EventEmitter);

Client.prototype.onConnect = function() {
  this.emit.apply(this, ['connect']);
  if (this.conf.onConnect) {
    this.conf.onConnect();
  }
  
  debug('C: connected');
};

Client.prototype.onDisconnect = function() {
  this.emit.apply(this, ['disconnect']);
  if (this.conf.onDisconnect) {
    this.conf.onDisconnect();
  }

  debug('C: disconnected');
};

Client.prototype.start = function() {
  var self = this;

  this.stop();

  this._mcnt = 0;

  this.socket = zmq.socket('dealer');
  this.socket.identity = new Buffer(this.conf.name);

  this.socket.on('message', function() {
    self.onMsg.call(self, putils.args(arguments));
  });

  this.socket.on('error', function(err) {
    self.emitErr(err);
  });

  this.socket.connect(this.broker);
  this.liveness = HEARTBEAT_LIVENESS;
  
  debug('C: starting');

  this.hbTimer = setInterval(function() {
    self.heartbeat();

    _.each(self.reqs, function(req, rid) {
      if (req.isValid()) {
        self.onMsg([
          MDP.CLIENT, MDP.W_REPLY, '', new Buffer(rid), new Buffer('-1'),
          new Buffer(JSON.stringify('C_TIMEOUT'))
        ]);
      }
    });
    
    self.liveness--;

    if (self.liveness <= 0) {
      debug('C: liveness=0');
      self.stop();
      setTimeout(function() {
        self.start();
      }, self.conf.reconnect);
    }

  }, this.conf.heartbeat);
 
  this.heartbeat(); 
  this.emit.apply(this, ['start']);
};

Client.prototype.stop = function() {
  clearInterval(this.hbTimer);

  if (this.socket) {
    debug('C: stopping');
    
    var socket = this.socket;
    delete this.socket;
    
    if (socket._zmq.state != zmq.STATE_CLOSED) {
      socket.close();
    }

    this.onDisconnect();
    this.emit.apply(this, ['stop']);
  }    
};

Client.prototype.send = function(msg) {
  if (!this.socket) {
    return;
  }

  this.socket.send(msg);
};

Client.prototype.onMsg = function(msg) {
  msg = putils.mparse(msg);

  var header = msg[0];
  var type = msg[1];

  this.liveness = HEARTBEAT_LIVENESS;

  if (header != MDP.CLIENT) {
    this.emitErr('ERR_MSG_HEADER');
    return;
  }

  this._mcnt++;
  
  if (this._mcnt === 1) {
    this.onConnect();
  }

  if (type == MDP.W_HEARTBEAT) {
    debug('C: HEARTBEAT');
    return;
  }

  if (msg.length < 3) {
    this.emitErr('ERR_MSG_LENGTH');
    return;
  }

  var rid = msg[3];
  var req = this.reqs[rid];
  if (!req) {
    this.emitErr('ERR_REQ_INVALID');
    return;
  }

  var err = +msg[4] || 0;
  var data = msg[5] || null;

  if (data) {
    data = JSON.parse(data);
  }

  if (err === -1) {
    err = data;
    data = null;
  }

  if (type == MDP.W_REPLY || type == MDP.W_REPLY_PARTIAL) {
    req.lts = Date.now(); 

    if (type == MDP.W_REPLY) {
      req._finalMsg = [err, data];
      req.ended = true;
      delete this.reqs[rid];
    }

    if (err) {
      req.stream.emit('error', err);
    }

    req.stream.push(data);

    if (type == MDP.W_REPLY) {
      req.stream.push(null);
    }
  } else {
    this.emitErr('ERR_MSG_TYPE');
  }
};

Client.prototype.emitErr = function(msg) {
  this.emit.apply(this, ['error', msg]);
};

function noop() {}

function _create_req(_opts) {
  var self = this;
  var opts = _.isObject(_opts) ? _opts : {};

  if (typeof opts.timeout === 'undefined') {
    opts.timeout = self.conf.timeout;
  }
  if (typeof opts.retry === 'undefined') {
    opts.retry = self.conf.retry;
  }

  var req = new ClientRequest({
    timeout: opts.timeout,
    opts: opts,
    heartbeat: function() {
      self.heartbeat(rid);
    }
  });
  this.reqs[req.rid] = req;

  return req;
}
function _request(serviceName, data, opts) {
  var self = this;
  var req = _create_req.call(this, opts);
  var rid = req.rid;
  debug('C: send request', serviceName, rid);

  this.send([
    MDP.CLIENT, MDP.W_REQUEST, serviceName, rid,
    JSON.stringify(data), JSON.stringify(opts)
  ]);

  return req;
};
function _requestMeta(serviceName, data, opts) {
  var self = this;
  var req = _create_req.call(this, 'callback', opts);
  var rid = req.rid;
  debug('C: send meta', serviceName, rid);

  this.send([
    MDP.CLIENT, MDP.W_META, serviceName, rid,
    data, JSON.stringify(opts)
  ]);

  return req;
};

Client.prototype.metaQuery = function (srvName, query, opts, cb) {
  var req = _requestMeta.call(this, srvName, query, opts);
  this.reqs[req.rid] = req;
  req.stream.on('data', function() {
  });
  req.stream.on('end', function() {
    var msg = req._finalMsg;

    if (cb) {
      cb(msg[0], msg[1]);
    }
  });

  req.stream.on('error', noop);
}

Client.prototype.requestStream = function(serviceName, data, opts) {
  return this.request(serviceName, data, opts);
};

Client.prototype.request = function() {
  var mode = 'stream';
  var serviceName = arguments[0];
  var data = arguments[1];
  var opts, partialCb, finalCb;

  if (arguments.length >= 4) {
    mode = 'callback';
    partialCb = arguments[2];
    finalCb = arguments[3];
    opts = arguments[4];
  } else {
    opts = arguments[2];
  }

  var req = _request.call(this, serviceName, data, opts);

  if (mode === 'callback') {
    req.stream.on('data', function(data) {
      if (req.ended) {
        return;
      }

      if (partialCb) {
        partialCb(null, data);
      }
    });

    req.stream.on('end', function() {
      var msg = req._finalMsg;

      if (finalCb) {
        finalCb(msg[0], msg[1]);
      }
    });

    req.stream.on('error', noop);

  } else {
    return req.stream;
  }
};

Client.prototype.heartbeat = function(rid) {
  var msg = [MDP.CLIENT, MDP.W_HEARTBEAT];
  if (rid) {
    msg.push(rid);
  }
  this.send(msg);
};

module.exports = Client;
