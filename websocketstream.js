// UMD header
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.WebSocketStream = factory();
    }
}(this, function () {
'use strict';

if(!WebSocket) {
  var WebSocket = require("ws");
}
if(!ayepromise) {
  var ayepromise = require("ayepromise")
}

/*
this class handles the buffering that WebSocket doesn't
providing the recv() method familiar from synchronous socket code.
Since it returns promises that conform to Promises/A+, the resulting code
is very nearly the same as the equivalent synchronous code.
[[aside: promises are continuation-passing-style indirected]]

It has the same (XXX not finished) API as WebSocket, except that
 .onmessage = handler is replaced by .recv(n, handler) and .recvline(handler)
TODO: is there any way to achieve this with inheritence? can I inherit and somehow zero out onmessage externally while still using onmessage internally?

.recvline() blocks until '\n' comes in
.recv(n) blocks until n bytes are ready
.recv() buffer until websocket closes
NOTE: only one of these can be active at a time; if you try to call recv() while a recv() is pending you will get an exception
 
*/

/* TODO:
 * 
 * [ ] do we want perhaps to add a nonblocking flag so that recv() is EITHER blocking or immediate polling? but the only way to deal with nonblocking sockets is polling, and we probably want to discourage polling in javascript...
 
 * [ ] handle the different modes you can open a websocket in: strings, base64, and binary;
       The websocket protocol technically allows intermixing text and binary (and base64 is a websockify addition) frame by frame. Internally, this means we need to our buffer to be tolerate receiving in all three modes.
       Sending is not as much of a problem, because we just relay that down to WebSocket itself, and it knows how to handle the differences, though perhaps a base64 mode would help.

 * [x] WebSockify, which I'm testing against (and which this is mostly useful with) insists on me specifying "binary" or "base64" in the protocols argument.
     [ ] Make sure upstream accepts my patch
     [ ] Support the "protocols" option somehow.
*/


// XXX a complication:
// 
// with 'binary' e.data ends up as a Blob which requires a whole slew of JS objects to manipulate: FileReader and ArrayBuffer. FileReader.readAsBinaryString + FileReader.result is the shortest way to just getting the bytes out, however readAsBinaryString has been deprecated for 2 years.
// readAsText assumes the data is UTF-8 (or otherwise specified) text and will decode as approproate
// readAsArrayBuffer just pushes the trouble of manipulation to learning the ArrayBuffer class
//
// For development, I'm going to force base64. I don't know if non-WebSockify WebSocketServers will understand it, but I can cross that bridge later. 

function WebSocketStream(addr) {
  var self = this; //so that we can refer to the WebSocketStream from the WebSocket's event handlers
  
  this._buffer = ""; //TODO: use something more efficient than strings here ( see https://github.com/phoboslab/jsmpeg/blob/master/jsmpg.js#L90 for how )
  
  this._pending = null;
  
  this._ws = new WebSocket(addr, "binary");
  
  this._ws.onmessage = function(e) {
    self._pushbuffer(e.data);
  }
  
  // these handlers which proxy need to be defined in here
  // in order to pick up 'self' and not cause infinite recurision
  //  saying .e.g this._ws.onopen = this._onopen does the wrong thing, because js doesn't care that this._onopen comes from this, it runs it with this=this._ws
  this._ws.onopen = function(e) {
    if(self.onopen) {
      self.onopen(e)
    }
  }
  this._ws.onclose = function(e) {
    // clear out a pending .recv()
    if(self._pending !== null) {
      if(self._pending.type == self._RECV) {
        self._pending.deferred.resolve(self._buffer)
      }
    }
    if(self.onclose) {
      self.onclose(e)
    }
  }
  this._ws.onerror = function(e) {
    if(self.onerror) {
      self.onerror(e)
    }
  }
  
  
}

WebSocketStream.prototype._pushbuffer = function(d) {
  var self = this;
  
  self._buffer += d;
  //console.log("[",this._buffer.length,"] buffer = ", self._buffer) //DEBUG

  // if we have a recv() or a recvline() blocked, scan
  if(self._pending !== null) {
    var split = -1; // if not -1, determines how many bytes to eat and call handler with, and causing the pending recv to be completed
    
    if(self._pending.type == self._RECVn) {
      if(self._buffer.length >= self._pending.n) {
        split = self._pending.n;
      }
    } else if(self._pending.type == self._RECVLINE) {
      split = self._buffer.indexOf("\n")
    }
    
    if(split != -1) {
      var d = self._buffer.slice(0, split)
      self._buffer = self._buffer.slice(split)
      
      var p = self._pending;
      // "complete" the pend; i.e. null out _pending
      self._pending = null; //it's important to complete *before* resolving,
                            //since the resolution handler might--is likely to, even--call recv() again
      p.deferred.resolve(d)
    }
  } 
}

 //TODO: .prototoype._recv = { NONE: 0, ..}
WebSocketStream.prototype._RECVNONE = 0
WebSocketStream.prototype._RECVn = 1
WebSocketStream.prototype._RECVLINE = 2
WebSocketStream.prototype._RECV = 3 //XXX NotImplemented
  
WebSocketStream.prototype.send = function(data) {
  
  if(typeof(data) === "string") {
    //Bad Things Happen if we let the websocket library send the data,
    //  namely it UTF-8 encodes it
    //XXX this is wrong! the client code should have control here.
    // Maybe it really does want to send UTF8??
    var _data = data;
    data = new Uint8Array(_data.length);
    for(var i = 0; i<data.length; i++) {
      data[i] = _data.charCodeAt(i)
      //console.log(data[i])
    }
  }
  
  this._ws.send(data);
}


WebSocketStream.prototype._recv = function(pend) {
  if(this._pending !== null) {
    throw "A recv is already pending on " + this._ws.url;
  }
  
  pend.deferred = ayepromise.defer()
  this._pending = pend;
  return this._pending.deferred.promise;
}

WebSocketStream.prototype.recv = function(n) {
  var promise = null;
  if(n === undefined) { // this should say "arguments.length == 0" but that's mysteriously misbehaving
    promise = this._recv({type: this._RECV})
  } else {
    promise = this._recv({type: this._RECVn, n: n})
  }
  
  this._pushbuffer("") //indirectly poll for whether we should immediately resolve the recv()
  return promise;
}
  
WebSocketStream.prototype.recvline = function() {
  var promise = this._recv({type: this._RECVLINE})
  
  this._pushbuffer("") //indirectly poll for whether we should immediately resolve the recv()
  return promise;
}

WebSocketStream.prototype.close = function() {
  return this._ws.close();
}

return WebSocketStream;
}));