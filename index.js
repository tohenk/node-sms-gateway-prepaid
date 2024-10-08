/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018-2024 Toha <tohenk@yahoo.com>
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

const fs = require('fs');
const path = require('path');
const moment = require('moment');
const formatNumber = require('format-number')();

/**
 * Prepaid plugin.
 */
class PrepaidPlugin {

    ACTIVITY_CALL = 1;
    ACTIVITY_RING = 2;
    ACTIVITY_SMS = 3;
    ACTIVITY_INBOX = 4;
    ACTIVITY_USSD = 5;
    ACTIVITY_CUSD = 6;

    months = [
        ['jan'],
        ['feb', 'peb'],
        ['mar'],
        ['apr'],
        ['mei', 'may'],
        ['jun'],
        ['jul'],
        ['agu', 'aug'],
        ['sep'],
        ['okt', 'oct'],
        ['nop', 'nov'],
        ['des', 'dec'],
    ]

    constructor(appterm) {
        this.name = 'prepaid';
        this.title = 'Prepaid';
        this.description = 'Prepaid allows checking for balance and active period for prepaid card';
        this.icon = 'dollar sign';
        this.appterm = appterm;
        this.prepaid = {};
        this.data = {};
    }

    initialize() {
        this.workdir = this.appterm.config.datadir ? path.join(this.appterm.config.datadir, 'prepaid') :
            path.join(__dirname, 'data');
        this.prepaidfile = path.join(__dirname, 'prepaid.json');
        this.datafile = path.join(this.workdir, 'prepaid.info');
        if (!fs.existsSync(this.workdir)) {
            fs.mkdirSync(this.workdir);
        }
        this.readPrepaidData();
        this.readData();
        this.watchPrepaidData();
    }

    watchPrepaidData() {
        fs.watchFile(this.prepaidfile, (curr, prev) => {
            if (curr.mtime !== prev.mtime) {
                console.log('Prepaid data is changed, reloading');
                this.readPrepaidData();
            }
        });
    }

    readPrepaidData() {
        try {
            const data = JSON.parse(fs.readFileSync(this.prepaidfile));
            this.prepaid = data;
        }
        catch (err) {
            console.log(err);
        }
    }

    readData() {
        if (fs.existsSync(this.datafile)) {
            this.data = JSON.parse(fs.readFileSync(this.datafile));
        }
    }

    writeData() {
        fs.writeFile(this.datafile, JSON.stringify(this.data, null, 4), err => {
            if (err) {
                console.log(err);
            }
        });
    }

    parse(queue, data) {
        const responses = typeof data.response === 'string' ? [data.response] : data.response;
        responses.forEach(pattern => {
            const re = new RegExp(pattern);
            const match = re.exec(queue.data);
            if (match) {
                console.log('Prepaid matches: %s', JSON.stringify(match));
                if (match.groups.BALANCE && match.groups.ACTIVE) {
                    const info = {
                        response: queue.data,
                        balance: match.groups.BALANCE,
                        active: match.groups.ACTIVE,
                        time: new Date()
                    }
                    if (!this.data[queue.imsi]) {
                        this.data[queue.imsi] = {};
                    }
                    Object.assign(this.data[queue.imsi], info);
                    this.writeData();
                    this.formatInfo(info);
                    this.appterm.uiCon.emit('prepaid', queue.imsi, info);
                }
            }
        });
    }

    formatInfo(info) {
        if (typeof info.time === 'string') {
            try {
                const time = new Date(info.time);
                info.time = time;
            }
            catch (err) {
                console.error(err.message);
            }
        }
        if (info.time instanceof Date) {
            info.time = moment(info.time).format('DD MMM YYYY HH:mm');
        }
        if (info.balance !== undefined) {
            info.balance = formatNumber(parseFloat(info.balance));
        }
        if (info.active !== undefined) {
            info.active = this.fixDate(info.active);
        }
    }

    fixDate(str) {
        let separator, parts;
        ['.', '-', '/'].forEach(sep => {
            if (str.indexOf(sep) >= 0) {
                separator = sep;
                return true;
            }
        });
        if (separator) {
            parts = str.split(separator);
        } else {
            const re = new RegExp('[a-zA-Z]+');
            const match = re.exec(str);
            if (match) {
                parts = str.split(match[0]);
                parts.splice(1, 0, match[0]);
            }
        }
        if (parts && parts.length === 3) {
            // assume D-M-Y
            const d = parseInt(parts[0]);
            const m = !isNaN(parts[1]) ? parseInt(parts[1]) : this.monthIndex(parts[1]);
            const y = parseInt(parts[2].length === 2 ? (new Date()).getFullYear().toString().substr(0, 2) + parts[2] : parts[2]);
            str = moment(new Date(y, m - 1, d)).format('DD MMM YYYY');
        }
        return str;
    }

    monthIndex(month) {
        let res = 0;
        if (month) {
            month = month.substr(0, 3).toLowerCase();
            this.months.forEach((names, idx) => {
                if (names.indexOf(month) >= 0) {
                    res = idx + 1;
                    return true;
                }
            });
        }
        return res;
    }

    handle(queue) {
        if (queue.type === this.ACTIVITY_CUSD) {
            const term = this.appterm.get(queue.imsi);
            if (term) {
                const data = this.prepaid[term.info.network.code] ? this.prepaid[term.info.network.code] :
                    this.prepaid[queue.imsi.substr(0, 5)];
                if (data && data.ussd === queue.address) {
                    this.parse(queue, data);
                }
            }
        }
    }

    router(req, res, next) {
        if (req.method === 'GET') {
            let nr = 0;
            const items = [];
            this.appterm.terminals.forEach(term => {
                const info = {
                    nr: ++nr,
                    name: term.name,
                    operator: term.info.network.operator
                }
                if (this.data[term.name]) {
                    info.response = this.data[term.name].response ? this.data[term.name].response : null;
                    info.balance = this.data[term.name].balance ? this.data[term.name].balance : null;
                    info.active = this.data[term.name].active ? this.data[term.name].active : null,
                    info.time = this.data[term.name].time ? this.data[term.name].time : null;
                }
                this.formatInfo(info);
                items.push(info);
            });
            res.render('prepaid', {items: items});
        }
        if (req.method === 'POST') {
            const result = {success: false}
            switch (req.query.cmd) {
                case 'check':
                    const term = this.appterm.get(req.body.imsi);
                    if (term) {
                        const data = this.prepaid[term.info.network.code] ? this.prepaid[term.info.network.code] :
                            this.prepaid[req.body.imsi.substr(0, 5)];
                        if (data) {
                            result.success = true;
                            term.addUssdQueue(data.ussd);
                        }
                    }
                    break;
            }
            res.json(result);
        }
    }
}

module.exports = PrepaidPlugin;
