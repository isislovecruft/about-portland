/*************************************************************************
 * Content policy to block stuff not handled by other components
 * (such as CSS)
 *   - http://www.w3.org/TR/REC-CSS2/selector.html#dynamic-pseudo-classes
 * 
 * Also serves as a safety net to catch content the other mechanisms 
 * somehow might be tricked into failing to block (this should not happen 
 * in normal operation though).
 *
 * Based on examples from:
 * - http://adblockplus.org/en/faq_internal
 *   - http://developer.mozilla.org/en/docs/How_to_Build_an_XPCOM_Component_in_Javascript
 *   - http://www.xulplanet.com/references/xpcomref/ifaces/nsICategoryManager.html
 *   - http://www.xulplanet.com/references/xpcomref/ifaces/nsIContentPolicy.html
 * - http://greasemonkey.devjavu.com/projects/greasemonkey/browser/trunk/src/components/greasemonkey.js
 *
 * Test cases:
 *   - http://www.tjkdesign.com/articles/css%20pop%20ups/default.asp
 *
 *************************************************************************/

// This is all local scope
const CSSB_CONTRACTID = "@torproject.org/cssblocker;1";
const CSSB_CID = Components.ID("{23f4d9ba-023a-94ab-eb75-67aed7562a18}");

const DNode = Components.interfaces.nsIDOMNode;
const DWindow = Components.interfaces.nsIDOMWindow;
const ok = Components.interfaces.nsIContentPolicy.ACCEPT;
const block = Components.interfaces.nsIContentPolicy.REJECT_REQUEST;
const CPolicy = Components.interfaces.nsIContentPolicy;
const Cr = Components.results;
const Cc = Components.classes;
const Ci = Components.interfaces;

// Retrieves the window object for a node or returns null if it isn't possible
function getWindow(node) {
    if (node && node.nodeType != DNode.DOCUMENT_NODE)
        node = node.ownerDocument;

    if (!node || node.nodeType != DNode.DOCUMENT_NODE)
        return null;

    return node.defaultView;
}

//FIXME: can we kill this noise?
//HACKHACK: need a way to get an implicit wrapper for nodes because of bug 337095 (fixed in Gecko 1.8.0.5)
var fakeFactory = {
	createInstance: function(outer, iid) {
		return outer;
	},

	QueryInterface: function(iid) {
		if (iid.equals(Components.interfaces.nsISupports) ||
				iid.equals(Components.interfaces.nsIFactory))
			return this;

       Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;
       return null;
	}
};
var array = Components.classes['@mozilla.org/supports-array;1'].createInstance(Components.interfaces.nsISupportsArray);
array.AppendElement(fakeFactory);
fakeFactory = array.GetElementAt(0).QueryInterface(Components.interfaces.nsIFactory);
array = null;

function wrapNode(insecNode) {
	return fakeFactory.createInstance(insecNode, Components.interfaces.nsISupports);
}

