var disposable = require('@phosphor/disposable');
var coreutils = require('@jupyterlab/coreutils');
var KernelFutureHandler = require('@jupyterlab/services/kernel/future').KernelFutureHandler;
var CommHandler = require('@jupyterlab/services/kernel/comm').CommHandler;

var EmacsJupyter = function(options) {
    var _this = this;

    this.username = options.username || '';
    // This is the Jupyter session id
    this.clientId = options.clientId;
    this.isDisposed = false;
    this.commPromises = new Map();
    this.targetRegistry = {};
    this.futures = new Map();
    this.widgetManager = null;
    this.widgetState = null;
    this.commManager = null;
    this.messagePromise = Promise.resolve();

    window.addEventListener("unload", function(event) {
        var XHR = window.skewerNativeXHR || XMLHttpRequest;
        var xhr = new XHR();
        xhr.open('POST', skewer.host + '/jupyter/widgets/state/' + _this.clientId, false);
        xhr.setRequestHeader("Content-Type", "text/plain");
        xhr.send(JSON.stringify(_this.widgetState));
        return undefined;
    });

    // Kick off the message receiving process
    var callback = function(msg) {
        if(_this.isDisposed) {
            return;
        }

        var p = _this.handlerPromise;
        _this.handlerPromise = new Promise(function (resolve) {
            if(msg.buffers && msg.buffers.length > 0) {
                for(var i = 0; i < msg.buffers.length; i++) {
                    var bin = atob(msg.buffers[i]);
                    var len = bin.length;
                    var buf = new Uint8Array(len);
                    for(var j = 0; j < len; j++) {
                        buf[j] = bin.charCodeAt(j);
                    }
                    msg.buffers[i] = buf.buffer;
                }
            }

            resolve(Promise.all([p, _this.handleMessage(msg)]).then(function () {
                skewer.getJSON(EmacsJupyter.baseUrl + "/recv?clientId=" + _this.clientId, callback);
            }));
        });
    };
    skewer.getJSON(EmacsJupyter.baseUrl + "/recv?clientId=" + _this.clientId, callback);
};
exports.EmacsJupyter = EmacsJupyter;

EmacsJupyter.baseUrl = skewer.host + "/jupyter/widgets"

EmacsJupyter.prototype.dispose = function () {
    if (this.isDisposed) {
        return;
    }
    this.isDisposed = true;
    this.commPromises.forEach(function (promise, key) {
        promise.then(function (comm) {
            comm.dispose();
        });
    });
};

EmacsJupyter.prototype.registerCommTarget = function(targetName, callback) {
    var _this = this;
    this.targetRegistry[targetName] = callback;
    return new disposable.DisposableDelegate(function () {
        if (!_this.isDisposed) {
            delete _this.targetRegistry[targetName];
        }
    });
};

EmacsJupyter.prototype.connectToComm = function (targetName, commId) {
    var _this = this;
    var id = commId || coreutils.uuid();
    if (this.commPromises.has(id)) {
        return this.commPromises.get(id);
    }
    var promise = Promise.resolve(void 0).then(function () {
        return new CommHandler(targetName, id, _this, function () { _this._unregisterComm(id); });
    });
    this.commPromises.set(id, promise);
    return promise;
};

EmacsJupyter.prototype.handleCommOpen = function (msg) {
    var _this = this;
    var content = msg.content;
    if (this.isDisposed) {
        return;
    }
    var promise = this.loadObject(content.target_name, content.target_module, this.targetRegistry).then(function (target) {
        var comm = new CommHandler(content.target_name, content.comm_id, _this, function () { _this._unregisterComm(content.comm_id); });
        var response;
        try {
            response = target(comm, msg);
        }
        catch (e) {
            comm.close();
            console.error('Exception opening new comm');
            throw (e);
        }
        return Promise.resolve(response).then(function () {
            if (_this.isDisposed) {
                return;
            }
            return comm;
        });
    });
    this.commPromises.set(content.comm_id, promise);
    return undefined;
};

EmacsJupyter.prototype.handleCommClose = function (msg) {
    var _this = this;
    var content = msg.content;
    var promise = this.commPromises.get(content.comm_id);
    if (!promise) {
        console.error('Comm not found for comm id ' + content.comm_id);
        return;
    }
    promise.then(function (comm) {
        if (!comm) {
            return;
        }
        _this._unregisterComm(comm.commId);
        try {
            var onClose = comm.onClose;
            if (onClose) {
                onClose(msg);
            }
            comm.dispose();
        }
        catch (e) {
            console.error('Exception closing comm: ', e, e.stack, msg);
        }
    });

    return undefined;
};

EmacsJupyter.prototype.handleCommMsg = function (msg) {
    var promise = this.commPromises.get(msg.content.comm_id);
    if (!promise) {
        // We do have a registered comm for this comm id, ignore.
        return;
    }
    promise.then(function (comm) {
        if (!comm) {
            return;
        }
        try {
            var onMsg = comm.onMsg;
            if (onMsg) {
                onMsg(msg);
            }
        }
        catch (e) {
            console.error('Exception handling comm msg: ', e, e.stack, msg);
        }
    });

    return undefined;
};

