/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018 Toha <tohenk@yahoo.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/*
 * Queue dispatcher.
 */

const AppDispatcher = module.exports = exports;

const EventEmitter  = require('events');
const util          = require('util');
const Sequelize     = require('sequelize');
const AppStorage    = require('./storage');

const Op            = Sequelize.Op;

AppDispatcher.Dispatcher = function() {
    EventEmitter.call(this);
    this.count = 0;
    this.queues = [];
    this.loading = false;
    this.loadTime = Date.now();
    this.reloadInterval = 5 * 60 * 1000; // 5 minute
}

util.inherits(AppDispatcher.Dispatcher, EventEmitter);

AppDispatcher.Dispatcher.prototype.reload = function() {
    this.count++;
    this.check();
    return this;
}

AppDispatcher.Dispatcher.prototype.load = function() {
    if (this.count > 0) {
        this.count = 0;
        this.queues = [];
        this.loading = true;
        this.getQueues((results) => {
            this.loading = false;
            this.loadTime = Date.now();
            this.queues = results;
            this.check();
        });
    }
}

AppDispatcher.Dispatcher.prototype.getQueues = function(done) {
}

AppDispatcher.Dispatcher.prototype.check = function() {
}

AppDispatcher.Dispatcher.prototype.reloadNeeded = function() {
    if (this.count > 0 || (this.count == 0 && this.queues.length == 0)) {
        if (this.count == 0 && ((Date.now() - this.loadTime) >= this.reloadInterval) && !this.loading) {
            this.count++;
        }
        this.load();
    }
}

// Terminal Dispatcher

AppDispatcher.Terminal = function(term) {
    AppDispatcher.Dispatcher.call(this);
    this.term = term;
    this.maxRetry = 3;
    this.term.on('idle', () => {
        this.reloadNeeded();
        if (this.queues.length && !this.term.busy) {
            const queue = this.queues.shift();
            console.log('Processing queue: %s <= %s (%d)', queue.imsi, queue.hash, queue.id);
            this.process(queue);
        }
        this.check();
    });
}

util.inherits(AppDispatcher.Terminal, AppDispatcher.Dispatcher);

AppDispatcher.Terminal.prototype.getQueues = function(done) {
    AppStorage.GwQueue.findAll({
        where: {
            imsi: this.term.name,
            [Op.or]: [
                {
                    [Op.and]: [
                        {processed: 0},
                        {type: {[Op.in]: [AppStorage.ACTIVITY_CALL, AppStorage.ACTIVITY_SMS, AppStorage.ACTIVITY_USSD]}}
                    ]
                },
                {
                    [Op.and]: [
                        {processed: 1},
                        {retry: {[Op.lte]: this.maxRetry}},
                        {type: AppStorage.ACTIVITY_SMS},
                        {status: 0}
                    ]
                }
            ]
        },
        order: [
            ['priority', 'ASC'],
            ['processed', 'ASC'],
            ['time', 'ASC']
        ]
    }).then((results) => {
        done(results);
    });
}

AppDispatcher.Terminal.prototype.check = function() {
    this.term.con.emit('state');
    return this;
}

AppDispatcher.Terminal.prototype.update = function(GwQueue, success) {
    const updates = {processed: 1};
    if (success) {
        updates.status = this.term.reply.success ? 1 : 0;
    }
    if (!success && GwQueue.type == AppStorage.ACTIVITY_SMS) {
        updates.retry = GwQueue.retry ? GwQueue.retry + 1 : 1;
    }
    GwQueue.update(updates).then((result) => {
        if (GwQueue.type != AppStorage.ACTIVITY_USSD) {
            AppStorage.saveLog(GwQueue.imsi, result);
        }
    });
}

AppDispatcher.Terminal.prototype.process = function(GwQueue) {
    const f = (action) => {
        if (action) {
            action.then(() => {
                this.update(GwQueue, true);
            }).catch(() => {
                this.update(GwQueue, false);
            });
        }
    }
    switch (GwQueue.type) {
        case AppStorage.ACTIVITY_CALL:
            f(this.term.dial(GwQueue));
            break;
        case AppStorage.ACTIVITY_SMS:
            // if it is a message retry then ensure the status is really failed
            if (GwQueue.retry != null) {
                this.term.query('status', GwQueue.hash).then((status) => {
                    if (status.success && status.hash == GwQueue.hash) {
                        if (status.status) {
                            // it was success, update status
                            GwQueue.update({status: 1});
                        } else {
                            // retry message
                            f(this.term.sendMessage(GwQueue));
                        }
                    } else {
                        // message not processed yet, okay to send
                        f(this.term.sendMessage(GwQueue));
                    }
                });
            } else {
                f(this.term.sendMessage(GwQueue));
            }
            break;
        case AppStorage.ACTIVITY_USSD:
            f(this.term.ussd(GwQueue));
            break;
    }
}

// Activity Dispatcher

AppDispatcher.Activity = function(appterm) {
    AppDispatcher.Dispatcher.call(this);
    this.appterm = appterm;
    this.processing = false;
}

util.inherits(AppDispatcher.Activity, AppDispatcher.Dispatcher);

