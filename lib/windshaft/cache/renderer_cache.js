// Current {RenderCache} responsibilities:
//  - Caches (adapted) renderer objects
//  - Purges the renderer objects after `{Number} options.timeout` ms of inactivity since the last cache entry access
//    Renderer objects are encapsulated inside a {CacheEntry} that tracks the last access time for each renderer
var _ = require('underscore');
var CacheEntry = require('./cache_entry');
var step = require('step');
var RendererParams = require('../renderers/renderer_params');
//var assert = require('assert');


function RendererCache(options, mapStore, rendererFactory) {

    this.renderers = {};
    this.timeout = options.timeout || 60000;

    this.mapStore = mapStore;
    this.rendererFactory = rendererFactory;

    setInterval(function () {
        var now = Date.now();
        _.each(this.renderers, function (cacheEntry, key) {
            if (cacheEntry.timeSinceLastAccess(now) > this.timeout) {
                this.del(key);
            }
        }.bind(this));
    }.bind(this), this.timeout);

    /**
     * @param req Request object that is triggering the renderer creation
     * @param callback Function to call with:
     *  - err Error in case something goes wrong
     *  - rendererOptions Object with different options for the renderer to be created
     *
     * @type {Function}
     */
    this.beforeRendererCreate = options.beforeRendererCreate || function (req, callback) {
        return callback(null, {});
    };
}

module.exports = RendererCache;

// If renderer cache entry exists at req-derived key, return it,
// else generate a new one and save at key.
//
// Caches lifetime is driven by the timeout passed at RendererCache
// construction time.
//
//
// @param callback will be called with (err, renderer)
//        If `err` is null the renderer should be
//        ready for you to use (calling getTile or getGrid).
//        Note that the object is a proxy to the actual TileStore
//        so you won't get the whole TileLive interface available.
//        If you need that, use the .get() function.
//        In order to reduce memory usage call renderer.release()
//        when you're sure you won't need it anymore.
RendererCache.prototype.getRenderer = function(params, callback) {
    var cacheBuster = this.getCacheBusterValue(params.cache_buster);

    // setup
    var key = RendererParams.createKey(params);

    var cache_entry = this.renderers[key];

    if (this.shouldRecreateRenderer(cache_entry, cacheBuster)) {

        cache_entry = this.renderers[key] = new CacheEntry(cacheBuster);
        cache_entry._addRef(); // we add another ref for this.renderers[key]

        var self = this;

        cache_entry.on('error', function(err) {
          console.log("Removing RendererCache " + key + " on error " + err);
          self.del(key);
        });

        var context = {};
        step(
            // TODO re-enable beforeRendererCreate
//            function beforeMakeRenderer() {
//                self.beforeRendererCreate(req, this);
//            },
//            function handleRendererOptions(err, rendererOptions) {
//                assert.ifError(err);
//                context = rendererOptions;
//                return null;
//            },
//            function getConfig(err) {
//                assert.ifError(err);
            function getConfig() {
                if (!params.token) {
                    throw new Error("Layergroup `token` id is a required param");
                }
                self.mapStore.load(params.token, this);
            },
            function makeRenderer (err, mapConfig) {
                if (err) {
                    self.del(key);
                    return callback(err);
                }
                self.rendererFactory.getRenderer(mapConfig, params, context, cache_entry.setReady.bind(cache_entry));
            }
        );
    }

    cache_entry.pushCallback(callback);
};

RendererCache.prototype.getCacheBusterValue = function(cache_buster) {
    if (_.isUndefined(cache_buster)) {
        return 0;
    }
    if (_.isNumber(cache_buster)) {
        return Math.min(this._getMaxCacheBusterValue(), cache_buster);
    }
    return cache_buster;
};

RendererCache.prototype._getMaxCacheBusterValue = function() {
    return Date.now();
};

RendererCache.prototype.shouldRecreateRenderer = function(cacheEntry, cacheBuster) {
    if (cacheEntry) {
        var entryCacheBuster = parseFloat(cacheEntry.cacheBuster),
            requestCacheBuster = parseFloat(cacheBuster);

        if (isNaN(entryCacheBuster) || isNaN(requestCacheBuster)) {
            return cacheEntry.cacheBuster !== cacheBuster;
        }
        return requestCacheBuster > entryCacheBuster;
    }
    return true;
};


// delete all renderers in cache
RendererCache.prototype.purge = function(){
    var that = this;
    _.each(_.keys(that.renderers), function(key){
        that.del(key);
    });
};


// Clears out all renderers related to a given database+token, regardless of other arguments
RendererCache.prototype.reset = function(params){
    var base_key = RendererParams.createKey(params, true);
    var regex = new RegExp('^' + base_key + '.*');
    var that = this;

    _.each(_.keys(this.renderers), function(key){
        if(key.match(regex)){
            that.del(key);
        }
    });
};


// drain render pools, remove renderer and associated timeout calls
RendererCache.prototype.del = function(id){
    var cache_entry = this.renderers[id];
    delete this.renderers[id];
    cache_entry.release();
};