EmacsJupyter.prototype.loadObject = function(name, moduleName, registry) {
    return new Promise(function (resolve, reject) {
        // Try loading the view module using require.js
        if (moduleName) {
            if (typeof window.require === 'undefined') {
                throw new Error('requirejs not found');
            }
            window.require([moduleName], function (mod) {
                if (mod[name] === void 0) {
                    var msg = "Object '" + name + "' not found in module '" + moduleName + "'";
                    reject(new Error(msg));
                }
                else {
                    resolve(mod[name]);
                }
            }, reject);
        }
        else {
            if (registry && registry[name]) {
                resolve(registry[name]);
            }
            else {
                reject(new Error("Object '" + name + "' not found in registry"));
            }
        }
    });
}

EmacsJupyter.prototype._unregisterComm = function (commId) {
    this.commPromises.delete(commId);
};

// It looks like widgets send messages through the callbacks of a
// KernelFutureHandler so I will have to redirect all received messages that
// originated from a request generated by skewer.postJSON back to the
// JavaScript environment. Emacs then acts as an intermediary, capturing kernel
// messages and re-packaging them to send to the Javascript environment.
//
// It looks like whenever the kernel receives a message it accesse the correct
// future object using this.futures.get and calls handleMsg function of the
// future.
//
// The flow of message with respect to Comm objects is that Comm object send
// shell messages, then widgets register callbacks on the future.
EmacsJupyter.prototype.sendShellMessage = function(msg, expectReply, disposeOnDone) {
    var _this = this;
    if (expectReply === void 0) { expectReply = false; }
    if (disposeOnDone === void 0) { disposeOnDone = true; }

    var future = new KernelFutureHandler(function () {
        var msgId = msg.header.msg_id;
        _this.futures.delete(msgId);
    }, msg, expectReply, disposeOnDone, this);

    var promise = new Promise(function (resolve) {
        skewer.postJSON(EmacsJupyter.baseUrl + "/send/" + _this.clientId, msg, function (reply) {
            // This is needed since Emacs will generate a new ID on every
            // messsage sent, this is the least intrusive way of handling it.
            var id = reply.id;
            msg.header.msg_id = id;
            _this.futures.set(id, future);
            resolve(void 0);
        });
    });
    if(_this.pending === void 0) {
        _this.pending = promise;
    } else {
        _this.pending = Promise.all([_this.pending, promise]);
    }
    return future;
};

EmacsJupyter.prototype.requestCommInfo = function(targetName) {
    var msg = {
        channel: 'shell',
        msg_type: 'comm_info_request',
        // A message ID will be added by Emacs anyway
        header: {msg_id: ''},
        content: {target_name: targetName}
    };
    var future = this.sendShellMessage(msg, true);
    return new Promise(function (resolve) {
        future.onReply = resolve;
    });
};

EmacsJupyter.prototype.handleMessage = function(msg) {
    var _this = this;
    var parentHeader = msg.parent_header;
    var future = parentHeader && this.futures && this.futures.get(parentHeader.msg_id);
    if (future) {
        return new Promise(function (resolve, reject) {
            try {
                future.handleMsg(msg);
                resolve(msg);
            } catch(err) {
                reject(err);
            }
        });
    } else {
        return new Promise(function (resolve, reject) {
            switch(msg.msg_type) {
                // Special messages not really a Jupyter message
            case 'display_model':
                _this.widgetManager.get_model(msg.content.model_id).then(function (model) {
                    _this.widgetManager.display_model(undefined, model);
                });
                break;
            case 'clear_display':
                var widget = _this.widgetManager.area;
                while(widget.firstChild) {
                    widget.removeChild(widget.firstChild);
                }
                break;
                // Regular Jupyter messages
            case 'comm_open':
                _this.handleCommOpen(msg);
                // Periodically get the state of the widgetManager, this gets
                // sent to the browser when its unloaded.
                // _this.widgetManager.get_state({}).then(function (state) {
                //     _this.widgetState = state;
                // });
                break;
            case 'comm_close':
                _this.handleCommClose(msg);
                break;
            case 'comm_msg':
                _this.handleCommMsg(msg);
                break;
            case 'status':
                // Comes from the comm info messages
                break;
            default:
                reject(new Error('Unhandled message', msg));
            };
            resolve(msg);
        });
    }
}

// The CommHandler object handles comm interaction to/from the kernel. It takes
// a target_name, usually jupyter.widget, and a comm id and takes care of
// sending comm messages to the kernel and calls the callback methods when a
// comm msg is received from the kernel.

// A Comm object is just a wrapper around a CommHandler that updates its
// callbacks

// The targetRegistry is a dictionary mapping target names to target functions
// to call whenever a new Comm is requested to be open by the kernel. The
// target function gets called with the message data cand a comm handler.

// A CommManager takes care of registering new comm targets and creating new
// comms and holding a list of all the live comms.

// It looks like I just ned to implement the IKernel interface and pass the
// object that implements it to CommManager, this way I can create new comms
// with CommManager.new_comm when handling comm_open messages. In the IKernel
// interface, I'll just redirect all the message sending functions to Emacs.
