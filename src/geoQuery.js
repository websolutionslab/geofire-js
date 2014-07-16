/**
 * Creates a GeoQuery instance.
 *
 * @constructor
 * @this {GeoQuery}
 * @param {Firebase} firebaseRef A Firebase reference.
 * @param {object} queryCriteria The criteria which specifies the query's center and radius.
 */
var GeoQuery = function (firebaseRef, queryCriteria) {
  /*********************/
  /*  PRIVATE METHODS  */
  /*********************/
  /**
   * Fires each callback for the provided eventType, passing it provided key's data.
   *
   * @param {string} eventType The event type whose callbacks to fire. One of "key_entered", "key_exited", or "key_moved".
   * @param {string} key The key of the location for which to fire the callbacks.
   * @param {array|null} location The location as latitude longitude pair
   * @param {double|null} distanceFromCenter The distance from the center or null
   */
  function _fireCallbacksForKey(eventType, key, location, distanceFromCenter) {
    _callbacks[eventType].forEach(function(callback) {
      if (typeof location === "undefined" || location === null) {
        callback(key, null, null);
      }
      else {
        callback(key, location, distanceFromCenter);
      }
    });
  }

  /**
   * Fires each callback for the "ready" event.
   */
  function _fireReadyEventCallbacks() {
    _callbacks.ready.forEach(function(callback) {
      callback();
    });
  }

  /**
   * Decodes a query string to a query
   * @param {string} str The encoded query
   * @return {array} The decoded query as a [start,end] pair
   */
  function _stringToQuery(string) {
    var decoded = string.split(":");
    if (decoded.length !== 2) {
      throw new Error("Invalid internal state! Not a valid geohash query: " + string);
    }
    return decoded;
  }

  /**
   * Encodes a query as a string for easier indexing and equality
   * @param {array} query The query to encode
   * @param {string} The encoded query as string
   */
  function _queryToString(query) {
    if (query.length !== 2) {
      throw new Error("Not a valid geohash query: " + query);
    }
    return query[0]+":"+query[1];
  }

  /**
   * Turns off all callbacks for geo query
   * @param {array} query The geohash query
   */
  function _geoQueryOff(query) {
    var queryRef = _firebaseRef.startAt(query[0]).endAt(query[1]);
    queryRef.off("child_added", _childAddedCallback);
    queryRef.off("child_removed", _childRemovedCallback);
    queryRef.off("child_changed", _childChangedCallback);
  }

  /**
   * Removes unnecessary Firebase queries which are currently being queried.
   */
  function _cleanUpCurrentGeohashesQueried() {
    for (var geohashQueryStr in _currentGeohashesQueried) {
      if (_currentGeohashesQueried.hasOwnProperty(geohashQueryStr)) {
        if (_currentGeohashesQueried[geohashQueryStr] === false) {
          var query = _stringToQuery(geohashQueryStr);
          // Delete the geohash since it should no longer be queried
          _geoQueryOff(query);
          delete _currentGeohashesQueried[geohashQueryStr];
        }
      }
    }

    // Delete each location which should no longer be queried
    for (var key in _locations) {
      if (_locations.hasOwnProperty(key)) {
        if (!_geohashInSomeQuery(_locations[key].geohash)) {
            delete _locations[key];
        }
      }
    }

    // Specify that this is done cleaning up the current geohashes queried
    _geohashCleanupScheduled = false;

    // Cancel any outstanding scheduled cleanup
    if (_cleanUpCurrentGeohashesQueriedTimeout !== null) {
      clearTimeout(_cleanUpCurrentGeohashesQueriedTimeout);
      _cleanUpCurrentGeohashesQueriedTimeout = null;
    }
  }

  /**
   * Callback for any updates to locations. Will update the information about a key and fire any necessary
   * events every time the key's location changes
   *
   * When a key is removed from GeoFire or the query, this function will can be called with null and performs
   * any necessary cleanup.
   *
   * @param {string} key The key of the geofire location
   * @param {array} location The location as [latitude, longitude] pair
   */
  function _updateLocation(key, location) {
    validateLocation(location);
    // Get the key and location
    var distanceFromCenter, isInQuery;
    var wasInQuery = (_locations.hasOwnProperty(key)) ? _locations[key].isInQuery : false;
    var oldLocation = (_locations.hasOwnProperty(key)) ? _locations[key].location : null;

    // Determine if the location is within this query
    distanceFromCenter = GeoFire.distance(location, _center);
    isInQuery = (distanceFromCenter <= _radius);

    // Add this location to the locations queried dictionary even if it is not within this query
    _locations[key] = {
      location: location,
      distanceFromCenter: distanceFromCenter,
      isInQuery: isInQuery,
      geohash: encodeGeohash(location, g_GEOHASH_PRECISION)
    };

    // Fire the "key_entered" event if the provided key has entered this query
    if (isInQuery && wasInQuery === false) {
      _fireCallbacksForKey("key_entered", key, location, distanceFromCenter);
    } else if (isInQuery && oldLocation !== null && (location[0] !== oldLocation[0] || location[1] !== oldLocation[1])) {
      _fireCallbacksForKey("key_moved", key, location, distanceFromCenter);
    } else if (isInQuery === false && wasInQuery) {
      _fireCallbacksForKey("key_exited", key, location, distanceFromCenter);
    }
  }

  /**
   * Checks if this geohash is currently part of any of the geohash queries
   *
   * @param {string} geohash The geohash
   * @param {boolean} Returns true if the geohash is part of any of the current geohash queries
   */
  function _geohashInSomeQuery(geohash) {
    for (var queryStr in _currentGeohashesQueried) {
      if (_currentGeohashesQueried.hasOwnProperty(queryStr)) {
        var query = _stringToQuery(queryStr);
        if (geohash >= query[0] && geohash <= query[1]) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Callback for child added events.
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childAddedCallback(locationDataSnapshot) {
    var location = decodeGeofireObject(locationDataSnapshot.val());
    // Only handle this change if there is no error with the data format
    if (location !== null) {
      _updateLocation(locationDataSnapshot.name(), location);
    }
  }

  /**
   * Callback for child changed events
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childChangedCallback(locationDataSnapshot) {
    var location = decodeGeofireObject(locationDataSnapshot.val());
    // Only handle this change if there is no error with the data format
    if (location !== null) {
      _updateLocation(locationDataSnapshot.name(), location);
    }
  }

  /**
   * Callback for child removed events
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childRemovedCallback(locationDataSnapshot) {
    var key = locationDataSnapshot.name();
    if (_locations.hasOwnProperty(key)) {
      _firebaseRef.child(key).once("value", function(snapshot) {
        var location = decodeGeofireObject(snapshot.val());
        var geohash = (location !== null) ? encodeGeohash(location) : null;
        // Only notify observers if key is not part of any other geohash query or this actually might not be
        // a key exited event, but a key moved or entered event. These events will be triggered by updates
        // to a different query
        if (!_geohashInSomeQuery(geohash)) {
          var locationDict = _locations[key];
          delete _locations[key];
          if (locationDict && locationDict.isInQuery) {
            var distanceFromCenter = (location !== null) ? GeoFire.distance(location, _center) : null;
            _fireCallbacksForKey("key_exited", key, location, distanceFromCenter);
          }
        }
      });
    }
  }

  /**
   * Checks if we have processed all of the geohashes to query and fires the ready event if necessary.
   */
  function _checkIfShouldFireReadyEvent() {
    // Increment the number of geohashes processed and set the "value" event as fired if we have
    // processed all of the geohashes we were expecting to process.
    _numGeohashesToQueryProcessed++;
    _valueEventFired = (_numGeohashesToQueryProcessed === _geohashesToQuery.length);

    // It's possible that there are no more child added events to process and that the "ready"
    // event will therefore not get called. We should call the "ready" event in that case.
    if (_valueEventFired) {
      _fireReadyEventCallbacks();
    }
  }

  /**
   * Attaches listeners to Firebase which track when new geohashes are added within this query's
   * bounding box.
   */
  function _listenForNewGeohashes() {
    // Get the list of geohashes to query
    _geohashesToQuery = geohashQueries(_center, _radius*1000).map(_queryToString);

    // Filter out duplicate geohashes
    _geohashesToQuery = _geohashesToQuery.filter(function(geohash, i){
      return _geohashesToQuery.indexOf(geohash) === i;
    });

    // For all of the geohashes that we are already currently querying, check if they are still
    // supposed to be queried. If so, don't re-query them. Otherwise, mark them to be un-queried
    // next time we clean up the current geohashes queried dictionary.
    for (var geohashQueryStr in _currentGeohashesQueried) {
      if (_currentGeohashesQueried.hasOwnProperty(geohashQueryStr)) {
        var index = _geohashesToQuery.indexOf(geohashQueryStr);
        if (index === -1) {
          _currentGeohashesQueried[geohashQueryStr] = false;
        }
        else {
          _currentGeohashesQueried[geohashQueryStr] = true;
          _geohashesToQuery.splice(index, 1);
        }
      }
    }

    // If we are not already cleaning up the current geohashes queried and we have more than 25 of them,
    // kick off a timeout to clean them up so we don't create an infinite number of unneeded queries.
    if (_geohashCleanupScheduled === false && Object.keys(_currentGeohashesQueried).length > 25) {
      _geohashCleanupScheduled = true;
      _cleanUpCurrentGeohashesQueriedTimeout = setTimeout(_cleanUpCurrentGeohashesQueried, 10);
    }

    // Keep track of how many geohashes have been processed so we know when to fire the "ready" event
    _numGeohashesToQueryProcessed = 0;

    // Loop through each geohash to query for and listen for new geohashes which have the same prefix.
    // For every match, attach a value callback which will fire the appropriate events.
    // Once every geohash to query is processed, fire the "ready" event.
    _geohashesToQuery.forEach(function(toQueryStr) {
      // decode the geohash query string
      var query = _stringToQuery(toQueryStr);

      // Create the Firebase query
      var firebaseQuery = _firebaseRef.startAt(query[0]).endAt(query[1]);

      // Add the geohash start prefix to the current geohashes queried dictionary and mark it as not
      // to be un-queried
      _currentGeohashesQueried[toQueryStr] = true;

      // For every new matching geohash, determine if we should fire the "key_entered" event
      firebaseQuery.on("child_added", _childAddedCallback);
      firebaseQuery.on("child_removed", _childRemovedCallback);
      firebaseQuery.on("child_changed", _childChangedCallback);

      // Once the current geohash to query is processed, see if it is the last one to be processed
      // and, if so, mark the value event as fired.
      // Note that Firebase fires the "value" event after every "child_added" event fires.
      firebaseQuery.once("value", _checkIfShouldFireReadyEvent);
    });
  }

  /********************/
  /*  PUBLIC METHODS  */
  /********************/
  /**
   * Returns the location signifying the center of this query.
   *
   * @return {array} The [latitude, longitude] pair signifying the center of this query.
   */
  this.center = function() {
    return _center;
  };

  /**
   * Returns the radius of this query, in kilometers.
   *
   * @return {integer} The radius of this query, in kilometers.
   */
  this.radius = function() {
    return _radius;
  };

  /**
   * Updates the criteria for this query.
   *
   * @param {object} newQueryCriteria The criteria which specifies the query's center and radius.
   */
  this.updateCriteria = function(newQueryCriteria) {
    // Validate and save the new query criteria
    validateCriteria(newQueryCriteria);
    _center = newQueryCriteria.center || _center;
    _radius = newQueryCriteria.radius || _radius;

    // Loop through all of the locations in the query, update their distance from the center of the
    // query, and fire any appropriate events
    for (var key in _locations) {
      if (_locations.hasOwnProperty(key)) {
        // Get the cached information for this location
        var locationDict = _locations[key];

        // Save if the location was already in the query
        var wasAlreadyInQuery = locationDict.isInQuery;

        // Update the location's distance to the new query center
        locationDict.distanceFromCenter = GeoFire.distance(locationDict.location, _center);

        // Determine if the location is now in this query
        locationDict.isInQuery = (locationDict.distanceFromCenter <= _radius);

        // If the location just left the query, fire the "key_exited" callbacks
        if (wasAlreadyInQuery && !locationDict.isInQuery) {
          _fireCallbacksForKey("key_exited", key, locationDict.location, locationDict.distanceFromCenter);
        }

        // If the location just entered the query, fire the "key_entered" callbacks
        else if (!wasAlreadyInQuery && locationDict.isInQuery) {
          _fireCallbacksForKey("key_entered", key, locationDict.location, locationDict.distanceFromCenter);
        }
      }
    }

    // Reset the variables which control when the "ready" event fires
    _valueEventFired = false;

    // Listen for new geohashes being added to GeoFire and fire the appropriate events
    _listenForNewGeohashes();
  };

  /**
   * Attaches a callback to this query which will be run when the provided eventType fires. Valid eventType
   * values are "ready", "key_entered", "key_exited", and "key_moved". The ready event callback is passed no
   * parameters. All other callbacks will be passed three parameters: (1) the location's key, (2) the location's
   * [latitude, longitude] pair, and (3) the distance, in kilometers, from the location to this query's center
   *
   * "ready" is used to signify that this query has loaded its initial state and is up-to-date with its corresponding
   * GeoFire instance. "ready" fires when this query has loaded all of the initial data from GeoFire and fired all
   * other events for that data. It also fires every time updateQuery() is called, after all other events have
   * fired for the updated query.
   *
   * "key_entered" fires when a key enters this query. This can happen when a key moves from a location outside of
   * this query to one inside of it or when a key is written to GeoFire for the first time and it falls within
   * this query.
   *
   * "key_exited" fires when a key moves from a location inside of this query to one outside of it. If the key was
   * entirely removed from GeoFire, both the location and distance passed to the callback will be null.
   *
   * "key_moved" fires when a key which is already in this query moves to another location inside of it.
   *
   * Returns a GeoCallbackRegistration which can be used to cancel the callback. You can add as many callbacks
   * as you would like for the same eventType by repeatedly calling on(). Each one will get called when its
   * corresponding eventType fires. Each callback must be cancelled individually.
   *
   * @param {string} eventType The event type for which to attach the callback. One of "ready", "key_entered",
   * "key_exited", or "key_moved".
   * @param {function} callback Callback function to be called when an event of type eventType fires.
   * @return {GeoCallbackRegistration} A callback registration which can be used to cancel the provided callback.
   */
  this.on = function(eventType, callback) {
    // Validate the inputs
    if (["ready", "key_entered", "key_exited", "key_moved"].indexOf(eventType) === -1) {
      throw new Error("event type must be \"ready\", \"key_entered\", \"key_exited\", or \"key_moved\"");
    }
    if (typeof callback !== "function") {
      throw new Error("callback must be a function");
    }

    // Add the callback to this query's callbacks list
    _callbacks[eventType].push(callback);

    // If this is a "key_entered" callback, fire it for every location already within this query
    if (eventType === "key_entered") {
      for (var key in _locations) {
        if (_locations.hasOwnProperty(key)) {
          var locationDict = _locations[key];
          if (locationDict.isInQuery) {
            callback(key, locationDict.location, locationDict.distanceFromCenter);
          }
        }
      }
    }

    // If this is a "ready" callback, fire it if this query is already ready
    if (eventType === "ready") {
      if (_valueEventFired) {
        callback();
      }
    }

    // Return an event registration which can be used to cancel the callback
    return new GeoCallbackRegistration(function() {
      _callbacks[eventType].splice(_callbacks[eventType].indexOf(callback), 1);
    });
  };

  /**
   * Terminates this query so that it no longer sends location updates. All callbacks attached to this
   * query via on() will be cancelled. This query can no longer be used in the future.
   */
  this.cancel = function () {
    // Cancel all callbacks in this query's callback list
    _callbacks = {
      ready: [],
      key_entered: [],
      key_exited: [],
      key_moved: []
    };

    // Turn off all Firebase listeners for the current geohashes being queried
    for (var geohashQueryStr in _currentGeohashesQueried) {
      if (_currentGeohashesQueried.hasOwnProperty(geohashQueryStr)) {
        var query = _stringToQuery(geohashQueryStr);
        _geoQueryOff(query);
        delete _currentGeohashesQueried[geohashQueryStr];
      }
    }

    // Delete any stored locations
    _locations = {};

    // Turn off the current geohashes queried clean up interval
    clearInterval(_cleanUpCurrentGeohashesQueriedInterval);
  };


  /*****************/
  /*  CONSTRUCTOR  */
  /*****************/
  // Firebase reference of the GeoFire which created this query
  if (firebaseRef instanceof Firebase === false) {
    throw new Error("firebaseRef must be an instance of Firebase");
  }
  var _firebaseRef = firebaseRef;

  // Event callbacks
  var _callbacks = {
    ready: [],
    key_entered: [],
    key_exited: [],
    key_moved: []
  };

  // Variables used to keep track of when to fire the "ready" event
  var _valueEventFired = false;
  var _geohashesToQuery, _numGeohashesToQueryProcessed;

  // A dictionary of locations that a currently active in the queries
  // Note that not all of these are currently within this query
  var _locations = {};

  // A dictionary of geohash queries which currently have an active "child_added" event callback
  var _currentGeohashesQueried = {};

  // Every ten seconds, clean up the geohashes we are currently querying for. We keep these around
  // for a little while since it's likely that they will need to be re-queried shortly after they
  // move outside of the query's bounding box.
  var _geohashCleanupScheduled = false;
  var _cleanUpCurrentGeohashesQueriedTimeout = null;
  var _cleanUpCurrentGeohashesQueriedInterval = setInterval(function() {
      if (_geohashCleanupScheduled === false) {
        _cleanUpCurrentGeohashesQueried();
      }
    }, 10000);

  // Validate and save the query criteria
  validateCriteria(queryCriteria, /* requireCenterAndRadius */ true);
  var _center = queryCriteria.center;
  var _radius = queryCriteria.radius;

  // Listen for new geohashes being added around this query and fire the appropriate events
  _listenForNewGeohashes();
};
