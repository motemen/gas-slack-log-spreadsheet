// Configuration: Obtain Slack web API token at https://api.slack.com/web
var API_TOKEN = PropertiesService.getScriptProperties().getProperty('slack_api_token');
if (!API_TOKEN) {
    throw 'You should set "slack_api_token" property from [File] > [Project properties] > [Script properties]';
}
var FOLDER_NAME = 'Slack Logs';
/**** Do not edit below unless you know what you are doing ****/
var COL_LOG_TIMESTAMP = 1;
var COL_LOG_USER = 2;
var COL_LOG_TEXT = 3;
var COL_LOG_RAW_JSON = 4;
var COL_MAX = COL_LOG_RAW_JSON;
// Slack offers 10,000 history logs for free plan teams
var MAX_HISTORY_PAGINATION = 10;
var HISTORY_COUNT_PER_PAGE = 1000;
function StoreLogsDelta() {
    var logger = new SlackChannelHistoryLogger();
    logger.run();
}
;
var SlackChannelHistoryLogger = (function () {
    function SlackChannelHistoryLogger() {
        this.memberNames = {};
    }
    SlackChannelHistoryLogger.prototype.requestSlackAPI = function (path, params) {
        if (params === void 0) { params = {}; }
        var url = "https://slack.com/api/" + path + "?";
        var qparams = [("token=" + encodeURIComponent(API_TOKEN))];
        for (var k in params) {
            qparams.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
        }
        url += qparams.join('&');
        Logger.log("==> GET " + url);
        var resp = UrlFetchApp.fetch(url);
        var data = JSON.parse(resp.getContentText());
        if (data.error) {
            throw "GET " + path + ": " + data.error;
        }
        return data;
    };
    SlackChannelHistoryLogger.prototype.run = function () {
        var _this = this;
        var usersResp = this.requestSlackAPI('users.list');
        usersResp.members.forEach(function (member) {
            _this.memberNames[member.id] = member.name;
        });
        var teamInfoResp = this.requestSlackAPI('team.info');
        this.teamName = teamInfoResp.team.name;
        var channelsResp = this.requestSlackAPI('channels.list');
        for (var _i = 0, _a = channelsResp.channels; _i < _a.length; _i++) {
            var ch = _a[_i];
            this.importChannelHistoryDelta(ch);
        }
    };
    SlackChannelHistoryLogger.prototype.getLogsFolder = function () {
        var folder = DriveApp.getRootFolder();
        var path = [FOLDER_NAME, this.teamName];
        path.forEach(function (name) {
            var it = folder.getFoldersByName(name);
            if (it.hasNext()) {
                folder = it.next();
            }
            else {
                folder = folder.createFolder(name);
            }
        });
        return folder;
    };
    SlackChannelHistoryLogger.prototype.getSheet = function (ch, d, readonly) {
        if (readonly === void 0) { readonly = false; }
        var dateString;
        if (d instanceof Date) {
            dateString = this.formatDate(d);
        }
        else {
            dateString = '' + d;
        }
        var spreadsheet;
        var sheetByID = {};
        var spreadsheetName = dateString;
        var folder = this.getLogsFolder();
        var it = folder.getFilesByName(spreadsheetName);
        if (it.hasNext()) {
            var file = it.next();
            spreadsheet = SpreadsheetApp.openById(file.getId());
        }
        else {
            if (readonly)
                return null;
            spreadsheet = SpreadsheetApp.create(spreadsheetName);
            folder.addFile(DriveApp.getFileById(spreadsheet.getId()));
        }
        var sheets = spreadsheet.getSheets();
        sheets.forEach(function (s) {
            var name = s.getName();
            var m = /^(.+) \((.+)\)$/.exec(name); // eg. "general (C123456)"
            if (!m)
                return;
            sheetByID[m[2]] = s;
        });
        var sheet = sheetByID[ch.id];
        if (!sheet) {
            if (readonly)
                return null;
            sheet = spreadsheet.insertSheet();
        }
        var sheetName = ch.name + " (" + ch.id + ")";
        if (sheet.getName() !== sheetName) {
            sheet.setName(sheetName);
        }
        return sheet;
    };
    SlackChannelHistoryLogger.prototype.importChannelHistoryDelta = function (ch) {
        var _this = this;
        Logger.log("importChannelHistoryDelta " + ch.name + " (" + ch.id + ")");
        var now = new Date();
        var oldest = '1'; // oldest=0 does not work
        var existingSheet = this.getSheet(ch, now, true);
        if (!existingSheet) {
            // try previous month
            now.setMonth(now.getMonth() - 1);
            existingSheet = this.getSheet(ch, now, true);
        }
        if (existingSheet) {
            var lastRow = existingSheet.getLastRow();
            try {
                var data = JSON.parse(existingSheet.getRange(lastRow, COL_LOG_RAW_JSON).getValue());
                oldest = data.ts;
            }
            catch (e) {
                Logger.log("while trying to parse the latest history item from existing sheet: " + e);
            }
        }
        var messages = this.loadMessagesBulk(ch, { oldest: oldest });
        var dateStringToMessages = {};
        messages.forEach(function (msg) {
            var date = new Date(+msg.ts * 1000);
            var dateString = _this.formatDate(date);
            if (!dateStringToMessages[dateString]) {
                dateStringToMessages[dateString] = [];
            }
            dateStringToMessages[dateString].push(msg);
        });
        for (var dateString in dateStringToMessages) {
            var sheet = this.getSheet(ch, dateString);
            var timezone = sheet.getParent().getSpreadsheetTimeZone();
            var lastTS = 0;
            var lastRow = sheet.getLastRow();
            if (lastRow > 0) {
                try {
                    var data = JSON.parse(sheet.getRange(lastRow, COL_LOG_RAW_JSON).getValue());
                    lastTS = +data.ts || 0;
                }
                catch (_) {
                }
            }
            var rows = dateStringToMessages[dateString].filter(function (msg) {
                return +msg.ts > lastTS;
            }).map(function (msg) {
                var date = new Date(+msg.ts * 1000);
                return [
                    Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm:ss'),
                    _this.memberNames[msg.user] || msg.username,
                    _this.unescapeMessageText(msg.text),
                    JSON.stringify(msg)
                ];
            });
            if (rows.length > 0) {
                var range = sheet.insertRowsAfter(lastRow || 1, rows.length)
                    .getRange(lastRow + 1, 1, rows.length, COL_MAX);
                range.setValues(rows);
            }
        }
    };
    SlackChannelHistoryLogger.prototype.formatDate = function (dt) {
        return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM');
    };
    SlackChannelHistoryLogger.prototype.loadMessagesBulk = function (ch, options) {
        var _this = this;
        if (options === void 0) { options = {}; }
        var messages = [];
        // channels.history will return the history from the latest to the oldest.
        // If the result's "has_more" is true, the channel has more older history.
        // In this case, use the result's "latest" value to the channel.history API parameters
        // to obtain the older page, and so on.
        options['count'] = HISTORY_COUNT_PER_PAGE;
        options['channel'] = ch.id;
        var loadSince = function (oldest) {
            if (oldest) {
                options['oldest'] = oldest;
            }
            // order: recent-to-older
            var resp = _this.requestSlackAPI('channels.history', options);
            messages = resp.messages.concat(messages);
            return resp;
        };
        var resp = loadSince();
        var page = 1;
        while (resp.has_more && page <= MAX_HISTORY_PAGINATION) {
            resp = loadSince(resp.messages[0].ts);
            page++;
        }
        // oldest-to-recent
        return messages.reverse();
    };
    SlackChannelHistoryLogger.prototype.unescapeMessageText = function (text) {
        var _this = this;
        return (text || '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/<@(.+?)>/g, function ($0, userID) {
            var name = _this.memberNames[userID];
            return name ? "@" + name : $0;
        });
    };
    return SlackChannelHistoryLogger;
})();
