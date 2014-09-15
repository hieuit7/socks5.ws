/* socks5.js
 * 
 * Partially implements the SOCKS5 protocol over WebSockets
 *  The missing parts are around the types of authentication:
 *   does NOT support GSSAPI, [and has no means for plugging in new ].
 *
 * Depends on WebSocketStream (which depends on ayepromise and some WebSocket library).
 */
 
/* TODO
 * 
 * 
 * [ ] We *should* be sending binary frames (i.e. have websocket frame opcode 0x2 i.e. use Blob()s)
 *     The SOCKS headers are binary, except for the DOMAINNAME address type, which is presumably ASCII. But after the SOCKS headers, we should get out of the way and use whatever form the user or remote end hands us (getting this right will mostly be an exercise in getting unit tests right)
 * [ ] We should be able to parse and unparse IP addresses
       since SOCKS transfers them in plain bytes, and the
       header we send depends on the format we send the address in.
 * [ ] Instead of using Strings everywhere, use integer enum codes and have a single function that does conversion between ints and (network ordered!) byte strings
 * [ ] factor the common parts of the protocol in some way that allows implementing all three kinds of APIs is feasible
 * [ ] unit tests!!
 */ 

// UMD header
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.SOCKS5 = factory();
    }
}(this, function () {
    'use strict';

if(!WebSocketStream) {
  var WebSocketStream = require("./websocketstream.js") 
}

/* Utility Routines */

function split_addr(addr) {
  // I would rather use the more general 'rsplit()' 
  // but js doesn't have that and writing it myself is fraught:
  //http://stackoverflow.com/questions/958908/how-do-you-reverse-a-string-in-place-in-javascript/16776621#16776621
  
  var split = addr.lastIndexOf(":")
  var host = addr.slice(0, split)
  var port = addr.slice(split+1)
  return [host, port]
}

function join_addr(host, port) {
  return host + ":" + port;
}


function build_int(n) {
  if(!(0 <= n && n<=0xFF)) throw "Integer out of range. SOCKS integers must fit in one byte"
  return String.fromCharCode(n);
}


function SOCKS5(proxy, target, user, pass) {
  /* implements the SOCKS5 client protocol
   *  reference: https://tools.ietf.org/html/rfc1928
   *  
   * This class only implements TCP CONNECT SOCKS; SOCKS also allows UDP and even BIND modes, but those types require distinctly different APIs (UDP needs .send() and .onmessage; BIND only allows one remote TCP connection (i.e. it's not a full listen()+accept() implementation) but presumably there should be an intermediate state for "connected to the proxy but no one is connected to us"

   */
  
  //A) initializations
  
  var self = this;
  self.target = target
  self.remote = { host: null, port: null } //the address of the remote end of the tunnel
  
  self._ws = new WebSocketStream(proxy)
  
  self._ws.onopen = function() {
    self._connect()
  }
  
  self._ws.onclose = function() {
    self.onclose()
  }
  self._ws.onerror = function() {
    self.onerror()
  }
}

// make SOCKS5 inherit from WebSocketStream
// trick from http://ncombo.wordpress.com/2013/07/11/javascript-inheritance-done-right/
//SOCKS5.prototype = Object.create(WebSocketStream.prototype);


SOCKS5.prototype._validate_version = function(b) {
  if(b != this.VERSION) { 
    throw "Unsupported SOCKS version"
  }
}


// B) connect to the SOCKS server  
  
SOCKS5.prototype._connect = function() {
  var self = this;
  return this._negotiate_method()
    .then(function(m) { return self._negotiate_auth(m) }) //the wrapping is because then() suffers from changing what 'this' is
    .then(function() { return self._negotiate_connection() } )
    .then(function() { return self.onopen({/*XXX fill me in*/}) })
    .fail(function(e) { self.onerror(e) }) //chain exceptions out to the event handler
}



// 1) negotiate an connection method (i.e. an auth method, though encryption and digital signatures are theoretically an option here too);

SOCKS5.prototype._negotiate_method = function() {
  this._ws.send(this._build_method_selection([this.auth.NONE]))
  
  return this._read_method();
}



SOCKS5.prototype._build_method_selection = function(methods) {
  // precondition: methods is a subset of this.auth
  // XXX this precondition isn't enforced!
  
  var nmethods = methods.length;
  
  return this.VERSION + build_int(nmethods) + methods.join('')
}


SOCKS5.prototype._read_method = function() {
  var ws = this._ws;
  var self = this;
  return ws.recv(1)
    .then(function(b) { self._validate_version(b) })
    .then(function() { return ws.recv(1); })
}


// 2) negotiate the authentication;
//  the spec says we "MUST" support GSSAPI, which I'm not going 
//  to do, and "SHOULD" support user/pass, which I am.


SOCKS5.prototype._negotiate_auth = function(method) {
  var self = this;
  // look up a handler for 'method'
  // points: this handler may return a promise, but it also might not
  //  this handler is run with this = [the SOCKS5]
  if(method == this.auth.UNACCEPTABLE) {
    
    //"If the selected METHOD is X'FF', none of the methods listed by the
    // client are acceptable, and the client MUST close the connection."
    this._ws.close(); //"client MUST close"
    
    //and we error out too, for good measure
    throw "SOCKS server rejected all our auth methods." 
  }
  
  function find_method() {
    var s = null;
    // .find() didn't work. for(k in self.auth) didn't work.
    // maybe things are different under Firefox??
    // So I fall back to using a global 's'
    Object.keys(self.auth).forEach(function(k) { //XXX this code feels like it probably exists in the stdlib somewhere
      if(self.auth[k].charCodeAt(0) == method.charCodeAt(0)) s = k;
    })
    
    if(s) return s;
    throw "Unknown auth method" //Shouldn't happen but not impossible; a conforming server should only respond with a method in the list we sent
  }
  
  var handler = this.authmethods[find_method()]
    
  // Note! handler might here overwrite this._ws here with a further
  //   wrapper because:
  // > If the negotiated method includes encapsulation [...]
  // > these requests MUST be encapsulated in the method-
  // > dependent encapsulation.
  // - <https://tools.ietf.org/html/rfc1928#section-4> 
  return handler.call(this)
}


SOCKS5.prototype.authmethods = {}
SOCKS5.prototype.authmethods.NONE = function() {
  return;
}

SOCKS5.prototype.authmethods.GSSAPI = function() {
  throw "NotImplemented"
}
SOCKS5.prototype.authmethods.LOGIN = function() {
  throw "NotImplemented"
  //this.send(....)
  //return ws.read(loginresponselength).then() .... 
}


// 3) request the actual tunnel
SOCKS5.prototype._negotiate_connection = function() {
  
  this._ws.send(this._build_request("CONNECT", this.target)) //hardcoded to "CONNECT"; see the comments near the top
  
  return this._read_reply();
}


SOCKS5.prototype._build_request = function(command, address) {
    command = command.toUpperCase();
    
    command = this.commands[command]
    if(command === undefined) {
      throw "Invalid SOCKS command."
    }
    
    // XXX for now, address is hardcoded as DOMAINAME
    //  most DNS resolvers should be able to handle text-formatted IPv4 and IPv6 addresses...
    var atype = this.atype.DOMAINNAME
    
    address = split_addr(address)
    var host = address[0]
    var port = address[1]
    
    // format address as a fortran-style string
    if(host.length > 0xFF) {
      throw "Target hostname too long to encode."
    }
    var n = String.fromCharCode(host.length)
    host = n + host
    
    // and finally, the port
    if(port === null) { //XXX maybe this should be inside of spit_addr
      throw "Target port must be specified when using SOCKS5."
    }
    
    // "in network octet order"
    port = +port; //convert to an integer
    port = String.fromCharCode((port & 0xFF00) >> 8) + String.fromCharCode(port & 0xFF)
    
    
    var m = this.VERSION + command + this.RSV + atype + host + port;
    return m
}

SOCKS5.prototype._read_reply = function() {
  // As a state machine, this process is:
  // [ read version ] -> [ read response ] -> [read reserved null byte] -> [error out]
  //                  |-> [error out]       |
  //                                        v
  //                                 [read address type]
  //                   [read ipv4]    [read domainname]     [readipv6]
  //                                     [read port]
  //
  // Because the message is a fixed size up to reading the address, I avoiding having to kludge
  //  around this by just saying .recv(4) and then using standard if statements instead of a chain of .recv(1)s
  //  but because this step comes after the split, it needs to
  

 //the trick here is that promises chain: .then() records the handler you pass it and then returns a new promise which will be fired after that promise completes and finishes the handler 
 // how do I write branching with promises?
 //  Promises/A+ makes it easy enough to write a chain of steps and
 //   get async almost free (the only expense is some repetition: .then().then().then()....)
 // MSFT even has an excellent doc on doing this: http://msdn.microsoft.com/en-us/library/windows/apps/Hh700334.aspx
 //
 // In principle, you should be able to have a promise that represents
 // the final result of a branching
 // How to express this is escaping me at the moment.

  //NB: the non-lint'd indenting is on purpose here!
  //    The correct indents would distract, because the .then()s
  //    are basically boilerplate around the real process. 
  
  var self = this;
  var ws = this._ws;
  
  // check the remote server version
  return ws.recv(1)
  .then(function(b) { return self._validate_version(b) })
  
  // parse the response type
  .then(function()  { return ws.recv(1) })
  .then(function(b) {
    if(b != self.responses.OK) {
      throw "SOCKS tunnel refused"
      //TODO: give more detailed error message based on what b is
    }
  })
  
  // check that the 'reserved' byte is actually unused;
  // if it's not, we might be not talking to SOCKS
  .then(function() { return ws.recv(1) }) // NB: Promises/A+ says that you can chain promises: http://promisesaplus.com/#point-49
  .then(function(b) {
    if(b != self.RSV ) { 
      throw "Malformed SOCKS reply"
    }
  })
  
  
  // determine the length of the next field, which is "bind.addr",
  // telling us what our remote host is
  .then(function() { return ws.recv(1) })
  .then(function(b) {
    switch(b) {
      case self.atype.IPv4: //ipv4: 4 bytes
        return ws.recv(4).then(function(addr) {
          //TODO: parse the bytes into a IP string
          self.remote.host = addr;
        })
        break;
      case self.atype.DOMAINNAME: // domain name: a fortran-style string (so we need to read 1 byte to find out the length)
        return ws.recv(1).then(function(h) {
          h = h.charCodeAt(0) //extract the number of bytes to read
          ws.recv(h).then(function(addr) {
            //the string as given is a string
            self.remote.host = addr;
          })
        })
        break;
      case self.atype.IPv6: //ipv6: 16 bytes
        return ws.recv(16).then(function(addr) {
          //TODO: parse the octets into a string
          self.remote.host = addr;
        })
        break;
      default:
        throw "Received unknown address type";
      }
  })
  
  // finally, read the port
  .then(function() { return ws.recv(2) })
  .then(function(b) {
    self.remote.port = b.charCodeAt(0) << 8 | b.charCodeAt(1)
  })
      
}


// C) Get out of the way: just forward packets
//

SOCKS5.prototype.recv = function(n) {
  // XXX I don't think I'm doing this right
  // TODO: ensure that recv() on the outer can be called before the SOCKS negotiation is done
  //  it should block until
  // XXX as written this could interfere with the SOCKS negotiation and totally screw up everything
  
  return this._ws.recv(n)
}

SOCKS5.prototype.recvline = function() {
  // XXX I don't think I'm doing this right
  // TODO: ensure that recv() on the outer can be called before the SOCKS negotiation is done
  
  return this._ws.recvline()
}

SOCKS5.prototype.send = function(d) {
  return this._ws.send(d)
}

SOCKS5.prototype.close = function() {
  return this._ws.close();
}

SOCKS5.prototype.onopen = function(evt) {} 
SOCKS5.prototype.onclose = function(evt) {} 
SOCKS5.prototype.onerror = function(evt) {} 

// These constants are hardcoded to correspond to their encoding within the protocol
// SOCKS is simple enough that the constants it uses are all single bytes.
SOCKS5.prototype.VERSION = String.fromCharCode(5) // i.e. SOCKS version 5
SOCKS5.prototype.RSV = String.fromCharCode(0) //RESERVED byte

SOCKS5.prototype.auth = {
                         NONE: String.fromCharCode(0),
                         GSSAPI: String.fromCharCode(1),
                         LOGIN: String.fromCharCode(2),
                         UNACCEPTABLE: String.fromCharCode(0xFF),
                         // all others are reserved either by IANA or for custom use
                         // i.e. probably no one uses them(?) 
                         }
                         
                         
SOCKS5.prototype.commands = {CONNECT: String.fromCharCode(1),
                          BIND: String.fromCharCode(2),
                          UDP: String.fromCharCode(3)}
                         
SOCKS5.prototype.atype = {
                          IPv4: String.fromCharCode(1),
                          DOMAINNAME: String.fromCharCode(3),
                          IPv6: String.fromCharCode(4)
                          }


SOCKS5.prototype.responses = {OK: String.fromCharCode(0),
                             //TODO: there's 8 possible errors
                            }


return SOCKS5;
}));