// Unwraps jar:, view-source: and wyciwyg: URLs, returns the contained URL
// This is no longer needed. These urls are now blocked by mozilla,
// or treated as normal network urls
function unwrapURL(url) {
	if (!url)
		return url;

	var ret = url.replace(/^view-source:/).replace(/^wyciwyg:\/\/\d+\//);
	if (/^jar:(.*?)!/.test(ret))
		ret = RegExp.$1;

	if (ret == url)
		return url;
	else
		return unwrapURL(ret);
}

var localSchemes = {"about" : true, "chrome" : true, "file" : true, 
    "resource" : true, "x-jsd" : true, "addbook" : true, 
    "mailbox" : true};

var browserSources = { "browser":true, "mozapps":true, "global":true, 
     "pippki":true};

var hostFreeSchemes = { "resource":true, "data":true, "cid":true, 
     "javascript":true, "file":true, "jar":true};

var safeOriginSchemes = { "about":true, "chrome":true, "file":true};

function ContentPolicy() {
    this._prefs = Components.classes["@mozilla.org/preferences-service;1"]
        .getService(Components.interfaces.nsIPrefBranch);
    this.wm = Components.classes["@torproject.org/content-window-mapper;1"]
        .getService(Components.interfaces.nsISupports)
        .wrappedJSObject;
    
    this.logger = Components.classes["@torproject.org/torbutton-logger;1"]
        .getService(Components.interfaces.nsISupports).wrappedJSObject;

    // Register observer: 
    var pref_service = Components.classes["@mozilla.org/preferences-service;1"]
        .getService(Components.interfaces.nsIPrefBranchInternal);
    this._branch = pref_service.QueryInterface(Components.interfaces.nsIPrefBranchInternal);
    this._branch.addObserver("extensions.torbutton", this, false);

    this.isolate_content = this._prefs.getBoolPref("extensions.torbutton.isolate_content");
    this.tor_enabled = this._prefs.getBoolPref("extensions.torbutton.tor_enabled");
    this.no_tor_plugins = this._prefs.getBoolPref("extensions.torbutton.no_tor_plugins");

    return;
}

ContentPolicy.prototype = {
    isLocalScheme: function(scheme) {
        return (scheme in localSchemes);
    },

	// nsIContentPolicy interface implementation
	shouldLoad: function(contentType, contentLocation, requestOrigin, insecNode, mimeTypeGuess, extra) {
        /*. Debugging hack. DO NOT UNCOMMENT IN PRODUCTION ENVIRONMENTS
        if(contentLocation.spec.search("venkman") != -1) {
            this.logger.log(3, "chrome-venk");
            return ok;
        }*/

        if(!insecNode) {
            // Happens on startup
            this.logger.log(3, "Skipping no insec: "+contentLocation.spec);
            return ok;
        }

        if(!this.isolate_content) {
            this.logger.eclog(1, "Content policy disabled");
            return ok;
        }

        if(contentLocation.scheme in hostFreeSchemes) {
            if(!requestOrigin) {
                this.logger.eclog(5, "NO ORIGIN! Chrome: "+contentLocation.spec);
            }
            if(requestOrigin && 
                    (requestOrigin.scheme in safeOriginSchemes)) { 
                this.logger.eclog(1, "Skipping chrome-sourced local: "+contentLocation.spec);
                return ok;
            } else if(this.tor_enabled) {
                this.logger.eclog(4, "Blocking local: "+contentLocation.spec+" from: "+requestOrigin.spec);
                return block;
            }
        } else if(contentLocation.schemeIs("chrome")) { 
            if(!requestOrigin) {
                if(contentLocation.host != "pippki") {
                    this.logger.eclog(5, "NO ORIGIN! Chrome: "+contentLocation.spec);
                }
            }

            if((!requestOrigin || !requestOrigin.schemeIs("chrome")) 
                    && !(contentLocation.host in browserSources)) {
                // Prevent access to all but the browser source chrome from websites
                this.logger.eclog(2, "Source: "+ contentLocation.host + ". Chrome: "+contentLocation.spec+" from: "+requestOrigin.spec);
                if(contentLocation.host  == "torbutton" || this.tor_enabled) {
                    // Always conceal torbutton's presence. Conceal 
                    // other stuff only if tor is enabled though.
                    this.logger.eclog(4, "Blocking source: "+contentLocation.host+ ". Chrome: "+contentLocation.spec+" from: "+requestOrigin.spec);
                    return block;
                }
            }
        }

		// Local stuff has to be eclog because otherwise debuglogger will
        // get into an infinite log-loop w/ its chrome updates
        if (this.isLocalScheme(contentLocation.scheme)) {
            this.logger.eclog(1, "Skipping local: "+contentLocation.spec);
			return ok;
        } 
        
        var node = wrapNode(insecNode);
        var wind = getWindow(node);

		// For frame elements go to their window
		if (contentType == CPolicy.TYPE_SUBDOCUMENT && node.contentWindow) {
			node = node.contentWindow;
			wind = node;
		}

        var tor_state = this.tor_enabled;

        if (contentType == 5) { // Object
            // Never seems to happen.. But it would be nice if we 
            // could handle it either here or shouldProcess, instead of in 
            // the webprogresslistener
            if(this.tor_enabled && this.no_tor_plugins) {
                this.logger.log(4, "Blocking object at "+contentLocation.spec);
                return block;
            }
        }

        if (!wind || !wind.top.location || !wind.top.location.href) {
            this.logger.log(4, "Skipping no location: "+contentLocation.spec);
			return ok;
        }


        var doc = wind.top.document;
        if(!doc) {
            // 1st load of a page in a new location
            this.logger.log(3, "Skipping no doc: "+contentLocation.spec);
            return ok;
        }

        var browser;
        if(wind.top.opener && 
            !(wind.top.opener instanceof Components.interfaces.nsIDOMChromeWindow)) {
            this.logger.log(3, "Popup found: "+contentLocation.spec);
            browser = this.wm.getBrowserForContentWindow(wind.top.opener.top)
        } else {
            browser = this.wm.getBrowserForContentWindow(wind.top);
        }

        if(!browser) {
            this.logger.log(5, "No window found: "+contentLocation.spec);
            return block; 
        }

        // source window of browser chrome window with a document content
        // type means the user entered a new URL.
        if(wind.top instanceof Components.interfaces.nsIDOMChromeWindow) {
            // This happens on non-browser chrome: updates, dialogs, etc
            if (!wind.top.browserDOMWindow 
                    && typeof(browser.__tb_tor_fetched) == 'undefined') {
                this.logger.log(3, "Untagged window for "+contentLocation.spec);
                return ok;
            }

            if(wind.top.browserDOMWindow 
                    && contentType == CPolicy.TYPE_DOCUMENT) {
                this.logger.log(3, "New location for "+contentLocation.spec+" (currently: "+wind.top.location+" and "+browser.currentURI.spec+")");
                // Workaround for Firefox Bug 409737.
                // This disables window.location style redirects if the tor state
                // has changed
                if(requestOrigin) {
                    this.logger.log(3, "Origin: "+requestOrigin.spec);
                    if(!requestOrigin.schemeIs("chrome")) {
                        if(typeof(browser.__tb_tor_fetched) == 'undefined') {
                            // This happens for "open in new window" context menu
                            this.logger.log(3, "Untagged window for redirect "+contentLocation.spec);
                            return ok;
                        }
                        if(browser.__tb_tor_fetched == tor_state) {
                            return ok;
                        } else {
                            this.logger.log(3, "Blocking redirect: "+contentLocation.spec);
                            return block;
                        }
                    }
                }
                return ok;
            }
        }

        if(browser.__tb_tor_fetched == tor_state) {
            return ok;
        } else {
            this.logger.log(3, "Blocking: "+contentLocation.spec);
            return block;
        }
	},

	shouldProcess: function(contentType, contentLocation, requestOrigin, insecNode, mimeType, extra) {
        // Were this actually ever called, it might be useful :(
        // Instead, related functionality has been grafted onto the 
        // webprogresslistener :(	
        // See mozilla bugs 380556, 305699, 309524
        if(ContentLocation) {
            this.logger.log(2, "Process for "+contentLocation.spec);
        }
        return ok;
	},

    // Pref observer interface implementation
  
    // topic:   what event occurred
    // subject: what nsIPrefBranch we're observing
    // data:    which pref has been changed (relative to subject)
    observe: function(subject, topic, data)
    {
        if (topic != "nsPref:changed") return;
        switch (data) {
            case "extensions.torbutton.isolate_content":
                this.isolate_content = this._prefs.getBoolPref("extensions.torbutton.isolate_content");
                break;
            case "extensions.torbutton.tor_enabled":
                this.tor_enabled = this._prefs.getBoolPref("extensions.torbutton.tor_enabled");
                break;
            case "extensions.torbutton.no_tor_plugins":
                this.no_tor_plugins = this._prefs.getBoolPref("extensions.torbutton.no_tor_plugins");
                break;
        }
    }
};

/*
 * Factory object
 */

var ContentPolicyInstance = null;

const factory = {
	// nsIFactory interface implementation
	createInstance: function(outer, iid) {
		if (outer != null) {
           Components.returnCode = Cr.NS_ERROR_NO_AGGREGATION;
           return null;
       }

        if (!iid.equals(Components.interfaces.nsIContentPolicy) &&
                !iid.equals(Components.interfaces.nsISupports)) {
            Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;          
            return null;
        }

        if(!ContentPolicyInstance)
            ContentPolicyInstance = new ContentPolicy();

		return ContentPolicyInstance;
	},

	// nsISupports interface implementation
	QueryInterface: function(iid) {
		if (iid.equals(Components.interfaces.nsISupports) ||
				iid.equals(Components.interfaces.nsIModule) ||
				iid.equals(Components.interfaces.nsIFactory))
			return this;

        /*
		if (!iid.equals(Components.interfaces.nsIClassInfo))
			dump("CSS Blocker: factory.QI to an unknown interface: " + iid + "\n");
        */

        Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;          
        return null;   
	}
};


/*
 * Module object
 */
const module = {
	registerSelf: function(compMgr, fileSpec, location, type) {
		compMgr = compMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
		compMgr.registerFactoryLocation(CSSB_CID, 
										"Torbutton content policy",
										CSSB_CONTRACTID,
										fileSpec, location, type);

		var catman = Components.classes["@mozilla.org/categorymanager;1"]
					 .getService(Components.interfaces.nsICategoryManager);
		catman.addCategoryEntry("content-policy", CSSB_CONTRACTID,
							CSSB_CONTRACTID, true, true);
	},

	unregisterSelf: function(compMgr, fileSpec, location) {
		compMgr = compMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);

		compMgr.unregisterFactoryLocation(CSSB_CID, fileSpec);
		var catman = Components.classes["@mozilla.org/categorymanager;1"]
					   .getService(Components.interfaces.nsICategoryManager);
		catman.deleteCategoryEntry("content-policy", CSSB_CONTRACTID, true);
	},

	getClassObject: function(compMgr, cid, iid) {
		if (cid.equals(CSSB_CID))
            return factory;

        Components.returnCode = Cr.NS_ERROR_NOT_REGISTERED;
        return null;
	},

	canUnload: function(compMgr) {
		return true;
	}
};

function NSGetModule(comMgr, fileSpec) {
	return module;
}


