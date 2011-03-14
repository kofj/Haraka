// Forward to an SMTP server

var constants = require('../../constants');
var config    = require('../../config');
var linesock  = require('../../line_socket');
var os        = require('os');

var next_state = {
    connect:    'helo',
    helo:       'mail_from',
    mail_from:  'rcpt_to',
    rcpt_to:    'data',
    data:       'dot',
    dot:        'quit',
};

exports.register = function () {
    this.register_hook('queue', 'smtp_forward');
};

var smtp_regexp = /^([0-9]{3})([ -])(.*)/;

exports.smtp_forward = function (callback) {
    this.loginfo("smtp forwarding");
    if (!this.connection.transaction.data_lines.length) {
        // Nothing in the data section, let's just decline it.
        return callback(constants.cont);
    }
    var smtp_config = config.get('smtp_forward.ini', 'ini');
    var socket = new linesock.Socket;
    socket.connect(smtp_config.main.port, smtp_config.main.host);
    var self = this;
    var connection = this.connection;
    var command = 'connect';
    var buf = '';
    var response = [];
    var recipients = this.connection.transaction.rcpt_to.map(function(item) { return item });
    console.log(recipients);
    var data_marker = 0;
    
    var send_data = function () {
        if (data_marker < connection.transaction.data_lines.length) {
            var wrote_all = socket.write(connection.transaction.data_lines[data_marker].replace(/^\./, '..'));
            data_marker++;
            if (wrote_all) {
                send_data();
            }
        }
        else {
            socket.write('.' + "\r\n");
        }
    }
    
    socket.on('error', function (err) {
        self.logerror("Ongoing connection failed: " + err);
        // we don't deny on error - maybe another plugin can deliver
        callback(constants.cont); 
    });
    socket.on('connect', function () {
    });
    socket.on('line', function (line) {
        var matches;
        self.logdebug("S: " + line);
        if (matches = smtp_regexp.exec(line)) {
            var code = matches[1],
                cont = matches[2],
                rest = matches[3];
            response.push(rest);
            if (cont === ' ') {
                if (code.match(/^[45]/)) {
                    socket.end();
                    return callback(constants.cont);
                }
                switch (command) {
                    case 'connect':
                        socket.write('HELO ' + os.hostname() + "\r\n");
                        break;
                    case 'helo':
                        socket.write('MAIL FROM:' + connection.transaction.mail_from + "\r\n");
                        break;
                    case 'mail_from':
                        var to_send = 'RCPT TO:' + recipients.shift() + "\r\n";
                        self.logdebug("C: " + to_send);
                        socket.write(to_send);
                        if (recipients.length) {
                            // don't move to next state if we have more recipients
                            return;
                        }
                        break;
                    case 'rcpt_to':
                        socket.write('DATA' + "\r\n");
                        break;
                    case 'data':
                        send_data();
                        break;
                    case 'dot':
                        socket.write('QUIT' + "\r\n");
                        break;
                    case 'quit':
                        socket.end();
                        callback(constants.ok);
                    default:
                        throw "Unknown command: " + command;
                }
                command = next_state[command];
            }
        }
        else {
            // Unrecognised response.
            self.logerror("Unrecognised response from upstream server: " + line);
            socket.end();
            return callback(constants.cont);
        }
    });
    socket.on('drain', function() {
        self.logdebug("Drained");
        if (command === 'dot') {
            send_data();
        }
    });
};
