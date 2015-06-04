// this is the data structure a Broker uses to represent a request
function BrokerRequest(opts) {
  this.service = opts.service;
  this.clientId = opts.clientId;
  this.attempts = opts.attempts || 0;
  this.rid = opts.rid;
  this.rhash = opts.hash;
  this.timeout = opts.timeout || 60000;
  this.ts = opts.ts || Date.now();
  this.rejects = opts.rejects || [];
  this.msg = opts.msg;
  this.opts = opts.opts;
}
module.exports = BrokerRequest;
BrokerRequest.prototype.isValid = function () {
  return this.ts < 0 || this.ts + this.timeout > Date.now();
}
