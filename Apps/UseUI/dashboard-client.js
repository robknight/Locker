/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var express = require('express'),
    connect = require('connect'),
    path = require('path'),
    async = require('async'),
    fs = require('fs'),
    socketio = require('socket.io'),
    request = require('request');
var logger = require("logger").logger;


var externalBase;
var locker;
module.exports = function(passedLocker, passedExternalBase, listenPort, callback) {
    locker = passedLocker;
    externalBase = passedExternalBase;
    app.listen(listenPort, callback);
};

var app = express.createServer();

app.configure(function() {
    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');
    app.set('view options', {
      layout: false
    });
    app.use(express.bodyParser());
    app.use(express.static(__dirname + '/static'));
});

app.get('/app', 
function(req, res) {
    var lconfig = require('../../Common/node/lconfig.js');
    lconfig.load('../../Config/config.json');
    var rev = fs.readFileSync(path.join(lconfig.lockerDir, '/../', 'gitrev.json'), 'utf8');
    var customFooter;
    if (lconfig.dashboard && lconfig.dashboard.customFooter) {
        customFooter = fs.readFileSync(__dirname + '/views/' + lconfig.dashboard.customFooter, 'utf8');
    }
    res.render('app', {
        dashboard: lconfig.dashboard,
        customFooter: customFooter,
        revision: rev.substring(1,11)
    });
});

// dumb defaults
var options = { logger: {
   info: new Function(),
   error: new Function(),
   warn: new Function(),
   debug: new Function()
 }};
var io = socketio.listen(app,options);

app.get('/apps', function(req, res) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    var apps = {contacts: {url : externalBase + '/Me/contactsviewer/', id : 'contactsviewer'},
                photos: {url : externalBase + '/Me/photosviewer/', id : 'photosviewer'},
                links: {url : externalBase + '/Me/linkalatte/', id : 'linkalatte'},
                search: {url : externalBase + '/Me/searchapp/', id : 'searchapp'}};
    res.end(JSON.stringify(apps));
});

var eventInfo = {
    "link":{"name":"link", "timer":null, "count":0, "new":0, "updated":0},
    "contact/full":{"name":"contact", "timer":null, "count":0, "new":0, "updated":0},
    "photo":{"name":"photo", "timer":null, "count":0, "new":0, "updated":0}
};

// lame way to track if any browser is actually open right now
var isSomeoneListening = 0;

app.post('/event', function(req, res) {
    res.send({}); // any positive response
    if(isSomeoneListening == 0) return; // ignore if nobody is around, shouldn't be getting any anyway
    if (req && req.body) {
        var evInfo = eventInfo[req.body.type];
        evInfo.new++;
        if (evInfo.timer) {
            clearTimeout(evInfo.timer);
        }
        evInfo.timer = setTimeout(function() {
            evInfo.count += evInfo.new;
            evInfo.updated = new Date().getTime();
            io.sockets.emit('event',{"name":evInfo.name, "new":evInfo.new, "count":evInfo.count, "updated":evInfo.updated});
            evInfo.new = 0;
            saveState();
        }, 2000);
    }
});


// just snapshot to disk every time we push an event so we can compare in the future
function saveState()
{
    var counts = {};
    for (var key in eventInfo) {
        if (eventInfo.hasOwnProperty(key)) counts[key] = {count:eventInfo[key].count};
    }
    fs.writeFileSync("state.json", JSON.stringify(counts));
}

// compare last-sent totals to current ones and send differences
function bootState()
{
    if(isSomeoneListening > 0) return; // only boot after we've been idle
    logger.debug("booting state fresh");
    async.forEach(['contacts','links','photos'],function(coll,callback){
        logger.debug("fetching "+locker.lockerBase+'/Me/'+coll+'/state '+ JSON.stringify(locker) );
        request.get({uri:locker.lockerBase+'/Me/'+coll+'/state',json:true},function(err,res,body){
            if(coll == 'links') var evInfo = eventInfo['link'];
            if(coll == 'photos') var evInfo = eventInfo['photo'];
            if(coll == 'contacts') var evInfo = eventInfo['contact/full'];
            evInfo.count = (body && body.count && body.count > 0) ? body.count : 0;
            evInfo.updated = (body && body.updated && body.updated > 0) ? body.updated : 0;
            callback();
        });
    },function(){
        var last = {
            "link":{"count":0},
            "contact/full":{"count":0},
            "photo":{"count":0}
        };
        // try to load from file passively
        try {
            last = JSON.parse(fs.readFileSync('state.json'));
        } catch(err) {
        }
        for(var type in eventInfo) {
            // stupd vrbos
            if(eventInfo[type].count > last[type].count) io.sockets.emit('event',{"name":eventInfo[type].name, "updated":eventInfo[type].updated, "new":eventInfo[type].count - last[type].count});
        }
        saveState(); // now that we possibly pushed events, note it
        locker.listen("photo","/event");
        locker.listen("link","/event");
        locker.listen("contact/full","/event");
        var counts = {};
        for (var key in eventInfo) {
            if (eventInfo.hasOwnProperty(key)) counts[eventInfo[key].name] = {count:eventInfo[key].count, updated:eventInfo[key].updated};
        }
        io.sockets.emit("counts", counts);
    });
}

io.sockets.on('connection', function (socket) {
    logger.debug("got new socket.io connection");
    bootState();
    isSomeoneListening++;
    var counts = {};
    for (var key in eventInfo) {
        if (eventInfo.hasOwnProperty(key)) counts[eventInfo[key].name] = {count:eventInfo[key].count, updated:eventInfo[key].updated};
    }
    socket.emit("counts", counts);
    socket.on('disconnect', function () {
        isSomeoneListening--;
        // when nobody is around, don't receive events anymore
        if(isSomeoneListening == 0)
        {
            logger.debug("everybody left, quiesce");
            locker.deafen("photo","/event");
            locker.deafen("link","/event");
            locker.deafen("contact/full","/event");
        }
      });
});
