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
 * App storage.
 */

const AppStorage    = module.exports = exports;

const path          = require('path');
const Sequelize     = require('sequelize');

AppStorage.ACTIVITY_CALL = 1;
AppStorage.ACTIVITY_RING = 2;
AppStorage.ACTIVITY_SMS = 3;
AppStorage.ACTIVITY_INBOX = 4;
AppStorage.ACTIVITY_USSD = 5;
AppStorage.ACTIVITY_CUSD = 6;

AppStorage.PRIORITY_ABOVE = 10;
AppStorage.PRIORITY_NORMAL = 20;
AppStorage.PRIORITY_BELOW = 50;

AppStorage.init = function(options) {
    this.db = new Sequelize(options);
    this.GwQueue = this.import('GwQueue');
    this.GwLog = this.import('GwLog');
    return new Promise((resolve, reject) => {
        this.db.authenticate().then(() => {
            resolve();
        }).catch((err) => {
            reject(err);
        });
    });
}

AppStorage.import = function(model) {
    return this.db.import(path.join(__dirname, 'model', model));
}

AppStorage.saveQueue = function(origin, queue, done) {
    const cb = (result) => {
        if (typeof done == 'function') {
            done(result);
        }
    }
    this.GwQueue.count({where: {imsi: origin, hash: queue.hash}}).then((count) => {
        if (count == 0) {
            queue.imsi = origin;
            queue.processed = 0;
            queue.status = 0;
            if (!queue.priority) queue.priority = this.PRIORITY_NORMAL;
            if (!queue.time) queue.time = new Date();
            this.GwQueue.create(queue).then((result) => {
                cb(result);
            }).catch((err) => {
                cb();
            });
        } else {
            cb();
        }
    }).catch((err) => {
        console.log(err);
        cb();
    });
}

AppStorage.saveLog = function(origin, log, done) {
    this.GwLog.count({where: {imsi: origin, hash: log.hash, type: log.type}}).then((count) => {
        if (count == 0) {
            this.GwLog.create({
                imsi: origin,
                hash: log.hash,
                type: log.type,
                address: log.address,
                data: log.data,
                status: log.status,
                time: log.time
            }).then((result) => {
                if (typeof done == 'function') {
                    done(result);
                }
            });
        }
    }).catch((err) => {
        console.log(err);
    });
}

AppStorage.updateReport = function(origin, report, done) {
    const condition = {imsi: origin, hash: report.hash, type: this.ACTIVITY_SMS};
    this.GwLog.count({where: condition}).then((count) => {
        if (count == 1) {
            this.GwLog.findOne({where: condition}).then((GwLog) => {
                GwLog.update({
                    code: report.code,
                    sent: report.sent,
                    received: report.received
                }).then((GwLog) => {
                    if (typeof done == 'function') {
                        done(GwLog);
                    }
                });
            });
        }
    }).catch((err) => {
        console.log(err);
    });
}

AppStorage.countRecents = function() {
    const table = 'gw_queue';
    const sql = `SELECT COUNT(a.id) AS count FROM ${table} AS a
INNER JOIN (
  SELECT address, MAX(id) AS id, MAX(time) AS time
  FROM ${table}
  WHERE type IN (${this.ACTIVITY_SMS}, ${this.ACTIVITY_INBOX})
  GROUP BY address
) AS b ON a.id = b.id`;
    return this.db.query(sql, {type: this.db.QueryTypes.SELECT});
}

AppStorage.getRecents = function(offset, limit) {
    const table = 'gw_queue';
    const sql = `SELECT a.* FROM ${table} AS a
INNER JOIN (
  SELECT address, MAX(id) AS id, MAX(time) AS time
  FROM ${table}
  WHERE type IN (${this.ACTIVITY_SMS}, ${this.ACTIVITY_INBOX})
  GROUP BY address
) AS b ON a.id = b.id
ORDER BY a.time DESC LIMIT ?, ?`;
    return this.db.query(sql, {replacements: [offset, limit], type: this.db.QueryTypes.SELECT,
        model: this.GwQueue});
}