AppDispatcher.Activity.prototype.getQueues = function(done) {
    AppStorage.GwQueue.findAll({
        where: {
            processed: 0,
            type: {[Op.in]: [AppStorage.ACTIVITY_RING, AppStorage.ACTIVITY_INBOX, AppStorage.ACTIVITY_CUSD]}
        },
        order: [
            ['priority', 'ASC'],
            ['time', 'ASC']
        ]
    }).then((results) => {
        done(results);
    });
}

AppDispatcher.Activity.prototype.check = function() {
    if (this.appterm.terminals.length) {
        if (this.appterm.gwclients.length == 0 && this.appterm.plugins.length == 0) {
            console.log('Activity processing skipped, no consumer registered.');
        } else {
            this.reloadNeeded();
            this.process();
        }
    }
    return this;
}

AppDispatcher.Activity.prototype.add = function(data, group, cb) {
    const terminals = this.getTerminal(data.type, data.address, group);
    if (terminals.length == 0) {
        console.log('No terminal available for activity %d => %s (%d)', data.type,
            data.address, group ? group : '-');
    } else {
        var index = 0;
        if (terminals.length > 1) {
            terminals.sort((a, b) => {
                return a.options.priority - b.options.priority;
            });
            index = Math.floor(Math.random() * terminals.length);
        }
        terminals[index].addQueue(data, cb);
    }
}

AppDispatcher.Activity.prototype.getTerminal = function(type, address, group) {
    const result = [];
    for (var i = 0; i < this.appterm.terminals.length; i++) {
        var term = this.appterm.terminals[i];
        if (!term.connected) continue;
        if (group && term.options.group != group) continue;
        if (type == AppStorage.ACTIVITY_CALL && !term.options.allowCall) continue;
        if (type == AppStorage.ACTIVITY_SMS && !term.options.sendMessage) continue;
        if (term.options.operators.length && type != AppStorage.ACTIVITY_USSD) {
            var op = this.appterm.getOperator(address);
            if (!op) continue;
            if (term.options.operators.indexOf(op) < 0) continue;
        }
        result.push(term);
    }
    return result;
}

AppDispatcher.Activity.prototype.process = function() {
    if (this.queues.length && !this.processing) {
        this.processing = true;
        process.nextTick(() => {
            if (this.queues.length) {
                const queue = this.queues.shift();
                this.emit('queue', queue);
            }
        });
        this.once('queue', (queue) => {
            this.processQueue(queue, () => {
                this.processing = false;
                if (this.appterm.uiCon) {
                    this.appterm.uiCon.emit('queue-processed', queue);
                }
                this.check();
            });
        });
    }
    if (this.queues.length == 0) {
        if (!this.timeout) {
            this.timeout = setTimeout(() => {
                this.timeout = null;
                this.check();
            }, this.reloadInterval);
        }
    }
}

AppDispatcher.Activity.prototype.processQueue = function(GwQueue, done) {
    const term = this.appterm.get(GwQueue.imsi);
    if (term) {
        var processed = true;
        if (GwQueue.type == AppStorage.ACTIVITY_RING || GwQueue.type == AppStorage.ACTIVITY_INBOX) {
            processed = this.addressAllowed(GwQueue.address) ? true : false;
        }
        // skip message based its terminal setting
        if (processed && !term.options.receiveMessage && GwQueue.type == AppStorage.ACTIVITY_INBOX) {
            processed = false;
        }
        if (processed) {
            if (this.appterm.gwclients.length) {
                this.appterm.gwclients.forEach((socket) => {
                    if (term.options.group == socket.group) {
                        console.log('Sending activity notification %d-%s to %s', GwQueue.type,
                            GwQueue.hash, socket.id);
                        switch (GwQueue.type) {
                            case AppStorage.ACTIVITY_RING:
                                socket.emit('ring', GwQueue.hash, GwQueue.address, GwQueue.time);
                                break;
                            case AppStorage.ACTIVITY_INBOX:
                                socket.emit('message', GwQueue.hash, GwQueue.address, GwQueue.data, GwQueue.time);
                                break;
                            case AppStorage.ACTIVITY_CUSD:
                                socket.emit('ussd', GwQueue.hash, GwQueue.address, GwQueue.data, GwQueue.time);
                                break;
                        }
                    } else {
                        console.log('Skipping activity notification %d-%s for %s', GwQueue.type,
                            GwQueue.hash, socket.id);
                    }
                });
            }
            this.appterm.plugins.forEach((plugin) => {
                if (plugin.group == undefined || term.options.group == plugin.group) {
                    plugin.handle(GwQueue);
                    if (GwQueue.veto) {
                        return true;
                    }
                }
            });
        }
        GwQueue.update({processed: 1, status: processed ? 1 : 0}).then(() => {
            done();
        }).catch((err) => {
            console.log(err);
            done();
        });
    } else {
        done();
    }
}

AppDispatcher.Activity.prototype.addressAllowed = function(address) {
    if (address) {
        const blacklists = this.appterm.config.blacklists || [];
        const premiumlen = this.appterm.config.premiumlen || 5;
        if (isNaN(address)) {
            console.log('Number %s is unreachable', address);
            return false;
        }
        if (address.length <= premiumlen) {
            console.log('Number %s is premium', address);
            return false;
        }
        if (blacklists.indexOf(address) >= 0) {
            console.log('Number %s is blacklisted', address);
            return false;
        }
        return true;
    }
}