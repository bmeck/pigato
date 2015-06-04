// this is the request data structure stored by a Client
// it contains a stream that is only used when in streaming mode
var Readable = require('readable-stream').Readable;
var uuid = require('node-uuid');

function ClientRequest(opts) {
  this.rid = opts.rid;
  this.timeout = opts.timeout || 60000;
  // time seen
  this.ts = opts.ts || Date.now();
  this.heartbeat = opts.heartbreat || Function.prototype;
  this.ended = opts.ended || false;
  this.opts = opts.opts;

  // last time seen
  this.lts = this.ts;

  // cache for callback mode
  this._finalMsg = null;

  var stream = new Readable({
    objectMode: true
  });

  stream._read = Function.prototype;

  var self = this;
  stream.heartbeat = function () {
    return self.heartbeat.apply(self, arguments);
  } 

  this.stream = stream;
}
module.exports = ClientRequest;
ClientRequest.prototype.isValid = function () {
  return this.timeout < 0 || this.ts + this.timeout > Date.now();
}
